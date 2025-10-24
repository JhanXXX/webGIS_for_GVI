/**
 * Data Builder Tool - Simplified incremental sequence builder
 */

const { Pool } = require('pg');
const SLApiService = require('../services/sl_api_service');
const DataPreprocessor = require('../services/data_preprocessor');




class DataBuilder {
    constructor() {
        this.dbConfig = {
            user: process.env.POSTGRES_USER || 'gvi_user',
            host: process.env.POSTGRES_HOST || 'postgres',
            database: process.env.POSTGRES_DB || 'gvi_app',
            password: process.env.POSTGRES_PASSWORD || 'gvi_pass',
            port: process.env.POSTGRES_PORT || 5432,
        };
        
        this.pool = new Pool(this.dbConfig);
        this.slApi = new SLApiService();
        this.preprocessor = new DataPreprocessor(this.dbConfig);
    }

    /**
     * Main build process with different strategies
     */
    async buildData(strategy = 'incremental', options = {}) {
        console.log(`Starting data build with strategy: ${strategy}`);

        try {
            await this.preprocessor.initializeTables();

            switch (strategy) {
                case 'setup':
                    await this.setupBaseTables();
                    break;
                    
                case 'sequences':
                    await this.addSequencesIncremental(options);
                    break;
                    
                case 'test':
                    await this.buildTestData(options);
                    break;
                    
                default:
                    throw new Error(`Unknown strategy: ${strategy}`);
            }

            const finalStats = await this.generateBuildStatistics();
            console.log(`Build completed. Final statistics:`, finalStats);
            return finalStats;

        } catch (error) {
            console.error(`Data build failed:`, error.message);
            throw error;
        }
    }

    /**
     * Setup base tables (sites and stop points) - run once
     */
    async setupBaseTables() {
        console.log(`Setting up base tables...`);
        await this.preprocessor.processSites();
        await this.preprocessor.processStopPoints();
        console.log(`Base tables setup completed`);
    }

