/**
 * Routing Engine Rewrite - Core path planning service
 * 使用新数据结构实现绿色权重路径规划，支持步行+公交(最多一次换乘)
 */

const { Pool } = require('pg');
const SLApiService = require('./sl_api_service');
const DGVICalculator = require('./dgvi_calculator');
const QueryAgent = require('./query_agent');
const RoutePlan = require('../models/route_plan');

class RoutingEngine {
    constructor(dbConfig) {
        this.pool = new Pool(dbConfig);
        this.slApi = new SLApiService();
        this.dgviCalculator = new DGVICalculator(dbConfig);
        this.walkingSpeed = 1.4; // m/s
        this.transferMargin = 60; // seconds
        this.maxWalkingTime = 1200; // 15 minutes in seconds
        this.stopSiteCache = new Map();
        this.nextStopCache = new Map();
    }

    /**
     * Get the correct table name based on strategy
     * @param {string} strategy - 'walking', 'bus', or 'general'
     * @returns {string} Table name
     */
    getTableName(strategy) {
        switch (strategy) {
            case 'walking':
                return 'stockholm_osm';
            case 'bus':
                return 'stockholm_osm';
            default:
                return 'stockholm_osm';
        }
    }

    /**
     * Plan routes with simplified scoring strategy
     * - Generate 2-3 walking routes (ASAP, GROOT, User preference)
     * - Select top 5 bus routes by earliest arrival
     * - Score bus routes by waiting DGVI only
     * - Return top 2 from each category (total 4 routes)
     */
    async planRoutes(origin, destination, options = {}) {
        const {
            gviMonth = "2025-06",
            preferences = { time: 0.5, green: 0.5 },
            maxResults = 4 
        } = options;

        try {
            console.log(`Planning routes with simplified strategy...`);
            const currentTime = new Date();
            
            // ========== PART 1: Walking Routes (强制输出 2 条) ==========
            const walkingRoutes = await this.generateWalkingCandidates(
                origin, destination, gviMonth, preferences
            );
            
            // ========== PART 2: Bus Routes (选 top 2) ==========
            const busRoutes = await this.generateBusCandidates(
                origin, destination, currentTime, gviMonth, preferences
            );
            
            // ========== PART 3: 组合结果 ==========
            const finalRoutes = [
                ...walkingRoutes.slice(0, 2),  // Top 2 walking
                ...busRoutes.slice(0, 2)       // Top 2 bus
            ].filter(r => r !== null);
            
            console.log(`Generated ${finalRoutes.length} routes (${walkingRoutes.length} walking, ${busRoutes.length} bus)`);
            
            return finalRoutes;
            
        } catch (error) {
            console.error('Route planning failed:', error.message);
            throw error;
        }
    }


    /**
     * Generate walking route candidates with different strategies
     */
    async generateWalkingCandidates(origin, destination, gviMonth, preferences) {
        console.log('Generating walking candidates...');
        
        const candidates = [];
        const strategies = [
            { name: 'User Preference', pref: preferences },
            { name: 'ASAP', pref: { time: 1.0, green: 0.0 } },
            { name: 'GROOT', pref: { time: 0.0, green: 1.0 } }
        ];
        
        for (const strategy of strategies) {
            try {
                const route = await this.calculateWalkingRoute(
                    origin, destination, gviMonth, strategy.pref
                );
                
                if (route) {
                    // 计算 DGVI 评分
                    route.totalAcDGVI = await this.dgviCalculator.calculateRouteDGVI(route, gviMonth);
                    route.strategy = strategy.name;
                    candidates.push(route);
                }
            } catch (error) {
                console.warn(`Failed to generate ${strategy.name} walking route:`, error.message);
            }
        }
        
        // 按照策略优先级排序：User > ASAP > GROOT
        // 但如果 User 和 ASAP/GROOT 结果相同，去重
        const uniqueRoutes = this.deduplicateRoutes(candidates);
        
        console.log(`Generated ${uniqueRoutes.length} unique walking routes`);
        return uniqueRoutes.slice(0, 2);  // 强制返回最多 2 条
    }

    /**
     * Generate bus route candidates with simplified scoring
     */
    async generateBusCandidates(origin, destination, currentTime, gviMonth, preferences) {
        console.log('Generating bus candidates...');
        
        // Step 1: 找到所有可达的 bus routes
        const originSites = await this.findNearbySites(origin);
        const destinationSites = await this.findNearbySites(destination);
        
        if (originSites.length === 0 || destinationSites.length === 0) {
            console.log('No nearby bus sites found');
            return [];
        }
        
        // Step 2: 预加载 departures（优化性能）
        const allSiteIds = [
            ...originSites.map(s => s.siteId),
            ...destinationSites.map(s => s.siteId)
        ];
        const departuresCache = await this.slApi.getBatchDepartures(allSiteIds, 1200);
        
        // Step 3: 找到所有 direct routes
        const directRoutes = await this.findDirectRoutes(
            originSites, destinationSites, currentTime, 3600, gviMonth, departuresCache, preferences
        );
        
        // Step 4: 按 earliest arrival 排序，取 top 5
        directRoutes.sort((a, b) => {
            const aArrival = this.getRouteArrivalTime(a);
            const bArrival = this.getRouteArrivalTime(b);
            return aArrival - bArrival;
        });
        
        const top5Routes = directRoutes.slice(0, 5);
        console.log(`Selected top 5 bus routes by earliest arrival`);
        
        // Step 5: 只对 top 5 计算 waiting DGVI
        for (const route of top5Routes) {
            // 只计算 waiting 段的 DGVI（不包括 bus ride）
            let waitingDGVI = 0;
            for (const segment of route.segments) {
                if (segment.type === 'bus_waiting' && segment.stopGeom) {
                    const dgvi = await this.dgviCalculator.calculateWaitingDGVI(
                        segment.stopGeom, gviMonth
                    );
                    waitingDGVI += dgvi;
                }
            }
            route.totalAcDGVI = waitingDGVI;
        }
        
        // Step 6: 根据 preference 评分，选 top 2
        const scoredRoutes = this.scoreBusRoutes(top5Routes, preferences);
        const top2Routes = scoredRoutes.slice(0, 2);
    
        // Step 7: 补充可视化数据
        await this.enrichVisualizationData(top2Routes, gviMonth);

        return top2Routes;
    }

