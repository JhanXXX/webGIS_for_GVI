import React, { useRef, useEffect, useState } from 'react';
import Map, { 
  NavigationControl, 
  ScaleControl, 
  Source, 
  Layer 
} from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './MapContainer.css'; 
import { api } from '../services/api';
import {
  MAPBOX_TOKEN,
  MAP_STYLE,
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  STOCKHOLM_BOUNDS,
  LAYER_COLORS,
} from '../../utils/constants';


const MapContainer = ({ 
  currentMonth, 
  sidebarOpen, 
  activeTab,
  routes = [],           
  selectedRoute = null,  
  onRoutesUpdate,        
  onRouteSelect         
}) => {
    const mapRef = useRef(null);
    const [viewState, setViewState] = useState({
      longitude: DEFAULT_MAP_CENTER.lng,
      latitude: DEFAULT_MAP_CENTER.lat,
      zoom: DEFAULT_MAP_ZOOM,
    });
    const [mapLoaded, setMapLoaded] = useState(false);
    const [gviData, setGviData] = useState(null);
    const [gviLoading, setGviLoading] = useState(false);

    const [routeOrigin, setRouteOrigin] = useState(null);
    const [routeDestination, setRouteDestination] = useState(null);
    const [routePlanning, setRoutePlanning] = useState(false);
    const [gviGenerating, setGviGenerating] = useState(false);
    const [clickedCoordInfo, setClickedCoordInfo] = useState(null); // For Map View
    const [drawingPoints, setDrawingPoints] = useState([]); // For Data Editor
    const [hoveredStop, setHoveredStop] = useState(null);


    const [layerSettings, setLayerSettings] = useState({
      showPoints: true,
      showHeatmap: false,
      heatmapOpacity: 0.7,
      showContour: false,
      contourOpacity: 0.7,
    });


/**
 * Generate uniformly distributed points on a line segment
 */
const generatePointsOnLine = (start, end, count) => {
  if (count < 2) return [start];
  
  const points = [];
  for (let i = 0; i < count; i++) {
    const ratio = i / (count - 1);
    points.push({
      lat: start.lat + (end.lat - start.lat) * ratio,
      lon: start.lon + (end.lon - start.lon) * ratio
    });
  }
  return points;
};

  /**
   * Trigger GVI point generation
   */
  const triggerGenerateGVIPoints = async () => {
    if (drawingPoints.length !== 2) {
      window.alert('Please draw a line segment first (click 2 points on the map)');
      return;
    }
    
    const input = document.getElementById('point-count-input');
    const count = parseInt(input?.value || '5');
    
    if (count < 1 || count > 20) {
      window.alert('Number of points must be between 1 and 20');
      return;
    }
    
    if (!window.confirm(`Generate ${count} GVI points for month ${currentMonth}?`)) {
      return;
    }
    
    try {
      // Generate uniformly distributed points
      setGviGenerating(true);
      const points = generatePointsOnLine(drawingPoints[0], drawingPoints[1], count);
      
      console.log('Generated points:', points);
      
      // call API
      const response = await api.addGVIPoints({
        points: points,
        month: currentMonth
      });
      
      if (response.success) {
        window.alert(
          `Success!\n` +
          `Calculated: ${response.statistics.calculated}\n` +
          `Inserted: ${response.statistics.inserted}\n` +
          `Failed: ${response.statistics.failed}\n` +
          `Processing time: ${response.processing_time.toFixed(2)}s`
        );
        
        // Clear the drawn line segments
        setDrawingPoints([]);
        
        // Reload GVI data
        loadGVIPoints(currentMonth);
      }
    } catch (error) {
      console.error('Failed to generate GVI points:', error);
      window.alert('Failed to generate GVI points: ' + error.message);
    }finally {
    setGviGenerating(false);
  }
};


    useEffect(() => {
      console.log('Current month changed:', currentMonth);
      if (mapLoaded && currentMonth) {
        loadGVIPoints(currentMonth);
      }
    }, [currentMonth, mapLoaded]);

    useEffect(() => {
        if (!mapLoaded) return;

      const handleResize = () => {
        if (mapRef.current) {
          const map = mapRef.current.getMap();
          if (map) {
            map.resize();
          }
        }
      };

    // Monitoring changes in window size
    window.addEventListener('resize', handleResize);
    const timer = setTimeout(handleResize, 350);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timer);
    };
  }, [mapLoaded]);

  const handleMapContextMenu = (event) => {
  const { lngLat } = event;
  
  console.log('Right click at:', { lat: lngLat.lat, lng: lngLat.lng });
  console.log('Clearing data for tab:', activeTab);
  
  // Clear different content based on different tabs
  switch (activeTab) {
    case 'map':
      // Map View Mode - Clear Map Markers or Info Boxes
      clearMapViewData();
      break;
      
    case 'timetravel':
      // Time Traveler Mode - Clear path planning-related data
      clearRoutePlanningData();
      break;
      
    case 'editor':
      // Data Editor Mode - Clear Edited Line Segments
      clearDataEditorData();
      break;
      
    default:
      console.log('Unknown tab mode');
  }
};


  const handleMapLoad = () => {
    console.log('Map loaded successfully');
    setMapLoaded(true);
    const map = mapRef.current?.getMap();
    if (map) {
      console.log('Map instance:', map);
    }
  };

  const loadGVIPoints = async (month) => {
    if (!month) return;
    
    setGviLoading(true);
    try {
      console.log('Loading GVI points for month:', month);
      const response = await api.getGVIPoints(month);
      
      if (response.success && response.data) {
        setGviData(response.data);
        console.log('GVI points loaded:', response.point_count);
      }
    } catch (error) {
      console.error('Failed to load GVI points:', error);
    } finally {
      setGviLoading(false);
    }
  };

  const planRoute = async (preferences = { time: 0.5, green: 0.5 }) => {
    if (!routeOrigin || !routeDestination) {
      console.error('Origin and destination are required');
      return;
    }
  
  setRoutePlanning(true);
  try {
    console.log('Planning route...', {
      origin: routeOrigin,
      destination: routeDestination,
      preferences
    });
    
    const response = await api.planRoutes({
      origin: routeOrigin,
      destination: routeDestination,
      preferences: preferences,
      gvi_month: currentMonth,
      max_results: 3
    });
    
    if (response.success && response.results) {
      const newRoutes = response.results.routes;
      console.log('=== Routes Comparison ===');
      newRoutes.forEach((route, i) => {
        console.log(`Route ${i}:`, {
          id: route.route_id,
          type: route.route_type,
          duration: route.total_duration,
          durationMin: Math.round(route.total_duration / 60),
          totalScore: route.total_score,
          durationScore: route.duration_score,
          acDGVIScore: route.acdgvi_score,
          instructions: route.instructions?.length
        });
      });

      if (onRoutesUpdate) {
        onRoutesUpdate(newRoutes);
      }
      if (onRouteSelect && newRoutes.length > 0) {
        onRouteSelect(newRoutes[0]);
      }
    }
  } catch (error) {
    console.error('Route planning failed:', error);
  } finally {
    setRoutePlanning(false);
  }
};


  const handleMapClick = (event) => {
    const { lngLat } = event;
    const coords = { lat: lngLat.lat, lon: lngLat.lng };
    
    console.log('Map clicked:', coords);
    // Perform different actions based on the selected tab
    switch (activeTab) {
      case 'map':
        // Map View - show coordinates
        handleMapViewClick(coords);
        break;
        
      case 'timetravel':
        // Time Traveler - path routing
        handleRoutePlanningClick(coords);
        break;
        
      case 'editor':
        // Data Editor - draw lines
        handleDataEditorClick(coords);
        break;
        
      default:
        console.log('Unknown tab mode');
    }
  };


