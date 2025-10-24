"""
轻量化卫星数据获取服务
基于原有代码简化，专注于实时GVI计算，添加tiff缓存机制
"""
import numpy as np
import pystac_client
import planetary_computer as pc
import rasterio
from rasterio.warp import reproject, calculate_default_transform, Resampling
from rasterio.crs import CRS
from rasterio.windows import from_bounds
import geopandas as gpd
from shapely.geometry import Point, box
from typing import Dict, List, Tuple, Optional
import logging
from datetime import datetime
import hashlib
from pathlib import Path
import os


class SentinelService:
    """轻量化Sentinel-2数据获取和处理服务，带tiff缓存"""
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
        # STAC API客户端
        self.catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=pc.sign_inplace,
        )
        
        # 固定配置
        self.base_resolution = 20  # 20m分辨率
        self.buffer_size = 40      # 40m buffer
        self.target_size = 4       # 4x4像素
        self.max_cloud_cover = 20  # 最大云覆盖率50%
        
        # 缓存配置
        self.cache_dir = Path("/app/cache/tiff")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Sentinel-2波段配置
        self.required_bands = ['B02', 'B03', 'B04', 'B05', 'B08', 'B11', 'B12']
        self.band_resolutions = {
            'B02': 10, 'B03': 10, 'B04': 10, 'B08': 10,  # 10m bands
            'B05': 20, 'B11': 20, 'B12': 20              # 20m bands
        }
        
        # Ground features顺序 - 严格按照训练时的顺序
        self.feature_names = ["NDVI", "EVI", "MSAVI", "GNDVI", "NDRE", "MNDWI", "UI", "BSI"]
        
        self.logger.info(f"Tiff cache directory: {self.cache_dir}")
    
    def _get_cache_key(self, bbox: Tuple, month: str) -> str:
        """生成缓存键"""
        # 将bbox量化到合理精度以提高缓存命中率
        bbox_rounded = tuple(round(x, 4) for x in bbox)
        bbox_str = "_".join(map(str, bbox_rounded))
        cache_key = f"{month}_{bbox_str}"
        
        # 使用hash避免文件名过长
        hash_key = hashlib.md5(cache_key.encode()).hexdigest()
        return hash_key
    
    def _get_cache_path(self, cache_key: str) -> Path:
        """获取缓存文件路径"""
        return self.cache_dir / f"{cache_key}.tif"
    
    def _load_from_cache(self, cache_path: Path) -> Optional[Dict[str, np.ndarray]]:
        """从缓存加载tiff文件"""
        if not cache_path.exists():
            return None
        
        try:
            with rasterio.open(cache_path) as src:
                # 验证波段数量
                if src.count != len(self.required_bands):
                    self.logger.warning(f"Cache file {cache_path} has wrong band count")
                    return None
                
                # 读取所有波段
                composite = {}
                for i, band_name in enumerate(self.required_bands):
                    band_data = src.read(i + 1).astype(np.float32)
                    composite[band_name] = band_data
                
                self.logger.debug(f"Loaded composite from cache: {cache_path}")
                return composite
                
        except Exception as e:
            self.logger.error(f"Error loading from cache {cache_path}: {e}")
            # 删除损坏的缓存文件
            try:
                cache_path.unlink()
            except:
                pass
            return None
    
    def _save_to_cache(self, composite: Dict[str, np.ndarray], cache_path: Path, 
                      bbox: Tuple, target_crs: str):
        """保存composite到缓存"""
        try:
            # 计算地理变换
            height, width = list(composite.values())[0].shape
            left, bottom, right, top = bbox
            
            # 转换bbox到目标坐标系
            if target_crs != "EPSG:4326":
                left, bottom, right, top = rasterio.warp.transform_bounds(
                    CRS.from_epsg(4326), CRS.from_string(target_crs), left, bottom, right, top
                )
            
            transform = rasterio.transform.from_bounds(left, bottom, right, top, width, height)
            
            # 堆叠所有波段
            band_stack = np.stack([composite[band] for band in self.required_bands], axis=0)
            
            # 保存为GeoTIFF
            with rasterio.open(
                cache_path,
                'w',
                driver='GTiff',
                height=height,
                width=width,
                count=len(self.required_bands),
                dtype=band_stack.dtype,
                crs=target_crs,
                transform=transform,
                compress='lzw'
            ) as dst:
                for i, (band_name, band_data) in enumerate(zip(self.required_bands, band_stack)):
                    dst.write(band_data, i + 1)
                    dst.set_band_description(i + 1, band_name)
            
            self.logger.debug(f"Saved composite to cache: {cache_path}")
            
        except Exception as e:
            self.logger.error(f"Error saving to cache {cache_path}: {e}")
            # 删除部分写入的文件
            try:
                if cache_path.exists():
                    cache_path.unlink()
            except:
                pass
    
    def calculate_gvi_features(self, lat: float, lon: float, month: str) -> Optional[np.ndarray]:
        """
        计算单个点的GVI特征，使用tiff缓存
        
        Args:
            lat: 纬度 (6位小数)
            lon: 经度 (6位小数) 
            month: 月份字符串 "YYYY-MM"
            
        Returns:
            8个ground features的4x4数组，失败返回None
        """
        try:
            # 解析月份
            year, month_num = map(int, month.split('-'))
            start_date = f"{year}-{month_num:02d}-01"
            if month_num == 12:
                end_date = f"{year + 1}-01-01"
            else:
                end_date = f"{year}-{month_num + 1:02d}-01"
            
            # 创建空间AOI
            bbox, target_crs = self._create_square_aoi(lat, lon)
            
            # 检查缓存
            cache_key = self._get_cache_key(bbox, month)
            cache_path = self._get_cache_path(cache_key)
            
            # 尝试从缓存加载
            composite = self._load_from_cache(cache_path)
            
            if composite is None:
                # 缓存未命中，从网络获取数据
                self.logger.debug(f"Cache miss for ({lat:.6f}, {lon:.6f}) in {month}")
                
                # 搜索卫星数据
                items = self._search_sentinel_items(bbox, start_date, end_date)
                if not items:
                    self.logger.debug(f"No satellite data found for ({lat:.6f}, {lon:.6f}) in {month}")
                    return None
                
                # 创建波段合成
                composite = self._create_band_composite(items, bbox, target_crs)
                if composite is None:
                    return None
                
                # 保存到缓存
                self._save_to_cache(composite, cache_path, bbox, target_crs)
                
            else:
                self.logger.debug(f"Cache hit for ({lat:.6f}, {lon:.6f}) in {month}")
            
            # 计算ground features
            features = self._calculate_ground_features(composite)
            
            # 转换为模型输入格式 (8, 4, 4)
            feature_stack = np.stack([features[name] for name in self.feature_names], axis=0)
            
            return feature_stack
            
        except Exception as e:
            self.logger.error(f"Error calculating features for ({lat:.6f}, {lon:.6f}): {e}")
            return None
    
    def _create_square_aoi(self, lat: float, lon: float) -> Tuple[Tuple[float, float, float, float], str]:
        """创建正方形AOI"""
        # 获取UTM坐标系
        target_crs = self._get_utm_crs(lat, lon)
        
        # 创建WGS84点
        point_wgs84 = Point(lon, lat)
        point_gdf = gpd.GeoDataFrame([1], geometry=[point_wgs84], crs="EPSG:4326")
        
        # 转换到UTM
        point_utm = point_gdf.to_crs(target_crs)
        utm_x, utm_y = point_utm.geometry.iloc[0].x, point_utm.geometry.iloc[0].y
        
        # 创建正方形buffer
        square_utm = box(
            utm_x - self.buffer_size,
            utm_y - self.buffer_size, 
            utm_x + self.buffer_size,
            utm_y + self.buffer_size
        )
        
        # 转换回WGS84用于STAC搜索
        square_gdf = gpd.GeoDataFrame([1], geometry=[square_utm], crs=target_crs)
        square_wgs84 = square_gdf.to_crs("EPSG:4326")
        bounds = square_wgs84.bounds.iloc[0]
        bbox = (bounds['minx'], bounds['miny'], bounds['maxx'], bounds['maxy'])
        
        return bbox, target_crs
    
    def _get_utm_crs(self, lat: float, lon: float) -> str:
        """获取UTM坐标系"""
        utm_zone = int((lon + 180) / 6) + 1
        hemisphere = 'north' if lat >= 0 else 'south'
        
        if hemisphere == 'north':
            return f"EPSG:{32600 + utm_zone}"
        else:
            return f"EPSG:{32700 + utm_zone}"
    
    def _search_sentinel_items(self, bbox: Tuple[float, float, float, float], 
                              start_date: str, end_date: str) -> List:
        """搜索Sentinel-2数据"""
        try:
            search = self.catalog.search(
                collections=["sentinel-2-l2a"],
                bbox=bbox,
                datetime=f"{start_date}/{end_date}",
                query={"eo:cloud_cover": {"lt": self.max_cloud_cover}}
            )
            
            items = list(search.get_items())
            return items
            
        except Exception as e:
            self.logger.error(f"Error searching sentinel items: {e}")
            return []
    
    def _create_band_composite(self, items: List, bbox: Tuple, target_crs: str) -> Optional[Dict[str, np.ndarray]]:
        """创建波段合成"""
        if not items:
            return None
        
        band_data = {band: [] for band in self.required_bands}
        
        for item in items:
            try:
                item_bands = {}
                for band_name in self.required_bands:
                    band_array = self._download_process_band(item, band_name, bbox, target_crs)
                    if band_array is not None:
                        item_bands[band_name] = band_array
                
                # 只有所有波段都成功才加入
                if len(item_bands) == len(self.required_bands):
                    for band_name, array in item_bands.items():
                        band_data[band_name].append(array)
                        
            except Exception as e:
                self.logger.warning(f"Failed to process item {item.id}: {e}")
                continue
        
        # 检查是否有有效数据
        if not any(band_data.values()):
            return None
        
        # 创建median合成
        composite = {}
        for band_name, arrays in band_data.items():
            if arrays:
                stacked = np.stack(arrays, axis=0)
                composite[band_name] = np.nanmedian(stacked, axis=0)
            else:
                composite[band_name] = np.full((self.target_size, self.target_size), np.nan)
        
        return composite
    
    def _download_process_band(self, item, band_name: str, bbox: Tuple, target_crs: str) -> Optional[np.ndarray]:
        """下载并处理单个波段"""
        if band_name not in item.assets:
            return None
        
        try:
            asset_url = item.assets[band_name].href
            
            with rasterio.open(asset_url) as src:
                # 转换bbox到源坐标系
                left, bottom, right, top = bbox
                if src.crs != CRS.from_epsg(4326):
                    left, bottom, right, top = rasterio.warp.transform_bounds(
                        CRS.from_epsg(4326), src.crs, left, bottom, right, top
                    )
                
                # 获取窗口
                window = from_bounds(left, bottom, right, top, src.transform)
                data = src.read(1, window=window)
                window_transform = src.window_transform(window)
                
                # 计算目标变换
                target_transform, _, _ = calculate_default_transform(
                    src.crs, CRS.from_string(target_crs),
                    data.shape[1], data.shape[0],
                    left, bottom, right, top,
                    dst_width=self.target_size, dst_height=self.target_size
                )
                
                # 重投影
                reprojected = np.empty((self.target_size, self.target_size), dtype=np.float32)
                
                # 根据波段分辨率选择重采样方法
                band_resolution = self.band_resolutions.get(band_name, 20)
                if band_resolution == 10:
                    resampling_method = Resampling.average  # 10m->20m使用average
                else:
                    resampling_method = Resampling.bilinear  # 20m->20m使用bilinear
                
                reproject(
                    source=data,
                    destination=reprojected,
                    src_transform=window_transform,
                    src_crs=src.crs,
                    dst_transform=target_transform,
                    dst_crs=CRS.from_string(target_crs),
                    resampling=resampling_method
                )
                
                # 转换为反射率并清理异常值
                reprojected = reprojected.astype(np.float32) / 10000.0
                reprojected[(reprojected <= 0) | (reprojected >= 1)] = np.nan
                
                return reprojected
                
        except Exception as e:
            self.logger.error(f"Error processing band {band_name}: {e}")
            return None
    
    def _calculate_ground_features(self, composite: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
        """计算ground features"""
        # 提取波段
        blue = composite['B02']
        green = composite['B03']
        red = composite['B04']
        red_edge = composite['B05']
        nir = composite['B08']
        swir1 = composite['B11']
        swir2 = composite['B12']
        
        features = {}
        
        # NDVI
        ndvi_denom = nir + red
        features["NDVI"] = np.where(ndvi_denom != 0, (nir - red) / ndvi_denom, np.nan)
        
        # EVI
        evi_denom = nir + 6 * red - 7.5 * blue + 1
        features["EVI"] = np.where(evi_denom != 0, 2.5 * (nir - red) / evi_denom, np.nan)
        
        # MSAVI
        discriminant = (2 * nir + 1)**2 - 8 * (nir - red)
        features["MSAVI"] = np.where(
            discriminant >= 0,
            (2 * nir + 1 - np.sqrt(discriminant)) / 2,
            np.nan
        )
        
        # GNDVI
        gndvi_denom = nir + green
        features["GNDVI"] = np.where(gndvi_denom != 0, (nir - green) / gndvi_denom, np.nan)
        
        # NDRE
        ndre_denom = nir + red_edge
        features["NDRE"] = np.where(ndre_denom != 0, (nir - red_edge) / ndre_denom, np.nan)
        
        # MNDWI
        mndwi_denom = green + swir1
        features["MNDWI"] = np.where(mndwi_denom != 0, (green - swir1) / mndwi_denom, np.nan)
        
        # UI (Urban Index)
        ui_denom = swir2 + nir
        features["UI"] = np.where(ui_denom != 0, (swir2 - nir) / ui_denom, np.nan)
        
        # BSI (Bare Soil Index)
        bsi_denom = (swir1 + red) + (nir + blue)
        features["BSI"] = np.where(bsi_denom != 0, ((swir1 + red) - (nir + blue)) / bsi_denom, np.nan)
        
        return features
    
    def get_cache_stats(self) -> Dict:
        """获取缓存统计信息"""
        try:
            cache_files = list(self.cache_dir.glob("*.tif"))
            total_size = sum(f.stat().st_size for f in cache_files)
            
            return {
                "cache_dir": str(self.cache_dir),
                "cached_files": len(cache_files),
                "total_size_mb": round(total_size / (1024 * 1024), 2),
                "cache_enabled": True
            }
        except Exception as e:
            self.logger.error(f"Error getting cache stats: {e}")
            return {"cache_enabled": False, "error": str(e)}
    
    def _create_square_aoi(self, lat: float, lon: float) -> Tuple[Tuple[float, float, float, float], str]:
        """创建正方形AOI"""
        # 获取UTM坐标系
        target_crs = self._get_utm_crs(lat, lon)
        
        # 创建WGS84点
        point_wgs84 = Point(lon, lat)
        point_gdf = gpd.GeoDataFrame([1], geometry=[point_wgs84], crs="EPSG:4326")
        
        # 转换到UTM
        point_utm = point_gdf.to_crs(target_crs)
        utm_x, utm_y = point_utm.geometry.iloc[0].x, point_utm.geometry.iloc[0].y
        
        # 创建正方形buffer
        square_utm = box(
            utm_x - self.buffer_size,
            utm_y - self.buffer_size, 
            utm_x + self.buffer_size,
            utm_y + self.buffer_size
        )
        
        # 转换回WGS84用于STAC搜索
        square_gdf = gpd.GeoDataFrame([1], geometry=[square_utm], crs=target_crs)
        square_wgs84 = square_gdf.to_crs("EPSG:4326")
        bounds = square_wgs84.bounds.iloc[0]
        bbox = (bounds['minx'], bounds['miny'], bounds['maxx'], bounds['maxy'])
        
        return bbox, target_crs
    
    def _get_utm_crs(self, lat: float, lon: float) -> str:
        """获取UTM坐标系"""
        utm_zone = int((lon + 180) / 6) + 1
        hemisphere = 'north' if lat >= 0 else 'south'
        
        if hemisphere == 'north':
            return f"EPSG:{32600 + utm_zone}"
        else:
            return f"EPSG:{32700 + utm_zone}"
    
    def _search_sentinel_items(self, bbox: Tuple[float, float, float, float], 
                              start_date: str, end_date: str) -> List:
        """搜索Sentinel-2数据"""
        try:
            search = self.catalog.search(
                collections=["sentinel-2-l2a"],
                bbox=bbox,
                datetime=f"{start_date}/{end_date}",
                query={"eo:cloud_cover": {"lt": self.max_cloud_cover}}
            )
            
            items = list(search.get_items())
            return items
            
        except Exception as e:
            self.logger.error(f"Error searching sentinel items: {e}")
            return []
    
    def _create_band_composite(self, items: List, bbox: Tuple, target_crs: str) -> Optional[Dict[str, np.ndarray]]:
        """创建波段合成"""
        if not items:
            return None
        
        band_data = {band: [] for band in self.required_bands}
        
        for item in items:
            try:
                item_bands = {}
                for band_name in self.required_bands:
                    band_array = self._download_process_band(item, band_name, bbox, target_crs)
                    if band_array is not None:
                        item_bands[band_name] = band_array
                
                # 只有所有波段都成功才加入
                if len(item_bands) == len(self.required_bands):
                    for band_name, array in item_bands.items():
                        band_data[band_name].append(array)
                        
            except Exception as e:
                self.logger.warning(f"Failed to process item {item.id}: {e}")
                continue
        
        # 检查是否有有效数据
        if not any(band_data.values()):
            return None
        
        # 创建median合成
        composite = {}
        for band_name, arrays in band_data.items():
            if arrays:
                stacked = np.stack(arrays, axis=0)
                composite[band_name] = np.nanmedian(stacked, axis=0)
            else:
                composite[band_name] = np.full((self.target_size, self.target_size), np.nan)
        
        return composite
    
    def _download_process_band(self, item, band_name: str, bbox: Tuple, target_crs: str) -> Optional[np.ndarray]:
        """下载并处理单个波段"""
        if band_name not in item.assets:
            return None
        
        try:
            asset_url = item.assets[band_name].href
            
            with rasterio.open(asset_url) as src:
                # 转换bbox到源坐标系
                left, bottom, right, top = bbox
                if src.crs != CRS.from_epsg(4326):
                    left, bottom, right, top = rasterio.warp.transform_bounds(
                        CRS.from_epsg(4326), src.crs, left, bottom, right, top
                    )
                
                # 获取窗口
                window = from_bounds(left, bottom, right, top, src.transform)
                data = src.read(1, window=window)
                window_transform = src.window_transform(window)
                
                # 计算目标变换
                target_transform, _, _ = calculate_default_transform(
                    src.crs, CRS.from_string(target_crs),
                    data.shape[1], data.shape[0],
                    left, bottom, right, top,
                    dst_width=self.target_size, dst_height=self.target_size
                )
                
                # 重投影
                reprojected = np.empty((self.target_size, self.target_size), dtype=np.float32)
                
                # 根据波段分辨率选择重采样方法
                band_resolution = self.band_resolutions.get(band_name, 20)
                if band_resolution == 10:
                    resampling_method = Resampling.average  # 10m->20m使用average
                else:
                    resampling_method = Resampling.bilinear  # 20m->20m使用bilinear
                
                reproject(
                    source=data,
                    destination=reprojected,
                    src_transform=window_transform,
                    src_crs=src.crs,
                    dst_transform=target_transform,
                    dst_crs=CRS.from_string(target_crs),
                    resampling=resampling_method
                )
                
                # 转换为反射率并清理异常值
                reprojected = reprojected.astype(np.float32) / 10000.0
                reprojected[(reprojected <= 0) | (reprojected >= 1)] = np.nan
                
                return reprojected
                
        except Exception as e:
            self.logger.error(f"Error processing band {band_name}: {e}")
            return None
    
    def _calculate_ground_features(self, composite: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
        """计算ground features"""
        # 提取波段
        blue = composite['B02']
        green = composite['B03']
        red = composite['B04']
        red_edge = composite['B05']
        nir = composite['B08']
        swir1 = composite['B11']
        swir2 = composite['B12']
        
        features = {}
        
        # NDVI
        ndvi_denom = nir + red
        features["NDVI"] = np.where(ndvi_denom != 0, (nir - red) / ndvi_denom, np.nan)
        
        # EVI
        evi_denom = nir + 6 * red - 7.5 * blue + 1
        features["EVI"] = np.where(evi_denom != 0, 2.5 * (nir - red) / evi_denom, np.nan)
        
        # MSAVI
        discriminant = (2 * nir + 1)**2 - 8 * (nir - red)
        features["MSAVI"] = np.where(
            discriminant >= 0,
            (2 * nir + 1 - np.sqrt(discriminant)) / 2,
            np.nan
        )
        
        # GNDVI
        gndvi_denom = nir + green
        features["GNDVI"] = np.where(gndvi_denom != 0, (nir - green) / gndvi_denom, np.nan)
        
        # NDRE
        ndre_denom = nir + red_edge
        features["NDRE"] = np.where(ndre_denom != 0, (nir - red_edge) / ndre_denom, np.nan)
        
        # MNDWI
        mndwi_denom = green + swir1
        features["MNDWI"] = np.where(mndwi_denom != 0, (green - swir1) / mndwi_denom, np.nan)
        
        # UI (Urban Index)
        ui_denom = swir2 + nir
        features["UI"] = np.where(ui_denom != 0, (swir2 - nir) / ui_denom, np.nan)
        
        # BSI (Bare Soil Index)
        bsi_denom = (swir1 + red) + (nir + blue)
        features["BSI"] = np.where(bsi_denom != 0, ((swir1 + red) - (nir + blue)) / bsi_denom, np.nan)
        
        return features