    /**
     * Score bus routes based on time and waiting DGVI
     */
    scoreBusRoutes(routes, preferences) {
        if (routes.length === 0) return [];
        
        // 归一化（只在 bus routes 内部归一化）
        const minTime = Math.min(...routes.map(r => r.totalDuration));
        const maxTime = Math.max(...routes.map(r => r.totalDuration));
        const minDGVI = Math.min(...routes.map(r => r.totalAcDGVI || 0));
        const maxDGVI = Math.max(...routes.map(r => r.totalAcDGVI || 0));
        
        for (const route of routes) {
            const timeNorm = maxTime > minTime ? 
                (route.totalDuration - minTime) / (maxTime - minTime) : 0;
            
            const dgviNorm = maxDGVI > minDGVI ?
                (route.totalAcDGVI - minDGVI) / (maxDGVI - minDGVI) : 0;
            
            // DGVI 越大越好，所以反转
            const totalScore = preferences.time * timeNorm + preferences.green * (1 - dgviNorm);
            
            // 存储为"越大越好"的格式
            route.durationScore = 1 - timeNorm;
            route.acDGVIScore = dgviNorm;
            route.totalScore = 1 - totalScore;
        }
        
        // 按总分排序
        routes.sort((a, b) => b.totalScore - a.totalScore);
        
        return routes;
    }

    /**
     * Get route arrival time for sorting
     */
    getRouteArrivalTime(route) {
        // 查找最后一个有 expectedArrival 的 segment
        for (let i = route.segments.length - 1; i >= 0; i--) {
            const segment = route.segments[i];
            if (segment.expectedArrival) {
                return new Date(segment.expectedArrival);
            }
        }
        
        // 如果没有找到，用当前时间 + totalDuration 估算
        return new Date(Date.now() + route.totalDuration * 1000);
    }

    /**
     * Remove duplicate routes based on road IDs
     */
    deduplicateRoutes(routes) {
        const seen = new Set();
        const unique = [];
        
        for (const route of routes) {
            // 提取所有 road IDs 作为指纹
            const roadIds = route.segments
                .filter(s => s.roadIds)
                .flatMap(s => s.roadIds)
                .sort()
                .join(',');
            
            if (!seen.has(roadIds)) {
                seen.add(roadIds);
                unique.push(route);
            }
        }
        
        return unique;
    }



