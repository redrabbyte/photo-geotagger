# Photo Geotagger

A fully client-side web app for adding GPS coordinates to photos from multiple
cameras and phones. Photos never leave your machine — the app reads and writes
files in local folders you pick, entirely in the browser.

## What it does

- **Load photos from local folders** — each folder becomes a named *source*
  (e.g. "Phone", "Sony A7") with its own color, clock correction and timezone
  assumption. JPEG, HEIC and common RAW formats (ARW, CR2/CR3, NEF, DNG, RAF,
  ORF, RW2) are scanned for capture time and existing GPS.
- **Load GPX tracks** — picked explicitly or auto-discovered inside source
  folders.
- **Match photos to positions** by timestamp, per photo or in bulk:
  - *Interpolate* between the surrounding trackpoints (never across segment
    gaps — degrades to closest with a warning)
  - *Closest / before / after* trackpoint
  - *Inherit* from time-adjacent photos that already have GPS (e.g. phone
    photos geotag the camera photos taken alongside them)
  - *Manual*: drag any marker on the map, optionally snapping to the track
    (with a live tooltip showing the track time vs. the photo time)
- **Fix wrong camera clocks** — per-source offset (±hh:mm:ss, quick ±1h
  chips), or click-calibrate: pick a photo, click the spot on the track where
  it was actually taken, and the offset is computed. Changing an offset marks
  affected matches stale and offers one-click re-matching.
- **See everything on a map and timeline** — MapLibre map with tracks and
  status-coded markers, a timeline strip showing track coverage vs. photo
  ticks (brush to select by time range), and a filmstrip with thumbnails.
- **Write GPS back** in one of two modes:

  | Mode | JPEG | RAW / HEIC |
  |---|---|---|
  | **Safe** (default) | EXIF written in place (pure JS, no recompression) | `.xmp` sidecar next to the original (merged into an existing sidecar, understood by Lightroom/darktable) |
  | **ExifTool (WASM)** | written in place | written in place — real ExifTool 13.42 compiled to WebAssembly (~25 MB, loads on first write) |

### Write safety

Every rewritten file is verified before it may replace the original: the GPS
is re-read from the output and compared, `DateTimeOriginal` is checked for
accidental changes, and implausibly small outputs are rejected. Writes go
through the File System Access API's atomic write-temp-then-swap, so a crash
mid-write cannot corrupt a file. An optional **Backup originals** setting
copies each file to `<name>.orig` before its first write (default on).

Note: rewriting a file unavoidably updates its filesystem modified time —
the browser offers no way to preserve it. The EXIF capture time inside the
file is untouched and remains authoritative.

## Browser support

Chrome or Edge (desktop). The app depends on the File System Access API
(`showDirectoryPicker`) to read and write local files in place; Firefox and
Safari don't support it. Previously used folders can be re-opened from the
"Previous session" list with one click (Chrome may re-ask for permission).

## Development

```bash
npm install
npm run dev        # dev server
npm test           # unit tests (vitest) — domain logic, JPEG/XMP round-trips,
                   # and a real ExifTool-WASM write in Node
npm run build      # type-check + production build
npm run lint       # oxlint
```

### Architecture

```
src/
  domain/     pure logic, no DOM/FS deps: matching strategies, track index,
              GPX parsing, XMP sidecar generate/merge, GPS math — unit tested
  services/   File System Access wrappers, scan client, write pipeline,
              IndexedDB handle persistence
  workers/    scan.worker (exifr metadata + thumbnails, pooled),
              exiftool.worker (zeroperl WASM, created lazily)
  state/      zustand store
  ui/         MapView, Timeline, Filmstrip, Inspector, SourcesPanel, WriteBar
```

Times are handled explicitly: EXIF capture times are wall-clock; each photo's
UTC time = wall-clock − timezone (EXIF `OffsetTimeOriginal` if present, else
the source's assumed timezone) + the source's clock offset. GPX times are UTC.
Photos with no EXIF time fall back to the file's modified time (flagged in
the inspector).

### Known limitations

- Thumbnails come from embedded EXIF previews (plus native decode for JPEG);
  a HEIC/RAW file with no embedded preview shows a placeholder.
- Map tiles come from openstreetmap.org and need network access; everything
  else works offline after the first load.
- In-browser writes to exotic RAW variants via ExifTool-WASM are less
  battle-tested than desktop ExifTool — keep backups enabled (the app also
  verifies every output before committing it).
