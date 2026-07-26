# Photo Geotagger

A fully client-side web app for adding GPS positions (and corrected capture
times) to photos and videos from multiple cameras and phones. Files never
leave your machine — the app reads and writes local folders you pick,
entirely in the browser.

## Disclaimer

100% vibe coded.
All features tested with my holiday photo collection of mobile jpgs, mp4s and Sony raws with normal and fast mode.  
Tested in Chrome on Android and Windows. No guarantees else- (or any-) where :D

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
  for photos that still need a position. Each folder shows how far its
  metadata and previews have loaded. Clicking a photo focuses it everywhere at
  once; the detail panel shows a large preview and can dump the file's
  complete metadata.
- **XMP sidecars are understood** — position and time from existing sidecars
  are used automatically, and sidecar GPS can be written into the RAW files
  themselves if you want it embedded.
- **Write back** in one of two modes:

  | Mode | JPEG | RAW / HEIC | Video (MP4/MOV) |
  |---|---|---|---|
  | **Into the files** (default) | written into the file (no recompression) | written into the file by ExifTool 13.42, compiled to WebAssembly | written into the video's standard location metadata — what Google Photos, Apple Photos and video players read |
  | **Sidecars** | written into the file | `.xmp` sidecar next to the original (Lightroom/darktable-compatible) | `.xmp` sidecar |

  Two experimental options replace ExifTool with a purpose-built writer in
  plain JS: **fast MP4** edits the container's metadata boxes and streams the
  untouched spans straight through (no whole-file buffer, so no size cap and
  no minutes-long wait for a large clip), **fast RAW** edits the TIFF
  directories of ARW/NEF/CR2/DNG (sub-second, and no 25 MB WASM download).
  Both verify their output through the app's own import path and hand the file
  to ExifTool on any doubt, so switching them on can cost speed but not
  correctness.

  Batch writes show live progress with a time estimate and a stop button; with
  photos selected, the write buttons apply to the selection only. Videos are
  written after all photos.
- **Repair Windows' view of RAW positions** — Windows' RAW codec reads a
  file's Interoperability IFD as GPS tags, where two of them collide with
  GPSLatitudeRef/GPSLatitude: Explorer shows "R98" as the hemisphere and no
  latitude at all, no matter which tool wrote the position. Writing GPS into a
  RAW now removes that directory, and a button offers the same repair for
  files that already carry one — it appears only when the import contains
  any.

## Write safety

Every rewritten file is verified before it may replace the original — the
new position and time are independently read back and compared, and dubious
results are rejected. Writes are atomic (a crash mid-write cannot corrupt a
file), transient read errors are retried automatically, and the **Backup
originals** setting — on by default — keeps a `<name>.orig` copy of every
file before its first write.

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

- The ExifTool path buffers a whole video in memory, so clips over ~1.3 GB
  are refused there — turn on experimental fast MP4 (no size limit) or write
  a sidecar instead.
- A RAW/HEIC file with no embedded JPEG preview shows a placeholder thumbnail;
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
npm install        # also applies patches/ via postinstall (see below)
npm run dev        # dev server
npm test           # unit tests (vitest) — domain logic, JPEG/XMP/MP4/TIFF
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
              (batching, ETA, memory estimates, crash recovery), pure-JS
              metadata writers for MP4/MOV and TIFF-based RAWs, targeted TIFF
              reader (GPS and embedded previews behind far pointers), video
              container parsing (dates, GPS, metadata-only copies), EXIF
              orientation, video frame thumbnails, direct zeroperl driver for
              batched ExifTool, IndexedDB handle persistence
  workers/    scan.worker (exifr metadata + thumbnails, pooled),
              exiftool.worker (zeroperl WASM, pooled, request coalescing)
  state/      state store (persisted settings)
  ui/         MapView, MapSearch, Timeline, Filmstrip, Inspector,
              TrackEditorPanel, SourcesPanel, WriteBar, LimitsDialog
patches/      zeroperl's fd_write, fixed to grow geometrically (see below)
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
  `-execute`), run in a worker pool that pre-boots as soon as writing into the
  files is selected. JPEGs always take the fast pure-JS path. Sidecar batches
  write with parallel workers and a per-batch directory-handle cache (FSA
  round trips dominate their cost).
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
  size doesn't matter. The ExifTool path buffers the whole file, so it is
  capped at ~1.3 GB, takes one clip at a time, and is never coalesced into a
  batch; the fast MP4 writer streams the untouched spans and runs in parallel
  like everything else. Videos are written after all photos either way.
- A patch in `patches/` fixes an O(n²) in zeroperl's `fd_write`: it
  reallocated the exact new size and copied the whole file on every appending
  write, so ExifTool's output grew quadratically — a 96 MB video took over ten
  minutes. Geometric growth brings the same write down to about three seconds.
- The pure-JS writers never move what they don't have to. The MP4 writer
  renames a faststart `moov` to `free` and appends a rebuilt one, so `mdat`
  stays where it is and the sample-offset tables stay valid. The TIFF writer
  grows a directory into the zero padding cameras leave behind it, or appends
  a block and repoints — no existing IFD, value or MakerNote offset ever
  moves, which is what keeps RAW viewers and phone galleries working.
- Windows' RAW codec merges a file's Interoperability IFD into the GPS tag
  namespace (Interop `0x0001`/`0x0002` land on GPSLatitudeRef/GPSLatitude), so
  Explorer shows "R98" and no latitude. Writing GPS into a TIFF-based RAW
  drops that directory by shrinking the Exif IFD table in place, which moves
  nothing else and so needs none of ExifTool's offset repair.
- Recovery: fatal WASM faults (frozen background tab) rebuild the
  interpreter and retry once; idle workers are recycled when the tab becomes
  visible again; monolithic file reads fall back to chunked reads on
  NotReadableError (network/cloud drives); write permission escalation
  copes with Chrome's one-prompt-per-user-gesture rule.
- The write ETA models per-file-class service times (jpeg/raw/video) against
  per-class priors, so a run of quick JPEGs cannot collapse the estimate for
  the RAWs still queued. It is recency-weighted, divides only what actually
  runs in parallel (a serialized WASM video rewrite counts whole), and never
  claims less than the slowest file still in flight.
