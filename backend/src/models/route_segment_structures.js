/**
 * Route Segment Data Structures
 * 定义所有路径段的标准数据结构，确保一致性和完整性
 */

/**
 * Base Segment Structure
 * 所有路径段的基础结构
 */
class BaseSegment {
    constructor(config) {
        this.type = config.type; // 'walking' | 'bus_waiting' | 'bus_ride'
        this.duration = config.duration; // 持续时间(秒)
        this.description = config.description || '';
        this.startPoint = config.startPoint || null; // {lat, lon}
        this.endPoint = config.endPoint || null; // {lat, lon}
        this.geometry = config.geometry || null; // GeoJSON geometry
    }

    validate() {
        const errors = [];
        if (!this.type) errors.push('Missing segment type');
        if (!this.duration || this.duration < 0) errors.push('Invalid duration');
        return { isValid: errors.length === 0, errors };
    }
}

/**
 * Walking Segment
 * 步行路段，包括普通步行和站内换乘步行
 */
class WalkingSegment extends BaseSegment {
    constructor(config) {
        super({ ...config, type: 'walking' });
        
        this.subtype = config.subtype || null; // null | 'intra_site_transfer'
        this.distance = config.distance || 0; // 步行距离(米)
        this.roadIds = config.roadIds || []; // 经过的路段ID(用于DGVI计算)
        
        // 站内换乘特有信息
        if (this.subtype === 'intra_site_transfer') {
            this.transferInfo = {
                fromStopPoint: config.transferInfo?.fromStopPoint || null,
                toStopPoint: config.transferInfo?.toStopPoint || null,
                siteId: config.transferInfo?.siteId || null
            };
        }
    }

    /**
     * 创建普通步行段
     */
    static createWalkingSegment(config) {
        return new WalkingSegment({
            duration: config.duration,
            distance: config.distance,
            startPoint: config.startPoint,
            endPoint: config.endPoint,
            description: config.description,
            roadIds: config.roadIds || [],
            geometry: config.geometry
        });
    }

    /**
     * 创建站内换乘步行段
     */
    static createIntraSiteTransferSegment(config) {
        return new WalkingSegment({
            subtype: 'intra_site_transfer',
            duration: config.duration,
            distance: config.distance,
            startPoint: config.startPoint,
            endPoint: config.endPoint,
            description: config.description,
            transferInfo: config.transferInfo,
            geometry: {
                type: 'LineString',
                coordinates: [
                    [config.startPoint.lon, config.startPoint.lat],
                    [config.endPoint.lon, config.endPoint.lat]
                ]
            }
        });
    }

    toGeoJSONFeatures(routeId, segmentIndex) {
        const features = [];

        // 步行路径线条
        if (this.geometry) {
            features.push({
                type: 'Feature',
                geometry: this.geometry,
                properties: {
                    segmentIndex,
                    segmentType: 'walking',
                    segmentSubtype: this.subtype,
                    duration: this.duration,
                    distance: this.distance,
                    description: this.description,
                    routeId,
                    isIntraSiteWalk: this.subtype === 'intra_site_transfer'
                }
            });
        }

        // 站内换乘的起终点
        if (this.subtype === 'intra_site_transfer' && this.transferInfo) {
            if (this.transferInfo.fromStopPoint) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [this.transferInfo.fromStopPoint.lon, this.transferInfo.fromStopPoint.lat]
                    },
                    properties: {
                        type: 'transfer_point',
                        subtype: 'arrival_platform',
                        name: this.transferInfo.fromStopPoint.stop_name,
                        stopPointId: this.transferInfo.fromStopPoint.stop_point_id,
                        routeId,
                        segmentIndex
                    }
                });
            }

            if (this.transferInfo.toStopPoint) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [this.transferInfo.toStopPoint.lon, this.transferInfo.toStopPoint.lat]
                    },
                    properties: {
                        type: 'transfer_point',
                        subtype: 'departure_platform',
                        name: this.transferInfo.toStopPoint.stop_name,
                        stopPointId: this.transferInfo.toStopPoint.stop_point_id,
                        routeId,
                        segmentIndex
                    }
                });
            }
        }

        return features;
    }
}

/**
 * Bus Waiting Segment
 * 公交等车段
 */
