# Photo Geotagger

A fully client-side web app for adding GPS positions (and corrected capture
times) to photos and videos from multiple cameras and phones. Files never
leave your machine — the app reads and writes local folders you pick,
entirely in the browser.

## Disclaimer

100% vibe coded.
All features tested with my holiday photo collection of mobile jpgs, mp4s and sony raws.  
Tested in Android and Windows Chrome. No guarantees elsewhere :D

## What it does

- **Load photos and videos from local folders** — each folder becomes a named
  *source* (e.g. "Phone", "Sony A7") with its own color, clock correction and
  timezone. Supported: JPEG, HEIC, common RAW formats (ARW, CR2/CR3, NEF,
  DNG, RAF, ORF, RW2) and videos (MP4, MOV). Single files work too, and
  filters let you import only certain types.
- **Load GPX tracks** — picked directly or found automatically inside your
  photo folders.
- **Match photos to positions** by time, per photo or for a whole selection:
  interpolate between surrounding points, or take the closest / previous /
  next one — using your GPX tracks, photos that already have GPS (e.g. phone
  photos geotag the camera photos taken alongside them), or both. Photos can
  also be placed by hand: drag their marker, or tap a spot on the map.
- **Create and edit tracks** — draw a track by hand, fix up an existing GPX
  (move points, trim, stretch or shift in time, append, reverse), build a
  track from your geotagged photos, and export everything as GPX.
- **Fix wrong camera clocks** — set a per-source offset, or calibrate by
  clicking where a photo was actually taken on the track. Corrected times
  can optionally be written into the files along with the position.
- **Keep an overview** — a map with a place search, a zoomable timeline to
  select photos by time range, and a filmstrip with thumbnails and a filter
  for photos that still need a position. Clicking a photo focuses it
  everywhere at once; the detail panel shows a large preview and can dump the
  file's complete metadata.
- **XMP sidecars are understood** — position and time from existing sidecars
  are used automatically, and sidecar GPS can be written into the RAW files
  themselves if you want it embedded.
- **Write back** in one of two modes:

  | Mode | JPEG | RAW / HEIC | Video (MP4/MOV) |
  |---|---|---|---|
  | **Safe** (default) | GPS written into the file (no recompression) | `.xmp` sidecar next to the original (Lightroom/darktable-compatible) | `.xmp` sidecar |
  | **ExifTool** | written into the file | written into the file (real ExifTool, running in the browser) | written into the video's standard location metadata — what Google Photos, Apple Photos and video players read |

  Batch writes show live progress with a time estimate and a stop button.
  Videos are always written after all photos.

## Write safety

Every rewritten file is verified before it may replace the original — the
new position and time are independently read back and compared, and dubious
results are rejected. Writes are atomic (a crash mid-write cannot corrupt a
file), transient read errors are retried automatically, and an optional
**Backup originals** setting keeps a `<name>.orig` copy of every file before
its first write.

Note: rewriting a file unavoidably updates its filesystem modified date —
browsers offer no way to preserve it. The capture time stored inside the
file is untouched.

## Browser support

Chrome or Edge, on desktop and Android — the app needs the File System
Access API to edit local files in place, which Firefox and Safari don't
offer. Folders and tracks from previous sessions can be re-opened with one
click, and your settings are remembered.

**Android caveat**: Android strips GPS from photos when a browser reads
them. The app detects such files, explains it, and warns before writing —
so you don't accidentally overwrite a photo's real location with a stripped
copy.

## Limitations

- Very large videos (over ~1.3 GB) can't be rewritten in the browser — they
  get an `.xmp` sidecar instead.
- A RAW/HEIC file without an embedded preview shows a placeholder thumbnail;
  video thumbnails need a codec the browser can play (H.264 yes, HEVC only
  with hardware support).
- Map tiles and the place search need internet; everything else works
  offline after the first load.
- Writing exotic RAW variants in the browser is less battle-tested than
  desktop ExifTool — keep backups on (every output is verified anyway).

## Licenses

Built on open-source software — see
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) for the frameworks,
the embedded ExifTool/Perl WASM stack, and the OpenStreetMap map/search
services with their licenses.

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
are UTC; Sony XAVC clips get their local time + timezone from the XML
metadata (`CreationDateValue`). Photos with no metadata time fall back to
the file's modified time (flagged in the inspector).

### Performance & robustness notes

- RAW previews are located by walking the file's own TIFF directories with
  small ranged reads (IFD chain, SubIFDs, single-strip JPEG IFDs), verifying a
  JPEG SOI marker before slicing. `exifr.thumbnail()` cannot do this: it reads
  only IFD1's ThumbnailOffset out of the chunk it happens to have loaded, so a
  Sony ARW (preview behind a SubIFD, megabytes in) yielded no thumbnail at
  all.
- Metadata scanning streams through a worker pool with small batches; there
  is no upfront stat pass (it starved the scan on Android SAF). Thumbnails
  are generated lazily for visible filmstrip items only, debounced against
  re-sorting during a scan; a clicked photo jumps the queue.
- ExifTool writes coalesce many files into one Perl execution (argfile +
  `-execute`), run in a worker pool that pre-boots when ExifTool mode is
  selected. JPEGs always take the fast pure-JS path. Safe-mode batches write
  with parallel workers and a per-batch directory-handle cache (FSA round
  trips dominate their cost).
- Write parallelism (files in flight, ExifTool workers) is fitted
  automatically: modest defaults while an import is still loading — sizes
  arrive per scanned file, so the memory estimate only grows — then the widest
  setting whose estimated peak stays under a comfortable target (1 GB on
  phones, 2 GB otherwise). The ⚙ Limits dialog offers values up to a peak of
  2 GB / 8 GB for anyone who wants to trade memory for speed; both figures
  come down to what `navigator.deviceMemory` reports, and neither knob is ever
  offered beyond the logical core count. It shows each value's estimated peak
  for the loaded files, marks the automatic choice, and switches to manual as
  soon as one is picked.
- Videos: capture date and GPS are parsed from the container with tiny
  sliced reads (Sony XML uuid box, `mvhd`, `©xyz`/`Keys`); the ExifTool
  inspector feeds on a metadata-only copy (all boxes except `mdat`), so file
  size doesn't matter. Rewrites are capped by the ~2 GB ArrayBuffer limit;
  videos run last, one at a time, and are never coalesced into batches.
- Recovery: fatal WASM faults (frozen background tab) rebuild the
  interpreter and retry once; idle workers are recycled when the tab becomes
  visible again; monolithic file reads fall back to chunked reads on
  NotReadableError (network/cloud drives); write permission escalation
  copes with Chrome's one-prompt-per-user-gesture rule.
- The write ETA models per-file-class service times (jpeg/raw/video) divided
  by the worker count — recency-weighted, so cold starts and mixed batches
  don't whipsaw the estimate.
