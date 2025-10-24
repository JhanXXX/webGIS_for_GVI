/**
 * Data Preprocessor - SL Data Preprocessing Service
 * Handles data transformation and database storage for SL API data
 */

const { Pool } = require('pg');
const SLApiService = require('./sl_api_service');

class DataPreprocessor {
    constructor(dbConfig) {
        this.pool = new Pool(dbConfig);
        this.slApi = new SLApiService();
    }

    /**
     * Initialize database tables for SL data
     */
    async initializeTables() {
        const client = await this.pool.connect();
        
        try {
            console.log('Initializing SL database tables...');
            
            // Create sl_bus_sites table
            await client.query(`
                CREATE TABLE IF NOT EXISTS sl_bus_sites (
                    site_id INTEGER PRIMARY KEY,
                    geom GEOMETRY(POINT, 4326),
                    site_name VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_sl_bus_sites_geom 
                ON sl_bus_sites USING GIST(geom);
            `);
            
            // Create sl_bus_stop_points table
            await client.query(`
                CREATE TABLE IF NOT EXISTS sl_bus_stop_points (
                    stop_point_id INTEGER PRIMARY KEY,
                    site_id INTEGER,
                    geom GEOMETRY(POINT, 4326),
                    stop_point_name VARCHAR(255),
                    direction_code INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_sl_bus_stop_points_geom 
                ON sl_bus_stop_points USING GIST(geom);
                
                CREATE INDEX IF NOT EXISTS idx_sl_bus_stop_points_site_id 
                ON sl_bus_stop_points(site_id);
            `);
            
            // Create sl_bus_trips table (route sequences)
            await client.query(`
                CREATE TABLE IF NOT EXISTS sl_bus_trips (
                    id SERIAL PRIMARY KEY,
                    line_id INTEGER,
                    line_designation VARCHAR(50),
                    direction_code INTEGER,
                    stop_point_id INTEGER,
                    next_stop_point_id INTEGER,
                    journey_id BIGINT,
                    sequence_order INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    
                    UNIQUE(line_id, direction_code, stop_point_id, next_stop_point_id)
                );
                
                CREATE INDEX IF NOT EXISTS idx_sl_bus_trips_line_direction 
                ON sl_bus_trips(line_id, direction_code);
                
                CREATE INDEX IF NOT EXISTS idx_sl_bus_trips_stop_point 
                ON sl_bus_trips(stop_point_id);
            `);
            
            console.log('Database tables initialized successfully');
            
        } catch (error) {
            console.error('Failed to initialize tables:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Process and store transport sites
     */
    async processSites() {
        const client = await this.pool.connect();
        
        try {
            console.log('Processing transport sites...');
            
            const sites = await this.slApi.getTransportSites();
            
            // Clear existing data
            await client.query('DELETE FROM sl_bus_sites');
            
            // Insert sites data
            const insertQuery = `
                INSERT INTO sl_bus_sites (site_id, geom, site_name)
                VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4)
                ON CONFLICT (site_id) DO UPDATE SET
                    geom = EXCLUDED.geom,
                    site_name = EXCLUDED.site_name
            `;
            
            let insertedCount = 0;
            for (const site of sites) {
                if (site.lat && site.lon) {
                    await client.query(insertQuery, [
                        site.id,
                        site.lon,
                        site.lat,
                        site.name
                    ]);
                    insertedCount++;
                }
            }
            
            console.log(`Processed ${insertedCount} transport sites`);
            
        } catch (error) {
            console.error('Failed to process sites:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Process and store bus stop points
     */
    async processStopPoints() {
        const client = await this.pool.connect();
        
        try {
            console.log('Processing bus stop points...');
            
            const stopPoints = await this.slApi.getSLBusStops();
            
            // Clear existing data
            await client.query('DELETE FROM sl_bus_stop_points');
            
            // Insert stop points data
            const insertQuery = `
                INSERT INTO sl_bus_stop_points (stop_point_id, site_id, geom, stop_point_name, direction_code)
                VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6)
                ON CONFLICT (stop_point_id) DO UPDATE SET
                    site_id = EXCLUDED.site_id,
                    geom = EXCLUDED.geom,
                    stop_point_name = EXCLUDED.stop_point_name,
                    direction_code = EXCLUDED.direction_code
            `;
            
            let insertedCount = 0;
            for (const stop of stopPoints) {
                if (stop.lat && stop.lon && stop.stop_area?.id) {
                    // Extract direction from local_num or use 1 as default
                    const directionCode = stop.local_num || 1;
                    
                    await client.query(insertQuery, [
                        stop.id,
                        stop.stop_area.id, // site_id
                        stop.lon,
                        stop.lat,
                        stop.name,
                        directionCode
                    ]);
                    insertedCount++;
                }
            }
            
            console.log(`Processed ${insertedCount} bus stop points`);
            
        } catch (error) {
            console.error('Failed to process stop points:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Process and store bus route sequences
     * @param {number} maxSites - Maximum number of sites to process (for testing)
     */
    async processRouteSequences(maxSites = null) {
        const client = await this.pool.connect();
        
        try {
            console.log('Processing bus route sequences...');
            
            const sequences = await this.slApi.buildBusRouteSequences(maxSites);
            
            // Clear existing data
            await client.query('DELETE FROM sl_bus_trips');
            
            // Insert route sequences with sequence_order for proper ordering
            const insertQuery = `
                INSERT INTO sl_bus_trips 
                (line_id, line_designation, direction_code, stop_point_id, next_stop_point_id, journey_id, sequence_order)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (line_id, direction_code, stop_point_id, next_stop_point_id) 
                DO UPDATE SET 
                    journey_id = EXCLUDED.journey_id,
                    sequence_order = EXCLUDED.sequence_order
            `;
            
            let insertedCount = 0;
            for (let i = 0; i < sequences.length; i++) {
                const seq = sequences[i];
                try {
                    await client.query(insertQuery, [
                        seq.line_id,
                        seq.line_designation,
                        seq.direction_code,
                        seq.stop_point_id,
                        seq.next_stop_point_id,
                        seq.journey_id,
                        i + 1 // Use index as sequence_order
                    ]);
                    insertedCount++;
                } catch (err) {
                    // Skip foreign key constraint errors (missing stop points)
                    if (!err.message.includes('violates foreign key constraint')) {
                        console.warn(`Warning: Failed to insert sequence:`, err.message);
                    }
                }
            }
            
            console.log(`Processed ${insertedCount} route sequences`);
            
        } catch (error) {
            console.error('Failed to process route sequences:', error.message);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Run complete data preprocessing pipeline
     * @param {Object} options - Processing options
     */
    async runPreprocessing(options = {}) {
        const { maxSites = null, skipRouteSequences = false } = options;
        
        try {
            console.log('Starting SL data preprocessing pipeline...');
            
            // await this.initializeTables();
            // await this.processSites();
            // await this.processStopPoints();
            
            if (!skipRouteSequences) {
                await this.processRouteSequences(maxSites);
            }
            
            // Generate statistics
            await this.generateStatistics();
            
            console.log('SL data preprocessing completed successfully!');
            
        } catch (error) {
            console.error('Data preprocessing failed:', error.message);
            throw error;
        }
    }

    /**
     * Generate and display processing statistics
     */
    async generateStatistics() {
        const client = await this.pool.connect();
        
        try {
            const stats = await client.query(`
                SELECT 
                    'Sites' as table_name,
                    COUNT(*) as record_count
                FROM sl_bus_sites
                
                UNION ALL
                
                SELECT 
                    'Stop Points' as table_name,
                    COUNT(*) as record_count
                FROM sl_bus_stop_points
                
                UNION ALL
                
                SELECT 
                    'Route Sequences' as table_name,
                    COUNT(*) as record_count
                FROM sl_bus_trips
                
                UNION ALL
                
                SELECT 
                    'Unique Lines' as table_name,
                    COUNT(DISTINCT line_id) as record_count
                FROM sl_bus_trips
            `);
            
            console.log('\nProcessing Statistics:');
            console.log('========================');
            for (const row of stats.rows) {
                console.log(`${row.table_name}: ${row.record_count}`);
            }
            console.log('========================\n');
            
        } catch (error) {
            console.error('Failed to generate statistics:', error.message);
        } finally {
            client.release();
        }
    }

    /**
     * Close database connection
     */
    async close() {
        await this.pool.end();
    }
}

module.exports = DataPreprocessor;