-- add length column for stockholm_osm
ALTER TABLE stockholm_osm 
ADD COLUMN IF NOT EXISTS length DOUBLE PRECISION;

UPDATE stockholm_osm
SET length = ST_Length(geom::geography)
WHERE length IS NULL;


-- add source / target
ALTER TABLE stockholm_osm_walking ADD COLUMN source INTEGER, ADD COLUMN target INTEGER;
ALTER TABLE stockholm_osm_bus ADD COLUMN source INTEGER, ADD COLUMN target INTEGER;
ALTER TABLE stockholm_osm ADD COLUMN source INTEGER, ADD COLUMN target INTEGER;
-- build up topology; 0.0001 ≈ 5-11 meters in Stockholm
SELECT pgr_createTopology('stockholm_osm', 0.0002, 'geom', 'id');



-- if rebuilding topology is needed
-- 1. clean current topology
-- UPDATE stockholm_osm_bus SET source = NULL, target = NULL;

-- 2. selete vertices if exist
-- DROP TABLE IF EXISTS stockholm_osm_bus_vertices_pgr;

-- 3. alter the degree if needed
-- 0.0001 ≈ 5-11 meters in Stockholm
-- SELECT pgr_createTopology('stockholm_osm_bus', 0.0002, 'geom', 'id');
