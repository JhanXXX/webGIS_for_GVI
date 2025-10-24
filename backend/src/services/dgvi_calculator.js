/**
 * DGVI Calculator - Distance-adjusted GVI calculation service
 * Updated to support separated road networks for walking and bus
 */

const { Pool } = require('pg');

class DGVICalculator {
    constructor(dbConfig) {
        this.pool = new Pool(dbConfig);
    }

    /**
     * Get available GVI data months
     * @returns {Promise<Array<string>>} Array of available months in YYYY-MM format
     */
    async getAvailableMonths() {
        const client = await this.pool.connect();
        
        try {
            const query = `
                SELECT DISTINCT month 
                FROM gvi_points 
                WHERE gvi IS NOT NULL
                ORDER BY month DESC
            `;
            const result = await client.query(query);
            return result.rows.map(row => row.month);
            
        } catch (error) {
            console.error('Failed to get available months:', error.message);
            return ["2025-08"]; // fallback
        } finally {
            client.release();
        }
    }

/**
 * Calculate and store DGVI for all road segments
 * @param {string} month - Month in format 'YYYY-MM'
 * @returns {Promise<Object>} Update statistics
 */
async updateAllRoadDGVI(month) {
    const client = await this.pool.connect();
    const strategy = "walking";
    const tableName = this.getTableName(strategy);
    
    try {
        console.log(`Calculating DGVI for all roads in month ${month}...`);
        
        // Get all road IDs
        const roadsQuery = `SELECT id FROM ${tableName} ORDER BY id`;
        const roadsResult = await client.query(roadsQuery);
        const totalRoads = roadsResult.rows.length;
        
        console.log(`Processing ${totalRoads} road segments...`);
        
        let processed = 0;
        let successful = 0;
        
        // Process in batches to avoid memory issues
        const batchSize = 100;
        
        for (let i = 0; i < totalRoads; i += batchSize) {
            const batch = roadsResult.rows.slice(i, i + batchSize);
            
            for (const row of batch) {
                const roadId = row.id;
                const dgvi = await this.calculateSegmentDGVI(roadId, month, strategy);
                
                // Insert or update DGVI
                await client.query(`
                    INSERT INTO road_dgvi (road_id, month, dgvi)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (road_id, month) 
                    DO UPDATE SET dgvi = $3, updated_at = CURRENT_TIMESTAMP
                `, [roadId, month, dgvi]);
                
                if (dgvi !== 0) successful++;
                processed++;
            }
            
            console.log(`Progress: ${processed}/${totalRoads} (${Math.round(processed/totalRoads*100)}%)`);
        }
        
        // Calculate and update normalized DGVI
        await client.query(`
            WITH stats AS (
                SELECT MIN(dgvi) as min_dgvi, MAX(dgvi) as max_dgvi
                FROM road_dgvi
                WHERE month = $1
            )
            UPDATE road_dgvi
            SET dgvi_normalized = CASE 
                WHEN stats.max_dgvi = stats.min_dgvi THEN 0
                ELSE (dgvi - stats.min_dgvi) / (stats.max_dgvi - stats.min_dgvi)
            END
            FROM stats
            WHERE month = $1
        `, [month]);
        
        console.log(`DGVI calculation complete: ${successful}/${totalRoads} roads with valid DGVI`);
        
        return {
            totalRoads,
            processed,
            successful,
            month
        };
        
    } catch (error) {
        console.error('Failed to update road DGVI:', error.message);
        throw error;
    } finally {
        client.release();
    }
}


