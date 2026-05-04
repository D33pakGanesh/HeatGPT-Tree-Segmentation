#!/usr/bin/env python3
"""
GeoAI Tree Segmentation Sidecar Script
Uses geoai-py CLIPSeg to detect individual tree crowns from a satellite GeoTIFF.

Usage:
    python3 tree_segment.py --tile /tmp/tile.tif --bbox '{"west":...}' --output /tmp/out.geojson

Output (stdout): JSON with keys: segments (GeoJSON), treeCount, totalAreaKm2, avgConfidence
Exit code 0 on success, non-zero on failure (error written to stderr).

Install dependency: pip install geoai-py
"""

import sys
import json
import argparse
import os
import traceback


def main():
    parser = argparse.ArgumentParser(description='GeoAI tree segmentation via CLIPSeg')
    parser.add_argument('--tile', required=True, help='Path to input GeoTIFF')
    parser.add_argument('--bbox', required=True, help='JSON bbox string {west,south,east,north}')
    parser.add_argument('--output', required=True, help='Path for output GeoJSON file')
    args = parser.parse_args()

    # Validate input file exists
    if not os.path.exists(args.tile):
        print(f'ERROR: Tile file not found: {args.tile}', file=sys.stderr)
        sys.exit(1)

    try:
        import geoai
    except ImportError:
        print('ERROR: geoai-py not installed. Run: pip install geoai-py', file=sys.stderr)
        sys.exit(2)

    try:
        import geopandas as gpd
        from shapely.geometry import mapping
    except ImportError:
        print('ERROR: geopandas not installed. Run: pip install geopandas', file=sys.stderr)
        sys.exit(2)

    try:
        bbox = json.loads(args.bbox)
    except json.JSONDecodeError as e:
        print(f'ERROR: Invalid bbox JSON: {e}', file=sys.stderr)
        sys.exit(1)

    mask_path = args.tile.replace('.tif', '_mask.tif')

    try:
        # Use local cached model path to avoid network calls
        from huggingface_hub import snapshot_download
        try:
            model_path = snapshot_download('CIDAS/clipseg-rd64-refined', local_files_only=True)
        except Exception:
            # Fall back to downloading if not cached
            model_path = 'CIDAS/clipseg-rd64-refined'

        # Run CLIPSeg segmentation with text prompt "trees"
        segmenter = geoai.CLIPSegmentation(model_name=model_path, tile_size=512, overlap=32)
        segmenter.segment_image(
            args.tile,       # input_path
            mask_path,       # output_path
            'trees',         # text_prompt (single string)
            0.4              # threshold
        )

        # Convert raster mask to vector polygons (min area 10 m²)
        gdf = geoai.raster_to_vector(mask_path, min_area=10)

        if gdf is None or len(gdf) == 0:
            # No trees detected — return empty result
            result = {
                'segments': {'type': 'FeatureCollection', 'features': []},
                'treeCount': 0,
                'totalAreaKm2': 0.0,
                'avgConfidence': 0.0
            }
            print(json.dumps(result))
            return

        # Reproject to WGS84 (EPSG:4326) if needed
        if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
            gdf = gdf.to_crs('EPSG:4326')

        # Compute area in m² using projected CRS
        gdf_proj = gdf.to_crs('EPSG:3857')
        gdf['area_m2'] = gdf_proj.geometry.area

        # Use score column as confidence if available, else default to 0.5
        if 'score' in gdf.columns:
            gdf['confidence'] = gdf['score'].clip(0.0, 1.0)
        else:
            gdf['confidence'] = 0.5

        # Filter to only Polygon geometries (drop any non-polygon artefacts)
        gdf = gdf[gdf.geometry.geom_type == 'Polygon'].copy()

        # Build GeoJSON FeatureCollection
        features = []
        for _, row in gdf.iterrows():
            features.append({
                'type': 'Feature',
                'geometry': mapping(row.geometry),
                'properties': {
                    'area_m2': round(float(row['area_m2']), 4),
                    'confidence': round(float(row['confidence']), 4)
                }
            })

        total_area_km2 = float(gdf['area_m2'].sum()) / 1_000_000
        avg_confidence = float(gdf['confidence'].mean()) if len(gdf) > 0 else 0.0

        result = {
            'segments': {'type': 'FeatureCollection', 'features': features},
            'treeCount': len(features),
            'totalAreaKm2': round(total_area_km2, 6),
            'avgConfidence': round(avg_confidence, 4)
        }

        # Also write GeoJSON to output file
        with open(args.output, 'w') as f:
            json.dump(result['segments'], f)

        print(json.dumps(result))

    except Exception as e:
        print(f'ERROR: Segmentation failed: {e}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        # Clean up mask file
        if os.path.exists(mask_path):
            try:
                os.remove(mask_path)
            except Exception:
                pass


if __name__ == '__main__':
    main()