const handleMapViewClick = (coords) => {
  console.log('Show info for:', coords);
  setClickedCoordInfo(coords);
};


const handleRoutePlanningClick = (coords) => {
  if (!routeOrigin) {
    setRouteOrigin(coords);
    console.log('Origin set:', coords);
  } else if (!routeDestination) {
    setRouteDestination(coords);
    console.log('Destination set:', coords);
  } else {
    setRouteOrigin(coords);
    setRouteDestination(null);
    if (onRoutesUpdate) onRoutesUpdate([]);
    if (onRouteSelect) onRouteSelect(null);
    console.log('Reset - new origin:', coords);
  }
};


const handleDataEditorClick = (coords) => {
  console.log('Add point to line:', coords);
  if (drawingPoints.length >= 2) {
    
    setDrawingPoints([coords]);
  } else {
    setDrawingPoints(prev => [...prev, coords]);
  }
};


const clearMapViewData = () => {
  console.log('Clearing Map View data');
  setClickedCoordInfo(null);
};


const clearRoutePlanningData = () => {
  console.log('Clearing route planning data');
  setRouteOrigin(null);
  setRouteDestination(null);
  if (onRoutesUpdate) onRoutesUpdate([]);
  if (onRouteSelect) onRouteSelect(null);
};


const clearDataEditorData = () => {
  console.log('Clearing Data Editor data');
  setDrawingPoints([]);
};



