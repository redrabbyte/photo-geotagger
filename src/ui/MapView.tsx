import { useEffect, useRef, useState } from 'react'
import type { FeatureCollection, Feature } from 'geojson'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GeoPoint, Track } from '../domain/types'
import { displayPosition, gpsStatus } from '../domain/types'
import { projectOntoTrack } from '../domain/projectOntoTrack'
import { projectOntoDraft, type TrackDraft } from '../domain/trackDraft'
import { useStore } from '../state/store'
import { formatDeltaMs, formatUtc } from './format'

const DRAFT_LINE_COLOR = '#ffd54f'
const DRAFT_MANUAL_COLOR = '#ff7043'
const DRAFT_AUTO_COLOR = '#4fc3f7'

const STATUS_STROKE: Record<string, string> = {
  original: '#2e7d32',
  assigned: '#1565c0',
  manual: '#ef6c00',
  none: '#757575',
}

const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

function trackFeatures(tracks: Record<string, Track>): FeatureCollection {
  const features: Feature[] = []
  for (const track of Object.values(tracks)) {
    for (const seg of track.segments) {
      const coords = track.points.slice(seg.startIdx, seg.endIdx + 1).map((p) => [p.lon, p.lat])
      if (coords.length < 2) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { color: track.color, id: track.id },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Nearest projection of a point across all tracks. */
function projectAcrossTracks(tracks: Track[], target: GeoPoint) {
  let best: { trackId: string; point: GeoPoint; t: number; distSq: number } | undefined
  for (const track of tracks) {
    const proj = projectOntoTrack(track, target)
    if (proj && (!best || proj.distSq < best.distSq)) {
      best = { trackId: track.id, point: proj.point, t: proj.t, distSq: proj.distSq }
    }
  }
  return best
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const didFitRef = useRef(false)

  const photos = useStore((s) => s.photos)
  const sources = useStore((s) => s.sources)
  const tracks = useStore((s) => s.tracks)
  const selectedIds = useStore((s) => s.selectedIds)
  const calibrate = useStore((s) => s.calibrate)
  const draft = useStore((s) => s.draft)
  const draftSelectedIndex = useStore((s) => s.draftSelectedIndex)
  const draftPlacement = useStore((s) => s.draftPlacement)

  // Live values for event handlers registered once.
  const stateRef = useRef({ photos, sources, tracks, selectedIds, calibrate, draft: draft as TrackDraft | undefined, draftPlacement })
  stateRef.current = { photos, sources, tracks, selectedIds, calibrate, draft, draftPlacement }

  // Positions being dragged override store positions until mouseup commits.
  const dragPositions = useRef(new Map<string, GeoPoint>()).current

  const refreshPhotoSource = () => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource('photos') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const { photos: ph, sources: srcs, selectedIds: sel } = stateRef.current
    const features: Feature[] = []
    for (const p of Object.values(ph)) {
      const pos = dragPositions.get(p.id) ?? displayPosition(p)
      if (!pos) continue
      const status = gpsStatus(p)
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
        properties: {
          id: p.id,
          color: srcs[p.sourceId]?.color ?? '#888',
          stroke: STATUS_STROKE[status],
          selected: sel.has(p.id) ? 1 : 0,
        },
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }
  const refreshRef = useRef(refreshPhotoSource)
  refreshRef.current = refreshPhotoSource

  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [8.5, 50],
      zoom: 4,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__map = map
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    // 'style.load' instead of 'load': the latter waits for tiles and never
    // fires when tile requests fail (offline, blocked by a proxy) — which
    // would leave the map without any photo/track layers or interactions.
    map.once('style.load', () => {
      map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: 'tracks-line',
        type: 'line',
        source: 'tracks',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.75 },
      })
      map.addSource('photos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: 'photos-selected-ring',
        type: 'circle',
        source: 'photos',
        filter: ['==', ['get', 'selected'], 1],
        paint: { 'circle-radius': 11, 'circle-color': '#ffffff', 'circle-opacity': 0.9 },
      })
      map.addLayer({
        id: 'photos-circle',
        type: 'circle',
        source: 'photos',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], 1], 8, 6],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': ['get', 'stroke'],
          'circle-opacity': 0.95,
        },
      })

      // Track draft (manual track builder / GPX editor).
      map.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: 'draft-line',
        type: 'line',
        source: 'draft',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': DRAFT_LINE_COLOR,
          'line-width': 5,
          'line-dasharray': [1.5, 1],
          'line-opacity': 0.9,
        },
      })
      map.addLayer({
        id: 'draft-points',
        type: 'circle',
        source: 'draft',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], 1], 9, 7],
          'circle-color': ['case', ['==', ['get', 'manual'], 1], DRAFT_MANUAL_COLOR, DRAFT_AUTO_COLOR],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      })

      const canvas = map.getCanvas()

      map.on('mouseenter', 'photos-circle', () => {
        canvas.style.cursor = 'pointer'
      })
      map.on('mouseleave', 'photos-circle', () => {
        canvas.style.cursor = ''
      })

      // Click empty map: draft endpoint placement, calibration click, or deselect.
      map.on('click', (e) => {
        const store = useStore.getState()
        if (stateRef.current.draftPlacement) {
          store.placeDraftPoint({ lat: e.lngLat.lat, lon: e.lngLat.lng })
          return
        }
        if (stateRef.current.draft) {
          const pointFeats = map.queryRenderedFeatures(e.point, { layers: ['draft-points'] })
          const idx = pointFeats[0]?.properties?.index
          store.selectDraftPoint(typeof idx === 'number' ? idx : undefined)
          return
        }
        const feats = map.queryRenderedFeatures(e.point, { layers: ['photos-circle'] })
        const cal = stateRef.current.calibrate
        if (cal) {
          const proj = projectAcrossTracks(Object.values(stateRef.current.tracks), {
            lat: e.lngLat.lat,
            lon: e.lngLat.lng,
          })
          if (!proj) {
            store.notify('error', 'No track loaded to calibrate against.')
          } else {
            const offset = proj.t - cal.photoBaseUtcMs
            store.updateSource(cal.sourceId, { clockOffsetMs: offset })
            store.notify(
              'success',
              `Clock offset for ${store.sources[cal.sourceId]?.name ?? 'source'} set to ${formatDeltaMs(offset)} (from ${cal.photoName} at ${formatUtc(proj.t)})`
            )
          }
          store.cancelCalibrate()
          return
        }
        if (feats.length === 0) store.setSelection([])
      })

      map.on('click', 'photos-circle', (e) => {
        if (stateRef.current.calibrate) return
        const id = e.features?.[0]?.properties?.id as string | undefined
        if (id) {
          const ev = e.originalEvent as MouseEvent
          useStore.getState().toggleSelected(id, ev.ctrlKey || ev.metaKey || ev.shiftKey)
        }
      })

      // Drag a photo marker to set a manual position (optionally snapped to track).
      let dragging: { id: string } | undefined
      const dragPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 })

      const onMove = (e: maplibregl.MapMouseEvent) => {
        if (!dragging) return
        const snap = useStore.getState().snapToTrack
        let pos: GeoPoint = { lat: e.lngLat.lat, lon: e.lngLat.lng }
        let popupHtml = ''
        if (snap) {
          const proj = projectAcrossTracks(Object.values(stateRef.current.tracks), pos)
          if (proj) {
            pos = proj.point
            const photo = stateRef.current.photos[dragging.id]
            const source = photo && stateRef.current.sources[photo.sourceId]
            let deltaText = ''
            if (photo?.meta && source) {
              const tz = photo.meta.tzOffsetMin ?? source.assumedTzOffsetMin
              const eff = photo.meta.captureLocalMs - tz * 60_000 + source.clockOffsetMs
              deltaText = `<br/>photo Δ ${formatDeltaMs(eff - proj.t)}`
            }
            popupHtml = `track time ${formatUtc(proj.t)}${deltaText}`
          }
        }
        updateDragFeature(dragging.id, pos)
        if (popupHtml) {
          dragPopup.setLngLat([pos.lon, pos.lat]).setHTML(popupHtml).addTo(map)
        } else {
          dragPopup.remove()
        }
      }

      const updateDragFeature = (id: string, pos: GeoPoint) => {
        dragPositions.set(id, pos)
        refreshRef.current()
      }

      const onUp = (e: maplibregl.MapMouseEvent) => {
        if (!dragging) return
        const id = dragging.id
        dragging = undefined
        map.off('mousemove', onMove)
        dragPopup.remove()
        map.dragPan.enable()
        const store = useStore.getState()
        const snap = store.snapToTrack
        let pos: GeoPoint = { lat: e.lngLat.lat, lon: e.lngLat.lng }
        let trackId: string | undefined
        if (snap) {
          const proj = projectAcrossTracks(Object.values(stateRef.current.tracks), pos)
          if (proj) {
            pos = proj.point
            trackId = proj.trackId
          }
        }
        dragPositions.delete(id)
        store.setManualPosition(id, pos, trackId)
      }

      map.on('mousedown', 'photos-circle', (e) => {
        if (stateRef.current.calibrate || stateRef.current.draft) return
        const feature = e.features?.[0]
        const id = feature?.properties?.id as string | undefined
        if (!id) return
        e.preventDefault()
        dragging = { id }
        map.dragPan.disable()
        map.on('mousemove', onMove)
        map.once('mouseup', onUp)
      })

      // --- draft editing: drag points; drag the line to insert a point ---
      let draggingDraftIndex: number | undefined

      const onDraftMove = (e: maplibregl.MapMouseEvent) => {
        if (draggingDraftIndex === undefined) return
        useStore.getState().moveDraftPointAt(draggingDraftIndex, { lat: e.lngLat.lat, lon: e.lngLat.lng })
      }
      const onDraftUp = () => {
        draggingDraftIndex = undefined
        map.off('mousemove', onDraftMove)
        map.dragPan.enable()
      }

      map.on('mousedown', 'draft-points', (e) => {
        if (!stateRef.current.draft) return
        const idx = e.features?.[0]?.properties?.index
        if (typeof idx !== 'number') return
        e.preventDefault()
        draggingDraftIndex = idx
        useStore.getState().selectDraftPoint(idx)
        map.dragPan.disable()
        map.on('mousemove', onDraftMove)
        map.once('mouseup', onDraftUp)
      })

      map.on('mousedown', 'draft-line', (e) => {
        const draft = stateRef.current.draft
        if (!draft) return
        // A point on top of the line wins — its own handler runs instead.
        if (map.queryRenderedFeatures(e.point, { layers: ['draft-points'] }).length > 0) return
        const proj = projectOntoDraft(draft.points, { lat: e.lngLat.lat, lon: e.lngLat.lng })
        if (!proj) return
        e.preventDefault()
        const newIndex = useStore.getState().insertDraftAutoAt(proj.segmentIndex, proj.point)
        if (newIndex < 0) return
        draggingDraftIndex = newIndex
        map.dragPan.disable()
        map.on('mousemove', onDraftMove)
        map.once('mouseup', onDraftUp)
      })

      map.on('mouseenter', 'draft-points', () => {
        canvas.style.cursor = 'move'
      })
      map.on('mouseleave', 'draft-points', () => {
        canvas.style.cursor = ''
      })
      map.on('mouseenter', 'draft-line', () => {
        if (stateRef.current.draft) canvas.style.cursor = 'copy'
      })
      map.on('mouseleave', 'draft-line', () => {
        canvas.style.cursor = ''
      })

      setMapReady(true)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fly-to commands from other components (track list, timeline).
  const mapTarget = useStore((s) => s.mapTarget)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !mapTarget) return
    map.flyTo({
      center: [mapTarget.point.lon, mapTarget.point.lat],
      zoom: Math.max(map.getZoom(), mapTarget.zoom ?? 13),
      duration: 700,
    })
  }, [mapTarget, mapReady])

  // Track layer updates.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('tracks') as maplibregl.GeoJSONSource | undefined
    src?.setData(trackFeatures(tracks))
  }, [tracks, mapReady])

  // Photo layer updates.
  useEffect(() => {
    if (!mapReady) return
    refreshPhotoSource()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, sources, selectedIds, mapReady])

  // Draft layer updates.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('draft') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const features: Feature[] = []
    if (draft && draft.points.length > 0) {
      if (draft.points.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: draft.points.map((p) => [p.lon, p.lat]) },
          properties: {},
        })
      }
      draft.points.forEach((p, index) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: {
            index,
            manual: p.manual ? 1 : 0,
            selected: index === draftSelectedIndex ? 1 : 0,
          },
        })
      })
    }
    src.setData({ type: 'FeatureCollection', features })
  }, [draft, draftSelectedIndex, mapReady])

  // Fit bounds once when positions first appear.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || didFitRef.current) return
    const coords: [number, number][] = []
    for (const t of Object.values(tracks)) for (const p of t.points) coords.push([p.lon, p.lat])
    for (const p of Object.values(photos)) {
      const pos = displayPosition(p)
      if (pos) coords.push([pos.lon, pos.lat])
    }
    if (coords.length < 2) return
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    )
    map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 400 })
    didFitRef.current = true
  }, [photos, tracks, mapReady])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {calibrate && (
        <div className="map-banner">
          Calibrating “{calibrate.photoName}”: click the spot on a track where this photo was taken.
          <button onClick={() => useStore.getState().cancelCalibrate()}>Cancel</button>
        </div>
      )}
      {draftPlacement && (
        <div className="map-banner">
          Click the map to place the track’s {draftPlacement.which === 'start' ? 'start' : 'end'} point.
          <button onClick={() => useStore.getState().cancelDraft()}>Cancel</button>
        </div>
      )}
    </div>
  )
}
