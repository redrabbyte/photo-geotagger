// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { generateXmpSidecar, mergeGpsIntoXmp, readGpsFromXmp, readTimeFromXmp, sidecarNameFor } from '../xmp'
import { parseGpx, GpxParseError } from '../parseGpx'

const GPS = { lat: 51.5074, lon: -0.1278, ele: 35.5 }

describe('XMP sidecar', () => {
  it('generate → read round-trip', () => {
    const xml = generateXmpSidecar(GPS, new Date('2026-06-01T10:00:00Z'))
    const back = readGpsFromXmp(xml)
    expect(back).toBeDefined()
    expect(back!.lat).toBeCloseTo(GPS.lat, 5)
    expect(back!.lon).toBeCloseTo(GPS.lon, 5)
    expect(back!.ele).toBeCloseTo(GPS.ele, 1)
  })

  it('negative altitude uses AltitudeRef 1', () => {
    const xml = generateXmpSidecar({ lat: 10, lon: 10, ele: -12.5 })
    expect(readGpsFromXmp(xml)!.ele).toBeCloseTo(-12.5, 1)
  })

  it('merges GPS into an existing sidecar preserving other properties', () => {
    const existing = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmp:Rating="4"
    exif:GPSLatitude="10,0N" exif:GPSLongitude="20,0E"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
    const merged = mergeGpsIntoXmp(existing, GPS)
    expect(merged).toContain('Rating="4"')
    const back = readGpsFromXmp(merged)
    expect(back!.lat).toBeCloseTo(GPS.lat, 5)
    expect(back!.lon).toBeCloseTo(GPS.lon, 5)
  })

  it('replaces element-form GPS properties on merge', () => {
    const existing = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/">
   <exif:GPSLatitude>10,0N</exif:GPSLatitude>
   <exif:GPSLongitude>20,0E</exif:GPSLongitude>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`
    const back = readGpsFromXmp(mergeGpsIntoXmp(existing, GPS))
    expect(back!.lat).toBeCloseTo(GPS.lat, 5)
  })

  it('throws on malformed existing sidecar', () => {
    expect(() => mergeGpsIntoXmp('this is not xml <', GPS)).toThrow()
  })

  it('removes a stale altitude when the new position has none', () => {
    // Old sidecar: position WITH altitude. New assignment: no elevation
    // (manual placement / track without <ele>) — the old altitude must go.
    const existing = generateXmpSidecar({ lat: 10, lon: 20, ele: 500 })
    const merged = mergeGpsIntoXmp(existing, { lat: 51.5, lon: -0.12 })
    const back = readGpsFromXmp(merged)
    expect(back!.lat).toBeCloseTo(51.5, 5)
    expect(back!.ele).toBeUndefined()
    expect(merged).not.toContain('GPSAltitude')
  })

  it('sidecar naming', () => {
    expect(sidecarNameFor('DSC01234.ARW')).toBe('DSC01234.xmp')
    expect(sidecarNameFor('IMG_0001.heic')).toBe('IMG_0001.xmp')
  })
})

describe('readTimeFromXmp', () => {
  // 2026-06-01 12:34:56 wall clock as epoch ms with UTC fields.
  const WALL = Date.UTC(2026, 5, 1, 12, 34, 56)

  it('reads the time our own sidecar generator writes', () => {
    const xml = generateXmpSidecar(GPS, new Date('2026-06-01T10:00:00Z'), {
      wallClockMs: WALL,
      tzOffsetMin: 120,
    })
    expect(readTimeFromXmp(xml)).toEqual({ wallClockMs: WALL, tzOffsetMin: 120 })
  })

  it('reads the time merged into an existing sidecar', () => {
    const base = generateXmpSidecar(GPS)
    const merged = mergeGpsIntoXmp(base, undefined, new DOMParser(), {
      wallClockMs: WALL,
      tzOffsetMin: -330,
    })
    expect(readTimeFromXmp(merged)).toEqual({ wallClockMs: WALL, tzOffsetMin: -330 })
  })

  it('parses Z, missing seconds, and missing offset', () => {
    const wrap = (v: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:DateTimeOriginal="${v}"/>
 </rdf:RDF>
</x:xmpmeta>`
    expect(readTimeFromXmp(wrap('2026-06-01T12:34:56Z'))).toEqual({ wallClockMs: WALL, tzOffsetMin: 0 })
    expect(readTimeFromXmp(wrap('2026-06-01T12:34'))).toEqual({
      wallClockMs: Date.UTC(2026, 5, 1, 12, 34, 0),
      tzOffsetMin: undefined,
    })
    expect(readTimeFromXmp(wrap('2026-06-01T12:34:56'))).toEqual({ wallClockMs: WALL, tzOffsetMin: undefined })
  })

  it('reads element-form DateTimeOriginal', () => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/">
   <exif:DateTimeOriginal>2026-06-01T12:34:56+02:00</exif:DateTimeOriginal>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`
    expect(readTimeFromXmp(xml)).toEqual({ wallClockMs: WALL, tzOffsetMin: 120 })
  })

  it('returns undefined for sidecars without a time or with garbage', () => {
    expect(readTimeFromXmp(generateXmpSidecar(GPS))).toBeUndefined()
    expect(readTimeFromXmp('not xml <')).toBeUndefined()
    const bad = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:DateTimeOriginal="yesterday"/>
 </rdf:RDF>
</x:xmpmeta>`
    expect(readTimeFromXmp(bad)).toBeUndefined()
  })
})