class BusWaitingSegment extends BaseSegment {
    constructor(config) {
        super({ ...config, type: 'bus_waiting' });

        // 站点信息
        this.stopPointId = config.stopPointId;
        this.siteId = config.siteId;
        this.stopName = config.stopName;
        this.stopGeom = config.stopGeom; // {lat, lon}

        // 线路信息
        this.lineInfo = config.lineInfo;
        this.expectedDeparture = config.expectedDeparture;

        // 换乘信息(如果是换乘等车)
        this.transferInfo = config.transferInfo || null;
        if (this.transferInfo) {
            this.transferInfo = {
                waitingTime: this.transferInfo.waitingTime || this.duration,
                fromLine: this.transferInfo.fromLine || null,
                toLine: this.transferInfo.toLine || null,
                intraSiteWalk: this.transferInfo.intraSiteWalk || false,
                transferMargin: this.transferInfo.transferMargin || 90
            };
        }
    }

    /**
     * 创建普通等车段
     */
    static createWaitingSegment(config) {
        return new BusWaitingSegment({
            duration: config.duration || 0,
            stopPointId: config.stopPointId,
            siteId: config.siteId,
            stopName: config.stopName,
            stopGeom: config.stopGeom,
            lineInfo: config.lineInfo,
            expectedDeparture: config.expectedDeparture,
            description: `Wait for ${config.lineInfo} at ${config.stopName}`
        });
    }

    /**
     * 创建换乘等车段
     */
    static createTransferWaitingSegment(config) {
        return new BusWaitingSegment({
            duration: config.duration,
            stopPointId: config.stopPointId,
            siteId: config.siteId,
            stopName: config.stopName,
            stopGeom: config.stopGeom,
            lineInfo: config.lineInfo,
            expectedDeparture: config.expectedDeparture,
            transferInfo: config.transferInfo,
            description: `Transfer to ${config.lineInfo} at ${config.stopName}`
        });
    }

    toGeoJSONFeatures(routeId, segmentIndex) {
        const features = [];

        // 等车站点
        if (this.stopGeom) {
            const feature = {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [this.stopGeom.lon, this.stopGeom.lat]
                },
                properties: {
                    type: 'bus_stop',
                    stopPointId: this.stopPointId,
                    siteId: this.siteId,
                    name: this.stopName,
                    lineInfo: this.lineInfo,
                    routeId,
                    segmentIndex,
                    expectedDeparture: this.expectedDeparture,
                    isTransferStop: !!this.transferInfo
                }
            };

            // 添加换乘信息
            if (this.transferInfo) {
                feature.properties.transferType = this.transferInfo.intraSiteWalk ? 'intra_site' : 'same_platform';
                feature.properties.fromLine = this.transferInfo.fromLine;
                feature.properties.toLine = this.transferInfo.toLine;
                feature.properties.waitingTime = this.transferInfo.waitingTime;
            }

            features.push(feature);
        }

        return features;
    }
}

/**
 * Bus Ride Segment
 * 公交乘车段
 */
class BusRideSegment extends BaseSegment {
    constructor(config) {
        super({ ...config, type: 'bus_ride' });

        // 起终站点信息
        this.startStopId = config.startStopId;
        this.endStopId = config.endStopId;
        this.startStopInfo = config.startStopInfo; // StopPoint object
        this.endStopInfo = config.endStopInfo;     // StopPoint object

        this.lineId = config.lineId;
        this.directionCode = config.directionCode;

        // 线路和时间信息
        this.lineInfo = config.lineInfo;
        this.expectedDeparture = config.expectedDeparture;
        this.expectedArrival = config.expectedArrival;

        // 路径信息(用于DGVI计算)
        this.roadIds = config.roadIds || [];
    }

    /**
     * 创建公交乘车段
     */
    static createBusRideSegment(config) {
        return new BusRideSegment({
            duration: config.duration,
            startStopId: config.startStopId,
            endStopId: config.endStopId,
            startStopInfo: config.startStopInfo,
            endStopInfo: config.endStopInfo,
            lineId: config.lineId, 
            directionCode: config.directionCode,
            lineInfo: config.lineInfo,
            expectedDeparture: config.expectedDeparture,
            expectedArrival: config.expectedArrival,
            geometry: config.geometry,
            roadIds: config.roadIds,
            description: `Take ${config.lineInfo} from ${config.startStopInfo?.stop_name} to ${config.endStopInfo?.stop_name}`
        });
    }

