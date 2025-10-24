const express = require('express');
const router = express.Router();
const RoutingEngine = require('../services/routing_engine');
const DataPreprocessor = require('../services/data_preprocessor');
const DGVICalculator = require('../services/dgvi_calculator');

// 数据库配置
const dbConfig = {
    user: process.env.POSTGRES_USER || 'gvi_user',
    host: process.env.POSTGRES_HOST || 'postgres',
    database: process.env.POSTGRES_DB || 'gvi_app',
    password: process.env.POSTGRES_PASSWORD || 'gvi_pass',
    port: process.env.POSTGRES_PORT || 5432,
};

// 初始化服务
const routingEngine = new RoutingEngine(dbConfig);
const dataPreprocessor = new DataPreprocessor(dbConfig);
const dgviCalculator = new DGVICalculator(dbConfig);

/**
 * POST /api/v1/update-dgvi
 * 更新指定月份的所有道路 DGVI
 */
router.post('/update-dgvi', async (req, res) => {
    console.log('Received update-dgvi request:', req.body);
    try {
        const { month } = req.body;
        
        if (!month) {
            return res.status(400).json({
                error: 'Missing month parameter',
                details: 'Month is required in YYYY-MM format'
            });
        }
        const monthValidation = await dgviCalculator.validateMonth(month);
        if (!monthValidation.isValid) {
            return res.status(400).json({
                error: 'Invalid month',
                details: monthValidation.error
            });
        }
        
        console.log(`Starting DGVI update for month ${month}...`);
        const stats = await dgviCalculator.updateAllRoadDGVI(month);
        
        res.json({
            success: true,
            message: 'DGVI updated successfully',
            statistics: stats,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('DGVI update failed:', error);
        res.status(500).json({
            error: 'DGVI update failed',
            details: error.message
        });
    }
});


/**
 * POST /api/v1/plan-routes
 * 核心路径规划API
 */
router.post('/plan-routes', async (req, res) => {
    try {
        const {
            origin,
            destination,
            gvi_month,
            preferences = { time: 0.5, green: 0.5 },
            max_results = 4
        } = req.body;

        // 输入验证
        if (!origin || !destination || !origin.lat || !origin.lon || !destination.lat || !destination.lon) {
            return res.status(400).json({
                error: 'Invalid coordinates',
                details: 'Origin and destination must have lat and lon properties'
            });
        }

        // GVI月份处理
        let gviMonth = gvi_month;
        if (!gviMonth) {
            gviMonth = await dgviCalculator.getRecommendedMonth();
        } else {
            const monthValidation = await dgviCalculator.validateMonth(gviMonth);
            if (!monthValidation.isValid) {
                return res.status(400).json({
                    error: 'Invalid GVI month',
                    details: monthValidation.error,
                    available_months: monthValidation.availableMonths || []
                });
            }
        }

        // 路径规划
        const routes = await routingEngine.planRoutes(origin, destination, {
            gviMonth: gviMonth,
            preferences: preferences,
            maxResults: max_results
        });

        // 响应格式
        const response = {
            success: true,
            request: {
                origin: origin,
                destination: destination,
                preferences: preferences,
                gvi_month: gviMonth,
                timestamp: new Date().toISOString()
            },
            results: {
                total_routes: routes.length,
                routes: routes.map(route => route.toApiResponse())
            }
        };

        res.json(response);

    } catch (error) {
        console.error('Route planning failed:', error);
        res.status(500).json({
            error: 'Route planning failed',
            details: error.message
        });
    }
});

/**
 * GET /api/v1/available-months
 * 获取可用的GVI数据月份
 */
router.get('/available-months', async (req, res) => {
    try {
        const monthsInfo = await routingEngine.getAvailableGVIMonths();
        
        res.json({
            success: true,
            available_months: monthsInfo.months,
            latest_month: monthsInfo.latest,
            recommended_month: monthsInfo.recommended,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Failed to get available months:', error);
        res.status(500).json({
            error: 'Failed to get available months',
            details: error.message
        });
    }
});

/**
 * GET /api/v1/dgvi-stats/:month
 * 获取特定月份的DGVI统计
 */
router.get('/dgvi-stats/:month', async (req, res) => {
    try {
        const { month } = req.params;
        
        const monthValidation = await dgviCalculator.validateMonth(month);
        if (!monthValidation.isValid) {
            return res.status(400).json({
                error: 'Invalid month',
                details: monthValidation.error,
                available_months: monthValidation.availableMonths || []
            });
        }

        const stats = await dgviCalculator.getDGVIStatistics(month);
        
        if (!stats) {
            return res.status(404).json({
                error: 'No data found',
                details: `No GVI data available for month ${month}`
            });
        }

        res.json({
            success: true,
            month: month,
            statistics: stats,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Failed to get DGVI statistics:', error);
        res.status(500).json({
            error: 'Failed to get statistics',
            details: error.message
        });
    }
});


/**
 * GET /api/v1/gvi-points/:month
 * 获取特定月份的GVI点数据用于地图可视化
 */
router.get('/gvi-points/:month', async (req, res) => {
    try {
        const { month } = req.params;
        const { limit = 20000 } = req.query; // 默认最多返回20000个点
        
        // 验证月份
        const monthValidation = await dgviCalculator.validateMonth(month);
        if (!monthValidation.isValid) {
            return res.status(400).json({
                error: 'Invalid month',
                details: monthValidation.error,
                available_months: monthValidation.availableMonths || []
            });
        }
        
        // 查询GVI点数据
        const query = `
            SELECT 
                id,
                ST_X(geometry) as lon,
                ST_Y(geometry) as lat,
                gvi,
                month
            FROM gvi_points 
            WHERE month = $1 AND gvi IS NOT NULL
            ORDER BY id
            LIMIT $2;
        `;
        
        const client = await routingEngine.pool.connect();
        const result = await client.query(query, [month, parseInt(limit)]);
        client.release();
        
        // 转换为GeoJSON格式
        const geojson = {
            type: 'FeatureCollection',
            features: result.rows.map(row => ({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [row.lon, row.lat]
                },
                properties: {
                    id: row.id,
                    gvi: row.gvi,
                    month: row.month
                }
            }))
        };
        
        res.json({
            success: true,
            month: month,
            point_count: result.rows.length,
            data: geojson,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Failed to get GVI points:', error);
        res.status(500).json({
            error: 'Failed to get GVI points',
            details: error.message
        });
    }
});

/**
 * POST /api/v1/calculate-dgvi
 * 计算特定路段的DGVI
 */
router.post('/calculate-dgvi', async (req, res) => {
    try {
        const { 
            road_ids, 
            month, 
            calculation_type = 'walking' 
        } = req.body;

        if (!road_ids || !Array.isArray(road_ids)) {
            return res.status(400).json({
                error: 'Invalid input',
                details: 'road_ids must be an array of road segment IDs'
            });
        }

        const targetMonth = month || await dgviCalculator.getRecommendedMonth();
        
        const monthValidation = await dgviCalculator.validateMonth(targetMonth);
        if (!monthValidation.isValid) {
            return res.status(400).json({
                error: 'Invalid month',
                details: monthValidation.error
            });
        }
        
        let totalDGVI;
        
        switch (calculation_type) {
            case 'walking':
                totalDGVI = await dgviCalculator.calculateWalkingDGVI(road_ids, targetMonth);
                break;
            
            case 'single_segment':
                if (road_ids.length !== 1) {
                    return res.status(400).json({
                        error: 'Invalid input',
                        details: 'single_segment calculation requires exactly one road ID'
                    });
                }
                totalDGVI = await dgviCalculator.calculateSegmentDGVI(road_ids[0], targetMonth);
                break;
                
            default:
                return res.status(400).json({
                    error: 'Invalid calculation type',
                    details: 'calculation_type must be "walking" or "single_segment"'
                });
        }

        res.json({
            success: true,
            calculation_type: calculation_type,
            month: targetMonth,
            road_ids: road_ids,
            total_dgvi: totalDGVI,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('DGVI calculation failed:', error);
        res.status(500).json({
            error: 'DGVI calculation failed',
            details: error.message
        });
    }
});



/**
 * GET /api/v1/nearby-sites
 * 查找附近的交通站点
 */
router.get('/nearby-sites', async (req, res) => {
    try {
        const { lat, lon, max_distance = 1200 } = req.query;

        if (!lat || !lon) {
            return res.status(400).json({
                error: 'Missing coordinates',
                details: 'lat and lon query parameters are required'
            });
        }

        const latitude = parseFloat(lat);
        const longitude = parseFloat(lon);

        if (isNaN(latitude) || isNaN(longitude)) {
            return res.status(400).json({
                error: 'Invalid coordinates',
                details: 'lat and lon must be valid numbers'
            });
        }

        const sites = await routingEngine.findNearbySites({ lat: latitude, lon: longitude });
        const filteredSites = sites.filter(site => site.walkingDistance <= max_distance);

        res.json({
            success: true,
            location: { lat: latitude, lon: longitude },
            max_distance: max_distance,
            sites_found: filteredSites.length,
            sites: filteredSites,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Failed to find nearby sites:', error);
        res.status(500).json({
            error: 'Failed to find nearby sites',
            details: error.message
        });
    }
});

/**
 * POST /api/v1/preprocess-data
 * 数据预处理
 */
router.post('/preprocess-data', async (req, res) => {
    try {
        const { 
            max_sites = null, 
            skip_route_sequences = false,
            force_update = false 
        } = req.body;

        console.log('Starting bus sequence building...');

        await dataPreprocessor.runPreprocessing({
            maxSites: max_sites,
            skipRouteSequences: skip_route_sequences
        });

        res.json({
            success: true,
            message: 'Data preprocessing completed successfully',
            options: {
                max_sites: max_sites,
                skip_route_sequences: skip_route_sequences,
                force_update: force_update
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Data preprocessing failed:', error);
        res.status(500).json({
            error: 'Data preprocessing failed',
            details: error.message
        });
    }
});

/**
 * POST /api/v1/add-gvi-points
 * 添加新的GVI采样点
 */
router.post('/add-gvi-points', async (req, res) => {
    try {
        const { points, month } = req.body;
        
        // 验证输入
        if (!points || !Array.isArray(points) || points.length === 0) {
            return res.status(400).json({
                error: 'Invalid input',
                details: 'points must be a non-empty array'
            });
        }
        
        if (points.length > 20) {
            return res.status(400).json({
                error: 'Too many points',
                details: 'Maximum 20 points per request'
            });
        }
        
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({
                error: 'Invalid month',
                details: 'Month must be in YYYY-MM format'
            });
        }
        
        // 验证坐标范围
        for (const point of points) {
            if (!point.lat || !point.lon) {
                return res.status(400).json({
                    error: 'Invalid coordinates',
                    details: 'Each point must have lat and lon properties'
                });
            }
            if (point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
                return res.status(400).json({
                    error: 'Coordinates out of range',
                    details: 'Latitude must be [-90, 90], Longitude must be [-180, 180]'
                });
            }
        }
        
        console.log(`Adding ${points.length} GVI points for month ${month}`);
        
        // 调用 GeoAI 容器
        const geoaiUrl = process.env.GEOAI_URL || 'http://geoai:8000';
        const geoaiResponse = await fetch(`${geoaiUrl}/api/v1/calculate_gvi`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ points, month })
        });
        
        if (!geoaiResponse.ok) {
            throw new Error(`GeoAI service error: ${geoaiResponse.status}`);
        }
        
        const geoaiData = await geoaiResponse.json();
        
        // 插入成功的结果到数据库
        const client = await routingEngine.pool.connect();
        
        try {
            let insertedCount = 0;
            let failedCount = 0;
            
            for (const result of geoaiData.results) {
                if (result.success && result.gvi !== null) {
                    try {
                        await client.query(`
                            INSERT INTO gvi_points (geometry, gvi, month)
                            VALUES (
                                ST_SetSRID(ST_MakePoint($1, $2), 4326),
                                $3,
                                $4
                            )
                            ON CONFLICT DO NOTHING
                        `, [result.lon, result.lat, result.gvi, month]);
                        
                        insertedCount++;
                    } catch (err) {
                        console.error(`Failed to insert point (${result.lat}, ${result.lon}):`, err.message);
                        failedCount++;
                    }
                } else {
                    failedCount++;
                }
            }
            
            res.json({
                success: true,
                message: `GVI points added successfully`,
                statistics: {
                    requested: points.length,
                    calculated: geoaiData.processed_count,
                    inserted: insertedCount,
                    failed: failedCount
                },
                month: month,
                processing_time: geoaiData.processing_time,
                timestamp: new Date().toISOString()
            });
            
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('Failed to add GVI points:', error);
        res.status(500).json({
            error: 'Failed to add GVI points',
            details: error.message
        });
    }
});

/**
 * GET /api/v1/health
 * 健康检查
 */
router.get('/health', async (req, res) => {
    try {
        res.json({
            status: 'healthy',
            service: 'Green Route Planning API',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});

/**
 * GET /api/v1/status
 * 系统状态
 */
router.get('/status', async (req, res) => {
    try {
        const monthsInfo = await routingEngine.getAvailableGVIMonths();
        
        const status = {
            service: 'Green Route Planning API',
            status: 'running',
            environment: process.env.NODE_ENV || 'development',
            database: {
                host: dbConfig.host,
                database: dbConfig.database,
                port: dbConfig.port
            },
            gvi_data: {
                available_months: monthsInfo.months,
                latest_month: monthsInfo.latest,
                recommended_month: monthsInfo.recommended
            },
            timestamp: new Date().toISOString()
        };

        res.json(status);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get status',
            details: error.message
        });
    }
});

module.exports = router;