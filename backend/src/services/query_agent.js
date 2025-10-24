/**
 * Query Agent - Represents a virtual passenger following a bus route
 * Updated to work with new data structures and corrected SL API constraints
 */

class QueryAgent {
    constructor(config) {
        this.journeyId = config.journeyId;
        this.lineId = config.lineId;
        this.directionCode = config.directionCode;
        this.currentStopId = config.currentStopId;
        this.nominalTime = config.nominalTime; // Current time in the journey
        this.departureInfo = config.departureInfo; // Enhanced departure information
        this.originSite = config.originSite;
        this.departureStopInfo = config.departureStopInfo; // Detailed stop-point info
        this.visitedStops = [config.currentStopId];
        this.routeChain = [];
    }
    
    /**
     * Move agent to next stop in the route
     * @param {number} nextStopId - Next stop point ID
     * @param {Date} arrivalTime - Expected arrival time
     */
    moveTo(nextStopId, arrivalTime) {
        if (this.visitedStops.includes(nextStopId)) {
            throw new Error(`Loop detected: stop ${nextStopId} already visited`);
        }
        
        this.currentStopId = nextStopId;
        this.nominalTime = arrivalTime;
        this.visitedStops.push(nextStopId);
        
        this.routeChain.push({
            stopId: nextStopId,
            arrivalTime: arrivalTime,
            travelTime: arrivalTime - this.nominalTime
        });
    }

    /**
     * Check if agent can reach a transfer within time constraints
     * @param {Date} transferTime - Proposed transfer time
     * @param {number} marginSeconds - Transfer margin in seconds
     * @returns {boolean}
     */
    canMakeTransfer(transferTime, marginSeconds = 90) {
        const requiredArrival = new Date(transferTime.getTime() - marginSeconds * 1000);
        return this.nominalTime <= requiredArrival;
    }

    /**
     * Get current journey progress summary
     */
    getProgress() {
        return {
            journeyId: this.journeyId,
            lineId: this.lineId,
            directionCode: this.directionCode,
            currentStop: this.currentStopId,
            currentTime: this.nominalTime,
            stopsVisited: this.visitedStops.length,
            totalTravelTime: this.nominalTime - this.departureInfo.expectedTime,
            departureStopInfo: this.departureStopInfo
        };
    }

    /**
     * Create a copy of the agent for branching search
     */
    clone() {
        const cloned = new QueryAgent({
            journeyId: this.journeyId,
            lineId: this.lineId,
            directionCode: this.directionCode,
            currentStopId: this.currentStopId,
            nominalTime: new Date(this.nominalTime),
            departureInfo: { ...this.departureInfo },
            originSite: this.originSite,
            departureStopInfo: this.departureStopInfo
        });
        
        cloned.visitedStops = [...this.visitedStops];
        cloned.routeChain = [...this.routeChain];
        
        return cloned;
    }

    /**
     * Get agent status for debugging
     */
    getStatus() {
        return {
            id: `${this.lineId}_${this.directionCode}_${this.journeyId}`,
            currentStopId: this.currentStopId,
            nominalTime: this.nominalTime.toISOString(),
            visitedStopsCount: this.visitedStops.length,
            lineInfo: `${this.departureInfo.lineDesignation} towards ${this.departureInfo.destination}`,
            originSite: this.originSite.siteName
        };
    }
}

module.exports = QueryAgent;