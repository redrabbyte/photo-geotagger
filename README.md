# Photo Geotagger

A fully client-side web app for adding GPS coordinates (and corrected capture
times) to photos and videos from multiple cameras and phones. Files never
leave your machine — the app reads and writes local folders you pick,
entirely in the browser.

## What it does

- **Load photos and videos from local folders** — each folder becomes a named
  *source* (e.g. "Phone", "Sony A7") with its own color, clock correction and
  timezone assumption. JPEG, HEIC, common RAW formats (ARW, CR2/CR3, NEF,
  DNG, RAF, ORF, RW2) and videos (MP4, MOV, M4V) are scanned for capture time
  and existing GPS. Individual files can be picked too, and checkbox filters
  (JPG / RAW / XMP / MP4) control what a folder import picks up.
- **XMP sidecars are first-class** — existing `.xmp` files next to RAWs are
  paired on import; their GPS *and* their `DateTimeOriginal` outrank the
  file's embedded values (a sidecar is the newer edit). Sidecar GPS can
  optionally be embedded into the RAW files themselves in ExifTool mode.
- **Videos are first-class** — capture time comes from Sony's XAVC XML
  metadata (`CreationDateValue`, with timezone) or the QuickTime movie header
  (UTC); GPS from `©xyz`/`Keys` ISO 6709 atoms. Thumbnails are decoded video
  frames. All of it reads only tiny byte ranges, so multi-GB clips are fine.
- **Load GPX tracks** — picked explicitly or auto-discovered inside source
  folders, with instant list placeholders while parsing.
- **Match photos to positions** by timestamp, per photo or in bulk, using GPX
  tracks, already-geotagged photos, or both (checkboxes):
  - *Interpolate* between the surrounding reference points (never across
    track-segment gaps — degrades to closest with a warning)
  - *Closest / before / after* reference point — across tracks, with no time
    cutoff (the time delta is always shown)
  - With both reference kinds enabled: inside a track's time span tracks are
    authoritative; outside, each side takes whichever is nearer in time — so
    interpolation can mix a track end with the next geotagged photo
  - *Manual*: drag any marker on the map (optionally snapping to a track), or
    tap **Place on map…** and then tap the position — also for the whole
    selection at once
- **Build and edit tracks** — draw a manual track (start/end time, points
  placed on the map, distance-based time interpolation, manual time anchors),
  edit existing GPX tracks (move/insert/delete points, trim before/after a
  point, proportional time stretch, shift in time, append one track to
  another, reverse direction), duplicate tracks, build a track from the
  selected photos' positions, and export any of it as GPX.
- **Fix wrong camera clocks** — per-source offset (±hh:mm:ss, quick ±1h
  chips), or click-calibrate: pick a photo, click the spot on the track where
  it was actually taken. Changing an offset marks affected matches stale and
  offers one-click re-matching. The corrected time (+ timezone) can
  optionally be written into the files — alongside a GPS write or on its own
  via **Fix times** (which targets the current selection when one exists).
- **See everything on a map, timeline, and filmstrip** — MapLibre map with
  tracks and status-coded markers plus a collapsible place search
  (OpenStreetMap/Photon); a zoomable timeline (wheel/pinch zoom, middle-drag
  pan, brush to select by time range — a bare click moves the cursor, flies
  the map and focuses the nearest photo without touching the selection); a
  virtualized filmstrip with lazy thumbnails, drag- and wheel-scrolling,
  multi/range select, and an *untagged* filter (plus an *untagged+stripped*
  state when Android-stripped files are present). Clicking a photo moves the
  timeline and map to it; the detail panel shows a high-quality preview
  (original JPEG / full-size embedded RAW preview / 1280px video frame) that
  scales with the resizable side panels. EXIF orientation is applied
  everywhere.
