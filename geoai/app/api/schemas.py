"""
Pydantic schemas for API request/response models
"""
from typing import List, Optional
from pydantic import BaseModel, Field, validator
import re


class CoordinatePoint(BaseModel):
    """单个坐标点"""
    lat: float = Field(..., ge=-90, le=90, description="latitude")
    lon: float = Field(..., ge=-180, le=180, description="longitude")
    
    @validator('lat', 'lon')
    def round_coordinates(cls, v):
        """确保坐标保留6位小数"""
        return round(float(v), 6)


class GVICalculationRequest(BaseModel):
    """GVI计算请求模型"""
    points: List[CoordinatePoint] = Field(..., min_items=1, max_items=20, 
                                         description="max 20 points at one go")
    month: str = Field(..., description="月份，格式: YYYY-MM")
    
    @validator('month')
    def validate_month(cls, v):
        """验证月份格式"""
        if not re.match(r'^\d{4}-\d{2}$', v):
            raise ValueError('enter YYYY-MM')
        year, month = map(int, v.split('-'))
        if not (2020 <= year <= 2025):  # 合理的年份范围
            raise ValueError('year must between 2020-2025')
        if not (1 <= month <= 12):
            raise ValueError('month must between 04-09')
        return v


class GVIResult(BaseModel):
    """单个点的GVI计算结果"""
    lat: float
    lon: float
    gvi: Optional[float] = Field(None, description="GVI值，失败时为null")
    success: bool
    error: Optional[str] = Field(None, description="错误信息，成功时为null")
    confidence: Optional[float] = Field(None, description="置信度，失败时为null")


class GVICalculationResponse(BaseModel):
    """GVI计算响应模型"""
    results: List[GVIResult]
    processed_count: int = Field(..., description="成功处理的点数量")
    failed_count: int = Field(..., description="失败的点数量")
    processing_time: float = Field(..., description="处理时间(秒)")
    month: str
    
    @validator('results')
    def validate_results_consistency(cls, v, values):
        """验证结果一致性"""
        if 'processed_count' in values and 'failed_count' in values:
            total_expected = values['processed_count'] + values['failed_count']
            if len(v) != total_expected:
                raise ValueError('结果数量与统计不一致')
        return v


class HealthCheckResponse(BaseModel):
    """健康检查响应"""
    status: str
    model_loaded: bool
    version: str = "1.0.0"
    uptime: float


class ErrorResponse(BaseModel):
    """错误响应模型"""
    error: str
    detail: Optional[str] = None
    code: Optional[str] = None