/**
 * SL API Service - Stockholm Public Transport API Integration
 * Handles all API calls to SL (Storstockholms Lokaltrafik)
 */

const axios = require('axios');
const { setTimeout } = require('timers/promises');

class SLApiService {
    constructor() {
        this.baseUrl = 'https://transport.integration.sl.se/v1';
        this.headers = {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            'Accept-Encoding': 'identity'
        };
        this.apiDelay = 500; // 100ms delay between calls
    }

    /**
     * Get all transport sites (static data)
     * @returns {Promise<Array>} Array of site objects
     */
    async getTransportSites() {
        try {
            const url = `${this.baseUrl}/sites?expand=true`;
            const response = await axios.get(url, { headers: this.headers });
            
            if (response.status === 200) {
                console.log(`Retrieved ${response.data.length} transport sites`);
                return response.data;
            }
            throw new Error(`API returned status ${response.status}`);
            
        } catch (error) {
            console.error('Failed to get transport sites:', error.message);
            throw error;
        }
    }

    /**
     * Get all SL bus stop points (static data)
     * @returns {Promise<Array>} Array of bus stop objects
     */
    async getSLBusStops() {
        try {
            const url = `${this.baseUrl}/stop-points`;
            const response = await axios.get(url, { headers: this.headers });
            
            if (response.status === 200) {
                // Filter for SL bus stops only
                const slBusStops = response.data.filter(stop => 
                    stop.type === 'BUSSTOP' && 
                    stop.transport_authority?.name === 'Storstockholms Lokaltrafik'
                );
                
                console.log(`Retrieved ${slBusStops.length} SL bus stops`);
                return slBusStops;
            }
            throw new Error(`API returned status ${response.status}`);
            
        } catch (error) {
            console.error('Failed to get SL bus stops:', error.message);
            throw error;
        }
    }
    
    /**
     * Get departures for a specific site
     * @param {number} siteId - Site ID
     * @param {number} forecastLimit - Forecast time in seconds
     * @returns {Promise<Array>} Array of departure objects
     */
    async getDepartures(siteId, forecastLimit = 1200) {
        try {
            // const forecast = Math.min(forecastLimit, 1200);
            const forecast = 1200;
            const url = `${this.baseUrl}/sites/${siteId}/departures?forecast=${forecast}`;
            const response = await axios.get(url, { 
                headers: { 'accept': 'application/json' } 
            });
            
            if (response.status === 200) {
                // Filter for bus departures only
                const busDepartures = response.data.departures?.filter(dep => 
                    dep.line?.transport_mode === 'BUS'
                ) || [];
                
                return busDepartures;
            }
            throw new Error(`API returned status ${response.status}`);
            
        } catch (error) {
            console.error(`Failed to get departures for site ${siteId}:`, error.message);
            return []; // Return empty array instead of throwing for individual site failures
        } finally {
            await setTimeout(this.apiDelay);
        }
    }

    /**
     * Batch get departures for multiple sites with delay
     * @param {Array<number>} siteIds - Array of site IDs
     * @param {number} forecastLimit - Forecast time in seconds
     * @returns {Promise<Map>} Map of siteId -> departures array
     */
    async getBatchDepartures(siteIds, forecastLimit) {
        const results = new Map();
        
        console.log(`Starting batch departures fetch for ${siteIds.length} sites...`);
        
        for (let i = 0; i < siteIds.length; i++) {
            const siteId = siteIds[i];
            
            try {
                const departures = await this.getDepartures(siteId, forecastLimit);
                results.set(siteId, departures);
                
                if ((i + 1) % 10 === 0) {
                    console.log(`Processed ${i + 1}/${siteIds.length} sites`);
                }
                
                // Add delay to avoid overwhelming the API
                if (i < siteIds.length - 1) {
                    await setTimeout(this.apiDelay);
                }
                
            } catch (error) {
                console.error(`Failed to get departures for site ${siteId}:`, error.message);
                results.set(siteId, []);
            }
        }
        
        console.log(`Completed batch departures fetch`);
        return results;
    }

    /**
     * Build bus route sequences by analyzing journey patterns
     * @param {number} maxSites - Maximum number of sites to analyze (for testing)
     * @returns {Promise<Array>} Array of route sequence objects
     */
    async buildBusRouteSequences(maxSites = null) {
        try {
            console.log('Starting bus route sequence building...');
            
            // Get all sites first
            const sites = await this.getTransportSites();
            const sitesToProcess = maxSites ? sites.slice(0, maxSites) : sites;
            
            // Get departures for all sites (next 20 minutes)
            const siteIds = sitesToProcess.map(site => site.id);
            const forecastLimit = 20 * 60; 
            const departuresMap = await this.getBatchDepartures(siteIds, forecastLimit);
            
            // Analyze journey patterns to build sequences
            const journeyRoutes = new Map(); // journeyId -> array of stops with times
            
            // Group all departures by journey_id
            for (const [siteId, departures] of departuresMap) {
                for (const departure of departures) {
                    const journeyId = departure.journey?.id;
                    if (!journeyId) continue;
                    
                    const stopInfo = {
                        site_id: siteId,
                        stop_point_id: departure.stop_point?.id,
                        stop_point_name: departure.stop_point?.name,
                        line_id: departure.line?.id,
                        line_designation: departure.line?.designation,
                        direction_code: departure.direction_code,
                        expected_time: departure.expected,
                        destination: departure.destination
                    };
                    
                    if (!journeyRoutes.has(journeyId)) {
                        journeyRoutes.set(journeyId, []);
                    }
                    journeyRoutes.get(journeyId).push(stopInfo);
                }
            }
            
            // Build sequence chains from journey data
            const routeSequences = [];
            
            for (const [journeyId, stops] of journeyRoutes) {
                if (stops.length < 2) continue; // Need at least 2 stops to form a sequence
                
                // Sort stops by expected time
                stops.sort((a, b) => new Date(a.expected_time) - new Date(b.expected_time));
                
                // Create sequence pairs (current -> next)
                for (let i = 0; i < stops.length - 1; i++) {
                    const current = stops[i];
                    const next = stops[i + 1];
                    
                    // Skip if essential data is missing
                    if (!current.stop_point_id || !next.stop_point_id) continue;
                    
                    routeSequences.push({
                        line_id: current.line_id,
                        line_designation: current.line_designation,
                        direction_code: current.direction_code,
                        stop_point_id: current.stop_point_id,
                        next_stop_point_id: next.stop_point_id,
                        journey_id: journeyId,
                        current_stop_name: current.stop_point_name,
                        next_stop_name: next.stop_point_name
                    });
                }
            }
            
            console.log(`Built ${routeSequences.length} route sequences from ${journeyRoutes.size} journeys`);
            return routeSequences;
            
        } catch (error) {
            console.error('Failed to build bus route sequences:', error.message);
            throw error;
        }
    }
}

module.exports = SLApiService;