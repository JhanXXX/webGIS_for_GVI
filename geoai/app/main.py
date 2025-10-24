"""
GeoAI GVI Calculator - FastAPI主应用
"""
import logging
import sys
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api.routes import router
from .config.settings import get_settings

# 获取配置
settings = get_settings()

# 配置日志
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(settings.log_file, mode='a') if Path(settings.log_file).parent.exists() else logging.StreamHandler()
    ]
)

logger = logging.getLogger(__name__)

# 创建FastAPI应用
app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="GeoAI-powered Green View Index (GVI) calculation service using Sentinel-2A satellite imagery",
    debug=settings.debug,
    docs_url="/docs" if settings.debug else None,  # 生产环境关闭docs
    redoc_url="/redoc" if settings.debug else None
)

# 添加CORS中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:8080"],  # 前端开发服务器
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# 包含API路由
app.include_router(router)


@app.on_event("startup")
async def startup_event():
    """应用启动事件"""
    logger.info(f"Starting {settings.app_name} v{settings.version}")
    logger.info(f"Debug mode: {settings.debug}")
    logger.info(f"Model path: {settings.model_path}")
    logger.info(f"Log level: {settings.log_level}")
    
    # 检查模型文件是否存在
    model_path = Path(settings.model_path)
    if not model_path.exists():
        logger.error(f"Model file not found: {settings.model_path}")
        logger.error("Please ensure the model file is properly mounted in the container")
    else:
        logger.info(f"Model file found: {settings.model_path}")


@app.on_event("shutdown")
async def shutdown_event():
    """应用关闭事件"""
    logger.info(f"Shutting down {settings.app_name}")


@app.get("/", 
         summary="根端点",
         description="服务基本信息")
async def root():
    """根端点 - 返回服务基本信息"""
    return {
        "service": settings.app_name,
        "version": settings.version,
        "status": "running",
        "description": "GeoAI-powered GVI calculation service",
        "endpoints": {
            "health": "/api/v1/health",
            "calculate_gvi": "/api/v1/calculate_gvi",
            "calculate_single_gvi": "/api/v1/calculate_single_gvi",
            "model_info": "/api/v1/model_info",
            "supported_features": "/api/v1/supported_features"
        }
    }


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    """404错误处理器"""
    return JSONResponse(
        status_code=404,
        content={
            "error": "Not Found", 
            "detail": f"Path {request.url.path} not found",
            "available_endpoints": [
                "/",
                "/api/v1/health", 
                "/api/v1/calculate_gvi",
                "/api/v1/calculate_single_gvi",
                "/api/v1/model_info",
                "/api/v1/supported_features"
            ]
        }
    )


@app.exception_handler(500)
async def internal_server_error_handler(request: Request, exc):
    """500错误处理器"""
    logger.error(f"Internal server error: {exc}")
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal Server Error",
            "detail": "An unexpected error occurred. Please check the logs for more details."
        }
    )


if __name__ == "__main__":
    import uvicorn
    
    # 开发环境运行
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.debug,
        log_level=settings.log_level.lower()
    )