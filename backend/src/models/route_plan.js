/**
 * RoutePlan Class - 完整的路径规划结果对象
 * 使用标准化的段结构，提供完整的可视化和信息展示支持
 */

const { SegmentFactory } = require('./route_segment_structures');

class RoutePlan {
    constructor(config) {
        this.routeId = config.routeId;
        this.routeType = config.routeType; // 'walking', 'direct_bus', 'transfer_bus'
        this.segments = config.segments || [];
        this.totalDuration = config.totalDuration; // 总时长(秒)
        
        // 起终点信息
        this.origin = config.origin;
        this.destination = config.destination;
        
        // 评分信息(在评分阶段填充)
        this.totalAcDGVI = 0;
        this.durationScore = 0;
        this.acDGVIScore = 0;
        this.totalScore = 0;
        
        // 额外信息
        this.journeyInfo = config.journeyInfo || null; // 直达路线信息
        this.transferInfo = config.transferInfo || null; // 换乘路线信息
        
        // 元数据
        this.createdAt = new Date();
        this.gviDataMonth = config.gviDataMonth || null; // 使用的GVI数据月份
    }

    /**
     * 添加路径段
     */
    addSegment(segmentConfig) {
        const segment = SegmentFactory.fromConfig(segmentConfig);
        this.segments.push(segment);
        return segment;
    }