useEffect(() => {
  window.triggerRoutePlanning = () => {
    const select = document.getElementById('route-preference');
    const preferenceMap = {
      'asap': { time: 1.0, green: 0.0 },
      'groot': { time: 0.0, green: 1.0 },
      'green-priority': { time: 0.3, green: 0.7 },
      'time-priority': { time: 0.7, green: 0.3 }
    };
    const preferences = preferenceMap[select?.value] || { time: 0.5, green: 0.5 };
    planRoute(preferences);
    };
  window.triggerGenerateGVIPoints = triggerGenerateGVIPoints;

  }, [routeOrigin, routeDestination, currentMonth, routes, selectedRoute, drawingPoints]);



  return (
    <div className="map-container">
      <Map
        ref={mapRef}
        {...viewState}
        onMove={(evt) => setViewState(evt.viewState)}
        onLoad={handleMapLoad}
        onClick={handleMapClick}
        onContextMenu={handleMapContextMenu}
        onMouseMove={(e) => {
          if (activeTab !== 'timetravel' || !routes || routes.length === 0) return;
          
          const map = e.target;
          
          // Build the ID for all site layers
          const stopLayerIds = routes.map((r, i) => `route-stops-${r.route_id}-${i}`);
          
          // Filter out existing layers
          const existingLayers = stopLayerIds.filter(id => map.getLayer(id));
          
          if (existingLayers.length === 0) return;
          
          const features = map.queryRenderedFeatures(e.point, {
            layers: existingLayers
          });
          
          if (features.length > 0) {
            setHoveredStop({
              name: features[0].properties.name,
              lineInfo: features[0].properties.lineInfo,
              x: e.point.x,
              y: e.point.y
            });
          } else {
            setHoveredStop(null);
          }
        }}
        mapStyle={MAP_STYLE}
        mapboxAccessToken={MAPBOX_TOKEN}
        maxBounds={STOCKHOLM_BOUNDS}
        style={{ width: '100%', height: '100%' }}
        attributionControl={true}
      >
        <NavigationControl 
          position="top-right" 
          showCompass={true}
          showZoom={true}
        />
        
        <ScaleControl 
          position="bottom-right"
          maxWidth={100}
          unit="metric"
        />

      {hoveredStop && (
        <div style={{
          position: 'absolute',
          left: hoveredStop.x + 10,
          top: hoveredStop.y + 10,
          backgroundColor: 'white',
          padding: '8px 12px',
          borderRadius: '6px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          pointerEvents: 'none',
          zIndex: 1000,
          fontSize: '12px'
        }}>
          <div style={{ fontWeight: '600' }}>{hoveredStop.name}</div>
          {hoveredStop.lineInfo && (
            <div style={{ color: '#6b7280' }}>{hoveredStop.lineInfo}</div>
          )}
        </div>
      )}

      {gviData && (
        <Source
          id="gvi-points"
          type="geojson"
          data={gviData}
        >

            {/* 热力图图层 */}
            {layerSettings.showHeatmap && (
              <Layer
                id="gvi-heatmap-layer"
                type="heatmap"
                paint={{
                  // 热力图权重，基于 GVI 值
                  'heatmap-weight': [
                    'interpolate',
                    ['linear'],
                    ['get', 'gvi'],
                    0, 0,
                    1, 1
                  ],
                  // 热力图强度，随缩放级别变化
                  'heatmap-intensity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0, 1,
                    15, 3
                  ],
                  // 热力图颜色渐变
                  'heatmap-color': [
                    'interpolate',
                    ['linear'],
                    ['heatmap-density'],
                      0, 'rgba(33,102,172,0)',
                      0.2, 'rgb(103,169,207)',
                      0.4, 'rgb(209,229,240)',
                      0.6, 'rgb(253,219,199)',
                      0.8, 'rgb(239,138,98)',
                      1, 'rgb(178,24,43)'
                  ],
                  // 热力图半径
                  'heatmap-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0, 2,
                    15, 20
                  ],
                  // 热力图透明度
                  'heatmap-opacity': layerSettings.heatmapOpacity
                }}
              />
            )}


          {/* 等值线图层 */}
          {layerSettings.showContour && (
              <Layer
                id="gvi-contour-layer"
                type="heatmap"
                paint={{
                  'heatmap-weight': [
                    'interpolate',
                    ['linear'],
                    ['get', 'gvi'],
                    0, 0,
                    1, 1
                  ],
                  'heatmap-intensity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0, 0.8,
                    15, 1.5
                  ],
                  'heatmap-color': [
                    'interpolate',
                    ['linear'],
                    ['heatmap-density'],
                      0.0, 'rgba(255,255,255,0)',   // 完全透明
                      0.2, '#c8c190',               // gviLow（黄灰）
                      0.4, '#b0b752',               // gviMedium（浅绿）
                      0.6, '#88ad2a',               // gviFine（亮绿）
                      0.8, '#5c8902',               // gviHigh（深绿）
                      1.0, '#089800'                // gviSuper（鲜绿）
                  ],
                  'heatmap-radius': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0, 8,
                    10, 15,
                    15, 30,
                    18, 50
                  ],
                  'heatmap-opacity': layerSettings.contourOpacity
                }}
              />
          )}




            
        {/* 点图层 */}
        {layerSettings.showPoints && (
          <Layer
            id="gvi-points-layer"
            type="circle"
            paint={{
              'circle-radius': 4,
              'circle-color': [
                'step',
                ['get', 'gvi'],
                LAYER_COLORS.gviLow,   
                0.05, LAYER_COLORS.gviMedium,  
                0.1, LAYER_COLORS.gviFine,
                0.15, LAYER_COLORS.gviHigh,
                0.3, LAYER_COLORS.gviSuper    
              ],
              'circle-opacity': 0.7,
              'circle-stroke-width': 1,
              'circle-stroke-color': '#ffffff'
            }}
          />
          )}
        </Source>
      )}


