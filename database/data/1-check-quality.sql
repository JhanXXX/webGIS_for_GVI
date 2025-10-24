-- check available gvi points
SELECT * FROM gvi_points

-- check gvi points by month
SELECT month, COUNT(*) FROM gvi_points GROUP BY month;

-- check retrieved bus sites
SELECT COUNT(*) FROM sl_bus_sites;
SELECT * FROM sl_bus_sites LIMIT 10;

-- check retrieved bus stop points
SELECT COUNT(*) FROM sl_bus_stop_points;
SELECT * FROM sl_bus_stop_points LIMIT 10;

-- check built bus trips (no reorganize)
SELECT COUNT(*) FROM sl_bus_trips;
SELECT * FROM sl_bus_trips LIMIT 10;

-- check retrieved lines
SELECT DISTINCT line_id, direction_code FROM sl_bus_trips ORDER BY line_id

-- check a certain line's sequence. replace the trips.line_id in need
SELECT stops.stop_poi_1, trips.*
FROM sl_bus_trips AS trips
JOIN sl_bus_stop_points AS stops
    ON stops.stop_point = trips.stop_point_id
	WHERE trips.line_id = 50 ORDER BY direction_code

-- delete dirty data
DELETE FROM sl_bus_trips 
WHERE stop_point_id = next_stop_point_id 
   OR line_id IS NULL;

-- check if there is dirty data 
SELECT stops.stop_poi_1, trips.*
FROM sl_bus_trips AS trips
JOIN sl_bus_stop_points AS stops
    ON stops.stop_point = trips.stop_point_id
	WHERE trips.stop_point_id = trips.next_stop_point_id
	ORDER BY line_id

-- end of the world
DROP TABLE sl_bus_sites;
DROP TABLE sl_bus_stop_points;
DROP TABLE sl_bus_trips;
