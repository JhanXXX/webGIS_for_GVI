"""
GeoAI Container API测试
"""
import pytest
import requests
import json
import time
from typing import Dict, Any

# 测试配置
API_BASE_URL = "http://localhost:8000/api/v1"
TIMEOUT = 30


class TestGeoAIAPI:
    """GeoAI API测试类"""
    
    @pytest.fixture(autouse=True)
    def setup(self):
        """测试设置"""
        # 等待服务启动
        max_retries = 10
        for _ in range(max_retries):
            try:
                response = requests.get(f"{API_BASE_URL}/health", timeout=5)
                if response.status_code == 200:
                    break
            except:
                time.sleep(2)
        else:
            pytest.fail("API service is not available")
    
    def test_health_check(self):
        """测试健康检查端点"""
        response = requests.get(f"{API_BASE_URL}/health")
        
        assert response.status_code == 200
        data = response.json()
        
        assert "status" in data
        assert "model_loaded" in data
        assert "version" in data
        assert data["status"] in ["healthy", "unhealthy"]
    
    def test_model_info(self):
        """测试模型信息端点"""
        response = requests.get(f"{API_BASE_URL}/model_info")
        
        # 如果模型加载成功
        if response.status_code == 200:
            data = response.json()
            assert "status" in data
            assert "device" in data
            assert "model_info" in data
            assert data["status"] == "loaded"
        else:
            # 模型未加载的情况
            assert response.status_code == 503
    
    def test_supported_features(self):
        """测试支持的特征列表端点"""
        response = requests.get(f"{API_BASE_URL}/supported_features")
        
        assert response.status_code == 200
        data = response.json()
        
        assert "ground_features" in data
        assert "feature_count" in data
        assert len(data["ground_features"]) == 8
        assert data["feature_count"] == 8
        
        # 验证特征顺序
        expected_features = ["NDVI", "EVI", "MSAVI", "GNDVI", "NDRE", "MNDWI", "UI", "BSI"]
        assert data["ground_features"] == expected_features
    
    def test_calculate_single_gvi_valid_stockholm(self):
        """测试单点GVI计算 - Stockholm有效坐标"""
        # Stockholm市中心坐标
        lat, lon = 59.329323, 18.068581
        month = "2023-06"
        
        response = requests.post(
            f"{API_BASE_URL}/calculate_single_gvi",
            params={"lat": lat, "lon": lon, "month": month},
            timeout=TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        assert "lat" in data
        assert "lon" in data
        assert "success" in data
        assert abs(data["lat"] - lat) < 0.000001  # 6位小数精度
        assert abs(data["lon"] - lon) < 0.000001
        
        if data["success"]:
            assert "gvi" in data
            assert "confidence" in data
            assert data["gvi"] is not None
            assert data["confidence"] is not None
            assert 0 <= data["confidence"] <= 1
    
    def test_calculate_batch_gvi_stockholm(self):
        """测试批量GVI计算 - Stockholm多点"""
        request_data = {
            "points": [
                {"lat": 59.329323, "lon": 18.068581},  # Stockholm市中心
                {"lat": 59.334591, "lon": 18.063240},  # 附近点1
                {"lat": 59.325157, "lon": 18.071004}   # 附近点2
            ],
            "month": "2023-06"
        }
        
        response = requests.post(
            f"{API_BASE_URL}/calculate_gvi",
            json=request_data,
            timeout=TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        assert "results" in data
        assert "processed_count" in data
        assert "failed_count" in data
        assert "processing_time" in data
        assert "month" in data
        
        assert len(data["results"]) == 3
        assert data["processed_count"] + data["failed_count"] == 3
        assert data["month"] == "2023-06"
        
        # 检查结果格式
        for result in data["results"]:
            assert "lat" in result
            assert "lon" in result
            assert "success" in result
            
            if result["success"]:
                assert "gvi" in result
                assert "confidence" in result
            else:
                assert "error" in result
    
    def test_calculate_gvi_invalid_coordinates(self):
        """测试无效坐标"""
        # 测试超出范围的坐标
        invalid_coords = [
            {"lat": 100, "lon": 18.068581},    # 无效纬度
            {"lat": 59.329323, "lon": 200},    # 无效经度
        ]
        
        for coord in invalid_coords:
            response = requests.post(
                f"{API_BASE_URL}/calculate_single_gvi",
                params={"lat": coord["lat"], "lon": coord["lon"], "month": "2023-06"}
            )
            assert response.status_code == 422  # 验证错误
    
    def test_calculate_gvi_invalid_month(self):
        """测试无效月份格式"""
        invalid_months = ["2023", "2023-13", "23-06", "2023/06"]
        
        for month in invalid_months:
            response = requests.post(
                f"{API_BASE_URL}/calculate_single_gvi",
                params={"lat": 59.329323, "lon": 18.068581, "month": month}
            )
            assert response.status_code == 422
    
    def test_calculate_gvi_too_many_points(self):
        """测试超过最大点数限制"""
        # 创建超过20个点的请求
        points = [{"lat": 59.3 + i*0.001, "lon": 18.0 + i*0.001} for i in range(25)]
        
        request_data = {
            "points": points,
            "month": "2023-06"
        }
        
        response = requests.post(
            f"{API_BASE_URL}/calculate_gvi",
            json=request_data
        )
        
        assert response.status_code == 422  # 验证错误
    
    def test_coordinate_precision(self):
        """测试坐标精度处理"""
        # 测试高精度坐标是否被正确舍入到6位小数
        lat = 59.3293234567  # 10位小数
        lon = 18.0685814321  # 10位小数
        
        response = requests.post(
            f"{API_BASE_URL}/calculate_single_gvi",
            params={"lat": lat, "lon": lon, "month": "2023-06"},
            timeout=TIMEOUT
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # 验证返回的坐标被舍入到6位小数
        expected_lat = round(lat, 6)
        expected_lon = round(lon, 6)
        
        assert data["lat"] == expected_lat
        assert data["lon"] == expected_lon


def test_container_integration():
    """集成测试：验证容器完整功能"""
    print("Testing GeoAI Container Integration...")
    
    # 1. 健康检查
    health_response = requests.get(f"{API_BASE_URL}/health")
    print(f"Health Check: {health_response.status_code}")
    if health_response.status_code == 200:
        health_data = health_response.json()
        print(f"Model Loaded: {health_data.get('model_loaded', False)}")
    
    # 2. 特征支持检查
    features_response = requests.get(f"{API_BASE_URL}/supported_features")
    print(f"Features Check: {features_response.status_code}")
    
    # 3. 示例GVI计算
    if health_response.status_code == 200:
        try:
            example_response = requests.post(
                f"{API_BASE_URL}/calculate_single_gvi",
                params={"lat": 59.3167, "lon": 18.1362, "month": "2023-06"},
                timeout=100
            )
            print(f"Example GVI Calculation: {example_response.status_code}")
            if example_response.status_code == 200:
                result = example_response.json()
                print(f"Success: {result.get('success', False)}")
                if result.get('success'):
                    print(f"GVI Value: {result.get('gvi', 'N/A')}")
                    print(f"Confidence: {result.get('confidence', 'N/A')}")
                else:
                    print(f"Error: {result.get('error', 'Unknown')}")
        except requests.exceptions.Timeout:
            print("GVI Calculation: Timeout (expected for first run)")


if __name__ == "__main__":
    test_container_integration()
        