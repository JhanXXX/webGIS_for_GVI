"""
FastAPI路由定义
"""
import time
import logging
from fastapi import APIRouter, HTTPException, Depends
from typing import List

from .schemas import (
    GVICalculationRequest, 
    GVICalculationResponse, 
    GVIResult,
    HealthCheckResponse,
    ErrorResponse
)
from ..services.gvi_calculator import GVICalculator
from ..config.settings import get_settings

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 创建路由器
router = APIRouter(prefix="/api/v1", tags=["GVI"])

# 全局GVI计算器实例
gvi_calculator = None


def get_gvi_calculator() -> GVICalculator:
    """依赖注入：获取GVI计算器实例"""
    global gvi_calculator
    if gvi_calculator is None:
        settings = get_settings()
        gvi_calculator = GVICalculator(settings.model_path)
    return gvi_calculator


@router.get("/health", 
           response_model=HealthCheckResponse,
           summary="健康检查",
           description="检查服务状态和模型加载情况")
async def health_check(calculator: GVICalculator = Depends(get_gvi_calculator)):
    """健康检查端点"""
    try:
        model_status = calculator.get_model_status()
        
        return HealthCheckResponse(
            status="healthy" if model_status["model_loaded"] else "unhealthy",
            model_loaded=model_status["model_loaded"],
            uptime=time.time()  # 简化的运行时间
        )
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(status_code=500, detail=f"Health check failed: {str(e)}")


@router.post("/calculate_gvi",
            response_model=GVICalculationResponse,
            summary="计算GVI值",
            description="批量计算指定坐标点在给定月份的绿色视图指数")
async def calculate_gvi(
    request: GVICalculationRequest,
    calculator: GVICalculator = Depends(get_gvi_calculator)
):
    """
    计算GVI值的主要端点
    
    Args:
        request: GVI计算请求
        calculator: GVI计算器服务
        
    Returns:
        GVI计算结果
        
    Raises:
        HTTPException: 当计算失败时
    """
    try:
        start_time = time.time()
        
        logger.info(f"Received GVI calculation request: {len(request.points)} points for {request.month}")
        
        # 执行批量计算
        results = calculator.calculate_batch_gvi(request.points, request.month)
        
        # 统计结果
        successful_results = [r for r in results if r.success]
        failed_results = [r for r in results if not r.success]
        
        processing_time = time.time() - start_time
        
        response = GVICalculationResponse(
            results=results,
            processed_count=len(successful_results),
            failed_count=len(failed_results),
            processing_time=processing_time,
            month=request.month
        )
        
        logger.info(f"GVI calculation completed: {len(successful_results)}/{len(request.points)} successful, "
                   f"processing time: {processing_time:.2f}s")
        
        return response
        
    except Exception as e:
        logger.error(f"GVI calculation failed: {e}")
        raise HTTPException(
            status_code=500, 
            detail=f"GVI calculation failed: {str(e)}"
        )


@router.post("/calculate_single_gvi",
            response_model=GVIResult,
            summary="计算单点GVI值",
            description="计算单个坐标点的GVI值（便捷接口）")
async def calculate_single_gvi(
    lat: float,
    lon: float, 
    month: str,
    calculator: GVICalculator = Depends(get_gvi_calculator)
):
    """
    单点GVI计算便捷接口
    
    Args:
        lat: 纬度 (-90 to 90)
        lon: 经度 (-180 to 180)
        month: 月份 (YYYY-MM格式)
        calculator: GVI计算器服务
        
    Returns:
        单点GVI计算结果
    """
    try:
        # 验证输入参数
        if not (-90 <= lat <= 90):
            raise HTTPException(status_code=422, detail="纬度必须在-90到90之间")
        if not (-180 <= lon <= 180):
            raise HTTPException(status_code=422, detail="经度必须在-180到180之间")
        
        # 验证月份格式
        import re
        if not re.match(r'^\d{4}-\d{2}$', month):
            raise HTTPException(status_code=422, detail="月份格式必须为YYYY-MM")
        
        logger.info(f"Single GVI calculation request: ({lat:.6f}, {lon:.6f}) for {month}")
        
        # 执行计算
        result = calculator.calculate_single_gvi(lat, lon, month)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Single GVI calculation failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Single GVI calculation failed: {str(e)}"
        )


@router.get("/model_info",
           summary="获取模型信息",
           description="获取当前加载的GVI模型信息")
async def get_model_info(calculator: GVICalculator = Depends(get_gvi_calculator)):
    """获取模型信息端点"""
    try:
        model_status = calculator.get_model_status()
        
        if not model_status["model_loaded"]:
            raise HTTPException(status_code=503, detail="Model is not loaded")
        
        return {
            "status": "loaded",
            "device": model_status["device"],
            "model_info": model_status["model_info"]
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get model info: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get model info: {str(e)}")


@router.get("/supported_features",
           summary="获取支持的特征列表",
           description="获取模型支持的ground features列表")
async def get_supported_features():
    """获取支持的特征列表"""
    return {
        "ground_features": [
            "NDVI", "EVI", "MSAVI", "GNDVI", 
            "NDRE", "MNDWI", "UI", "BSI"
        ],
        "feature_count": 8,
        "spatial_resolution": "20m",
        "buffer_size": "40m",
        "output_size": "4x4 pixels"
    }

@router.get("/cache_stats",
           summary="获取缓存统计信息", 
           description="获取tiff缓存的使用情况统计")
async def get_cache_stats(calculator: GVICalculator = Depends(get_gvi_calculator)):
    """获取缓存统计信息"""
    try:
        cache_stats = calculator.sentinel_service.get_cache_stats()
        return {
            "cache_statistics": cache_stats,
            "timestamp": time.time()
        }
    except Exception as e:
        logger.error(f"Failed to get cache stats: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get cache stats: {str(e)}")