    /**
     * Calculate walking-only route using PgRouting
     */
    async calculateWalkingRoute(
        origin, 
        destination, 
        gviMonth,
        preferences = { time: 0.5, green: 0.5 },
        strategy = "walking")
        {
        const client = await this.pool.connect();
        const tableName = this.getTableName(strategy);
        try {
            // Find nearest road nodes
            const nearestNodeQuery = `
                SELECT id, the_geom, 
                       ST_Distance(the_geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) as distance
                FROM ${tableName}_vertices_pgr
                ORDER BY the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
                LIMIT 1;
            `;
            
            const originNodeResult = await client.query(nearestNodeQuery, [origin.lon, origin.lat]);
            const destNodeResult = await client.query(nearestNodeQuery, [destination.lon, destination.lat]);
            
            if (originNodeResult.rows.length === 0 || destNodeResult.rows.length === 0) {
                throw new Error('Cannot find nearest road nodes');
            }
            
            const originNodeId = originNodeResult.rows[0].id;
            const destNodeId = destNodeResult.rows[0].id;
            
            // Calculate shortest path with merged geometry
            const routeQuery = `
                WITH route_segments AS (
                    SELECT 
                        r.seq,
                        r.edge as road_id,
                        e.length,
                        e.geom
                    FROM pgr_dijkstra(
                        'SELECT 
                            w.id, 
                            w.source, 
                            w.target, 
                            w.length_normalized * ${preferences.time} + (1 - COALESCE(d.dgvi_normalized, 0)) * ${preferences.green} as cost
                        FROM ${tableName} w
                        LEFT JOIN road_dgvi d ON w.id = d.road_id AND d.month = ''${gviMonth}''',
                        $1::bigint, $2::bigint, false
                    ) r
                    JOIN ${tableName} e ON r.edge = e.id
                    ORDER BY r.seq
                )
                SELECT 
                    array_agg(road_id ORDER BY seq) as road_ids,
                    sum(length) as total_length,
                    ST_AsGeoJSON(ST_LineMerge(ST_Union(geom ORDER BY seq))) as merged_geom
                FROM route_segments;
            `;
            
            const routeResult = await client.query(routeQuery, [originNodeId, destNodeId]);
            
            if (routeResult.rows.length === 0) {
                throw new Error('No walking route found');
            }
            
            const row = routeResult.rows[0];
            const totalDistance = row.total_length;
            const totalDuration = totalDistance / this.walkingSpeed;
            const roadIds = row.road_ids;

            // Parse merged geometry
            const routeGeometry = JSON.parse(row.merged_geom);
            
            // Create walking route using new structure
            return RoutePlan.createWalkingRoute({
                totalDuration: totalDuration,
                totalDistance: totalDistance,
                origin: origin,
                destination: destination,
                roadIds: roadIds,
                geometry: routeGeometry,
                gviDataMonth: gviMonth
            });
            
        } catch (error) {
            console.error('Failed to calculate walking route:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Calculate a walking segment between two points with preferences
     * @param {Object} from - Starting point {lat, lon}
     * @param {Object} to - Ending point {lat, lon}
     * @param {Object} preferences - User preferences {time, green}
     * @param {string} gviMonth - GVI data month
     * @param {string} strategy - Routing strategy (default: 'walking')
     * @returns {Promise<Object>} {duration, distance, roadIds, geometry}
     */
    async calculateWalkingSegment(from, to, preferences, gviMonth, strategy = 'walking') {
        const client = await this.pool.connect();
        const tableName = this.getTableName(strategy);
        
        try {
            // Find nearest road nodes
            const nearestNodeQuery = `
                SELECT id, the_geom
                FROM ${tableName}_vertices_pgr
                ORDER BY the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
                LIMIT 1;
            `;
            
            const fromNodeResult = await client.query(nearestNodeQuery, [from.lon, from.lat]);
            const toNodeResult = await client.query(nearestNodeQuery, [to.lon, to.lat]);
            
            if (fromNodeResult.rows.length === 0 || toNodeResult.rows.length === 0) {
                console.warn('Cannot find nearest nodes for walking segment');
                return { duration: 0, distance: 0, roadIds: [], geometry: null };
            }
            
            const fromNodeId = fromNodeResult.rows[0].id;
            const toNodeId = toNodeResult.rows[0].id;
            
            // Calculate path with preferences
            const routeQuery = `
                WITH route_segments AS (
                    SELECT 
                        r.seq,
                        r.edge as road_id,
                        e.length,
                        e.geom
                    FROM pgr_dijkstra(
                        'SELECT 
                            w.id, 
                            w.source, 
                            w.target, 
                            w.length_normalized * ${preferences.time} + (1 - COALESCE(d.dgvi_normalized, 0)) * ${preferences.green} as cost
                        FROM ${tableName} w
                        LEFT JOIN road_dgvi d ON w.id = d.road_id AND d.month = ''${gviMonth}''',
                        $1::bigint, $2::bigint, false
                    ) r
                    JOIN ${tableName} e ON r.edge = e.id
                    ORDER BY r.seq
                )
                SELECT 
                    array_agg(road_id ORDER BY seq) as road_ids,
                    sum(length) as total_length,
                    ST_AsGeoJSON(ST_LineMerge(ST_Union(geom ORDER BY seq))) as merged_geom
                FROM route_segments;
            `;
            
            const routeResult = await client.query(routeQuery, [fromNodeId, toNodeId]);
            
            if (routeResult.rows.length === 0 || !routeResult.rows[0].road_ids) {
                console.warn('No walking path found');
                return { duration: 0, distance: 0, roadIds: [], geometry: null };
            }
            
            const row = routeResult.rows[0];
            const distance = row.total_length;
            const duration = distance / this.walkingSpeed;
            const roadIds = row.road_ids;
            const geometry = row.merged_geom ? JSON.parse(row.merged_geom) : null;
            
            return {
                duration: duration,
                distance: distance,
                roadIds: roadIds,
                geometry: geometry
            };
            
        } catch (error) {
            console.error('Failed to calculate walking segment:', error.message);
            return { duration: 0, distance: 0, roadIds: [], geometry: null };
        } finally {
            client.release();
        }
    }


    /**
     * Find nearby transport sites within walking distance
     */
    async findNearbySites(point) {
        const client = await this.pool.connect();
        
        try {
            const maxWalkingDistance = this.maxWalkingTime * this.walkingSpeed; // 米
            
            const query = `
                WITH walking_sites AS (
                    SELECT 
                        site_id,
                        site_name,
                        geom,
                        ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance_meters
                    FROM sl_bus_sites
                    WHERE ST_DWithin(
                        geom::geography, 
                        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 
                        $3
                    )
                ),
                closest_sites AS (
                    SELECT 
                        site_id,
                        site_name,
                        geom,
                        ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance_meters
                    FROM sl_bus_sites
                    ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
                    LIMIT 3
                )
                SELECT DISTINCT 
                    site_id,
                    site_name,
                    ST_X(geom) as lon,
                    ST_Y(geom) as lat,
                    distance_meters as walkingDistance
                FROM (
                    SELECT * FROM walking_sites
                    UNION
                    SELECT * FROM closest_sites
                ) combined
                ORDER BY distance_meters
                LIMIT 5;
            `;
            
            const result = await client.query(query, [point.lon, point.lat, maxWalkingDistance]);
            
            return result.rows.map(row => ({
                siteId: row.site_id,
                siteName: row.site_name,
                lat: row.lat,
                lon: row.lon,
                walkingDistance: row.walkingdistance
            }));
            
        } catch (error) {
            console.error('Failed to find nearby sites:', error.message);
            return [];
        } finally {
            client.release();
        }
    }


    /**
 * Predict potential transfer sites based on origin journeys
 * @param {Array} originSites - Origin sites array
 * @param {number} maxDepth - Maximum search depth
 * @returns {Promise<Set>} Set of potential transfer site IDs
 */
async predictTransferSites(originSites, maxDepth = 10) {
    const client = await this.pool.connect();
    const transferSiteIds = new Set();
    
    try {
        const originSiteIds = originSites.map(s => s.siteId);
        const tempDepartures = await this.slApi.getBatchDepartures(originSiteIds, 300);
        
        const query = `
            WITH RECURSIVE journey_path AS (
                SELECT stop_point_id, next_stop_point_id, 1 as depth
                FROM sl_bus_trips
                WHERE line_id = $1 
                  AND direction_code = $2 
                  AND stop_point_id = $3
                
                UNION ALL
                
                SELECT bt.stop_point_id, bt.next_stop_point_id, jp.depth + 1
                FROM journey_path jp
                JOIN sl_bus_trips bt ON jp.next_stop_point_id = bt.stop_point_id
                WHERE bt.line_id = $1 
                  AND bt.direction_code = $2
                  AND jp.depth < $4
            )
            SELECT DISTINCT sp.site_id
            FROM journey_path jp
            JOIN sl_bus_stop_points sp ON jp.next_stop_point_id = sp.stop_point_id
            WHERE sp.site_id IS NOT NULL;
        `;
        
        for (const [siteId, departures] of tempDepartures) {
            for (const dep of departures.slice(0, 5)) {
                if (!dep.journey?.id || !dep.stop_point?.id) continue;
                
                const lineId = dep.line?.id;
                const directionCode = dep.direction_code;
                const stopPointId = dep.stop_point?.id;
                
                if (!lineId || directionCode === undefined || !stopPointId) {
                    console.log('Skipping departure with missing data:', { lineId, directionCode, stopPointId });
                    continue;
                }
                
                const result = await client.query(query, [
                    lineId,
                    directionCode,
                    stopPointId,
                    maxDepth
                ]);
                
                result.rows.forEach(row => transferSiteIds.add(row.site_id));
            }
        }
        
        console.log(`Predicted ${transferSiteIds.size} potential transfer sites`);
        return transferSiteIds;
        
    } catch (error) {
        console.error('Failed to predict transfer sites:', error.message);
        return new Set();
    } finally {
        client.release();
    }
}

    /**
     * Find direct bus routes between origin and destination sites
     */
    async findDirectRoutes(originSites, destinationSites, currentTime, maxDuration, gviMonth, departuresCache, preferences) {
        try {
            console.log('Searching for direct bus routes...');
            
            const directRoutes = [];
            const forecastLimit = 1200;
            
            // Use pre-loaded cache instead of querying API
            const originDepartures = new Map();
            const destDepartures = new Map();

            for (const site of originSites) {
                originDepartures.set(site.siteId, departuresCache.get(site.siteId) || []);
            }
            for (const site of destinationSites) {
                destDepartures.set(site.siteId, departuresCache.get(site.siteId) || []);
            }

            // Build journey maps
            const originJourneys = new Map();
            const destJourneys = new Map();
            
            // Process origin departures
            for (const [siteId, departures] of originDepartures) {
                for (const dep of departures) {
                    if (dep.journey?.id && dep.stop_point?.id) {
                        originJourneys.set(dep.journey.id, {
                            siteId: siteId,
                            stopPointId: dep.stop_point.id,
                            stopName: dep.stop_point.name,
                            expectedTime: new Date(dep.expected),
                            lineId: dep.line?.id,
                            lineDesignation: dep.line?.designation,
                            destination: dep.destination,
                            directionCode: dep.direction_code
                        });
                    }
                }
            }
            
            // Process destination departures and find matches
            for (const [siteId, departures] of destDepartures) {
                for (const dep of departures) {
                    const journeyId = dep.journey?.id;
                    if (!journeyId || !dep.stop_point?.id) continue;
                    
                    // Check if this journey started from our origins
                    const originInfo = originJourneys.get(journeyId);
                    if (originInfo && 
                        originInfo.lineId === dep.line?.id && 
                        originInfo.directionCode === dep.direction_code) {
                        
                        destJourneys.set(journeyId, {
                            siteId: siteId,
                            stopPointId: dep.stop_point.id,
                            stopName: dep.stop_point.name,
                            expectedTime: new Date(dep.expected),
                            lineId: dep.line?.id,
                            lineDesignation: dep.line?.designation
                        });
                    }
                }
            }
            
            console.log(`Found ${originJourneys.size} origin journeys, ${destJourneys.size} matching arrivals`);
            
            // Create direct route plans
            for (const [journeyId, depInfo] of originJourneys) {
                const arrInfo = destJourneys.get(journeyId);
                if (!arrInfo) continue;
                
                // Validate timing
                const travelTime = (arrInfo.expectedTime - depInfo.expectedTime) / 1000;
                if (travelTime <= 0 || travelTime > maxDuration) continue;
                
                // Check if we can reach departure stop in time
                const originSite = originSites.find(s => s.siteId === depInfo.siteId);
                const walkingTimeToDep = originSite.walkingDistance / this.walkingSpeed;
                const timeUntilDeparture = (depInfo.expectedTime - currentTime) / 1000;
                
                if (walkingTimeToDep + 60 > timeUntilDeparture) continue;
                
                // Get detailed stop information
                const departureStopInfo = await this.getStopPointSite(depInfo.stopPointId);
                const arrivalStopInfo = await this.getStopPointSite(arrInfo.stopPointId);
                
                if (!departureStopInfo || !arrivalStopInfo) continue;
                
            const destSite = destinationSites.find(s => s.siteId === arrInfo.siteId);

            // 计算实际的 walking 路径
            const walkingToDep = await this.calculateWalkingSegment(
                { lat: originSite.lat, lon: originSite.lon },
                { lat: departureStopInfo.lat, lon: departureStopInfo.lon },
                preferences,
                gviMonth
            );

            const walkingFromArr = await this.calculateWalkingSegment(
                { lat: arrivalStopInfo.lat, lon: arrivalStopInfo.lon },
                { lat: destSite.lat, lon: destSite.lon },
                preferences,
                gviMonth
            );

            const totalDuration = walkingToDep.duration + travelTime + walkingFromArr.duration;

            // 创建 direct route 使用新结构
            const routePlan = RoutePlan.createDirectBusRoute({
                origin: { lat: originSite.lat, lon: originSite.lon },
                destination: { lat: destSite.lat, lon: destSite.lon },
                
                walkingToDeparture: walkingToDep.duration,
                walkingToDepDistance: walkingToDep.distance,
                walkingToDepRoadIds: walkingToDep.roadIds,      
                walkingToDepGeometry: walkingToDep.geometry,    
                
                departureStop: departureStopInfo,
                arrivalStop: arrivalStopInfo,
                
                busRideDuration: travelTime,
                walkingFromArrival: walkingFromArr.duration,
                walkingFromArrDistance: walkingFromArr.distance,
                walkingFromArrRoadIds: walkingFromArr.roadIds,      
                walkingFromArrGeometry: walkingFromArr.geometry,  
                
                lineId: depInfo.lineId,
                lineDesignation: depInfo.lineDesignation,
                directionCode: depInfo.directionCode,
                lineInfo: `${depInfo.lineDesignation} to ${depInfo.destination}`,
                expectedDeparture: depInfo.expectedTime,
                expectedArrival: arrInfo.expectedTime,
                journeyId: journeyId,
                
                totalDuration: totalDuration,
                gviDataMonth: gviMonth
            });
                directRoutes.push(routePlan);
            }
            
            console.log(`Found ${directRoutes.length} direct routes`);
            return directRoutes;
            
        } catch (error) {
            console.error('Failed to find direct routes:', error.message);
            return [];
        }
    }

    /**
     * Get stop-point site information
     * @param {number} stopPointId - Stop point ID
     * @returns {Promise<Object>} Site information for the stop-point
     */
    async getStopPointSite(stopPointId) {
        const client = await this.pool.connect();
        
        try {
            const query = `
                SELECT 
                    stop_point_id,
                    site_id,
                    stop_point_name,
                    ST_X(geom) as lon,
                    ST_Y(geom) as lat,
                    geom
                FROM sl_bus_stop_points 
                WHERE stop_point_id = $1
            `;
            
            const result = await client.query(query, [stopPointId]);
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const row = result.rows[0];
            return {
                stop_point_id: row.stop_point_id,
                site_id: row.site_id,
                stop_name: row.stop_point_name,
                lat: row.lat,
                lon: row.lon,
                geom: row.geom
            };
            
        } catch (error) {
            console.error(`Failed to get site for stop-point ${stopPointId}:`, error.message);
            return null;
        } finally {
            client.release();
        }
    }

        async getStopPointSiteCached(stopPointId) {
        if (this.stopSiteCache.has(stopPointId)) {
            return this.stopSiteCache.get(stopPointId);
        }
        
        const siteInfo = await this.getStopPointSite(stopPointId);
        this.stopSiteCache.set(stopPointId, siteInfo);
        return siteInfo;
    }

    async getNextStopDirect(lineId, directionCode, currentStopId) {
        const cacheKey = `${lineId}_${directionCode}_${currentStopId}`;
        if (this.nextStopCache.has(cacheKey)) {
            return this.nextStopCache.get(cacheKey);
        }
        
        const client = await this.pool.connect();
        try {
            const result = await client.query(`
                SELECT 
                    bt.next_stop_point_id,
                    sp.site_id as next_site_id,
                    sp.stop_point_name as next_name
                FROM sl_bus_trips bt
                JOIN sl_bus_stop_points sp ON bt.next_stop_point_id = sp.stop_point_id
                WHERE bt.line_id = $1 AND bt.direction_code = $2 AND bt.stop_point_id = $3
                LIMIT 1
            `, [lineId, directionCode, currentStopId]);
            
            const nextStop = result.rows[0] || null;
            this.nextStopCache.set(cacheKey, nextStop);
            return nextStop;
            
        } finally {
            client.release();
        }
    }

    /**
     * Find routes with one transfer
     */
    async findTransferRoutes(originSites, destinationSites, currentTime, maxDuration, gviMonth, departuresCache) {
        try {
            console.log('Searching for transfer routes...');
            
            // Step 1: Use cached departures to create agents
            const originDepartures = new Map();
            for (const site of originSites) {
                originDepartures.set(site.siteId, departuresCache.get(site.siteId) || []);
            }

            const queryAgents = [];
            for (const [siteId, departures] of originDepartures) {
                // 限制每个site最多创建10个agents，避免过多
                const limitedDepartures = departures.slice(0, 10);
                
                for (const dep of limitedDepartures) {
                    if (!dep.journey?.id || !dep.stop_point?.id) continue;
                    
                    const originSite = originSites.find(s => s.siteId === siteId);
                    const departureStopInfo = await this.getStopPointSiteCached(dep.stop_point.id);
                    
                    if (!departureStopInfo) continue;
                    
                    const agent = new QueryAgent({
                        journeyId: dep.journey.id,
                        lineId: dep.line?.id,
                        directionCode: dep.direction_code,
                        currentStopId: dep.stop_point.id,
                        nominalTime: new Date(dep.expected),
                        departureInfo: {
                            stopPointId: dep.stop_point.id,
                            stopName: dep.stop_point.name,
                            lineDesignation: dep.line?.designation,
                            destination: dep.destination,
                            expectedTime: new Date(dep.expected)
                        },
                        originSite: originSite,
                        departureStopInfo: departureStopInfo
                    });
                    queryAgents.push(agent);
                }
            }
            
            console.log(`Created ${queryAgents.length} query agents`);

            // Step 2: Cache already loaded in planRoutes, pass it to search function
            
            // Step 3: 处理agents，使用缓存的数据
            const transferRoutes = [];
            for (const agent of queryAgents) {
                const transfers = await this.findTransferChainCached(
                    agent, 
                    destinationSites, 
                    maxDuration, 
                    gviMonth, 
                    departuresCache
                );
                transferRoutes.push(...transfers);
                
                // 限制总数，提前结束
                if (transferRoutes.length >= 20) break;
            }
            
            console.log(`Found ${transferRoutes.length} transfer routes`);
            return transferRoutes;
            
        } catch (error) {
            console.error('Failed to find transfer routes:', error.message);
            return [];
        }
    }

    /**
     * Follow a journey chain to find transfer opportunities
     */

    async findConnectionsFromCachedDepartures(departures, destinationSites, earliestTime, transferSiteId) {
        const connections = [];
        const destSiteIds = new Set(destinationSites.map(site => site.siteId));
        
        const processedKeys = new Set();

        for (const dep of departures.slice(0, 10)) {
            const depTime = new Date(dep.expected);
            if (depTime < earliestTime) continue;
            
            const journeyId = dep.journey?.id;
            const departureStopId = dep.stop_point?.id;
            
            if (!journeyId || !departureStopId) continue;
            
            // 去重检查1：stop_point + direction_code组合
            const stopKey = `${departureStopId}_${dep.direction_code}`;

            if (processedKeys.has(stopKey)) {
                console.log(`Skipping duplicate stop-direction: ${stopKey}`);
                continue;
            }
            processedKeys.add(stopKey);
            
            // 检查这个journey能否到达目的地
            const reachableDestinations = await this.checkJourneyDestinations(
                journeyId,
                dep.line?.id,
                dep.direction_code,
                departureStopId,
                destSiteIds
            );
            
            // 去重检查2：site_id组合
            const siteSeen = new Set();
            for (const destSiteId of reachableDestinations) {
                if (siteSeen.has(destSiteId)) continue;
                siteSeen.add(destSiteId);
                
                const destSite = destinationSites.find(site => site.siteId === destSiteId);
                if (destSite) {
                    connections.push({
                        journeyId,
                        lineId: dep.line?.id,
                        lineDesignation: dep.line?.designation,
                        departureTime: depTime,
                        departureStopId: departureStopId,
                        departureStopName: dep.stop_point?.name,
                        transferSiteId: transferSiteId,
                        destSiteId: destSiteId,
                        destSite: destSite,
                        directionCode: dep.direction_code
                    });
                }
            }
        }
        
        return connections.slice(0, 5);
}
/**
 * 简化版：使用实际的SL API时间表，而不是估算时间
 */
    async findTransferChainCached(agent, destinationSites, maxDuration, gviMonth, transferDeparturesCache) {
        const transferRoutes = [];
        
        try {
            /**
             * 由于 SL API 限制（最多查询 1200 秒窗口），无法获取完整 journey 时间表。
             * 使用 90 秒平均站间时间估算到达换乘站的时间。
             * 这个估算值在 10 站搜索深度内的误差是可接受的。
             */
            let currentStopId = agent.currentStopId;
            let estimatedTime = new Date(agent.nominalTime);
            const avgStopTime = 90 * 1000; // 90秒，毫秒单位
            
            // 最多查找10站
            for (let stepCount = 0; stepCount < 10; stepCount++) {
                const nextStopInfo = await this.getNextStopDirect(agent.lineId, agent.directionCode, currentStopId);
                if (!nextStopInfo) break;
                
                estimatedTime = new Date(estimatedTime.getTime() + avgStopTime);
                const transferTime = new Date(estimatedTime.getTime() + this.transferMargin * 1000);
                
                const totalTimeUsed = (transferTime.getTime() - agent.nominalTime.getTime()) / 1000;
                if (totalTimeUsed > maxDuration) break;
                
                // 使用缓存的departure数据而不是重新调用API
                const siteId = nextStopInfo.next_site_id;
                const cachedDepartures = transferDeparturesCache.get(siteId) || [];
                
                const connections = await this.findConnectionsFromCachedDepartures(
                    cachedDepartures,
                    destinationSites,
                    transferTime,
                    nextStopInfo.next_site_id
                );
                
                // 限制每个站点最多处理2个连接
                for (const connection of connections.slice(0, 2)) {
                    const marginSeconds = (connection.departureTime - estimatedTime) / 1000;
                    if (marginSeconds >= 60) {
                        const transferRoute = await this.createTransferRoutePlan(
                            agent,
                            { next_stop_point_id: nextStopInfo.next_stop_point_id, next_name: nextStopInfo.next_name },
                            { site_id: nextStopInfo.next_site_id, stop_name: nextStopInfo.next_name },
                            connection,
                            maxDuration,
                            estimatedTime,  // 使用估算的到达时间
                            gviMonth
                        );
                        if (transferRoute) {
                            transferRoutes.push(transferRoute);
                            if (transferRoutes.length >= 2) return transferRoutes; // 每个agent最多2个routes
                        }
                    }
                }
                
                currentStopId = nextStopInfo.next_stop_point_id;
            }
            
        } catch (error) {
            console.error('Failed to find transfer chain:', error.message);
        }
        
        return transferRoutes;
    }

 

    /**
     * Find connections from transfer site to destination sites
     */
    async findConnectionsToDestination(transferSiteId, destinationSites, earliestTime, maxDuration) {
        try {
            const forecastLimit = 1200;
            
            // Query departures by site_id (SL API constraint)
            const departures = await this.slApi.getDepartures(transferSiteId, forecastLimit);
            
            const connections = [];
            const destSiteIds = new Set(destinationSites.map(site => site.siteId));
            
            for (const dep of departures) {
                const depTime = new Date(dep.expected);
                if (depTime < earliestTime) continue;
                
                const journeyId = dep.journey?.id;
                const departureStopId = dep.stop_point?.id;
                if (!journeyId || !departureStopId) continue;
                
                // Check if this journey reaches any destination site
                const reachableDestinations = await this.checkJourneyDestinations(
                    journeyId, 
                    dep.line?.id, 
                    dep.direction_code, 
                    departureStopId,
                    destSiteIds
                );
                
                for (const destSiteId of reachableDestinations) {
                    const destSite = destinationSites.find(site => site.siteId === destSiteId);
                    if (!destSite) continue;
                    
                    connections.push({
                        journeyId,
                        lineId: dep.line?.id,
                        lineDesignation: dep.line?.designation,
                        departureTime: depTime,
                        departureStopId: departureStopId,
                        departureStopName: dep.stop_point?.name,
                        transferSiteId: transferSiteId,
                        destSiteId: destSiteId,
                        destSite: destSite,
                        directionCode: dep.direction_code
                    });
                }
            }
            
            return connections;
            
        } catch (error) {
            console.error(`Failed to find connections from site ${transferSiteId}:`, error.message);
            return [];
        }
    }

    /**
     * Check if a journey reaches destination sites using pre-built sequences
     */
    async checkJourneyDestinations(journeyId, lineId, directionCode, currentStopId, destSiteIds) {
        const client = await this.pool.connect();
        
        try {
            const query = `
                WITH RECURSIVE journey_path AS (
                    -- Start from current stop
                    SELECT 
                        bt.stop_point_id,
                        bt.next_stop_point_id,
                        sp.site_id,
                        1 as depth
                    FROM sl_bus_trips bt
                    JOIN sl_bus_stop_points sp ON bt.next_stop_point_id = sp.stop_point_id
                    WHERE bt.line_id = $1 
                      AND bt.direction_code = $2 
                      AND bt.stop_point_id = $3
                    
                    UNION ALL
                    
                    -- Follow the sequence forward
                    SELECT 
                        bt.stop_point_id,
                        bt.next_stop_point_id,
                        sp.site_id,
                        jp.depth + 1
                    FROM journey_path jp
                    JOIN sl_bus_trips bt ON jp.next_stop_point_id = bt.stop_point_id
                    JOIN sl_bus_stop_points sp ON bt.next_stop_point_id = sp.stop_point_id
                    WHERE bt.line_id = $1 
                      AND bt.direction_code = $2
                      AND jp.depth < 20
                )
                SELECT DISTINCT site_id
                FROM journey_path
                WHERE site_id = ANY($4::INTEGER[]);
            `;
            
            const destSiteArray = Array.from(destSiteIds);
            const result = await client.query(query, [lineId, directionCode, currentStopId, destSiteArray]);
            
            return result.rows.map(row => row.site_id);
            
        } catch (error) {
            console.error('Failed to check journey destinations:', error.message);
            return [];
        } finally {
            client.release();
        }
    }

    /**
     * Create transfer route plan using new data structure
     */
    async createTransferRoutePlan(agent, transferStop, nextStopSite, connection, maxDuration, transferArrivalTime, gviMonth) {
        try {
            // Get detailed stop information
            const transferArrivalStopInfo = nextStopSite;
            const transferDepartureStopInfo = await this.getStopPointSite(connection.departureStopId);
            
            if (!transferDepartureStopInfo) return null;
            
            // Calculate intra-site walking if needed
            let intraSiteWalk = 0;
            let intraSiteDistance = 0;
            
            if (transferArrivalStopInfo.stop_point_id !== transferDepartureStopInfo.stop_point_id) {
                intraSiteDistance = this.calculateStopPointDistance(transferArrivalStopInfo, transferDepartureStopInfo);
                intraSiteWalk = intraSiteDistance / this.walkingSpeed;
            }
            
            // Calculate timing
            const walkingToFirst = agent.originSite.walkingDistance / this.walkingSpeed;
            const firstBusRide = (transferArrivalTime - agent.departureInfo.expectedTime) / 1000;
            const transferWaiting = Math.max(
                (connection.departureTime - transferArrivalTime) / 1000 - intraSiteWalk,
                this.transferMargin
            );
            const secondBusRide = 10 * 60; // estimated
            const walkingFromFinal = connection.destSite.walkingDistance / this.walkingSpeed;
            
            const totalDuration = walkingToFirst + firstBusRide + intraSiteWalk + transferWaiting + secondBusRide + walkingFromFinal;
            
            if (totalDuration > maxDuration) return null;
            
            // Create transfer route using new structure
            return RoutePlan.createTransferRoute({
                origin: { lat: agent.originSite.lat, lon: agent.originSite.lon },
                destination: { lat: connection.destSite.lat, lon: connection.destSite.lon },
                
                // First segment
                walkingToFirst: walkingToFirst,
                walkingToFirstDistance: agent.originSite.walkingDistance,
                firstDepartureStop: agent.departureStopInfo,
                firstLineId: agent.lineId,
                firstLineDesignation: agent.departureInfo.lineDesignation,
                firstLineInfo: `${agent.departureInfo.lineDesignation} to ${agent.departureInfo.destination}`,
                firstDeparture: agent.departureInfo.expectedTime,
                firstBusRideDuration: firstBusRide,
                firstArrival: transferArrivalTime,
                
                // Transfer
                transferArrivalStop: transferArrivalStopInfo,
                transferDepartureStop: transferDepartureStopInfo,
                transferSiteId: connection.transferSiteId,
                transferSiteName: transferArrivalStopInfo.stop_name,
                intraSiteWalk: intraSiteWalk,
                intraSiteDistance: intraSiteDistance,
                transferWaiting: transferWaiting,
                
                // Second segment  
                secondLineId: connection.lineId,
                secondLineDesignation: connection.lineDesignation,
                secondLineInfo: connection.lineDesignation,
                secondDeparture: connection.departureTime,
                secondBusRideDuration: secondBusRide,
                secondArrival: new Date(connection.departureTime.getTime() + secondBusRide * 1000),
                finalArrivalStop: transferDepartureStopInfo, // Simplified - would need actual destination stop
                
                // Final segment
                walkingFromFinal: walkingFromFinal,
                walkingFromFinalDistance: connection.destSite.walkingDistance,
                
                totalDuration: totalDuration,
                gviDataMonth: gviMonth
            });
            
        } catch (error) {
            console.error('Failed to create transfer route plan:', error.message);
            return null;
        }
    }


    /**
     * Enrich routes with visualization data after selection
     * - Bus ride geometries
     * - Stops along the route
     * - Ensure walking segments have geometries
     */
    async enrichVisualizationData(routes, gviMonth) {
        console.log(`Enriching visualization data for ${routes.length} routes...`);
        
        for (const route of routes) {
            for (const segment of route.segments) {
                try {
                    switch (segment.type) {
                        case 'walking':
                            // Walking segments should already have geometry
                            // But verify and log if missing
                            if (!segment.geometry) {
                                console.warn(`Missing geometry for walking segment`);
                            }
                            break;
                            
                        case 'bus_ride':
                            // Fetch bus ride geometry and stops along route
                            await this.enrichBusRideVisualization(segment, gviMonth);
                            break;
                            
                        case 'bus_waiting':
                            // Waiting segments just need the stop point
                            // Should already be set
                            break;
                    }
                } catch (error) {
                    console.error(`Failed to enrich segment visualization:`, error.message);
                }
            }
    console.log('\n=== Visualization Data Summary ===');
    routes.forEach((route, i) => {
        console.log(`\nRoute ${i + 1} (${route.routeType}):`);
        route.segments.forEach((seg, j) => {
            console.log(`  Segment ${j + 1} (${seg.type}):`);
            console.log(`    - Has geometry: ${!!seg.geometry}`);
            if (seg.type === 'bus_ride') {
                console.log(`    - Stops along: ${seg.stopsAlong?.length || 0}`);
            }
        });
    });
    console.log('=================================\n');

        }
        
        console.log('Visualization data enrichment completed');
        return routes;
    }

    /**
     * Enrich bus ride segment with geometry and stops along route
     */
    async enrichBusRideVisualization(segment, gviMonth) {
        console.log(`\n  → Enriching bus ride segment:`);
        console.log(`    Line ID: ${segment.lineId}`);
        console.log(`    Direction: ${segment.directionCode}`);
        console.log(`    From: ${segment.startStopId} to ${segment.endStopId}`);
        
        if (!segment.startStopId || !segment.endStopId) {
            console.warn('Missing stop IDs, skipping');
            return;
        }
        
        if (!segment.lineId || segment.directionCode === undefined) {
            console.warn('Missing lineId or directionCode, skipping');
            return;
        }
        
        try {
            // Step 1: Get bus ride geometry
            console.log(`Calculating geometry...`);
            const startTime = Date.now();
            
            const busRideData = await this.dgviCalculator.calculateBusRideDGVI(
                segment.startStopId,
                segment.endStopId,
                gviMonth
            );
            
            const geometryTime = Date.now() - startTime;
            console.log(`Geometry calculated (${geometryTime}ms)`);
            
            if (busRideData.geometry) {
                segment.geometry = busRideData.geometry;
                segment.roadIds = busRideData.roadIds;
                console.log(`Stored geometry and ${busRideData.roadIds?.length || 0} road IDs`);
            } else {
                console.warn(`No geometry returned`);
            }
            
            // Step 2: Get stops along route
            console.log(`Getting stops along route...`);
            const stopsStartTime = Date.now();
            
            const stopsAlong = await this.getStopsAlongBusRide(
                segment.lineId,
                segment.directionCode,
                segment.startStopId,
                segment.endStopId
            );
            
            const stopsTime = Date.now() - stopsStartTime;
            console.log(`Got ${stopsAlong.length} stops (${stopsTime}ms)`);
            
            segment.stopsAlong = stopsAlong;
            
        } catch (error) {
            console.error(`Failed to enrich bus ride:`, error.message);
            console.error(`Error stack:`, error.stack);
        }
    }

    /**
     * Get all stops along a bus ride between start and end
     */
    async getStopsAlongBusRide(lineId, directionCode, startStopId, endStopId) {
        const client = await this.pool.connect();
        console.log(`Getting stops along bus ride: line=${lineId}, dir=${directionCode}, from=${startStopId}, to=${endStopId}`);
        
        try {
            const query = `
                WITH RECURSIVE journey_path AS (
                    -- Start from departure stop
                    SELECT 
                        bt.stop_point_id,
                        bt.next_stop_point_id,
                        sp.stop_point_name,
                        ST_X(sp.geom) as lon,
                        ST_Y(sp.geom) as lat,
                        1 as sequence_order
                    FROM sl_bus_trips bt
                    JOIN sl_bus_stop_points sp ON bt.stop_point_id = sp.stop_point_id
                    WHERE bt.line_id = $1
                    AND bt.direction_code = $2
                    AND bt.stop_point_id = $3
                    
                    UNION ALL
                    
                    -- Follow the sequence until we reach end stop
                    SELECT 
                        bt.stop_point_id,
                        bt.next_stop_point_id,
                        sp.stop_point_name,
                        ST_X(sp.geom) as lon,
                        ST_Y(sp.geom) as lat,
                        jp.sequence_order + 1
                    FROM journey_path jp
                    JOIN sl_bus_trips bt ON jp.next_stop_point_id = bt.stop_point_id
                    JOIN sl_bus_stop_points sp ON bt.stop_point_id = sp.stop_point_id
                    WHERE bt.line_id = $1
                    AND bt.direction_code = $2
                    AND jp.next_stop_point_id != $4
                    AND jp.sequence_order < 50
                )
                SELECT 
                    stop_point_id,
                    stop_point_name,
                    lon,
                    lat,
                    sequence_order
                FROM journey_path
                ORDER BY sequence_order;
            `;
            
            const result = await client.query(query, [lineId, directionCode, startStopId, endStopId]);
            
            console.log(`Found ${result.rows.length} stops along route`);
            
            return result.rows.map(row => ({
                stopPointId: row.stop_point_id,
                stopName: row.stop_point_name,
                lat: row.lat,
                lon: row.lon,
                sequenceOrder: row.sequence_order
            }));
            
        } catch (error) {
            console.error('Failed to get stops along bus ride:', error.message);
            return [];
        } finally {
            client.release();
        }
    }

    /**
     * Calculate walking distance between two stop-points
     */
    calculateStopPointDistance(stop1, stop2) {
        const R = 6371000; // Earth radius in meters
        const lat1 = stop1.lat * Math.PI / 180;
        const lat2 = stop2.lat * Math.PI / 180;
        const deltaLat = (stop2.lat - stop1.lat) * Math.PI / 180;
        const deltaLon = (stop2.lon - stop1.lon) * Math.PI / 180;
        
        const a = Math.sin(deltaLat/2) * Math.sin(deltaLat/2) +
                  Math.cos(lat1) * Math.cos(lat2) *
                  Math.sin(deltaLon/2) * Math.sin(deltaLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        
        return R * c;
    }

    /**
     * Score all routes based on time and DGVI preferences
     */
    async scoreRoutes(routes, preferences, gviMonth) {
        console.log(`Scoring ${routes.length} routes with GVI data from ${gviMonth}...`);
        
        for (const route of routes) {
            route.totalAcDGVI = await this.dgviCalculator.calculateRouteDGVI(route, gviMonth);
            route.gviDataMonth = gviMonth;
        }
        
        // Normalize scores
        const minTime = Math.min(...routes.map(r => r.totalDuration));
        const maxTime = Math.max(...routes.map(r => r.totalDuration));
        const minAcDGVI = Math.min(...routes.map(r => r.totalAcDGVI || 0));
        const maxAcDGVI = Math.max(...routes.map(r => r.totalAcDGVI || 0));
        
        for (const route of routes) {
            // Normalize to [0, 1], smaller is better for both
            const timeNormalized = maxTime > minTime ? 
                (route.totalDuration - minTime) / (maxTime - minTime) : 0;
            
            // For DGVI, higher is better, so reverse it (1 - normalized)
            const dgviNormalized = maxAcDGVI > minAcDGVI ? 
                1 - (route.totalAcDGVI - minAcDGVI) / (maxAcDGVI - minAcDGVI) : 0;
            
            // Weighted score (lower is better)
            const totalScore = preferences.time * timeNormalized + preferences.green * dgviNormalized;
            
            // Store as "higher is better" for user display
            route.durationScore = 1 - timeNormalized;
            route.acDGVIScore = 1 - dgviNormalized;
            route.totalScore = 1 - totalScore;
        }
        
        return routes;
    }

    /**
     * Validate GVI data month availability
     */
    async validateGVIDataMonth(month) {
        try {
            const availableMonths = await this.dgviCalculator.getAvailableMonths();
            return availableMonths.includes(month);
        } catch (error) {
            console.error('Failed to validate GVI data month:', error.message);
            return false;
        }
    }

    /**
     * Get available GVI data months
     */
    async getAvailableGVIMonths() {
        try {
            const months = await this.dgviCalculator.getAvailableMonths();
            const recommended = await this.dgviCalculator.getRecommendedMonth();
            
            return {
                months: months,
                latest: months[0] || "2025-08",
                recommended: recommended
            };
        } catch (error) {
            console.error('Failed to get available GVI months:', error.message);
            return {
                months: ["2025-08"],
                latest: "2025-08", 
                recommended: "2025-08"
            };
        }
    }

    /**
     * Close database connections
     */
    async close() {
        await this.pool.end();
        await this.dgviCalculator.close();
    }
}

module.exports = RoutingEngine;