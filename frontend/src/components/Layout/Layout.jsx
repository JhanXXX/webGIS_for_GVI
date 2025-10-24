import React, { useState } from 'react';
import { 
  MapIcon, 
  ClockIcon, 
  PencilSquareIcon,
  Bars3Icon,
  XMarkIcon 
} from '@heroicons/react/24/outline';
import './Layout.css';
import { api } from '../services/api';



const Layout = ({ 
  children, 
  systemStatus, 
  availableMonths, 
  currentMonth, 
  onMonthChange,
  routes = [],
  selectedRoute = null,
  onRouteSelect 
}) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('map');

const tabs = [
  { id: 'map', name: 'Map View', icon: MapIcon },
  { id: 'timetravel', name: 'Time Traveler', icon: ClockIcon },
  { id: 'editor', name: 'Data Editor', icon: PencilSquareIcon },
];

  return (
    <div className="layout-container">
      {/* Header */}
      <header className="layout-header">
        <div className="header-content">
          {/* Left: Title + Toggle */}
          <div className="header-left">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="toggle-button"
              aria-label="Toggle sidebar"
            >
              {sidebarOpen ? (
                <XMarkIcon style={{ width: '28px', height: '28px' }} />
              ) : (
                <Bars3Icon style={{ width: '28px', height: '28px' }} />
              )}
            </button>
            <div className="header-title">
              <h1>GVI Routing Application</h1>
              <p>Stockholm Green Path Planner</p>
            </div>
          </div>
          
          {/* Middle: Month Selector */}
          <div className="month-selector">
            <label>Month:</label>
            <select
              value={currentMonth}
              onChange={(e) => onMonthChange(e.target.value)}
            >
              {availableMonths && availableMonths.length > 0 ? (
                availableMonths.map((month) => (
                  <option key={month} value={month}>
                    {month}
                  </option>
                ))
              ) : (
                <option value={currentMonth}>{currentMonth}</option>
              )}
            </select>
          </div>

          {/* Right: Status Indicator */}
          {systemStatus && (
            <div className="status-indicator">
              <div className="status-dot"></div>
              <span className="status-text">Connected</span>
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="layout-main">
        {/* Sidebar */}
        <aside className={`layout-sidebar ${!sidebarOpen ? 'sidebar-hidden' : ''}`}>
          {/* Tab Navigation */}
          <nav className="tab-nav">
            <div className="tab-list">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`tab-button ${activeTab === tab.id ? 'tab-button-active' : ''}`}
                  >
                    <Icon className="tab-icon" />
                    <span>{tab.name}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Tab Content */}
          <div className="tab-content">
            {activeTab === 'map' && (
              <div className="tab-panel">
                <h3>Map Controls</h3>
                <p>View and explore GVI data on the map.</p>


                <button
                  onClick={async () => {
                    if (window.confirm(`Update DGVI for ${currentMonth}?`)) {
                      try {
                        const result = await api.updateDGVI(currentMonth);
                        window.alert(`Success: ${result.statistics.successful}/${result.statistics.totalRoads} roads`);
                      } catch (error) {
                        window.alert('Failed: ' + error.message);
                      }
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '10px',
                    marginTop: '16px',
                    backgroundColor: '#0ea5e9',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '14px',
                    cursor: 'pointer'
                  }}
                >
                  Update DGVI for {currentMonth}
                </button>
              </div>
            )}

            {activeTab === 'timetravel' && (
              <div className="tab-panel">
                <h3>Time Traveler</h3>
                <p>Click on the map to set origin and destination.</p>
                
                {/* 路径规划控制 */}
                <div style={{ marginTop: '20px' }}>
                  <label style={{ display: 'block', fontWeight: '500', marginBottom: '8px', fontSize: '14px' }}>
                    Route Preference:
                  </label>
                  <select 
                    id="route-preference"
                    onChange={(e) => {
                      const hint = document.getElementById('preference-hint');
                      switch(e.target.value) {
                        case 'asap':
                          hint.textContent = 'Time weight: 1.0 Green weight: 0.0';
                          break;
                        case 'groot':
                          hint.textContent = 'Time weight: 0.0 Green weight: 1.0';
                          break;
                        case 'green-priority':
                          hint.textContent = 'Time weight: 0.3 Green weight: 0.7';
                          break;
                        case 'time-priority':
                          hint.textContent = 'Time weight: 0.7 Green weight: 0.3';
                          break;
                      }
                    }}
                    style={{ 
                      width: '100%', 
                      padding: '8px', 
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      fontSize: '14px',
                      marginBottom: '8px'
                    }}
                  >
                    <option value="asap">ASAP (Fastest)</option>
                    <option value="groot">GROOT</option>
                    <option value="green-priority">Green Priority</option>
                    <option value="time-priority">Time Priority</option>
                  </select>
                  
                  {/* 参数提示 */}
                  <div style={{
                    padding: '10px',
                    backgroundColor: '#f3f4f6',
                    borderRadius: '6px',
                    fontSize: '12px',
                    marginBottom: '12px'
                  }}>
                    <div id="preference-hint">
                      Time weight: 1.0, Green weight: 0.0
                    </div>
                  </div>

                  {/* 规划按钮 */}
                  <button
                    id="plan-route-btn"
                    onClick={() => {
                      if (window.triggerRoutePlanning) {
                        window.triggerRoutePlanning();
                      }
                    }}
                    style={{
                      width: '100%',
                      padding: '10px',
                      backgroundColor: '#059669',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '14px',
                      fontWeight: '500',
                      cursor: 'pointer'
                    }}
                  >
                    GoGoGo!
                  </button>
                </div>
                <div className="info-box info-box-blue" style={{ marginTop: '16px' }}>
                  <p>Current Month: <strong>{currentMonth}</strong></p>
                </div>


     {routes && routes.length > 0 && (  // 改用 props
    <div style={{ marginTop: '20px' }}>
      <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>
        Route Options ({routes.length})
      </h4>
      {routes.map((route, index) => (
        <div
          key={`${route.route_id}-${index}`}
          onClick={() => onRouteSelect?.(route)}  // 改用 props
          style={{
            padding: '12px',
            marginBottom: '8px',
            backgroundColor: selectedRoute?.route_id === route.route_id ? '#d1fae5' : '#f9fafb',  // 改用 props
            border: `2px solid ${selectedRoute?.route_id === route.route_id ? '#059669' : '#e5e7eb'}`,  // 改用 props
            borderRadius: '8px',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <div style={{ fontWeight: '600', fontSize: '13px', marginBottom: '4px' }}>
            Option {index + 1}: {route.route_type === 'walking' ? 'Walking' : 'Transit'}
          </div>
          <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px' }}>
            Duration: {Math.round(route.total_duration / 60)} min
          </div>
          
          <div style={{ fontSize: '11px', color: '#374151' }}>
            {route.instructions && route.instructions.length > 0 ? (
              route.instructions.map((instruction, i) => (
                <div key={i} style={{ marginBottom: '2px' }}>
                  • {instruction}
                </div>
              ))
            ) : (
              <div style={{ color: '#9ca3af', fontStyle: 'italic' }}>
                No route details
              </div>
              )}
          </div>
        </div> 
        ))}
        </div> 
    )}
        </div> 
    )}

      {activeTab === 'editor' && (
        <div className="tab-panel">
          <h3>Data Editor</h3>
          <p>Click on map to draw a line segment, then generate GVI sampling points.</p>
          
          <div className="info-box info-box-blue" style={{ marginTop: '16px' }}>
            <p>Current Month: <strong>{currentMonth}</strong></p>
          </div>
          
          {/* 点数输入 */}
          <div style={{ marginTop: '16px' }}>
            <label style={{ 
              display: 'block', 
              fontWeight: '500', 
              marginBottom: '8px', 
              fontSize: '14px' 
            }}>
              Number of Points (1-20):
            </label>
            <input
              id="point-count-input"
              type="number"
              min="1"
              max="20"
              defaultValue="5"
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px'
              }}
            />
          </div>
          
          {/* 生成按钮 */}
          <button
            id="generate-points-btn"
            onClick={() => {
              if (window.triggerGenerateGVIPoints) {
                window.triggerGenerateGVIPoints();
              }
            }}
            style={{
              width: '100%',
              padding: '10px',
              marginTop: '12px',
              backgroundColor: '#f59e0b',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer'
            }}
          >
            Generate GVI Points
          </button>
          
          <div className="info-box info-box-yellow" style={{ marginTop: '16px' }}>
            <p>
              <strong>Note:</strong> Draw only ONE line segment. 
              Points will be distributed evenly along the line.
            </p>
          </div>
        </div>
      )}
          </div>
        </aside>

        {/* Main Content (Map) */}
        <main className="layout-content">
          {children ? React.cloneElement(children, { sidebarOpen, activeTab }) :  (
            <div className="content-placeholder">
              <p>Map will be displayed here</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default Layout;