-- Run these lines in the database query tool

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pgrouting;

SELECT name, default_version, installed_version 
FROM pg_available_extensions 
WHERE name IN ('postgis', 'postgis_topology', 'pgrouting');