import type { GeoPoint } from './types'
import { degToXmpCoordinate, xmpCoordinateToDeg } from './gpsMath'

const XMP_TEMPLATE = (lat: string, lon: string, altTags: string, modifyDate: string) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="photo-geotagger">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   exif:GPSVersionID="2.3.0.0"
   exif:GPSLatitude="${lat}"
   exif:GPSLongitude="${lon}"${altTags}
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

/** Generate a fresh XMP sidecar containing only GPS + ModifyDate. */
export function generateXmpSidecar(gps: GeoPoint, now: Date = new Date()): string {
  return XMP_TEMPLATE(
    degToXmpCoordinate(gps.lat, true),
    degToXmpCoordinate(gps.lon, false),
    altAttributes(gps.ele),
    isoNow(now)
  )
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
export function mergeGpsIntoXmp(existingXml: string, gps: GeoPoint, parser: DOMParser = new DOMParser()): string {
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

  const gpsProps: Record<string, string | undefined> = {
    GPSVersionID: '2.3.0.0',
    GPSLatitude: degToXmpCoordinate(gps.lat, true),
    GPSLongitude: degToXmpCoordinate(gps.lon, false),
    GPSAltitude: gps.ele !== undefined ? `${Math.round(Math.abs(gps.ele) * 100)}/100` : undefined,
    GPSAltitudeRef: gps.ele !== undefined ? (gps.ele < 0 ? '1' : '0') : undefined,
  }

  for (const [local, value] of Object.entries(gpsProps)) {
    if (value === undefined) continue
    // Remove element-form duplicates anywhere under this description.
    for (const el of elementsByLocalName(desc, local)) el.remove()
    // Replace any attribute-form value regardless of its prefix.
    for (const attr of Array.from(desc.attributes)) {
      if (!attr.name.startsWith('xmlns') && attrLocalName(attr.name) === local) {
        desc.removeAttribute(attr.name)
      }
    }
    desc.setAttribute(`exif:${local}`, value)
  }

  const serialized = new XMLSerializer().serializeToString(doc)
  // Preserve the xpacket wrapper if the original had one and the serializer dropped it.
  if (existingXml.includes('<?xpacket begin') && !serialized.includes('<?xpacket begin')) {
    return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${serialized}\n<?xpacket end="w"?>\n`
  }
  return serialized
}

/** Read GPS back out of an XMP sidecar (for verification and status display). */
export function readGpsFromXmp(xml: string, parser: DOMParser = new DOMParser()): GeoPoint | undefined {
  const doc = parser.parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return undefined

  const readProp = (local: string): string | undefined => {
    for (const desc of elementsByLocalName(doc, 'Description')) {
      const attr = attributeByLocalName(desc, local)
      if (attr) return attr
      const elems = elementsByLocalName(desc, local)
      if (elems.length > 0 && elems[0].textContent) return elems[0].textContent
    }
    return undefined
  }

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
