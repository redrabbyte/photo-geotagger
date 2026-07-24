import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

interface SearchResult {
  label: string
  lat: number
  lon: number
  /** [minLon, minLat, maxLon, maxLat] when the place has an extent. */
  extent?: [number, number, number, number]
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    city?: string
    state?: string
    country?: string
    osm_value?: string
    extent?: [number, number, number, number]
  }
}

function labelOf(p: PhotonFeature['properties']): string {
  const parts = [p.name, p.city, p.state, p.country].filter(
    (v, i, arr) => v && arr.indexOf(v) === i
  )
  return parts.join(', ')
}

function zoomFor(extent?: [number, number, number, number]): number {
  if (!extent) return 14
  const dLon = Math.max(1e-4, Math.abs(extent[2] - extent[0]))
  return Math.max(3, Math.min(16, Math.floor(Math.log2(360 / dLon))))
}

/** Collapsible place search (Photon/OSM geocoder) overlaid on the map. */
export function MapSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [status, setStatus] = useState<'idle' | 'busy' | 'error'>('idle')
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Setting the input to a picked result's label must not re-trigger the
  // search — the dropdown would immediately reopen over the map.
  const lastPickedRef = useRef<string>('')

  // Debounced as-you-type search (Photon is built for it; 450ms is polite).
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || query === lastPickedRef.current) {
      setResults([])
      setStatus('idle')
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setStatus('busy')
      try {
        const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { features?: PhotonFeature[] }
        setResults(
          (json.features ?? [])
            .map((f) => ({
              label: labelOf(f.properties) || `${f.geometry.coordinates[1]}, ${f.geometry.coordinates[0]}`,
              lat: f.geometry.coordinates[1],
              lon: f.geometry.coordinates[0],
              extent: f.properties.extent,
            }))
            .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
        )
        setStatus('idle')
      } catch (err) {
        // A superseded request (new keystroke, unmount) is not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setResults([])
        setStatus('error')
      }
    }, 450)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const pick = (r: SearchResult) => {
    useStore.getState().flyTo({ lat: r.lat, lon: r.lon }, zoomFor(r.extent))
    setResults([])
    lastPickedRef.current = r.label
    setQuery(r.label)
  }

  if (!open) {
    return (
      <button className="map-search-toggle" title="Search for a place (OpenStreetMap)" onClick={() => setOpen(true)}>
        🔍
      </button>
    )
  }

  return (
    <div className="map-search">
      <div className="map-search-row">
        <input
          ref={inputRef}
          value={query}
          placeholder="Search place…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results.length > 0) pick(results[0])
            if (e.key === 'Escape') setOpen(false)
          }}
        />
        <button title="Collapse search" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      {status === 'error' && <div className="map-search-note">Search failed — try again</div>}
      {status === 'busy' && results.length === 0 && <div className="map-search-note">Searching…</div>}
      {results.length > 0 && (
        <ul className="map-search-results">
          {results.map((r, i) => (
            <li key={i} onClick={() => pick(r)}>
              {r.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