{/* 添加起点标记 */}
{routeOrigin && (
  <Source
    id="route-origin"
    type="geojson"
    data={{
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [routeOrigin.lon, routeOrigin.lat]
      }
    }}
  >
    <Layer
      id="route-origin-layer"
      type="circle"
      paint={{
        'circle-radius': 8,
        'circle-color': '#3b82f6',
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff'
      }}
    />
  </Source>
)}

{/* 添加终点标记 */}
{routeDestination && (
  <Source
    id="route-destination"
    type="geojson"
    data={{
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [routeDestination.lon, routeDestination.lat]
      }
    }}
  >
    <Layer
      id="route-destination-layer"
      type="circle"
      paint={{
        'circle-radius': 8,
        'circle-color': '#ef4444',
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff'
      }}
    />
  </Source>
)}


{/* 显示所有规划的路径 */}
{routes && routes.length > 0 && routes.map((route, index) => {
  const isSelected = selectedRoute?.route_id === route.route_id;
  
  return (
    <React.Fragment key={`${route.route_id}-${index}`}>
    <Source
      key={`${route.route_id}-${index}`} 
      id={`route-${route.route_id}-${index}`}
      type="geojson"
      data={route.geojson}
    >
      {/* 步行路段 */}
      <Layer
        id={`route-walking-${route.route_id}-${index}`}
        type="line"
        filter={['==', ['get', 'segmentType'], 'walking']}
        paint={{
          'line-color': isSelected ? LAYER_COLORS.walkingRoute : '#9ca3af',
          'line-width': isSelected ? 4 : 2,
          'line-opacity': isSelected ? 0.8 : 0.4
        }}
      />

      {/* 公交路段 */}
      <Layer
        id={`route-bus-${route.route_id}-${index}`}
        type="line"
        filter={['==', ['get', 'segmentType'], 'bus_ride']}
        paint={{
          'line-color': isSelected ? LAYER_COLORS.busRoute : '#9ca3af',
          'line-width': isSelected ? 5 : 3,
          'line-opacity': isSelected ? 0.8 : 0.4
        }}
      />
      
      {/* 公交站点 */}
      <Layer
        id={`route-stops-${route.route_id}-${index}`}  
        type="circle"
        filter={['in', ['get', 'type'], ['literal', ['bus_stop', 'departure_stop', 'arrival_stop']]]}
        paint={{
          'circle-radius': isSelected ? 6 : 4,
          'circle-color': isSelected ? LAYER_COLORS.busStop : '#9ca3af',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': isSelected ? 1 : 0.5
        }}
      />
    </Source>

      {/* 渲染途经站点 */}
      {isSelected && route.segments && route.segments
        .filter(seg => seg.type === 'bus_ride' && seg.stopsAlong)
        .map((busSegment, segIdx) => (
          <Source
            key={`stops-along-${route.route_id}-${segIdx}`}
            id={`stops-along-${route.route_id}-${segIdx}`}
            type="geojson"
            data={{
              type: 'FeatureCollection',
              features: busSegment.stopsAlong.map(stop => ({
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [stop.lon, stop.lat]
                },
                properties: {
                  name: stop.stopName,
                  order: stop.sequenceOrder
                }
              }))
            }}
          >
            <Layer
              id={`stops-along-layer-${route.route_id}-${segIdx}`}
              type="circle"
              paint={{
                'circle-radius': 4,
                'circle-color': '#fbbf24',  // 黄色表示途经站
                'circle-stroke-width': 1,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.8
              }}
            />
          </Source>
        ))
      }
    </React.Fragment>
  );
})}