    /**
     * Get recommended month (the one with most complete data)
     * @returns {Promise<string>} Recommended month in YYYY-MM format
     */
    async getRecommendedMonth() {
        const client = await this.pool.connect();
        
        try {
            const query = `
                SELECT 
                    month,
                    COUNT(*) as point_count
                FROM gvi_points 
                WHERE gvi IS NOT NULL
                GROUP BY month
                ORDER BY point_count DESC, month DESC
                LIMIT 1
            `;
            const result = await client.query(query);
            return result.rows[0]?.month || "2025-08";
            
        } catch (error) {
            console.error('Failed to get recommended month:', error.message);
            return "2025-08"; // fallback
        } finally {
            client.release();
        }
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
                return 'stockholm_osm'; // general/original table
        }
    }

    /**
     * Calculate DGVI for a single road segment
     * @param {number} roadId - Road segment ID
     * @param {string} month - Month in format 'YYYY-MM'
     * @param {string} strategy - 'walking' or 'bus'
     * @returns {Promise<number>} DGVI value
     */
    async calculateSegmentDGVI(roadId, month, strategy = 'walking') {
        const client = await this.pool.connect();
        const tableName = this.getTableName(strategy);
        
        try {
            const query = `
                WITH road_info AS (
                    SELECT 
                        id,
                        geom,
                        length as road_length
                    FROM ${tableName} 
                    WHERE id = $1
                ),
                matched_gvi_points AS (
                    SELECT 
                        ST_LineLocatePoint(
                            ST_LineMerge(r.geom),  -- 合并MultiLineString
                            g.geometry
                        ) as position,
                        g.gvi as gvi_value
                    FROM road_info r
                    JOIN gvi_points g ON ST_Intersects(
                        ST_Buffer(r.geom::geography, 1)::geometry,
                        g.geometry
                    )
                    WHERE g.month = $2 AND g.gvi IS NOT NULL
                ),
                points_with_endpoints AS (
                    SELECT position, gvi_value FROM matched_gvi_points
                    
                    UNION ALL
                    
                    SELECT 
                        0.0 as position,
                        COALESCE(
                            (SELECT gvi_value FROM matched_gvi_points ORDER BY position LIMIT 1),
                            0.0
                        ) as gvi_value
                    WHERE NOT EXISTS (
                        SELECT 1 FROM matched_gvi_points WHERE position = 0.0
                    )
                    
                    UNION ALL
                    
                    SELECT 
                        1.0 as position,
                        COALESCE(
                            (SELECT gvi_value FROM matched_gvi_points ORDER BY position DESC LIMIT 1),
                            0.0
                        ) as gvi_value
                    WHERE NOT EXISTS (
                        SELECT 1 FROM matched_gvi_points WHERE position = 1.0
                    )
                    
                    ORDER BY position
                ),
                segment_intervals AS (
                    SELECT 
                        position as start_pos,
                        LEAD(position) OVER (ORDER BY position) as end_pos,
                        gvi_value as start_gvi,
                        LEAD(gvi_value) OVER (ORDER BY position) as end_gvi,
                        (SELECT road_length FROM road_info) as total_length
                    FROM points_with_endpoints
                )
                SELECT 
                    COALESCE(
                        SUM(
                            (end_pos - start_pos) * total_length * ((start_gvi + end_gvi) / 2.0 - 1.0)
                        ),
                        0.0
                    ) as dgvi
                FROM segment_intervals
                WHERE end_pos IS NOT NULL;
            `;
            
            const result = await client.query(query, [roadId, month]);
            return result.rows[0]?.dgvi || 0.0;
            
        } catch (error) {
            console.error(`Failed to calculate DGVI for road ${roadId} in ${tableName}:`, error.message);
            return 0.0;
        } finally {
            client.release();
        }
    }

        /**
         * Calculate DGVI accumulation for a walking path
         * @param {Array<number>} roadIds - Array of road segment IDs
         * @param {string} month - Month in format 'YYYY-MM'
         * @returns {Promise<number>} Total DGVI accumulation
         */
        async calculateWalkingDGVI(roadIds, month) {
            if (!roadIds || roadIds.length === 0) return 0.0;
            
            try {
                let totalDGVI = 0.0;
                const strategy = "walking";
                
                // Calculate DGVI for each road segment
                for (const roadId of roadIds) {
                    const segmentDGVI = await this.calculateSegmentDGVI(roadId, month, strategy);
                    totalDGVI += segmentDGVI;
                }
                
                return totalDGVI;
                
            } catch (error) {
                console.error('Failed to calculate walking DGVI:', error.message);
                return 0.0;
            }
        }

    /**
     * Calculate DGVI for bus stop waiting area (200m radius)
     * @param {Object} stopGeom - Stop point geometry {lat, lon}
     * @param {string} month - Month in format 'YYYY-MM'
     * @returns {Promise<number>} DGVI accumulation for waiting area
     */
    async calculateWaitingDGVI(stopGeom, month) {
        const client = await this.pool.connect();
        const strategy = "walking";
        const tableName = this.getTableName(strategy);
        
        try {
            const query = `
                WITH stop_point AS (
                    SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) as geom
                ),
                nearby_roads AS (
                    SELECT r.id as road_id
                    FROM ${tableName} r, stop_point s
                    WHERE ST_DWithin(r.geom::geography, s.geom::geography, 200)
                ),
                road_dgvi AS (
                    SELECT 
                        nr.road_id,
                        COALESCE(
                            (
                                WITH road_info AS (
                                    SELECT geom, length as road_length
                                    FROM ${tableName} WHERE id = nr.road_id
                                ),
                                matched_points AS (
                                    SELECT AVG(g.gvi) as avg_gvi
                                    FROM road_info r
                                    JOIN gvi_points g ON ST_Intersects(
                                        ST_Buffer(r.geom::geography, 1)::geometry,
                                        g.geometry
                                    )
                                    WHERE g.month = $3 AND g.gvi IS NOT NULL
                                ),
                                road_length AS (
                                    SELECT road_length FROM road_info
                                )
                                SELECT 
                                    CASE 
                                        WHEN mp.avg_gvi IS NOT NULL 
                                        THEN rl.road_length * mp.avg_gvi - rl.road_length
                                        ELSE 0.0
                                    END
                                FROM matched_points mp, road_length rl
                            ),
                            0.0
                        ) as road_dgvi
                    FROM nearby_roads nr
                )
                SELECT COALESCE(SUM(road_dgvi), 0.0) as total_dgvi
                FROM road_dgvi;
            `;
            
            const result = await client.query(query, [stopGeom.lon, stopGeom.lat, month]);
            return result.rows[0]?.total_dgvi || 0.0;
            
        } catch (error) {
            console.error('Failed to calculate waiting DGVI:', error.message);
            return 0.0;
        } finally {
            client.release();
        }
    }

    /**
     * Calculate DGVI for bus ride segment by reconstructing shortest path
     * @param {number} startStopId - Starting stop point ID
     * @param {number} endStopId - Ending stop point ID
     * @param {string} month - Month in format 'YYYY-MM'
     * @returns {Promise<Object>} {dgvi: number, geometry: GeoJSON, roadIds: Array}
     */
    async calculateBusRideDGVI(startStopId, endStopId, month) {
        const client = await this.pool.connect();
        const strategy = "walking";
        const tableName = this.getTableName(strategy);
        
        try {
            // Get stop point coordinates
            const stopsQuery = `
                SELECT 
                    stop_point_id,
                    ST_X(geom) as lon,
                    ST_Y(geom) as lat,
                    geom
                FROM sl_bus_stop_points 
                WHERE stop_point_id IN ($1, $2);
            `;
            
            const stopsResult = await client.query(stopsQuery, [startStopId, endStopId]);
            
            if (stopsResult.rows.length < 2) {
                console.warn(`Missing stop points: ${startStopId}, ${endStopId}`);
                return { dgvi: 0.0, geometry: null, roadIds: [] };
            }
            
            const startStop = stopsResult.rows.find(s => s.stop_point_id === startStopId);
            const endStop = stopsResult.rows.find(s => s.stop_point_id === endStopId);
            
            // Find nearest road nodes for both stops
            const nearestNodesQuery = `
                SELECT 
                    n.id as node_id,
                    ST_Distance(n.the_geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
                FROM ${tableName}_vertices_pgr n
                ORDER BY n.the_geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
                LIMIT 1;
            `;
            
            const startNodeResult = await client.query(nearestNodesQuery, [startStop.lon, startStop.lat]);
            const endNodeResult = await client.query(nearestNodesQuery, [endStop.lon, endStop.lat]);
            
            if (startNodeResult.rows.length === 0 || endNodeResult.rows.length === 0) {
                console.warn(`Cannot find nearest nodes for stops: ${startStopId}, ${endStopId}`);
                return { dgvi: 0.0, geometry: null, roadIds: [] };
            }
            
            const startNodeId = startNodeResult.rows[0].node_id;
            const endNodeId = endNodeResult.rows[0].node_id;
            
            // Calculate shortest path using current length calculation
            const routeQuery = `
                WITH route_segments AS (
                    SELECT 
                        r.seq,
                        r.edge as road_id,
                        e.geom
                    FROM pgr_dijkstra(
                        'SELECT id, source, target, ST_Length(geom::geography) as cost FROM ${tableName}',
                        $1::bigint, $2::bigint, false
                    ) r
                    JOIN ${tableName} e ON r.edge = e.id
                    ORDER BY r.seq
                )
                SELECT 
                    array_agg(road_id ORDER BY seq) as road_ids,
                    ST_AsGeoJSON(ST_LineMerge(ST_Union(geom ORDER BY seq))) as merged_geom
                FROM route_segments;
            `;
             
            const routeResult = await client.query(routeQuery, [startNodeId, endNodeId]);

            if (routeResult.rows.length === 0) {
                console.warn(`No route found between nodes: ${startNodeId}, ${endNodeId}`);
                return { dgvi: 0.0, geometry: null, roadIds: [] };
            }

            const row = routeResult.rows[0];
            const roadIds = row.road_ids;
            const dgvi = await this.calculateWalkingDGVI(roadIds, month);

            // Parse merged geometry
            const routeGeometry = JSON.parse(row.merged_geom);

            return {
                dgvi: dgvi,
                geometry: routeGeometry,
                roadIds: roadIds
            };
            
        } catch (error) {
            console.error(`Failed to calculate bus ride DGVI from ${startStopId} to ${endStopId}:`, error.message);
            return { dgvi: 0.0, geometry: null, roadIds: [] };
        } finally {
            client.release();
        }
    }

    // ... 其余方法保持不变 ...
    /**
     * Calculate total DGVI accumulation for a complete route plan
     * @param {RoutePlan} routePlan - Route plan object with segments
     * @param {string} month - Month in format 'YYYY-MM'
     * @returns {Promise<number>} Total DGVI accumulation
     */
    async calculateRouteDGVI(routePlan, month) {
        try {
            let totalDGVI = 0.0;
            
            for (const segment of routePlan.segments) {
                switch (segment.type) {
                    case 'walking':
                        if (segment.roadIds && segment.roadIds.length > 0) {
                            const walkingDGVI = await this.calculateWalkingDGVI(segment.roadIds, month);
                            totalDGVI += walkingDGVI;
                        }
                        break;
                        
                    case 'bus_waiting':
                        if (segment.stopGeom) {
                            const waitingDGVI = await this.calculateWaitingDGVI(segment.stopGeom, month);
                            totalDGVI += waitingDGVI;
                        }
                        break;
                        
                    case 'bus_ride':
                        // bus_ride 不计算 DGVI，但需要重构路径用于可视化
                        if (segment.startStopId && segment.endStopId) {
                            const busRideResult = await this.calculateBusRideDGVI(
                                segment.startStopId, 
                                segment.endStopId, 
                                month
                            );
                            
                            // 不累加 DGVI！乘客在车上无法感知绿化
                            // totalDGVI += busRideResult.dgvi;  // 注释掉这行
                            
                            // 但要保存 geometry 和 roadIds 用于可视化
                            if (!segment.geometry && busRideResult.geometry) {
                                segment.geometry = busRideResult.geometry;
                            }
                            if (!segment.roadIds && busRideResult.roadIds) {
                                segment.roadIds = busRideResult.roadIds;
                            }
                            
                            console.log(`Bus ride segment: geometry reconstructed, DGVI NOT counted`);
                        }
                        break;
                        
                    default:
                        console.warn(`Unknown segment type for DGVI calculation: ${segment.type}`);
                }
            }

            console.log(`Total route DGVI: ${totalDGVI.toFixed(2)}`);
            return totalDGVI;
            
        } catch (error) {
            console.error('Failed to calculate route DGVI:', error.message);
            return 0.0;
        }
    }

    /**
     * Get DGVI statistics for a specific month
     * @param {string} month - Month in format 'YYYY-MM'
     * @returns {Promise<Object>} DGVI statistics
     */
    async getDGVIStatistics(month) {
        const client = await this.pool.connect();
        
        try {
            const query = `
                WITH gvi_stats AS (
                    SELECT 
                        COUNT(*) as total_gvi_points,
                        AVG(gvi) as avg_gvi,
                        MIN(gvi) as min_gvi,
                        MAX(gvi) as max_gvi,
                        STDDEV(gvi) as stddev_gvi
                    FROM gvi_points 
                    WHERE month = $1 AND gvi IS NOT NULL
                ),
                road_coverage AS (
                    SELECT COUNT(DISTINCT w.id) as roads_with_nearby_gvi
                    FROM stockholm_osm w
                    WHERE EXISTS (
                        SELECT 1 FROM gvi_points g 
                        WHERE g.month = $1 
                        AND ST_DWithin(w.geom::geography, g.geometry::geography, 1)
                    )
                ),
                total_roads AS (
                    SELECT COUNT(*) as total_roads FROM stockholm_osm
                )
                SELECT 
                    gs.*,
                    rc.roads_with_nearby_gvi,
                    tr.total_roads
                FROM gvi_stats gs, road_coverage rc, total_roads tr;
            `;
            
            const result = await client.query(query, [month]);
            const stats = result.rows[0];
            
            return {
                month: month,
                total_gvi_points: parseInt(stats.total_gvi_points),
                avg_gvi: parseFloat(stats.avg_gvi) || 0,
                min_gvi: parseFloat(stats.min_gvi) || 0,
                max_gvi: parseFloat(stats.max_gvi) || 0,
                stddev_gvi: parseFloat(stats.stddev_gvi) || 0,
                roads_with_gvi: parseInt(stats.roads_with_nearby_gvi),
                total_roads: parseInt(stats.total_roads),
                coverage_ratio: stats.total_roads > 0 ? 
                    (parseInt(stats.roads_with_nearby_gvi) / parseInt(stats.total_roads)) : 0
            };
            
        } catch (error) {
            console.error('Failed to get DGVI statistics:', error.message);
            return null;
        } finally {
            client.release();
        }
    }

    /**
     * Get statistics for all available months
     * @returns {Promise<Array>} Array of monthly statistics
     */
    async getAllMonthsStatistics() {
        try {
            const availableMonths = await this.getAvailableMonths();
            const allStats = [];
            
            for (const month of availableMonths) {
                const stats = await this.getDGVIStatistics(month);
                if (stats) {
                    allStats.push(stats);
                }
            }
            
            return allStats;
            
        } catch (error) {
            console.error('Failed to get all months statistics:', error.message);
            return [];
        }
    }

    /**
     * Validate month format and data availability
     * @param {string} month - Month string to validate
     * @returns {Promise<Object>} Validation result
     */
    async validateMonth(month) {
        // Check format
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return {
                isValid: false,
                error: 'Invalid month format. Use YYYY-MM format.'
            };
        }
        
        // Check data availability
        try {
            const availableMonths = await this.getAvailableMonths();
            if (!availableMonths.includes(month)) {
                return {
                    isValid: false,
                    error: `No GVI data available for month ${month}`,
                    availableMonths: availableMonths
                };
            }
            
            return {
                isValid: true,
                message: `GVI data available for month ${month}`
            };
            
        } catch (error) {
            return {
                isValid: false,
                error: 'Failed to validate month availability'
            };
        }
    }

    /**
     * Close database connection
     */
    async close() {
        await this.pool.end();
    }
}

module.exports = DGVICalculator;