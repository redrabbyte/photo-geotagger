import type { GeoPoint } from './types'
import { degToXmpCoordinate, xmpCoordinateToDeg } from './gpsMath'

const XMP_TEMPLATE = (attrs: string, modifyDate: string) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="photo-geotagger">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"${attrs}
   xmp:ModifyDate="${modifyDate}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`

function altAttributes(ele: number | undefined): string {
  if (ele === undefined) return ''
  const ref = ele < 0 ? '1' : '0'
  const abs = Math.abs(ele)
  // XMP GPSAltitude is a rational string.
  const num = Math.round(abs * 100)
  return `\n   exif:GPSAltitude="${num}/100"\n   exif:GPSAltitudeRef="${ref}"`
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** ISO 8601 with explicit offset, e.g. "2026-06-01T12:34:56+02:00". */
export function xmpDateTime(wallClockMs: number, tzOffsetMin?: number): string {
  const d = new Date(wallClockMs)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  // A zone-less XMP timestamp is valid and honest; readTimeFromXmp reads both.
  if (tzOffsetMin === undefined) return stamp
  const sign = tzOffsetMin < 0 ? '-' : '+'
  const abs = Math.abs(tzOffsetMin)
  return `${stamp}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

export interface SidecarTimeCorrection {
  wallClockMs: number
  /** Minutes east of UTC; omitted when nothing states a zone. */
  tzOffsetMin?: number
}

/** Generate a fresh XMP sidecar with GPS and/or corrected time + ModifyDate. */
export function generateXmpSidecar(
  gps: GeoPoint | undefined,
  now: Date = new Date(),
  time?: SidecarTimeCorrection
): string {
  let attrs = ''
  if (gps) {
    attrs +=
      `\n   exif:GPSVersionID="2.3.0.0"` +
      `\n   exif:GPSLatitude="${degToXmpCoordinate(gps.lat, true)}"` +
      `\n   exif:GPSLongitude="${degToXmpCoordinate(gps.lon, false)}"` +
      altAttributes(gps.ele)
  }
  if (time) {
    attrs += `\n   exif:DateTimeOriginal="${xmpDateTime(time.wallClockMs, time.tzOffsetMin)}"`
  }
  return XMP_TEMPLATE(attrs, isoNow(now))
}

/** All elements in document order whose local (un-prefixed) name matches. */
function elementsByLocalName(root: ParentNode, localName: string): Element[] {
  const out: Element[] = []
  const walk = (node: ParentNode) => {
    for (const child of Array.from(node.children)) {
      const local = child.localName ?? child.tagName.split(':').pop()
      if (local === localName) out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

/** Local part of a possibly-prefixed attribute name ("exif:GPSLatitude" → "GPSLatitude"). */
function attrLocalName(attrName: string): string {
  return attrName.split(':').pop()!
}

function attributeByLocalName(el: Element, localName: string): string | undefined {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('xmlns')) continue
    if (attrLocalName(attr.name) === localName) return attr.value
  }
  return undefined
}

/**
 * Merge GPS values into an existing XMP sidecar, preserving everything else.
 * Handles both attribute-form and element-form rdf:Description properties.
 * Matching is namespace-lenient (by local name) to cope with real-world XMP.
 * Throws if the existing content is not parseable XMP — the caller must then
 * refuse to overwrite the file.
 */
export function mergeGpsIntoXmp(
  existingXml: string,
  gps: GeoPoint | undefined,
  parser: DOMParser = new DOMParser(),
  time?: SidecarTimeCorrection
): string {
  const doc = parser.parseFromString(existingXml, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('Existing sidecar is not valid XML')
  }
  const descriptions = elementsByLocalName(doc, 'Description')
  if (descriptions.length === 0) {
    throw new Error('Existing sidecar has no rdf:Description')
  }
  const desc = descriptions[0]
  if (!desc.getAttribute('xmlns:exif')) {
    desc.setAttribute('xmlns:exif', 'http://ns.adobe.com/exif/1.0/')
  }

  // Removal is separate from setting: writing a position WITHOUT elevation
  // must also delete any existing altitude, or the sidecar keeps the old
  // location's altitude attached to the new coordinates.
  const removals: string[] = []
  const sets: Record<string, string> = {}
  if (gps) {
    removals.push('GPSVersionID', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSAltitudeRef')
    sets.GPSVersionID = '2.3.0.0'
    sets.GPSLatitude = degToXmpCoordinate(gps.lat, true)
    sets.GPSLongitude = degToXmpCoordinate(gps.lon, false)
    if (gps.ele !== undefined) {
      sets.GPSAltitude = `${Math.round(Math.abs(gps.ele) * 100)}/100`
      sets.GPSAltitudeRef = gps.ele < 0 ? '1' : '0'
    }
  }
  if (time) {
    removals.push('DateTimeOriginal')
    sets.DateTimeOriginal = xmpDateTime(time.wallClockMs, time.tzOffsetMin)
  }

  for (const local of removals) {
    // Remove element-form duplicates anywhere under this description.
    for (const el of elementsByLocalName(desc, local)) el.remove()
    // Remove any attribute-form value regardless of its prefix.
    for (const attr of Array.from(desc.attributes)) {
      if (!attr.name.startsWith('xmlns') && attrLocalName(attr.name) === local) {
        desc.removeAttribute(attr.name)
      }
    }
  }
  for (const [local, value] of Object.entries(sets)) {
    desc.setAttribute(`exif:${local}`, value)
  }

  const serialized = new XMLSerializer().serializeToString(doc)
  // Preserve the xpacket wrapper if the original had one and the serializer dropped it.
  if (existingXml.includes('<?xpacket begin') && !serialized.includes('<?xpacket begin')) {
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${serialized}\n<?xpacket end="w"?>\n`
  }
  return serialized
}

