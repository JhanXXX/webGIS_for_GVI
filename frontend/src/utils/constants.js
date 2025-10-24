// API配置
export const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';
export const API_VERSION = '/api/v1';

// Mapbox配置
export const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_TOKEN;
export const MAP_STYLE = 'mapbox://styles/mapbox/streets-v12';

// 地图默认设置
export const DEFAULT_MAP_CENTER = {
  lat: parseFloat(process.env.REACT_APP_DEFAULT_LAT) || 59.3293,
  lng: parseFloat(process.env.REACT_APP_DEFAULT_LNG) || 18.0686,
};

export const DEFAULT_MAP_ZOOM = parseFloat(process.env.REACT_APP_DEFAULT_ZOOM) || 11;

// Stockholm边界（用于限制地图范围）
export const STOCKHOLM_BOUNDS = [
  [17.8, 59.2], // Southwest coordinates
  [18.3, 59.5], // Northeast coordinates
];

export const MAP_CONFIG = {
  minZoom: 9,
  maxZoom: 18,
  maxPitch: 60,
  maxBearing: 360,
  attributionControl: true,
  logoPosition: 'bottom-left'
};

// Application Settings
export const APP_CONFIG = {
  healthCheckInterval: 30000, // 30 seconds
  maxRouteResults: 4,
  defaultPreferences: {
    time: 0.5,
    green: 0.5
  }
};




// 路径偏好选项
export const ROUTE_PREFERENCES = {
  ASAP: { time: 1.0, green: 0.0, label: 'ASAP' },
  GROOT: { time: 0.0, green: 1.0, label: 'GROOT!' },
  GREEN_PRIORITY: { time: 0.3, green: 0.7, label: 'Green > Duration' },
  DURATION_PRIORITY: { time: 0.7, green: 0.3, label: 'Duration > Green' },
};

// 图层类型
export const LAYER_TYPES = {
  GVI_POINTS: 'gvi-points',
  DGVI_VISUALIZATION: 'dgvi-visualization',
  BUS_STOPS: 'bus-stops',
  ROUTES: 'routes',
};

// GVI Data Settings
export const GVI_CONFIG = {
  defaultMonth: '2025-08',
  maxSamplingPoints: 20,
  walkingSpeed: 1.4, // meters per second
  busWaitingMargin: 90, // seconds
  transferMargin: 90 // seconds
};

// Layer Colors (for map visualization)
export const LAYER_COLORS = {
  gviSuper: '#089800',
  gviHigh: '#5c8902',
  gviFine: '#88ad2a',      
  gviMedium: '#b0b752',    
  gviLow: '#c8c190',       
  walkingRoute: '#dca80c', 
  busRoute: '#145f92',     
  busStop: '#581616'       
};

// Responsive Breakpoints (matching Tailwind)
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536
};

// API Endpoints
export const API_ENDPOINTS = {
  status: '/api/v1/status',
  health: '/api/v1/health',
  availableMonths: '/api/v1/available-months',
  planRoutes: '/api/v1/plan-routes',
  nearbySites: '/api/v1/nearby-sites',
  dgviStats: '/api/v1/dgvi-stats',
  calculateDgvi: '/api/v1/calculate-dgvi',
  preprocessData: '/api/v1/preprocess-data'
};

// Error Messages
export const ERROR_MESSAGES = {
  connectionFailed: 'Failed to connect to the server. Please check your connection.',
  invalidCoordinates: 'Invalid coordinates provided.',
  noDataAvailable: 'No data available for the selected period.',
  routePlanningFailed: 'Route planning failed. Please try again.',
  mapLoadFailed: 'Failed to load the map. Please check your Mapbox token.'
};

// Success Messages
export const SUCCESS_MESSAGES = {
  routeCalculated: 'Route successfully calculated!',
  dataUpdated: 'Data successfully updated!',
  pointsAdded: 'New points successfully added!'
};
