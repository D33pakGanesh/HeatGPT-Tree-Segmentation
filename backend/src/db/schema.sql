-- Enable PostGIS extension if not already enabled
CREATE EXTENSION IF NOT EXISTS postgis;

-- LGA boundaries table
CREATE TABLE IF NOT EXISTS lgas (
    lga_id      VARCHAR(10)  PRIMARY KEY,
    lga_name    VARCHAR(255) NOT NULL,
    state       VARCHAR(50)  NOT NULL,
    geom        GEOMETRY(MultiPolygon, 4326) NOT NULL,
    bbox        JSONB,
    area_km2    NUMERIC(12, 4),
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lgas_geom ON lgas USING GIST(geom);

-- Heat statistics table
CREATE TABLE IF NOT EXISTS heat_stats (
    id               SERIAL PRIMARY KEY,
    lga_id           VARCHAR(10) NOT NULL REFERENCES lgas(lga_id),
    avg_lst_celsius  NUMERIC(6, 3),
    avg_ndvi         NUMERIC(6, 4),
    uhi_intensity    NUMERIC(6, 3),
    data_source      VARCHAR(50),
    date_range_start DATE,
    date_range_end   DATE,
    processed_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(lga_id)
);

CREATE INDEX IF NOT EXISTS idx_heat_stats_lga ON heat_stats(lga_id);

-- GEE layer exports table — stores exported satellite layer metadata per LGA
CREATE TABLE IF NOT EXISTS gee_layers (
    id               SERIAL PRIMARY KEY,
    lga_id           VARCHAR(10) NOT NULL REFERENCES lgas(lga_id),
    layer_type       VARCHAR(20) NOT NULL,          -- 'lst', 'ndvi', or 'tree_segmentation'
    date_range_start DATE NOT NULL,
    date_range_end   DATE NOT NULL,
    tile_url         TEXT NOT NULL,                 -- proxied tile URL
    ee_url           TEXT,                          -- raw EE URL (may expire)
    avg_lst_celsius  NUMERIC(6, 3),
    avg_ndvi         NUMERIC(6, 4),
    uhi_intensity    NUMERIC(6, 3),
    exported_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gee_layers_lga ON gee_layers(lga_id);
CREATE INDEX IF NOT EXISTS idx_gee_layers_lga_type ON gee_layers(lga_id, layer_type);
CREATE INDEX IF NOT EXISTS idx_gee_layers_lookup ON gee_layers(lga_id, layer_type, date_range_start, date_range_end);

-- Tree segmentation results — individual tree/cluster polygon footprints from GeoAI (geoai-py CLIPSeg)
CREATE TABLE IF NOT EXISTS tree_segments (
    id               SERIAL PRIMARY KEY,
    lga_id           VARCHAR(10) NOT NULL REFERENCES lgas(lga_id),
    geom             GEOMETRY(Polygon, 4326) NOT NULL,
    area_m2          NUMERIC(16, 4) NOT NULL,
    confidence       NUMERIC(6, 4) NOT NULL,
    date_range_start DATE NOT NULL,
    date_range_end   DATE NOT NULL,
    processed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tree_segments_lga
    ON tree_segments(lga_id, date_range_start, date_range_end);

CREATE INDEX IF NOT EXISTS idx_tree_segments_geom
    ON tree_segments USING GIST(geom);
