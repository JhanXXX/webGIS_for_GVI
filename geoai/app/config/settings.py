"""
应用配置设置
"""
from pydantic_settings import BaseSettings
from pathlib import Path
from functools import lru_cache


class Settings(BaseSettings):
    """应用配置类"""
    
    # 基本配置
    app_name: str = "GeoAI GVI Calculator"
    version: str = "1.0.0"
    debug: bool = False
    
    # 模型配置
    model_path: str = "/app/models/gvi_estimater.pth"
    
    # 卫星数据配置
    max_cloud_cover: float = 50.0
    base_resolution: int = 20  # 20m分辨率
    buffer_size: int = 40      # 40m buffer
    target_size: int = 4       # 4x4像素输出
    
    # API配置
    max_points_per_request: int = 20
    request_timeout: int = 500  # 2分钟超时
    
    # 日志配置
    log_level: str = "INFO"
    log_file: str = "/app/logs/geoai.log"
    
    # Microsoft Planetary Computer配置
    stac_api_url: str = "https://planetarycomputer.microsoft.com/api/stac/v1"
    
    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    """获取设置实例（缓存）"""
    return Settings()