    /**
     * 验证路径完整性
     */
    validate() {
        const errors = [];
        
        // 基础验证
        if (!this.routeId) errors.push('Missing route ID');
        if (!this.routeType) errors.push('Missing route type');
        if (!this.totalDuration || this.totalDuration <= 0) errors.push('Invalid total duration');
        
        // 路径段验证
        if (!this.segments || this.segments.length === 0) {
            errors.push('No segments defined');
        } else {
            const segmentValidation = SegmentFactory.validateSegmentSequence(this.segments);
            if (!segmentValidation.isValid) {
                errors.push(...segmentValidation.errors);
            }
        }
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * 获取路径概要信息
     */
    getSummary() {
        const segmentCounts = this.segments.reduce((counts, segment) => {
            const key = segment.subtype ? `${segment.type}_${segment.subtype}` : segment.type;
            counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, {});
        
        return {
            routeId: this.routeId,
            routeType: this.routeType,
            totalDuration: this.totalDuration,
            durationMinutes: Math.round(this.totalDuration / 60),
            segmentCounts,
            walkingSegments: (segmentCounts.walking || 0) + (segmentCounts.walking_intra_site_transfer || 0),
            busRideSegments: segmentCounts.bus_ride || 0,
            waitingSegments: segmentCounts.bus_waiting || 0,
            transferCount: this.routeType === 'transfer_bus' ? 1 : 0,
            hasIntraSiteTransfer: !!segmentCounts.walking_intra_site_transfer,
            gviDataMonth: this.gviDataMonth
        };
    }

    /**
     * 生成详细的导航指引
     */
    getInstructions() {
        const instructions = [];
        
        for (let i = 0; i < this.segments.length; i++) {
            const segment = this.segments[i];
            const instruction = this._generateSegmentInstruction(segment, i);
            if (instruction) {
                instructions.push(instruction);
            }
        }
        
        return instructions;
    }

    /**
     * 为单个路径段生成指引
     */
    _generateSegmentInstruction(segment, index) {
        const duration = Math.round(segment.duration / 60);
        
        switch (segment.type) {
            case 'walking':
                if (segment.subtype === 'intra_site_transfer') {
                    const distance = Math.round(segment.distance || 0);
                    const fromPlatform = segment.transferInfo?.fromStopPoint?.stop_name || 'Platform';
                    const toPlatform = segment.transferInfo?.toStopPoint?.stop_name || 'Platform';
                    return `🚶 Walk ${distance}m within station from ${fromPlatform} to ${toPlatform} (${duration} min)`;
                } else {
                    const distance = Math.round(segment.distance || 0);
                    return `🚶 ${segment.description} - ${distance}m (${duration} min)`;
                }
                
            case 'bus_waiting':
                if (segment.transferInfo) {
                    const waitTime = Math.round(segment.duration / 60);
                    const transferNote = segment.transferInfo.intraSiteWalk ? 
                        ' (after walking within station)' : '';
                    return `Wait ${waitTime} min for ${segment.lineInfo} at ${segment.stopName}${transferNote}`;
                } else {
                    const departureTime = segment.expectedDeparture ? 
                        new Date(segment.expectedDeparture).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
                    return `Board ${segment.lineInfo} at ${segment.stopName}${departureTime ? ` (${departureTime})` : ''}`;
                }
                
            case 'bus_ride':
                const rideDuration = Math.round(segment.duration / 60);
                const startStop = segment.startStopInfo?.stop_name || 'departure';
                const endStop = segment.endStopInfo?.stop_name || 'arrival';
                
                let timeInfo = '';
                if (segment.expectedDeparture && segment.expectedArrival) {
                    const depTime = new Date(segment.expectedDeparture).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    const arrTime = new Date(segment.expectedArrival).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    timeInfo = ` ${depTime}-${arrTime}`;
                }
                
                return `Take ${segment.lineInfo} from ${startStop} to ${endStop} (${rideDuration} min)${timeInfo}`;
                
            default:
                return null;
        }
    }

    /**
     * 转换为GeoJSON格式
     */
    toGeoJSON() {
        const features = [];
        
        // 收集所有路径段的GeoJSON特征
        for (let i = 0; i < this.segments.length; i++) {
            const segment = this.segments[i];
            if (segment.toGeoJSONFeatures) {
                const segmentFeatures = segment.toGeoJSONFeatures(this.routeId, i);
                features.push(...segmentFeatures);
            }
        }
        
        return {
            type: 'FeatureCollection',
            features,
            properties: {
                routeId: this.routeId,
                routeType: this.routeType,
                totalDuration: this.totalDuration,
                totalScore: this.totalScore,
                durationScore: this.durationScore,
                acDGVIScore: this.acDGVIScore,
                totalAcDGVI: this.totalAcDGVI,
                hasTransfer: this.routeType.includes('transfer'),
                transferInfo: this.transferInfo,
                gviDataMonth: this.gviDataMonth,
                summary: this.getSummary()
            }
        };
    }

    /**
     * 获取时间详情
     */
    getTimingDetails() {
        const details = [];
        let cumulativeTime = 0;
        
        for (let i = 0; i < this.segments.length; i++) {
            const segment = this.segments[i];
            const startTime = cumulativeTime;
            const endTime = cumulativeTime + segment.duration;
            
            details.push({
                segmentIndex: i,
                type: segment.type,
                subtype: segment.subtype || null,
                startTime,
                endTime,
                duration: segment.duration,
                startTimeFormatted: this._formatDuration(startTime),
                endTimeFormatted: this._formatDuration(endTime),
                durationFormatted: this._formatDuration(segment.duration),
                description: segment.description || `${segment.type} segment`
            });
            
            cumulativeTime = endTime;
        }
        
        return details;
    }

    /**
     * 获取换乘摘要
     */
    getTransferSummary() {
        if (!this.transferInfo) {
            return null;
        }
        
        const summary = {
            transferCount: this.routeType === 'transfer_bus' ? 1 : 0,
            linesUsed: []
        };
        
        // 第一段线路
        if (this.transferInfo.firstLine) {
            summary.linesUsed.push({
                lineId: this.transferInfo.firstLine.lineId,
                lineDesignation: this.transferInfo.firstLine.lineDesignation,
                departureTime: this.transferInfo.firstLine.departure,
                arrivalTime: this.transferInfo.firstLine.arrival,
                departureStop: this.transferInfo.firstLine.departureStop?.stop_name || null,
                arrivalStop: this.transferInfo.firstLine.arrivalStop?.stop_name || null
            });
        }
        
        // 第二段线路
        if (this.transferInfo.secondLine) {
            summary.linesUsed.push({
                lineId: this.transferInfo.secondLine.lineId,
                lineDesignation: this.transferInfo.secondLine.lineDesignation,
                departureTime: this.transferInfo.secondLine.departure,
                departureStop: this.transferInfo.secondLine.departureStop?.stop_name || null
            });
        }
        
        // 换乘详情
        if (this.transferInfo.transferSite) {
            summary.transferDetails = {
                siteId: this.transferInfo.transferSite.siteId,
                siteName: this.transferInfo.transferSite.siteName,
                waitingTimeSeconds: this.transferInfo.transferSite.waitingTime || 0,
                intraSiteWalkSeconds: this.transferInfo.transferSite.intraSiteWalk || 0,
                intraSiteDistanceMeters: this.transferInfo.transferSite.intraSiteDistance || 0,
                transferType: this.transferInfo.transferSite.intraSiteWalk > 0 ? 'intra_site_walk' : 'same_platform'
            };
        }
        
        return summary;
    }

    /**
     * 转换为API响应格式
     */
    toApiResponse() {
        return {
            route_id: this.routeId,
            route_type: this.routeType,
            total_duration: this.totalDuration,
            duration_score: this.durationScore,
            acdgvi_score: this.acDGVIScore,
            total_acdgvi: this.totalAcDGVI,
            total_score: this.totalScore,
            gvi_data_month: this.gviDataMonth,
            
            summary: this.getSummary(),
            instructions: this.getInstructions(),
            timing_details: this.getTimingDetails(),
            transfer_summary: this.getTransferSummary(),
            geojson: this.toGeoJSON(),
            
            segments: this.segments.map((segment, index) => ({
                segment_index: index,
                type: segment.type,
                subtype: segment.subtype || null,
                duration: segment.duration,
                distance: segment.distance || null,
                description: segment.description,
                
                // 路径几何
                geometry: segment.geometry,
                
                // 站点信息
                stop_point_id: segment.stopPointId || null,
                site_id: segment.siteId || null,
                stop_name: segment.stopName || null,
                
                // 时间信息
                expected_departure: segment.expectedDeparture || null,
                expected_arrival: segment.expectedArrival || null,
                
                // 线路信息
                line_info: segment.lineInfo || null,
                
                // 特殊信息
                transfer_info: segment.transferInfo || null,
                start_stop_info: segment.startStopInfo || null,
                end_stop_info: segment.endStopInfo || null,
                road_ids: segment.roadIds || null
            }))
        };
    }

    /**
     * 格式化时长
     */
    _formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        } else {
            return `${remainingSeconds}s`;
        }
    }

