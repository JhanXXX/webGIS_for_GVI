-- create table
CREATE TABLE road_dgvi (
    road_id INTEGER,
    month VARCHAR(7),
    dgvi DOUBLE PRECISION,
    dgvi_normalized DOUBLE PRECISION,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (road_id, month),
    FOREIGN KEY (road_id) REFERENCES stockholm_osm(id) ON DELETE CASCADE
);

CREATE INDEX idx_road_dgvi_month ON road_dgvi(month);

-- add normalized length column
ALTER TABLE stockholm_osm 
ADD COLUMN IF NOT EXISTS length_normalized DOUBLE PRECISION;

WITH stats AS (
    SELECT MIN(length) as min_len, MAX(length) as max_len
    FROM stockholm_osm
)
UPDATE stockholm_osm
SET length_normalized = (length - stats.min_len) / (stats.max_len - stats.min_len)
FROM stats;
