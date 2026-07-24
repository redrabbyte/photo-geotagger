export type SourceId = string
export type PhotoId = string
export type TrackId = string

export interface GeoPoint {
  lat: number
  lon: number
  /** Elevation in meters, if known. */
  ele?: number
}

export type PhotoKind = 'jpeg' | 'heic' | 'raw' | 'video'

export interface Source {
  id: SourceId
  name: string
  color: string
  /** Milliseconds ADDED to a photo's capture time to obtain true UTC. */
  clockOffsetMs: number
  /**
   * Minutes east of UTC assumed for photos in this source whose EXIF has no
   * OffsetTimeOriginal. Applied when converting wall-clock capture time to UTC.
   */
  assumedTzOffsetMin: number
  /** Live directory handle; not serializable, restored from IndexedDB. */
  dirHandle?: FileSystemDirectoryHandle
}

export interface PhotoMeta {
  /** DateTimeOriginal parsed as wall-clock milliseconds (as if UTC). */
  captureLocalMs: number
  /** Where the capture time came from; 'file' = filesystem mtime fallback. */
  timeSource?: 'exif' | 'file'
  /** Timezone offset in minutes east of UTC from OffsetTimeOriginal, if present. */
  tzOffsetMin?: number
  /** GPS coordinates already present in the file. */
  originalGps?: GeoPoint
  /**
   * GPS tag structure exists but holds no coordinates — the signature of
   * Android's scoped-storage location redaction (or a metadata stripper).
   */
  gpsEmpty?: boolean
  /**
   * The corrected capture time has been written into the file; the source's
   * clock offset must no longer be applied to this photo.
   */
  timeCorrected?: boolean
  cameraModel?: string
  width?: number
  height?: number
  /** EXIF Orientation (1–8); displays rotate/mirror accordingly. */
  orientation?: number
}

export type AssignmentMethod =
  | 'closest'
  | 'before'
  | 'after'
  | 'interpolated'
  | 'inherit'
  | 'manual'
  | 'manual-on-track'

export interface TrackPointRef {
  trackId: TrackId
  index: number
  point: GeoPoint
  /** Epoch ms of the trackpoint. */
  t: number
  /** Signed ms from photo effective time to this trackpoint (point - photo). */
  deltaMs: number
}

export interface PositionAssignment {
  method: AssignmentMethod
  /** The coordinate that will be written to the file. */
  point: GeoPoint
  trackId?: TrackId
  neighbors?: { before?: TrackPointRef; after?: TrackPointRef }
  inheritedFrom?: PhotoId
  /** Effective UTC time (captureUtc + source offset) used when assigning. */
  effectiveUtcMs: number
  /** True when the strategy had to degrade (e.g. interpolation across a gap). */
  degraded?: boolean
}

export type ScanState = 'pending' | 'scanning' | 'done' | 'error'
export type WriteState = 'clean' | 'dirty' | 'writing' | 'written' | 'write-error'

export interface Photo {
  id: PhotoId
  sourceId: SourceId
  fileName: string
  relativePath: string
  kind: PhotoKind
  sizeBytes: number
  lastModified: number
  fileHandle?: FileSystemFileHandle
  /** Companion .xmp sidecar found next to this file during folder import. */
  sidecarHandle?: FileSystemFileHandle
  /** GPS read from the sidecar (takes precedence over embedded EXIF GPS). */
  sidecarGps?: GeoPoint
  /** Capture time read from the sidecar (outranks the file's EXIF time). */
  sidecarTime?: { wallClockMs: number; tzOffsetMin?: number }

  meta?: PhotoMeta
  scanState: ScanState
  scanError?: string
  thumbUrl?: string

  assignment?: PositionAssignment
  writeState: WriteState
  writeError?: string
  /** How the last write was performed. */
  writeTarget?: 'exif' | 'sidecar'
}

export interface TrackPoint {
  lat: number
  lon: number
  ele?: number
  /** Epoch ms. */
  t: number
}

export interface TrackSegment {
  /** Inclusive start index into points. */
  startIdx: number
  /** Inclusive end index into points. */
  endIdx: number
}

export interface Track {
  id: TrackId
  name: string
  fileName: string
  color: string
  /** Sorted by t ascending. */
  points: TrackPoint[]
  /** trkseg boundaries; interpolation never crosses segments. */
  segments: TrackSegment[]
  startMs: number
  endMs: number
}

export type GpsStatus = 'original' | 'assigned' | 'manual' | 'none'

export function effectiveUtcMs(photo: Photo, source: Source): number | undefined {
  // A sidecar's DateTimeOriginal outranks the file's EXIF time (it is the
  // newer edit) and is treated as already corrected: no clock offset applied.
  if (photo.sidecarTime) {
    const tz = photo.sidecarTime.tzOffsetMin ?? source.assumedTzOffsetMin
    return photo.sidecarTime.wallClockMs - tz * 60_000
  }
  if (!photo.meta) return undefined
  const tz = photo.meta.tzOffsetMin ?? source.assumedTzOffsetMin
  // Once the corrected time is baked into the file, the offset is spent.
  const offset = photo.meta.timeCorrected ? 0 : source.clockOffsetMs
  return photo.meta.captureLocalMs - tz * 60_000 + offset
}

export function gpsStatus(photo: Photo): GpsStatus {
  if (photo.assignment) {
    return photo.assignment.method === 'manual' || photo.assignment.method === 'manual-on-track'
      ? 'manual'
      : 'assigned'
  }
  return photo.sidecarGps || photo.meta?.originalGps ? 'original' : 'none'
}

export function displayPosition(photo: Photo): GeoPoint | undefined {
  // Sidecar GPS outranks embedded EXIF GPS (the sidecar is the newer edit).
  return photo.assignment?.point ?? photo.sidecarGps ?? photo.meta?.originalGps
}

export function isDirty(photo: Photo): boolean {
  return photo.assignment !== undefined && photo.writeState !== 'written'
}

const KIND_BY_EXT: Record<string, PhotoKind> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  heic: 'heic',
  heif: 'heic',
  arw: 'raw',
  cr2: 'raw',
  cr3: 'raw',
  nef: 'raw',
  dng: 'raw',
  raf: 'raw',
  orf: 'raw',
  rw2: 'raw',
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
}

export function photoKindFromName(name: string): PhotoKind | undefined {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? KIND_BY_EXT[ext] : undefined
}

export function isGpxName(name: string): boolean {
  return name.toLowerCase().endsWith('.gpx')
}