    /**
     * 创建步行路径
     */
    static createWalkingRoute(config) {
        const walkingSegment = SegmentFactory.createWalkingSegment({
            duration: config.totalDuration,
            distance: config.totalDistance,
            startPoint: config.origin,
            endPoint: config.destination,
            description: `Walk from origin to destination`,
            roadIds: config.roadIds || [],
            geometry: config.geometry
        });

        return new RoutePlan({
            routeId: `walking_${Date.now()}`,
            routeType: 'walking',
            segments: [walkingSegment],
            totalDuration: config.totalDuration,
            origin: config.origin,
            destination: config.destination,
            gviDataMonth: config.gviDataMonth
        });
    }

    /**
     * 创建直达公交路径
     */
    static createDirectBusRoute(config) {
        const segments = [];

        // 步行到出发站
        if (config.walkingToDeparture > 0) {
            segments.push(SegmentFactory.createWalkingSegment({
                duration: config.walkingToDeparture,
                distance: config.walkingToDepDistance || 0,
                startPoint: config.origin,
                endPoint: { lat: config.departureStop.lat, lon: config.departureStop.lon },
                description: `Walk to ${config.departureStop.stop_name}`,
                roadIds: config.walkingToDepRoadIds || [],
                geometry: config.walkingToDepGeometry || null  
            }));
        }

        // 等车
        segments.push(SegmentFactory.createWaitingSegment({
            duration: 0, // 通常很短
            stopPointId: config.departureStop.stop_point_id,
            siteId: config.departureStop.site_id,
            stopName: config.departureStop.stop_name,
            stopGeom: { lat: config.departureStop.lat, lon: config.departureStop.lon },
            lineInfo: config.lineInfo,
            expectedDeparture: config.expectedDeparture
        }));

        // 乘车
        segments.push(SegmentFactory.createBusRideSegment({
            duration: config.busRideDuration,
            startStopId: config.departureStop.stop_point_id,
            endStopId: config.arrivalStop.stop_point_id,
            startStopInfo: config.departureStop,
            endStopInfo: config.arrivalStop,
            lineId: config.lineId,             
            directionCode: config.directionCode,
            lineInfo: config.lineInfo,
            expectedDeparture: config.expectedDeparture,
            expectedArrival: config.expectedArrival,
            geometry: config.busRideGeometry || null,
            roadIds: config.busRideRoadIds || []
        }));

        // 步行到终点
        if (config.walkingFromArrival > 0) {
            segments.push(SegmentFactory.createWalkingSegment({
                duration: config.walkingFromArrival,
                distance: config.walkingFromArrDistance || 0,
                startPoint: { lat: config.arrivalStop.lat, lon: config.arrivalStop.lon },
                endPoint: config.destination,
                description: `Walk from ${config.arrivalStop.stop_name}`,
                roadIds: config.walkingFromArrRoadIds || [],
                geometry: config.walkingFromArrGeometry || null 
            }));
        }

        return new RoutePlan({
            routeId: `direct_${config.lineId}_${Date.now()}`,
            routeType: 'direct_bus',
            segments,
            totalDuration: config.totalDuration,
            origin: config.origin,
            destination: config.destination,
            gviDataMonth: config.gviDataMonth,
            journeyInfo: {
                lineId: config.lineId,
                lineDesignation: config.lineDesignation,
                departure: config.expectedDeparture,
                arrival: config.expectedArrival,
                directionCode: config.directionCode,
                journeyId: config.journeyId,
                departureStop: config.departureStop,
                arrivalStop: config.arrivalStop
            }
        });
    }