const GPX_OK = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
 <trk><name>Morning walk</name>
  <trkseg>
   <trkpt lat="50.0" lon="8.0"><ele>100</ele><time>2026-06-01T10:00:00Z</time></trkpt>
   <trkpt lat="50.001" lon="8.001"><ele>101</ele><time>2026-06-01T10:01:00Z</time></trkpt>
  </trkseg>
  <trkseg>
   <trkpt lat="50.010" lon="8.010"><time>2026-06-01T10:30:00Z</time></trkpt>
  </trkseg>
 </trk>
</gpx>`

describe('parseGpx', () => {
  it('parses tracks, segments, times', () => {
    const tracks = parseGpx(GPX_OK, 'walk.gpx', (n) => `t${n}`)
    expect(tracks).toHaveLength(1)
    const t = tracks[0]
    expect(t.name).toBe('Morning walk')
    expect(t.points).toHaveLength(3)
    expect(t.segments).toEqual([
      { startIdx: 0, endIdx: 1 },
      { startIdx: 2, endIdx: 2 },
    ])
    expect(t.startMs).toBe(Date.parse('2026-06-01T10:00:00Z'))
    expect(t.endMs).toBe(Date.parse('2026-06-01T10:30:00Z'))
    expect(t.points[0].ele).toBe(100)
  })

  it('rejects tracks with no timestamps', () => {
    const noTime = GPX_OK.replace(/<time>[^<]*<\/time>/g, '')
    expect(() => parseGpx(noTime, 'walk.gpx', (n) => `t${n}`)).toThrow(GpxParseError)
  })

  it('skips an empty <trk> instead of discarding the whole file', () => {
    const withEmpty = GPX_OK.replace(
      '</gpx>',
      '<trk><name>placeholder</name><trkseg></trkseg></trk></gpx>'
    )
    const tracks = parseGpx(withEmpty, 'walk.gpx', (n) => `t${n}`)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].name).toBe('Morning walk')
  })

  it('rejects non-XML and GPX without tracks', () => {
    expect(() => parseGpx('nope <', 'x.gpx', (n) => `t${n}`)).toThrow(GpxParseError)
    expect(() =>
      parseGpx('<gpx xmlns="http://www.topografix.com/GPX/1/1"></gpx>', 'x.gpx', (n) => `t${n}`)
    ).toThrow(GpxParseError)
  })
})