{/* 路由规划 Loading 提示 */}
{routePlanning && (
  <div style={{
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
  }}>
    <div style={{
      backgroundColor: 'white',
      padding: '32px',
      borderRadius: '12px',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
      maxWidth: '400px',
      textAlign: 'center'
    }}>
      <div style={{
        width: '48px',
        height: '48px',
        border: '4px solid #e5e7eb',
        borderTopColor: '#059669',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
        margin: '0 auto 16px'
      }}></div>
      <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', color: '#111827' }}>
        Planning Routes
      </h3>
      <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#6b7280' }}>
        Searching for optimal green paths...
      </p>
      <button
        onClick={() => setRoutePlanning(false)}
        style={{
          padding: '8px 16px',
          backgroundColor: '#f3f4f6',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '14px',
          color: '#374151'
        }}
      >
        Cancel
      </button>
    </div>
  </div>
)}

{/* GVI 点生成 Loading 提示 */}
{gviGenerating && (
  <div style={{
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000
  }}>
    <div style={{
      backgroundColor: 'white',
      padding: '32px',
      borderRadius: '12px',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
      maxWidth: '400px',
      textAlign: 'center'
    }}>
      <div style={{
        width: '48px',
        height: '48px',
        border: '4px solid #e5e7eb',
        borderTopColor: '#f59e0b',
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
        margin: '0 auto 16px'
      }}></div>
      <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', color: '#111827' }}>
        Generating GVI Points
      </h3>
      <p style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#6b7280' }}>
        Calculating green view indices...
      </p>
      <button
        onClick={() => setGviGenerating(false)}
        style={{
          padding: '8px 16px',
          backgroundColor: '#f3f4f6',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '14px',
          color: '#374151'
        }}
      >
        Cancel
      </button>
    </div>
  </div>
)}


{/* Map View - 显示点击的坐标标记 */}
{activeTab === 'map' && clickedCoordInfo && (
  <Source
    id="clicked-coord"
    type="geojson"
    data={{
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [clickedCoordInfo.lon, clickedCoordInfo.lat]
      }
    }}
  >
    <Layer
      id="clicked-coord-layer"
      type="circle"
      paint={{
        'circle-radius': 8,
        'circle-color': '#8b5cf6',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff'
      }}
    />
  </Source>
)}

{/* Data Editor - 显示绘制的点 */}
{activeTab === 'editor' && drawingPoints.length > 0 && (
  <>
    {/* 显示点 */}
    <Source
      id="drawing-points"
      type="geojson"
      data={{
        type: 'FeatureCollection',
        features: drawingPoints.map((point, index) => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [point.lon, point.lat]
          },
          properties: { index }
        }))
      }}
    >
      <Layer
        id="drawing-points-layer"
        type="circle"
        paint={{
          'circle-radius': 6,
          'circle-color': '#f59e0b',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }}
      />
    </Source>

    {/* 如果有多个点，连成线 */}
    {drawingPoints.length > 1 && (
      <Source
        id="drawing-line"
        type="geojson"
        data={{
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: drawingPoints.map(p => [p.lon, p.lat])
          }
        }}
      >
        <Layer
          id="drawing-line-layer"
          type="line"
          paint={{
            'line-color': '#f59e0b',
            'line-width': 3,
            'line-dasharray': [2, 2]
          }}
        />
      </Source>
    )}
  </>
)}



      </Map>

