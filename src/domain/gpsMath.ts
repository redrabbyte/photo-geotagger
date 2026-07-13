import type { GeoPoint } from './types'

export interface Rational {
  num: number
  den: number
}

/** Convert decimal degrees to EXIF DMS rationals (degrees, minutes, seconds). */
export function degToDmsRationals(deg: number): [Rational, Rational, Rational] {
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const minFloat = (abs - d) * 60
  const m = Math.floor(minFloat)
  const secFloat = (minFloat - m) * 60
  // 10000 denominator gives ~1cm precision at the equator.
  const s = Math.round(secFloat * 10000)
  return [
    { num: d, den: 1 },
    { num: m, den: 1 },
    { num: s, den: 10000 },
  ]
}

export function dmsRationalsToDeg(dms: [Rational, Rational, Rational], ref: string): number {
  const [d, m, s] = dms
  const deg = d.num / d.den + m.num / m.den / 60 + s.num / s.den / 3600
  return ref === 'S' || ref === 'W' ? -deg : deg
}

/** Format decimal degrees as an XMP GPSCoordinate string, e.g. "51,30.1234N". */
export function degToXmpCoordinate(deg: number, isLat: boolean): string {
  const ref = isLat ? (deg >= 0 ? 'N' : 'S') : deg >= 0 ? 'E' : 'W'
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const min = (abs - d) * 60
  return `${d},${min.toFixed(6)}${ref}`
}

/** Parse an XMP GPSCoordinate ("51,30.123456N" or "51,30,7.4N") to decimal degrees. */
export function xmpCoordinateToDeg(value: string): number | undefined {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])$/i)
  if (!m) return undefined
  const d = parseFloat(m[1])
  const min = m[2] !== undefined ? parseFloat(m[2]) : 0
  const sec = m[3] !== undefined ? parseFloat(m[3]) : 0
  const deg = d + min / 60 + sec / 3600
  const ref = m[4].toUpperCase()
  return ref === 'S' || ref === 'W' ? -deg : deg
}

const EARTH_RADIUS_M = 6371000

/** Great-circle distance in meters. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(sa)))
}

/**
 * Linear interpolation between two points by fraction f in [0,1].
 * Longitude is interpolated across the antimeridian correctly.
 */
export function lerpPoint(a: GeoPoint, b: GeoPoint, f: number): GeoPoint {
  let dLon = b.lon - a.lon
  if (dLon > 180) dLon -= 360
  else if (dLon < -180) dLon += 360
  let lon = a.lon + dLon * f
  if (lon > 180) lon -= 360
  else if (lon < -180) lon += 360
  const ele =
    a.ele !== undefined && b.ele !== undefined ? a.ele + (b.ele - a.ele) * f : (a.ele ?? b.ele)
  return { lat: a.lat + (b.lat - a.lat) * f, lon, ele }
}

/** Round coordinates to a sane precision for writing (~1.1cm at 7 decimals). */
export function roundGps(p: GeoPoint): GeoPoint {
  const r = (v: number) => Math.round(v * 1e7) / 1e7
  return { lat: r(p.lat), lon: r(p.lon), ele: p.ele !== undefined ? Math.round(p.ele * 100) / 100 : undefined }
}