    /**
     * 创建换乘路径
     */
    static createTransferRoute(config) {
        const segments = [];

        // 步行到第一个出发站
        if (config.walkingToFirst > 0) {
            segments.push(SegmentFactory.createWalkingSegment({
                duration: config.walkingToFirst,
                distance: config.walkingToFirstDistance || 0,
                startPoint: config.origin,
                endPoint: { lat: config.firstDepartureStop.lat, lon: config.firstDepartureStop.lon },
                description: `Walk to ${config.firstDepartureStop.stop_name}`,
                roadIds: config.walkingToFirstRoadIds || []
            }));
        }

        // 第一段等车
        segments.push(SegmentFactory.createWaitingSegment({
            duration: 0,
            stopPointId: config.firstDepartureStop.stop_point_id,
            siteId: config.firstDepartureStop.site_id,
            stopName: config.firstDepartureStop.stop_name,
            stopGeom: { lat: config.firstDepartureStop.lat, lon: config.firstDepartureStop.lon },
            lineInfo: config.firstLineInfo,
            expectedDeparture: config.firstDeparture
        }));

        // 第一段乘车
        segments.push(SegmentFactory.createBusRideSegment({
            duration: config.firstBusRideDuration,
            startStopId: config.firstDepartureStop.stop_point_id,
            endStopId: config.transferArrivalStop.stop_point_id,
            startStopInfo: config.firstDepartureStop,
            endStopInfo: config.transferArrivalStop,
            lineId: config.lineId,              
            directionCode: config.directionCode,
            lineInfo: config.firstLineInfo,
            expectedDeparture: config.firstDeparture,
            expectedArrival: config.firstArrival,
            geometry: config.firstBusRideGeometry,
            roadIds: config.firstBusRideRoadIds || []
        }));

        // 站内换乘步行(如果需要)
        if (config.intraSiteWalk > 0) {
            segments.push(SegmentFactory.createIntraSiteTransferSegment({
                duration: config.intraSiteWalk,
                distance: config.intraSiteDistance,
                startPoint: { lat: config.transferArrivalStop.lat, lon: config.transferArrivalStop.lon },
                endPoint: { lat: config.transferDepartureStop.lat, lon: config.transferDepartureStop.lon },
                description: `Walk within ${config.transferSiteName} from ${config.transferArrivalStop.stop_name} to ${config.transferDepartureStop.stop_name}`,
                transferInfo: {
                    fromStopPoint: config.transferArrivalStop,
                    toStopPoint: config.transferDepartureStop,
                    siteId: config.transferSiteId
                }
            }));
        }

        // 第二段等车
        segments.push(SegmentFactory.createTransferWaitingSegment({
            duration: config.transferWaiting,
            stopPointId: config.transferDepartureStop.stop_point_id,
            siteId: config.transferDepartureStop.site_id,
            stopName: config.transferDepartureStop.stop_name,
            stopGeom: { lat: config.transferDepartureStop.lat, lon: config.transferDepartureStop.lon },
            lineInfo: config.secondLineInfo,
            expectedDeparture: config.secondDeparture,
            transferInfo: {
                waitingTime: config.transferWaiting,
                fromLine: config.firstLineDesignation,
                toLine: config.secondLineDesignation,
                intraSiteWalk: config.intraSiteWalk > 0,
                transferMargin: 90
            }
        }));

        // 第二段乘车
        segments.push(SegmentFactory.createBusRideSegment({
            duration: config.secondBusRideDuration,
            startStopId: config.transferDepartureStop.stop_point_id,
            endStopId: config.finalArrivalStop.stop_point_id,
            startStopInfo: config.transferDepartureStop,
            endStopInfo: config.finalArrivalStop,
            lineInfo: config.secondLineInfo,
            expectedDeparture: config.secondDeparture,
            expectedArrival: config.secondArrival,
            geometry: config.secondBusRideGeometry,
            roadIds: config.secondBusRideRoadIds || []
        }));

        // 步行到终点
        if (config.walkingFromFinal > 0) {
            segments.push(SegmentFactory.createWalkingSegment({
                duration: config.walkingFromFinal,
                distance: config.walkingFromFinalDistance || 0,
                startPoint: { lat: config.finalArrivalStop.lat, lon: config.finalArrivalStop.lon },
                endPoint: config.destination,
                description: `Walk from ${config.finalArrivalStop.stop_name}`,
                roadIds: config.walkingFromFinalRoadIds || []
            }));
        }

        return new RoutePlan({
            routeId: `transfer_${config.firstLineId}_${config.secondLineId}_${Date.now()}`,
            routeType: 'transfer_bus',
            segments,
            totalDuration: config.totalDuration,
            origin: config.origin,
            destination: config.destination,
            gviDataMonth: config.gviDataMonth,
            transferInfo: {
                firstLine: {
                    lineId: config.firstLineId,
                    lineDesignation: config.firstLineDesignation,
                    departure: config.firstDeparture,
                    arrival: config.firstArrival,
                    departureStop: config.firstDepartureStop,
                    arrivalStop: config.transferArrivalStop
                },
                secondLine: {
                    lineId: config.secondLineId,
                    lineDesignation: config.secondLineDesignation,
                    departure: config.secondDeparture,
                    departureStop: config.transferDepartureStop
                },
                transferSite: {
                    siteId: config.transferSiteId,
                    siteName: config.transferSiteName,
                    waitingTime: config.transferWaiting,
                    intraSiteWalk: config.intraSiteWalk,
                    intraSiteDistance: config.intraSiteDistance
                }
            }
        });
    }
}

module.exports = RoutePlan;