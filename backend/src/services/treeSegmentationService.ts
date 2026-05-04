import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { pool } from '../db/pool'
import { BBox, DateRange, TreeSegmentationResult } from '../types'
import { getLgaById } from './lgaService'
import { downloadHRTile } from './earthEngineService'

interface SidecarResult {
  segments: GeoJSON.FeatureCollection
  treeCount: number
  totalAreaKm2: number
  avgConfidence: number
}

/**
 * Spawns the Python geoai-py sidecar and returns parsed segmentation results.
 */
export async function runPythonSidecar(tilePath: string, bbox: BBox): Promise<SidecarResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../../scripts/tree_segment.py')
    const outputPath = tilePath.replace('.tif', '_segments.geojson')

    const proc = spawn('python3', [
      scriptPath,
      '--tile', tilePath,
      '--bbox', JSON.stringify(bbox),
      '--output', outputPath,
    ])

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python sidecar exited with code ${code}: ${stderr}`))
      }
      try {
        const result = JSON.parse(stdout.trim()) as SidecarResult
        resolve(result)
      } catch (e) {
        reject(new Error(`Failed to parse sidecar output: ${stdout}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python sidecar: ${err.message}. Ensure python3 and geoai-py are installed.`))
    })
  })
}

/**
 * DB-first lookup for tree segmentation results.
 * Returns cached rows if present; otherwise runs the GeoAI pipeline.
 */
export async function getTreeSegmentation(
  lgaId: string,
  dateRange: DateRange
): Promise<TreeSegmentationResult> {
  // Check cache
  const cached = await pool.query(
    `SELECT ts.*, l.lga_name, l.bbox, l.area_km2
     FROM tree_segments ts
     JOIN lgas l ON l.lga_id = ts.lga_id
     WHERE ts.lga_id = $1
       AND ts.date_range_start = $2
       AND ts.date_range_end = $3
     LIMIT 1`,
    [lgaId, dateRange.start, dateRange.end]
  )

  if (cached.rows.length > 0) {
    return await reconstructFromCache(lgaId, dateRange)
  }

  // Cache miss — verify LGA exists
  const lga = await getLgaById(lgaId)
  if (!lga) {
    const err = new Error(`LGA not found: ${lgaId}`) as any
    err.status = 404
    throw err
  }

  return await computeAndStoreSegmentation(lgaId, lga.bbox, lga.areaKm2, dateRange)
}

/**
 * Reconstructs a full TreeSegmentationResult from cached DB rows.
 */
async function reconstructFromCache(
  lgaId: string,
  dateRange: DateRange
): Promise<TreeSegmentationResult> {
  const rows = await pool.query(
    `SELECT ts.id, ts.lga_id, ST_AsGeoJSON(ts.geom)::json AS geom,
            ts.area_m2, ts.confidence, ts.processed_at,
            l.lga_name, l.bbox, l.area_km2
     FROM tree_segments ts
     JOIN lgas l ON l.lga_id = ts.lga_id
     WHERE ts.lga_id = $1
       AND ts.date_range_start = $2
       AND ts.date_range_end = $3`,
    [lgaId, dateRange.start, dateRange.end]
  )

  const features: GeoJSON.Feature[] = rows.rows.map((r: any) => ({
    type: 'Feature' as const,
    geometry: r.geom,
    properties: {
      area_m2: parseFloat(r.area_m2),
      confidence: parseFloat(r.confidence),
    },
  }))

  const totalAreaKm2 = features.reduce((sum, f) => sum + (f.properties?.area_m2 ?? 0), 0) / 1_000_000
  const avgConfidence = features.length > 0
    ? features.reduce((sum, f) => sum + (f.properties?.confidence ?? 0), 0) / features.length
    : 0

  const first = rows.rows[0]
  const bbox: BBox = first.bbox
  const areaKm2: number = parseFloat(first.area_km2)
  const coveragePct = areaKm2 > 0 ? Math.min(100, (totalAreaKm2 / areaKm2) * 100) : 0

  // Get tile URL from gee_layers
  const layerRow = await pool.query(
    `SELECT tile_url FROM gee_layers
     WHERE lga_id = $1 AND layer_type = 'tree_segmentation'
       AND date_range_start = $2 AND date_range_end = $3
     LIMIT 1`,
    [lgaId, dateRange.start, dateRange.end]
  )
  const tileUrl = layerRow.rows[0]?.tile_url ??
    `/api/lga/${lgaId}/tile-image?type=tree_segmentation&start=${dateRange.start}&end=${dateRange.end}`

  return {
    lgaId,
    lgaName: first.lga_name,
    treeCount: features.length,
    totalAreaKm2: parseFloat(totalAreaKm2.toFixed(6)),
    avgConfidence: parseFloat(avgConfidence.toFixed(4)),
    coveragePct: parseFloat(coveragePct.toFixed(3)),
    tileUrl,
    bbox,
    segments: { type: 'FeatureCollection', features },
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
    processedAt: first.processed_at instanceof Date
      ? first.processed_at.toISOString()
      : new Date(first.processed_at).toISOString(),
  }
}

/**
 * Runs the full GeoAI pipeline: download tile → Python sidecar → bulk insert → return result.
 */
export async function computeAndStoreSegmentation(
  lgaId: string,
  bbox: BBox,
  areaKm2: number,
  dateRange: DateRange
): Promise<TreeSegmentationResult> {
  const lga = await getLgaById(lgaId)
  if (!lga) {
    const err = new Error(`LGA not found: ${lgaId}`) as any
    err.status = 404
    throw err
  }

  let tilePath: string | null = null

  try {
    // Step 1: Download HR satellite tile from EE
    const { tilePath: tp, eeUrl } = await downloadHRTile(bbox, dateRange, lgaId)
    tilePath = tp

    // Step 2: Run Python sidecar (geoai-py CLIPSeg)
    const sidecarResult = await runPythonSidecar(tilePath, bbox)

    // Step 3: Compute coverage
    const coveragePct = areaKm2 > 0
      ? Math.min(100, (sidecarResult.totalAreaKm2 / areaKm2) * 100)
      : 0

    // Step 4: Build proxied tile URL
    const tileUrl = `/api/lga/${lgaId}/tile-image?type=tree_segmentation&start=${dateRange.start}&end=${dateRange.end}`

    // Step 5: Bulk-insert segment polygons into PostGIS
    if (sidecarResult.segments.features.length > 0) {
      const insertValues = sidecarResult.segments.features.map((f, i) => {
        const geomJson = JSON.stringify(f.geometry)
        const areaM2 = f.properties?.area_m2 ?? 0
        const confidence = f.properties?.confidence ?? 0.5
        return `(${i + 1}, '${lgaId}', ST_GeomFromGeoJSON('${geomJson}'), ${areaM2}, ${confidence}, '${dateRange.start}', '${dateRange.end}')`
      })

      // Use parameterised bulk insert for safety
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const feature of sidecarResult.segments.features) {
          const areaM2 = Math.max(0, feature.properties?.area_m2 ?? 0)
          const confidence = Math.min(9.9999, Math.max(0, feature.properties?.confidence ?? 0.5))
          await client.query(
            `INSERT INTO tree_segments (lga_id, geom, area_m2, confidence, date_range_start, date_range_end)
             VALUES ($1, ST_GeomFromGeoJSON($2), $3, $4, $5, $6)`,
            [
              lgaId,
              JSON.stringify(feature.geometry),
              areaM2,
              confidence,
              dateRange.start,
              dateRange.end,
            ]
          )
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    }

    // Step 6: Insert basemap tile into gee_layers
    await pool.query(
      `INSERT INTO gee_layers (lga_id, layer_type, date_range_start, date_range_end, tile_url, ee_url)
       VALUES ($1, 'tree_segmentation', $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [lgaId, dateRange.start, dateRange.end, tileUrl, eeUrl]
    )

    return {
      lgaId,
      lgaName: lga.lgaName,
      treeCount: sidecarResult.treeCount,
      totalAreaKm2: parseFloat(sidecarResult.totalAreaKm2.toFixed(6)),
      avgConfidence: parseFloat(sidecarResult.avgConfidence.toFixed(4)),
      coveragePct: parseFloat(coveragePct.toFixed(3)),
      tileUrl,
      bbox,
      segments: sidecarResult.segments,
      dateRangeStart: dateRange.start,
      dateRangeEnd: dateRange.end,
      processedAt: new Date().toISOString(),
    }
  } finally {
    // Clean up temp tile file
    if (tilePath && fs.existsSync(tilePath)) {
      try { fs.unlinkSync(tilePath) } catch (_) {}
    }
  }
}