    toGeoJSONFeatures(routeId, segmentIndex) {
        const features = [];

        // 乘车路径线条
        if (this.geometry) {
            features.push({
                type: 'Feature',
                geometry: this.geometry,
                properties: {
                    segmentIndex,
                    segmentType: 'bus_ride',
                    duration: this.duration,
                    lineInfo: this.lineInfo,
                    routeId,
                    expectedDeparture: this.expectedDeparture,
                    expectedArrival: this.expectedArrival
                }
            });
        }

        // 上车站点
        if (this.startStopInfo) {
            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [this.startStopInfo.lon, this.startStopInfo.lat]
                },
                properties: {
                    type: 'departure_stop',
                    stopPointId: this.startStopInfo.stop_point_id,
                    siteId: this.startStopInfo.site_id,
                    name: this.startStopInfo.stop_name,
                    lineInfo: this.lineInfo,
                    routeId,
                    segmentIndex,
                    expectedDeparture: this.expectedDeparture,
                    busRideSegment: true
                }
            });
        }

        // 下车站点
        if (this.endStopInfo) {
            features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [this.endStopInfo.lon, this.endStopInfo.lat]
                },
                properties: {
                    type: 'arrival_stop',
                    stopPointId: this.endStopInfo.stop_point_id,
                    siteId: this.endStopInfo.site_id,
                    name: this.endStopInfo.stop_name,
                    lineInfo: this.lineInfo,
                    routeId,
                    segmentIndex,
                    expectedArrival: this.expectedArrival,
                    busRideSegment: true
                }
            });
        }

        return features;
    }
}

/**
 * Segment Factory
 * 路径段工厂类，统一创建不同类型的路径段
 */
class SegmentFactory {
    
    static createWalkingSegment(config) {
        return WalkingSegment.createWalkingSegment(config);
    }

    static createIntraSiteTransferSegment(config) {
        return WalkingSegment.createIntraSiteTransferSegment(config);
    }

    static createWaitingSegment(config) {
        return BusWaitingSegment.createWaitingSegment(config);
    }

    static createTransferWaitingSegment(config) {
        return BusWaitingSegment.createTransferWaitingSegment(config);
    }

    static createBusRideSegment(config) {
        return BusRideSegment.createBusRideSegment(config);
    }

    /**
     * 从配置对象创建路径段
     */
    static fromConfig(config) {
        switch (config.type) {
            case 'walking':
                if (config.subtype === 'intra_site_transfer') {
                    return this.createIntraSiteTransferSegment(config);
                }
                return this.createWalkingSegment(config);
            
            case 'bus_waiting':
                if (config.transferInfo) {
                    return this.createTransferWaitingSegment(config);
                }
                return this.createWaitingSegment(config);
            
            case 'bus_ride':
                return this.createBusRideSegment(config);
            
            default:
                throw new Error(`Unknown segment type: ${config.type}`);
        }
    }

    /**
     * 验证路径段序列的完整性
     */
    static validateSegmentSequence(segments) {
        const errors = [];
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const validation = segment.validate();
            
            if (!validation.isValid) {
                errors.push(`Segment ${i}: ${validation.errors.join(', ')}`);
            }
        }

        // 检查路径段序列的逻辑性
        for (let i = 0; i < segments.length - 1; i++) {
            const current = segments[i];
            const next = segments[i + 1];
            
            // 步行后应该是等车或者到达
            if (current.type === 'walking' && next.type === 'walking') {
                // 连续步行段只有在站内换乘时才合理
                if (current.subtype !== 'intra_site_transfer' && next.subtype !== 'intra_site_transfer') {
                    errors.push(`Segment ${i}-${i+1}: Consecutive walking segments without transfer`);
                }
            }

            // 等车后应该是乘车
            if (current.type === 'bus_waiting' && next.type !== 'bus_ride') {
                errors.push(`Segment ${i}-${i+1}: Waiting segment not followed by bus ride`);
            }
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }
}

module.exports = {
    BaseSegment,
    WalkingSegment,
    BusWaitingSegment,
    BusRideSegment,
    SegmentFactory
};