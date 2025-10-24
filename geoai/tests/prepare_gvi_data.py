#!/usr/bin/env python3
"""
批量GVI数据准备脚本
从shapefile读取坐标点，调用GeoAI服务计算GVI，存储到PostgreSQL数据库
"""

import os
import sys
import json
import time
import argparse
import logging
from pathlib import Path
from typing import List, Dict, Tuple, Optional
import requests
import geopandas as gpd
import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor
from shapely.geometry import Point
import numpy as np


class GVIDataPreparer:
    """GVI数据准备工具"""
    
    def __init__(self, 
                 month: str,
                 shapefile_path: str = "/app/tests/test_data/Stockholm_jr_samples.shp",                 
                 geoai_url: str = "http://localhost:8000",
                 db_config: Dict = None,
                 batch_size: int = 10):
        """
        初始化数据准备工具
        
        Args:
            shapefile_path: shapefile文件路径
            month: 月份 (YYYY-MM)
            geoai_url: GeoAI服务URL
            db_config: 数据库配置
            batch_size: 批处理大小
        """
        self.month = month
        self.shapefile_path = Path(shapefile_path)
        self.geoai_url = geoai_url.rstrip('/')
        self.batch_size = batch_size
        
        # 数据库配置
        self.db_config = db_config or {
            'host': os.getenv('POSTGRES_HOST', 'postgres'),
            'port': os.getenv('POSTGRES_PORT', '5432'),
            'database': os.getenv('POSTGRES_DB', 'gvi_app'),
            'user': os.getenv('POSTGRES_USER', 'gvi_user'),
            'password': os.getenv('POSTGRES_PASSWORD', 'gvi_pass')
        }
        
        # 设置日志
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.StreamHandler(sys.stdout),
                logging.FileHandler(f'/app/logs/gvi_data_prep_{month.replace("-", "_")}.log')
            ]
        )
        self.logger = logging.getLogger(__name__)
        
        # 统计信息
        self.stats = {
            'total_points': 0,
            'processed_points': 0,
            'successful_gvi': 0,
            'failed_gvi': 0,
            'inserted_db': 0,
            'start_time': None,
            'end_time': None
        }
    
    def load_points_from_shapefile(self) -> gpd.GeoDataFrame:
        """从shapefile加载坐标点"""
        try:
            if not self.shapefile_path.exists():
                raise FileNotFoundError(f"Shapefile not found: {self.shapefile_path}")
            
            self.logger.info(f"Loading points from {self.shapefile_path}")
            gdf = gpd.read_file(self.shapefile_path)
            
            # 确保是点几何
            if not all(gdf.geometry.geom_type == 'Point'):
                self.logger.warning("Non-point geometries found, filtering to points only")
                gdf = gdf[gdf.geometry.geom_type == 'Point']
            
            # 转换到WGS84
            if gdf.crs != 'EPSG:4326':
                self.logger.info(f"Converting CRS from {gdf.crs} to EPSG:4326")
                gdf = gdf.to_crs('EPSG:4326')
            
            # 提取坐标并保留6位小数
            gdf['lat'] = gdf.geometry.y.round(6)
            gdf['lon'] = gdf.geometry.x.round(6)
            
            # 添加唯一ID (如果没有)
            if 'id' not in gdf.columns:
                gdf['id'] = range(len(gdf))
            
            self.stats['total_points'] = len(gdf)
            self.logger.info(f"Loaded {len(gdf)} points")
            
            return gdf
            
        except Exception as e:
            self.logger.error(f"Error loading shapefile: {e}")
            raise
    
    def check_existing_data(self, points_df: pd.DataFrame) -> pd.DataFrame:
        """检查数据库中已存在的GVI数据，过滤掉重复的点"""
        try:
            conn = psycopg2.connect(**self.db_config)
            cursor = conn.cursor()
            
            # 检查gvi_points表是否存在
            cursor.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'gvi_points'
                );
            """)
            
            if not cursor.fetchone()[0]:
                self.logger.info("gvi_points table does not exist, will process all points")
                conn.close()
                return points_df
            
            # 检查该月份是否有任何数据
            cursor.execute("SELECT COUNT(*) FROM gvi_points WHERE month = %s", (self.month,))
            month_count = cursor.fetchone()[0]
            
            if month_count == 0:
                self.logger.info(f"No existing data for month {self.month}, will process all points")
                conn.close()
                return points_df
            
            self.logger.info(f"Found {month_count} existing records for {self.month}, checking for duplicates")
            
            # 使用更精确的坐标比较
            # 为每个点检查是否存在（使用空间距离）
            existing_coords = set()
            
            for _, row in points_df.iterrows():
                cursor.execute("""
                    SELECT COUNT(*) FROM gvi_points 
                    WHERE month = %s 
                    AND ST_DWithin(
                        geometry, 
                        ST_GeomFromText('POINT(%s %s)', 4326), 
                        0.000001  -- 约0.1米的容差
                    )
                """, (self.month, row.lon, row.lat))
                
                if cursor.fetchone()[0] > 0:
                    existing_coords.add((round(row.lat, 6), round(row.lon, 6)))
            
            conn.close()
            
            # 过滤掉已存在的点
            if existing_coords:
                initial_count = len(points_df)
                points_df = points_df[~points_df.apply(
                    lambda row: (round(row.lat, 6), round(row.lon, 6)) in existing_coords, axis=1
                )]
                filtered_count = len(points_df)
                
                self.logger.info(f"Filtered out {initial_count - filtered_count} existing points")
                self.logger.info(f"Remaining points to process: {filtered_count}")
            else:
                self.logger.info("No duplicate points found")
            
            return points_df
            
        except Exception as e:
            self.logger.error(f"Error checking existing data: {e}")
            self.logger.warning("Will process all points due to error")
            try:
                conn.close()
            except:
                pass
            return points_df  # 出错时处理所有点
    
    def call_geoai_batch(self, points_batch: List[Dict]) -> List[Dict]:
        """调用GeoAI服务批量计算GVI"""
        try:
            url = f"{self.geoai_url}/api/v1/calculate_gvi"
            payload = {
                "points": [{"lat": p["lat"], "lon": p["lon"]} for p in points_batch],
                "month": self.month
            }
            
            response = requests.post(url, json=payload, timeout=300)  # 5分钟超时
            
            if response.status_code == 200:
                return response.json()
            else:
                self.logger.error(f"GeoAI API error: {response.status_code} - {response.text}")
                return {"results": [], "processed_count": 0, "failed_count": len(points_batch)}
                
        except requests.exceptions.Timeout:
            self.logger.error(f"Timeout calling GeoAI service for batch of {len(points_batch)} points")
            return {"results": [], "processed_count": 0, "failed_count": len(points_batch)}
        except Exception as e:
            self.logger.error(f"Error calling GeoAI service: {e}")
            return {"results": [], "processed_count": 0, "failed_count": len(points_batch)}
    
    def create_gvi_points_table(self):
        """创建gvi_points表 (如果不存在)"""
        try:
            conn = psycopg2.connect(**self.db_config)
            cursor = conn.cursor()
            
            create_table_sql = """
                CREATE TABLE IF NOT EXISTS gvi_points (
                    id SERIAL PRIMARY KEY,
                    geometry GEOMETRY(POINT, 4326) NOT NULL,
                    gvi DOUBLE PRECISION NOT NULL,
                    confidence DOUBLE PRECISION,
                    month VARCHAR(7) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    original_id INTEGER
                );
                
                -- 创建空间索引
                CREATE INDEX IF NOT EXISTS idx_gvi_points_geom 
                ON gvi_points USING GIST (geometry);
                
                -- 创建月份索引
                CREATE INDEX IF NOT EXISTS idx_gvi_points_month 
                ON gvi_points (month);
                
                -- 创建复合索引 (坐标 + 月份)
                CREATE INDEX IF NOT EXISTS idx_gvi_points_coord_month 
                ON gvi_points (month, ST_X(geometry), ST_Y(geometry));
            """
            
            cursor.execute(create_table_sql)
            conn.commit()
            conn.close()
            
            self.logger.info("gvi_points table created/verified")
            
        except Exception as e:
            self.logger.error(f"Error creating gvi_points table: {e}")
            raise
    
    def insert_gvi_results(self, successful_results: List[Dict]):
        """将成功的GVI结果插入数据库"""
        if not successful_results:
            return
        
        try:
            conn = psycopg2.connect(**self.db_config)
            cursor = conn.cursor()
            
            insert_sql = """
                INSERT INTO gvi_points (geometry, gvi, confidence, month, original_id)
                VALUES (ST_GeomFromText('POINT(%s %s)', 4326), %s, %s, %s, %s)
            """
            
            insert_data = []
            for result in successful_results:
                insert_data.append((
                    result['lon'], result['lat'],  # POINT(lon lat) 格式
                    result['gvi'],
                    result.get('confidence'),
                    self.month,
                    result.get('original_id')
                ))
            
            cursor.executemany(insert_sql, insert_data)
            conn.commit()
            
            self.stats['inserted_db'] += len(insert_data)
            self.logger.info(f"Inserted {len(insert_data)} records into database")
            
            conn.close()
            
        except Exception as e:
            self.logger.error(f"Error inserting data: {e}")
            raise
    
    def process_data(self):
        """主处理流程"""
        self.stats['start_time'] = time.time()
        
        try:
            # 1. 加载shapefile数据
            points_gdf = self.load_points_from_shapefile()
            
            # 2. 检查已存在的数据
            points_gdf = self.check_existing_data(points_gdf)
            
            if len(points_gdf) == 0:
                self.logger.info("No new points to process")
                return
            
            # 3. 创建数据库表
            self.create_gvi_points_table()
            
            # 4. 批量处理点
            total_batches = (len(points_gdf) + self.batch_size - 1) // self.batch_size
            self.logger.info(f"Processing {len(points_gdf)} points in {total_batches} batches")
            
            for batch_idx in range(0, len(points_gdf), self.batch_size):
                batch_df = points_gdf.iloc[batch_idx:batch_idx + self.batch_size]
                batch_num = (batch_idx // self.batch_size) + 1
                
                self.logger.info(f"Processing batch {batch_num}/{total_batches} ({len(batch_df)} points)")
                
                # 准备批次数据
                points_batch = []
                for _, row in batch_df.iterrows():
                    points_batch.append({
                        'lat': row.lat,
                        'lon': row.lon,
                        'original_id': row.get('id')
                    })
                
                # 调用GeoAI服务
                gvi_results = self.call_geoai_batch(points_batch)
                
                # 更新统计
                self.stats['processed_points'] += len(points_batch)
                self.stats['successful_gvi'] += gvi_results.get('processed_count', 0)
                self.stats['failed_gvi'] += gvi_results.get('failed_count', 0)
                
                # 准备成功的结果用于数据库插入
                successful_results = []
                for i, result in enumerate(gvi_results.get('results', [])):
                    if result.get('success'):
                        result['original_id'] = points_batch[i].get('original_id')
                        successful_results.append(result)
                
                # 插入数据库
                if successful_results:
                    self.insert_gvi_results(successful_results)
                
                # 进度报告
                progress = (batch_num / total_batches) * 100
                self.logger.info(f"Progress: {progress:.1f}% - "
                               f"Success: {self.stats['successful_gvi']}, "
                               f"Failed: {self.stats['failed_gvi']}")
                
                # 批次间短暂暂停，避免过载
                if batch_num < total_batches:
                    time.sleep(1)
            
            self.stats['end_time'] = time.time()
            self.print_summary()
            
        except Exception as e:
            self.logger.error(f"Error in main processing: {e}")
            raise
    
    def print_summary(self):
        """打印处理摘要"""
        duration = self.stats['end_time'] - self.stats['start_time']
        
        summary = f"""
        
