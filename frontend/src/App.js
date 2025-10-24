import React, { useState, useEffect } from 'react';
import { api } from './components/services/api';
import Layout from './components/Layout/Layout';
import MapContainer from './components/Map/MapContainer';
import toast from 'react-hot-toast';
import './App.css';

function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [systemStatus, setSystemStatus] = useState(null);
  const [availableMonths, setAvailableMonths] = useState([]);
  const [currentMonth, setCurrentMonth] = useState('2025-08');
  const [routes, setRoutes] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);



  const handleRoutesUpdate = (newRoutes) => {
    setRoutes(newRoutes);
    if (newRoutes.length > 0) {
      setSelectedRoute(newRoutes[0]);
    }
  };

  const handleRouteSelect = (route) => {
    if (route) {
      setSelectedRoute(route);
    } else {
      setSelectedRoute(null); 
    }
  };


  // 初始化应用
  useEffect(() => {
    const initializeApp = async () => {
      try {
        setIsLoading(true);

        // 检查后端健康状态
        const healthResponse = await api.health();
        console.log('Backend health:', healthResponse);

        // 获取系统状态
        const statusResponse = await api.status();
        setSystemStatus(statusResponse);
        console.log('System status:', statusResponse);

        // 获取可用月份
        const monthsResponse = await api.getAvailableMonths();
        setAvailableMonths(monthsResponse.available_months || []);
        
        // 设置推荐月份或默认月份
        if (monthsResponse.recommended_month) {
          setCurrentMonth(monthsResponse.recommended_month);
        }

        toast.success('Application initialized successfully');
      } catch (error) {
        console.error('Failed to initialize app:', error);
        toast.error('Failed to connect to backend. Please check if services are running.');
      } finally {
        setIsLoading(false);
      }
    };

    initializeApp();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-600 mx-auto mb-4"></div>
          <p className="text-gray-600 text-lg">Loading GVI Application...</p>
        </div>
      </div>
    );
  }

  return (
    <Layout 
      systemStatus={systemStatus}
      availableMonths={availableMonths}
      currentMonth={currentMonth}
      onMonthChange={setCurrentMonth}
      routes={routes}                    
      selectedRoute={selectedRoute}
      onRoutesUpdate={handleRoutesUpdate}
      onRouteSelect={handleRouteSelect}
    >
      <MapContainer 
        currentMonth={currentMonth} 
        routes={routes}
        selectedRoute={selectedRoute}
        onRoutesUpdate={handleRoutesUpdate}
        onRouteSelect={handleRouteSelect}
      />
    </Layout>
  );
}

export default App;