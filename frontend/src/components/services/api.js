import axios from 'axios';
import { API_BASE_URL, API_VERSION } from '../../utils/constants';
import toast from 'react-hot-toast';

// 创建axios实例
const apiClient = axios.create({
  baseURL: `${API_BASE_URL}${API_VERSION}`,
  timeout: 120000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 请求拦截器
apiClient.interceptors.request.use(
  (config) => {
    // 可以在这里添加token等
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
apiClient.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    // 统一错误处理
    const message = error.response?.data?.error || error.message || 'An error occurred';
    console.error('API Error:', message);
    toast.error(message);
    return Promise.reject(error);
  }
);

// API服务对象
export const api = {
  // 健康检查
  health: () => apiClient.get('/health'),

  // 系统状态
  status: () => apiClient.get('/status'),

  // 获取可用月份
  getAvailableMonths: () => apiClient.get('/available-months'),

  // 获取DGVI统计
  getDGVIStats: (month) => apiClient.get(`/dgvi-stats/${month}`),

  // 查找附近站点
  findNearbySites: (lat, lon, maxDistance = 1000) => 
    apiClient.get('/nearby-sites', { 
      params: { lat, lon, max_distance: maxDistance } 
    }),

  // 路径规划
  planRoutes: (data) => apiClient.post('/plan-routes', data),

  // 计算DGVI
  calculateDGVI: (data) => apiClient.post('/calculate-dgvi', data),

  // 数据预处理（管理功能）
  preprocessData: (data) => apiClient.post('/preprocess-data', data),

  // 获取GVI点数据

  getGVIPoints: (month) => 
    apiClient.get(`/gvi-points/${month}`),
  
  // 添加 GVI 点
  addGVIPoints: (data) => apiClient.post('/add-gvi-points', data),

  // update DGVI

  updateDGVI: async (month) => {
    const response = await fetch(`${API_BASE_URL}/api/v1/update-dgvi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response.json();
  }

};

export default apiClient;