"""
CNN模型定义 - 基于训练时的original模型架构
"""
import torch
import torch.nn as nn
import torch.nn.functional as F
from typing import Tuple


class OriginalGVICNN(nn.Module):
    def __init__(self, input_channels=8, input_size=4, dropout_rate=0.3,
                 conv_channels=(8,16,32), fc_sizes=(64,16)):
        super().__init__()

        self.input_channels = input_channels 
        self.input_size = input_size 
        self.dropout_rate = dropout_rate

        self.feature_extractor = nn.Sequential(
            nn.Conv2d(input_channels, conv_channels[0], kernel_size=3, padding=1),
            nn.BatchNorm2d(conv_channels[0]),
            nn.ReLU(inplace=True),
            nn.Dropout2d(0.1),  # 添加2D dropout
            
            # 第二层
            nn.Conv2d(conv_channels[0], conv_channels[1], kernel_size=3, padding=1),
            nn.BatchNorm2d(conv_channels[1]),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Dropout2d(0.15),
            
            # 第三层
            nn.Conv2d(conv_channels[1], conv_channels[2], kernel_size=3, padding=1),
            nn.BatchNorm2d(conv_channels[2]),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Dropout2d(0.2),
        )
        # Calculate adaptive pooling size based on input size
        pool_size = max(input_size // 4, 4)
        self.adaptive_pool = nn.AdaptiveAvgPool2d((pool_size, pool_size))
        
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Dropout(dropout_rate),
            nn.Linear(conv_channels[2] * pool_size * pool_size, fc_sizes[0]),
            nn.BatchNorm1d(fc_sizes[0]),  # 添加BN
            nn.ReLU(inplace=True),
            nn.Dropout(dropout_rate * 0.6),
            nn.Linear(fc_sizes[0], fc_sizes[1]),
            nn.BatchNorm1d(fc_sizes[1]),  # 添加BN
            nn.ReLU(inplace=True),
            nn.Dropout(dropout_rate * 0.3),
            nn.Linear(fc_sizes[1], 1),
            nn.Sigmoid()
        )
    
    def forward(self,x):
        x = self.feature_extractor(x)
        x = self.adaptive_pool(x)
        x = self.classifier(x)
        return x

    
    def get_param_count(self) -> int:
        """获取模型参数数量"""
        return sum(p.numel() for p in self.parameters() if p.requires_grad)
    
    def get_model_info(self) -> dict:
        """获取模型信息"""
        return {
            "model_type": "OriginalGVICNN",
            "input_channels": self.input_channels,
            "input_size": self.input_size,
            "dropout_rate": self.dropout_rate,
            "total_params": self.get_param_count(),
            "input_shape": f"({self.input_channels}, {self.input_size}, {self.input_size})",
            "output_shape": "(1,)"
        }


class ModelFactory:
    """
    模型工厂类 - 负责创建和加载模型
    """
    
    @staticmethod
    

    def create_model(input_channels: int = 8, 
                    input_size: int = 4,
                    **kwargs) -> OriginalGVICNN:
        """
        创建原始GVI CNN模型
        
        Args:
            input_channels: 输入通道数
            input_size: 输入空间尺寸
            **kwargs: 其他参数
            
        Returns:
            初始化的模型
        """

        return OriginalGVICNN(
            input_channels=input_channels,
            input_size=input_size,
            **kwargs
        )
    


    
    @staticmethod
    def load_trained_model(model_path: str, 
                          device: torch.device = None) -> OriginalGVICNN:
        """
        加载训练好的模型
        
        Args:
            model_path: 模型权重文件路径
            device: 运行设备
            
        Returns:
            加载权重的模型
        """
        if device is None:
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # 创建模型实例 (使用固定配置)
        model = ModelFactory.create_model(
            input_channels=8,
            input_size=4,
            dropout_rate=0.3
        )
        
        # 加载权重
        checkpoint = torch.load(model_path, map_location=device)
        
        # 从checkpoint中获取模型状态字典
        if 'model_state_dict' in checkpoint:
            model.load_state_dict(checkpoint['model_state_dict'])
        else:
            # 如果checkpoint就是状态字典
            model.load_state_dict(checkpoint)
        
        model.to(device)
        model.eval()
        
        return model