{/* Map View - 坐标信息面板 */}
{activeTab === 'map' && clickedCoordInfo && (
  <div className="coord-info-panel">
    <h4>Clicked Location</h4>
    <div className="coord-row">
      <span className="coord-label">Latitude:</span>
      <span className="coord-value">{clickedCoordInfo.lat.toFixed(6)}</span>
    </div>
    <div className="coord-row">
      <span className="coord-label">Longitude:</span>
      <span className="coord-value">{clickedCoordInfo.lon.toFixed(6)}</span>
    </div>
    <button 
      className="coord-close-btn"
      onClick={() => setClickedCoordInfo(null)}
    >
      ✕
    </button>
  </div>
)}

{/* Data Editor - 绘制信息面板 */}
{activeTab === 'editor' && drawingPoints.length > 0 && (
  <div className="drawing-info-panel">
    <h4>Drawing Line</h4>
    <p className="drawing-count">Points: {drawingPoints.length}</p>
    <button 
      className="drawing-clear-btn"
      onClick={() => setDrawingPoints([])}
    >
      Clear All
    </button>
  </div>
)}

      {/* 图层控制面板 */}
      {gviData && (
        <div className="layer-control-panel">
          <h3>Layer Controller</h3>
          
          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={layerSettings.showPoints}
                onChange={(e) => setLayerSettings({
                  ...layerSettings,
                  showPoints: e.target.checked
                })}
              />
              GVI Points
            </label>
          </div>



          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={layerSettings.showHeatmap}
                onChange={(e) => setLayerSettings({
                  ...layerSettings,
                  showHeatmap: e.target.checked
                })}
              />
              GVI Density
            </label>
          </div>



          {layerSettings.showHeatmap && (
            <div className="control-group">
              <label>
                Occupacy: {Math.round(layerSettings.heatmapOpacity * 100)}%
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={layerSettings.heatmapOpacity}
                  onChange={(e) => setLayerSettings({
                    ...layerSettings,
                    heatmapOpacity: parseFloat(e.target.value)
                  })}
                />
              </label>
            </div>
          )}



          {/* ↓↓↓ 在这里添加等值线图控制 ↓↓↓ */}
          <div className="control-group">
            <label>
              <input
                type="checkbox"
                checked={layerSettings.showContour}
                onChange={(e) => setLayerSettings({
                  ...layerSettings,
                  showContour: e.target.checked
                })}
              />
              GVI Contour
            </label>
          </div>

          {layerSettings.showContour && (
            <div className="control-group">
              <label>
                Occupacy: {Math.round(layerSettings.contourOpacity * 100)}%
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={layerSettings.contourOpacity}
                  onChange={(e) => setLayerSettings({
                    ...layerSettings,
                    contourOpacity: parseFloat(e.target.value)
                  })}
                />
              </label>
            </div>
          )}
          
        </div>
      )}
      {gviLoading && (
        <div className="loading-indicator">
          Loading...
        </div>
      )}

      {/* Debug Info */}
      <div className="map-debug-info">
        <div className="debug-row">
          <span className="debug-label">Month:</span>
          <span className="debug-value">{currentMonth}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Lat:</span>
          <span className="debug-value debug-mono">{viewState.latitude.toFixed(4)}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Lng:</span>
          <span className="debug-value debug-mono">{viewState.longitude.toFixed(4)}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Zoom:</span>
          <span className="debug-value debug-mono">{viewState.zoom.toFixed(2)}</span>
        </div>
        <div className="debug-row debug-divider">
          <div className="status-indicator">
            <div className={`status-dot ${mapLoaded ? 'status-dot-ready' : 'status-dot-loading'}`}></div>
            <span className={`status-text ${mapLoaded ? 'status-text-ready' : 'status-text-loading'}`}>
              {mapLoaded ? 'Map Ready' : 'Loading...'}
            </span>
          </div>
        </div>
      </div>

      {/* Loading Overlay */}
      {!mapLoaded && (
        <div className="map-loading-overlay">
          <div className="loading-card">
            <div className="loading-content">
              <div className="loading-spinner"></div>
              <div className="loading-text-wrapper">
                <p className="loading-title">Loading Map</p>
                <p className="loading-subtitle">Please wait...</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MapContainer;