    /**
     * Add sequences incrementally - run periodically
     */
    async addSequencesIncremental(options) {
        const { batchSize = 50, maxSites = null } = options;
        
        console.log(`Adding sequences incrementally...`);
        
        const client = await this.pool.connect();
        
        try {
            const sitesQuery = `
                SELECT site_id, site_name 
                FROM sl_bus_sites 
                ORDER BY site_id
                ${maxSites ? `LIMIT ${maxSites}` : ''}
            `;
            
            const sitesResult = await client.query(sitesQuery);
            const allSites = sitesResult.rows;
            
            console.log(`Processing ${allSites.length} sites in batches of ${batchSize}`);
            
            let totalNewSequences = 0;
            
            for (let i = 0; i < allSites.length; i += batchSize) {
                const batch = allSites.slice(i, i + batchSize);
                const batchNum = Math.floor(i / batchSize) + 1;
                const totalBatches = Math.ceil(allSites.length / batchSize);
                
                console.log(`Processing batch ${batchNum}/${totalBatches}`);
                
                const newSequences = await this.processSiteBatch(batch);
                totalNewSequences += newSequences;
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            console.log(`Added ${totalNewSequences} new sequences`);
            
        } finally {
            client.release();
        }
    }

    /**
     * Process a batch of sites for route sequence building
     */
    async processSiteBatch(sites) {
        const siteIds = sites.map(s => s.site_id);
        const forecastLimit = 1200; // 20 minutes - SL API maximum
        
        try {
            const departuresMap = await this.slApi.getBatchDepartures(siteIds, forecastLimit);
            
            const journeyRoutes = new Map();
            
            for (const [siteId, departures] of departuresMap) {
                for (const departure of departures) {
                    const journeyId = departure.journey?.id;
                    if (!journeyId) continue;
                    
                    const stopInfo = {
                        site_id: siteId,
                        stop_point_id: departure.stop_point?.id,
                        line_id: departure.line?.id,
                        direction_code: departure.direction_code,
                        expected_time: departure.expected
                    };
                    
                    if (!journeyRoutes.has(journeyId)) {
                        journeyRoutes.set(journeyId, []);
                    }
                    journeyRoutes.get(journeyId).push(stopInfo);
                }
            }
            
            return await this.saveRouteSequences(journeyRoutes);
            
        } catch (error) {
            console.error(`Failed to process batch:`, error.message);
            return 0;
        }
    }

    /**
     * Save journey route sequences to database incrementally
     */
    async saveRouteSequences(journeyRoutes) {
        const client = await this.pool.connect();
        
        try {
            let savedCount = 0;
            
            for (const [journeyId, stops] of journeyRoutes) {
                if (stops.length < 2) continue;
                
                stops.sort((a, b) => new Date(a.expected_time) - new Date(b.expected_time));
                
                for (let i = 0; i < stops.length - 1; i++) {
                    const current = stops[i];
                    const next = stops[i + 1];
                    
                    if (!current.stop_point_id || !next.stop_point_id || 
                        current.stop_point_id === next.stop_point_id) {
                        continue;  // 跳过无效的sequence
                    }
                    
                    const insertQuery = `
                        INSERT INTO sl_bus_trips 
                        (line_id, direction_code, stop_point_id, next_stop_point_id, journey_id)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (line_id, direction_code, stop_point_id, next_stop_point_id) 
                        DO NOTHING
                    `;
                    
                    try {
                        const result = await client.query(insertQuery, [
                            current.line_id,
                            current.direction_code,
                            current.stop_point_id,
                            next.stop_point_id,
                            journeyId
                        ]);
                        
                        if (result.rowCount > 0) {
                            savedCount++;
                        }
                    } catch (err) {
                        if (!err.message.includes('violates foreign key constraint')) {
                            console.warn(`Failed to save sequence:`, err.message);
                        }
                    }
                }
            }
            
            console.log(`Saved ${savedCount} new sequences`);
            return savedCount;
            
        } finally {
            client.release();
        }
    }

    /**
     * Build small test dataset
     */
    async buildTestData(options) {
        console.log(`Building test dataset...`);
        
        await this.setupBaseTables();
        await this.addSequencesIncremental({
            ...options,
            maxSites: Math.min(options.maxSites || 20, 20),
            batchSize: 10
        });
    }

    /**
     * Check existing data status
     */
    async checkExistingData() {
        const client = await this.pool.connect();
        
        try {
            const stats = await client.query(`
                SELECT 
                    (SELECT COUNT(*) FROM sl_bus_sites) as sites_count,
                    (SELECT COUNT(*) FROM sl_bus_stop_points) as stop_points_count,
                    (SELECT COUNT(*) FROM sl_bus_trips) as route_sequences_count,
                    (SELECT COUNT(DISTINCT line_id) FROM sl_bus_trips) as unique_lines_count
            `);
            
            const row = stats.rows[0];
            
            return {
                sitesCount: parseInt(row.sites_count),
                stopPointsCount: parseInt(row.stop_points_count),
                routeSequencesCount: parseInt(row.route_sequences_count),
                uniqueLinesCount: parseInt(row.unique_lines_count)
            };
            
        } finally {
            client.release();
        }
    }

    /**
     * Generate build statistics
     */
    async generateBuildStatistics() {
        const client = await this.pool.connect();
        
        try {
            const query = `
                SELECT 
                    (SELECT COUNT(*) FROM sl_bus_sites) as total_sites,
                    (SELECT COUNT(*) FROM sl_bus_stop_points) as total_stop_points,
                    (SELECT COUNT(*) FROM sl_bus_trips) as total_sequences,
                    (SELECT COUNT(DISTINCT line_id) FROM sl_bus_trips) as unique_lines,
                    (SELECT COUNT(DISTINCT direction_code) FROM sl_bus_trips) as unique_directions
            `;
            
            const result = await client.query(query);
            return result.rows[0];
            
        } finally {
            client.release();
        }
    }

    /**
     * Close connections
     */
    async close() {
        await this.pool.end();
    }
}

// CLI interface
if (require.main === module) {
    const args = process.argv.slice(2);
    const strategy = args[0] || 'test';
    
    const options = {};
    for (let i = 1; i < args.length; i += 2) {
        const key = args[i].replace('--', '');
        const value = args[i + 1];
        
        if (value === 'true') options[key] = true;
        else if (value === 'false') options[key] = false;
        else if (!isNaN(value)) options[key] = parseInt(value);
        else options[key] = value;
    }
    
    const builder = new DataBuilder();
    
    builder.buildData(strategy, options)
        .then(() => {
            console.log(`Build completed successfully`);
            process.exit(0);
        })
        .catch(error => {
            console.error(`Build failed:`, error.message);
            process.exit(1);
        })
        .finally(() => {
            builder.close();
        });
}

module.exports = DataBuilder;