- **Inspect raw metadata** — an ExifTool dump of any file (for videos built
  from a metadata-only copy, so size doesn't matter), including embedded
  documents (`-ee`, e.g. motion-photo trailers).
- **Write back** in one of two modes:

  | Mode | JPEG | RAW / HEIC | Video (MP4/MOV) |
  |---|---|---|---|
  | **Safe** (default) | EXIF written in place (pure JS, no recompression) | `.xmp` sidecar next to the original (merged into an existing sidecar; Lightroom/darktable-compatible) | `.xmp` sidecar |
  | **ExifTool (WASM)** | written in place (fast pure-JS path) | written in place — real ExifTool 13.42 compiled to WebAssembly | QuickTime `GPSCoordinates` (Keys + UserData) and, for time fixes, `CreateDate`/`ModifyDate` (UTC) + `Keys:CreationDate` (with timezone) |

  Batches show live progress with a recency-weighted ETA (per file class,
  parallelism-aware) and a stop button. Videos are always written last, one
  at a time, so an out-of-memory crash on a huge clip can never take
  unwritten photos down with it (rewrites over ~1.3 GB are refused with
  advice to use sidecars — a single ArrayBuffer cannot hold them).

### Write safety

Every rewritten file is verified before it may replace the original: the GPS
is re-read from the output and compared, the capture time is checked
(`DateTimeOriginal`, or `CreateDate` for videos), and implausibly small
outputs are rejected. Writes go through the File System Access API's atomic
write-temp-then-swap, so a crash mid-write cannot corrupt a file. An optional
**Backup originals** setting copies each file to `<name>.orig` before its
first write (forced on when enabling ExifTool mode).

The pipeline also self-heals: a corrupted WASM interpreter (typical after the
tab was frozen in the background) is rebuilt and the write retried
automatically, and full-file reads fall back to chunked reads when a network
or cloud-backed drive rejects one big read.

Note: rewriting a file unavoidably updates its filesystem modified time —
the browser offers no way to preserve it.

## Browser support

Chrome or Edge — desktop and Android. The app depends on the File System
Access API to read and write local files in place; Firefox and Safari don't
support it. Previously used folders and GPX files can be re-opened from the
"Previous session" list with one click (Chrome may re-ask for permission;
it shows at most one permission prompt per click, and the app guides through
multi-source grants). Settings (write mode, filters, panel widths, …)
persist across sessions.

On mobile the layout reflows: the map stays pinned at a capped height with
panels scrolling over it, and the header collapses to a finger-high grab
handle that shows compact write progress.

**Android caveat**: scoped storage strips GPS from photos when a browser
reads them. The app detects the empty-GPS signature, explains it in the
inspector, offers a filter state for such files, and warns before writing
(with a skip option) — writing would bake the stripped copy in.

## Performance

Optimized for large imports on slow storage (Android SAF, network drives):
metadata scanning streams in worker pools with no upfront stat pass,
thumbnails are generated lazily only for what is visible (debounced against
reordering; a clicked photo jumps the queue), and ExifTool writes batch many
files into one Perl execution, run in an adaptively sized worker pool (2–4,
by CPU/memory) that pre-boots when ExifTool mode is selected. JPEGs always
take the fast pure-JS path. Sidecar/JPEG batches write with parallel workers
and a per-batch directory-handle cache.

## Development

```bash
npm install
npm run dev        # dev server
npm test           # unit tests (vitest) — domain logic, JPEG/XMP/MP4
                   # round-trips, and real ExifTool-WASM writes in Node
npm run build      # type-check + production build
npm run lint       # oxlint
```

### Architecture

```
src/
  domain/     pure logic, no DOM/FS deps: matching strategies, track index,
              track drafts/editing, GPX parsing, XMP sidecar generate/merge/
              read, GPS math — unit tested
  services/   File System Access wrappers, scan client, write pipeline
              (batching, ETA, crash recovery), video container parsing
              (dates, GPS, metadata-only copies), EXIF orientation, video
              frame thumbnails, direct zeroperl driver for batched ExifTool,
              IndexedDB handle persistence
  workers/    scan.worker (exifr metadata + thumbnails, pooled),
              exiftool.worker (zeroperl WASM, pooled, request coalescing)
  state/      zustand store (persisted settings)
  ui/         MapView, MapSearch, Timeline, Filmstrip, Inspector,
              TrackEditorPanel, SourcesPanel, WriteBar
```

Times are handled explicitly: EXIF capture times are wall-clock; each photo's
UTC time = wall-clock − timezone (EXIF `OffsetTimeOriginal`, a sidecar's
timezone, or the source's assumed timezone) + the source's clock offset. A
sidecar's `DateTimeOriginal` and an in-file written correction count as
already corrected (the offset is not applied twice). GPX and QuickTime times
are UTC. Photos with no metadata time fall back to the file's modified time
(flagged in the inspector).

### Known limitations

- RAW/HEIC thumbnails come from embedded EXIF previews; a file with no
  embedded preview shows a placeholder. Video thumbnails need a codec the
  browser can decode (H.264 yes; HEVC only with hardware support).
- Map tiles and the place search need network access; everything else works
  offline after the first load.
- In-place video rewrites are capped around 1.3 GB by the browser's
  ArrayBuffer limit — larger clips use `.xmp` sidecars (Safe mode).
- In-browser writes to exotic RAW variants via ExifTool-WASM are less
  battle-tested than desktop ExifTool — keep backups enabled (the app also
  verifies every output before committing it).