function readXmpProp(doc: Document, local: string): string | undefined {
  for (const desc of elementsByLocalName(doc, 'Description')) {
    const attr = attributeByLocalName(desc, local)
    if (attr) return attr
    const elems = elementsByLocalName(desc, local)
    if (elems.length > 0 && elems[0].textContent) return elems[0].textContent
  }
  return undefined
}

export interface SidecarTime {
  /** Wall-clock capture time as epoch ms (fields interpreted as UTC). */
  wallClockMs: number
  /** Minutes east of UTC, when the sidecar value carries an offset. */
  tzOffsetMin?: number
}

/** Read the capture time (exif:DateTimeOriginal) from an XMP sidecar. */
export function readTimeFromXmp(xml: string, parser: DOMParser = new DOMParser()): SidecarTime | undefined {
  const doc = parser.parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return undefined
  const raw = readXmpProp(doc, 'DateTimeOriginal')
  if (!raw) return undefined
  const m = raw
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/)
  if (!m) return undefined
  const wallClockMs = Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    m[6] ? parseInt(m[6], 10) : 0
  )
  let tzOffsetMin: number | undefined
  const tz = m[7]
  if (tz === 'Z') tzOffsetMin = 0
  else if (tz) {
    const tm = tz.match(/([+-])(\d{2}):?(\d{2})/)
    if (tm) tzOffsetMin = (tm[1] === '-' ? -1 : 1) * (parseInt(tm[2], 10) * 60 + parseInt(tm[3], 10))
  }
  return { wallClockMs, tzOffsetMin }
}

/** Read GPS back out of an XMP sidecar (for verification and status display). */
export function readGpsFromXmp(xml: string, parser: DOMParser = new DOMParser()): GeoPoint | undefined {
  const doc = parser.parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return undefined

  const readProp = (local: string): string | undefined => readXmpProp(doc, local)

  const latStr = readProp('GPSLatitude')
  const lonStr = readProp('GPSLongitude')
  if (!latStr || !lonStr) return undefined
  const lat = xmpCoordinateToDeg(latStr)
  const lon = xmpCoordinateToDeg(lonStr)
  if (lat === undefined || lon === undefined) return undefined

  let ele: number | undefined
  const altStr = readProp('GPSAltitude')
  if (altStr) {
    const m = altStr.match(/^(\d+(?:\.\d+)?)(?:\/(\d+))?$/)
    if (m) {
      ele = parseFloat(m[1]) / (m[2] ? parseInt(m[2], 10) : 1)
      if (readProp('GPSAltitudeRef') === '1') ele = -ele
    }
  }
  return { lat, lon, ele }
}

/** Sidecar file name convention Lightroom/darktable expect: DSC01234.ARW → DSC01234.xmp */
export function sidecarNameFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  return `${base}.xmp`
}
