"""
GVI计算核心服务
整合卫星数据获取和模型推理
"""
import torch
import numpy as np
import logging
import time
from typing import List, Dict, Tuple, Optional
from pathlib import Path

from .sentinel_service import SentinelService
from ..models.gvi_model import ModelFactory
from ..api.schemas import CoordinatePoint, GVIResult


class GVICalculator:
    """GVI计算核心服务类"""
    
    def __init__(self, model_path: str):
        """
        初始化GVI计算器
        
        Args:
            model_path: 预训练模型路径
        """
        torch.backends.mkldnn.enabled = False
        self.logger = logging.getLogger(__name__)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # 初始化卫星数据服务
        self.sentinel_service = SentinelService()
        
        # 加载模型
        self.model = None
        self.model_loaded = False
        self._load_model(model_path)
        
        self.logger.info(f"GVI Calculator initialized on {self.device}")
        self.logger.info(f"Model loaded: {self.model_loaded}")
    
    def _load_model(self, model_path: str):
        """加载预训练模型"""
        try:
            model_file = Path(model_path)
            if not model_file.exists():
                raise FileNotFoundError(f"Model file not found: {model_path}")
            
            self.model = ModelFactory.load_trained_model(model_path, self.device)
            self.model_loaded = True
            
            model_info = self.model.get_model_info()
            self.logger.info(f"Model loaded successfully: {model_info}")
            
        except Exception as e:
            self.logger.error(f"Failed to load model: {e}")
            self.model_loaded = False
            raise
    
    def calculate_batch_gvi(self, points: List[CoordinatePoint], month: str) -> List[GVIResult]:
        """
        批量计算GVI值
        
        Args:
            points: 坐标点列表
            month: 月份字符串 "YYYY-MM"
            
        Returns:
            GVI计算结果列表
        """
        if not self.model_loaded:
            raise RuntimeError("Model is not loaded")
        
        start_time = time.time()
        results = []
        
        # 准备批量数据
        valid_features = []
        valid_indices = []
        
        self.logger.info(f"Starting batch GVI calculation for {len(points)} points in {month}")
        
        # 第一阶段：获取所有点的卫星特征
        for i, point in enumerate(points):
            try:
                features = self.sentinel_service.calculate_gvi_features(
                    point.lat, point.lon, month
                )
                
                if features is not None:
                    # 验证特征数据质量
                    if self._validate_features(features):
                        valid_features.append(features)
                        valid_indices.append(i)
                    else:
                        self.logger.debug(f"Invalid features for point {i}: ({point.lat:.6f}, {point.lon:.6f})")
                        results.append(GVIResult(
                            lat=point.lat,
                            lon=point.lon,
                            success=False,
                            error="invalid_features"
                        ))
                else:
                    self.logger.debug(f"No features for point {i}: ({point.lat:.6f}, {point.lon:.6f})")
                    results.append(GVIResult(
                        lat=point.lat,
                        lon=point.lon,
                        success=False,
                        error="no_satellite_data"
                    ))
                    
            except Exception as e:
                self.logger.error(f"Error processing point {i}: {e}")
                results.append(GVIResult(
                    lat=point.lat,
                    lon=point.lon,
                    success=False,
                    error=f"processing_error: {str(e)}"
                ))
        self.logger.info(f"This batch feature collection finished")
        
        # 第二阶段：批量模型推理
        if valid_features:
            try:
                gvi_predictions = self._batch_model_inference(valid_features)
                
                # 将预测结果插回到对应位置
                pred_idx = 0
                for i, point in enumerate(points):
                    if i in valid_indices:
                        gvi_value = gvi_predictions[pred_idx]
                        confidence = 1 # 预留api
                        
                        results.insert(i, GVIResult(
                            lat=point.lat,
                            lon=point.lon,
                            gvi=float(gvi_value),
                            success=True,
                            confidence=float(confidence)
                        ))
                        pred_idx += 1
                        
            except Exception as e:
                self.logger.error(f"Batch inference failed: {e}")
                # 标记所有有效特征的点为失败
                for i in valid_indices:
                    point = points[i]
                    results.insert(i, GVIResult(
                        lat=point.lat,
                        lon=point.lon,
                        success=False,
                        error="model_inference_failed"
                    ))
        
        processing_time = time.time() - start_time
        successful_count = sum(1 for r in results if r.success)
        
        self.logger.info(f"Batch calculation completed: {successful_count}/{len(points)} successful, "
                        f"processing time: {processing_time:.2f}s")
        
        return results
    
    def _validate_features(self, features: np.ndarray) -> bool:
        """
        验证特征数据质量
        
        Args:
            features: 特征数组 (8, 4, 4)
            
        Returns:
            是否有效
        """
        if features.shape != (8, 4, 4):
            return False
        
        # 检查是否有NaN值
        nan_count = np.isnan(features).sum()
        if nan_count > 0:  # intolerate towards nan values (median method is already making compensations)
            return False
        
        # 检查是否有合理的数值范围
        # valid_features = features[~np.isnan(features)]
        #if len(valid_features) == 0:
        #    return False
        
        # 基本范围检查 (大部分植被指数在-1到1之间)
        # if np.any(np.abs(valid_features) > 5):  # 排除极端异常值
        #    return False
        
        return True
    
    def _batch_model_inference(self, features_list: List[np.ndarray]) -> List[float]:
        """
        批量模型推理
        
        Args:
            features_list: 特征列表
            
        Returns:
            GVI预测值列表
        """
        if not features_list:
            return []
        
        # 准备批量输入
        batch_features = np.stack(features_list, axis=0)  # (batch_size, 8, 4, 4)
        
        # 处理NaN值 - 用0填充
        # batch_features = np.nan_to_num(batch_features, nan=0.0)
        
        # 转换为torch张量
        input_tensor = torch.from_numpy(batch_features).float().to(self.device)
        
        # 模型推理
        with torch.no_grad():
            self.model.eval()
            predictions = self.model(input_tensor)
            
            # 转换为CPU numpy数组
            predictions = predictions.cpu().numpy().flatten()
        
        return predictions.tolist()
    
    """def _calculate_confidence(self, features: np.ndarray) -> float:
        
        # 基于数据完整性计算置信度
        nan_ratio = np.isnan(features).sum() / features.size
        data_completeness = 1.0 - nan_ratio
        
        # 基于特征值的合理性
        valid_features = features[~np.isnan(features)]
        if len(valid_features) == 0:
            return 0.0
        
        # 检查值的分布是否合理
        feature_std = np.std(valid_features)
        stability_score = min(1.0, 1.0 / (1.0 + feature_std * 2))
        
        # 综合置信度
        confidence = (data_completeness * 0.7 + stability_score * 0.3)
        
        return max(0.1, min(0.99, confidence))  # 限制在0.1-0.99之间"""
    
    def get_model_status(self) -> Dict:
        """获取模型状态信息"""
        status = {
            "model_loaded": self.model_loaded,
            "device": str(self.device),
            "model_info": None
        }
        
        if self.model_loaded and self.model:
            status["model_info"] = self.model.get_model_info()
        
        return status
    
    def calculate_single_gvi(self, lat: float, lon: float, month: str) -> GVIResult:
        """
        计算单点GVI (便捷方法)
        
        Args:
            lat: 纬度
            lon: 经度  
            month: 月份
            
        Returns:
            GVI计算结果
        """
        point = CoordinatePoint(lat=lat, lon=lon)
        results = self.calculate_batch_gvi([point], month)
        return results[0]