=== GVI Data Preparation Summary ===
Month: {self.month}
Shapefile: {self.shapefile_path}
Processing Time: {duration:.2f} seconds

Points Statistics:
- Total points in shapefile: {self.stats['total_points']}
- Points processed: {self.stats['processed_points']}
- Successful GVI calculations: {self.stats['successful_gvi']}
- Failed GVI calculations: {self.stats['failed_gvi']}
- Records inserted to database: {self.stats['inserted_db']}

Success Rate: {(self.stats['successful_gvi'] / max(self.stats['processed_points'], 1)) * 100:.1f}%
Processing Speed: {self.stats['processed_points'] / max(duration, 1):.2f} points/second

"""
        
        print(summary)
        self.logger.info(summary)


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description='Prepare GVI data from shapefile')
    parser.add_argument('month', default="2025-08", help='Month in YYYY-MM format')
    parser.add_argument('shapefile', default="/app/tests/test_data/Stockholm_jr_samples.shp",help='Path to the shapefile')
    parser.add_argument('--geoai-url', default='http://localhost:8000', 
                       help='GeoAI service URL (default: http://localhost:8000)')
    parser.add_argument('--batch-size', type=int, default=10,
                       help='Batch size for GVI calculations (max: 10)')
    parser.add_argument('--db-host', default='postgres',
                       help='Database host (default: postgres)')
    parser.add_argument('--db-port', default='5432',
                       help='Database port (default: 5432)')
    
    args = parser.parse_args()
    
    
    # 数据库配置
    db_config = {
        'host': args.db_host,
        'port': args.db_port,
        'database': os.getenv('POSTGRES_DB', 'gvi_app'),
        'user': os.getenv('POSTGRES_USER', 'gvi_user'),
        'password': os.getenv('POSTGRES_PASSWORD', 'gvi_pass')
    }
    
    # 创建处理器并运行
    preparer = GVIDataPreparer(
        month=args.month,
        shapefile_path=args.shapefile,
        geoai_url=args.geoai_url,
        db_config=db_config,
        batch_size=args.batch_size
    )
    
    try:
        preparer.process_data()
        print("Data preparation completed successfully!")
        
    except KeyboardInterrupt:
        print("\nData preparation interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"Data preparation failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()