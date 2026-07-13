import { describe, it, expect } from 'vitest'
import {
  degToDmsRationals,
  dmsRationalsToDeg,
  degToXmpCoordinate,
  xmpCoordinateToDeg,
  haversineMeters,
  lerpPoint,
} from '../gpsMath'

describe('degToDmsRationals round-trip', () => {
  const cases = [51.5074, -0.1278, 48.858093, 2.294694, -33.856784, 151.215297, 0, 89.999999]
  for (const deg of cases) {
    it(`round-trips ${deg}`, () => {
      const dms = degToDmsRationals(deg)
      const ref = deg < 0 ? 'S' : 'N'
      const back = dmsRationalsToDeg(dms, ref)
      expect(Math.abs(back - Math.abs(deg) * (deg < 0 ? -1 : 1))).toBeLessThan(1e-6)
    })
  }
})

describe('XMP coordinate strings', () => {
  it('formats and parses back', () => {
    for (const [deg, isLat] of [
      [51.5074, true],
      [-0.1278, false],
      [-33.856784, true],
      [151.215297, false],
    ] as [number, boolean][]) {
      const s = degToXmpCoordinate(deg, isLat)
      const back = xmpCoordinateToDeg(s)
      expect(back).toBeDefined()
      expect(Math.abs(back! - deg)).toBeLessThan(1e-6)
    }
  })

  it('parses DMS form', () => {
    expect(xmpCoordinateToDeg('51,30,26.64N')).toBeCloseTo(51.5074, 4)
    expect(xmpCoordinateToDeg('0,7.668W')).toBeCloseTo(-0.1278, 4)
  })

  it('rejects garbage', () => {
    expect(xmpCoordinateToDeg('not a coordinate')).toBeUndefined()
  })
})

describe('haversine', () => {
  it('London to Paris ~343km', () => {
    const d = haversineMeters({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 })
    expect(d).toBeGreaterThan(330_000)
    expect(d).toBeLessThan(350_000)
  })
})

describe('lerpPoint', () => {
  it('interpolates midpoint', () => {
    const m = lerpPoint({ lat: 0, lon: 0, ele: 100 }, { lat: 10, lon: 10, ele: 200 }, 0.5)
    expect(m.lat).toBeCloseTo(5)
    expect(m.lon).toBeCloseTo(5)
    expect(m.ele).toBeCloseTo(150)
  })

  it('crosses the antimeridian the short way', () => {
    const m = lerpPoint({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }, 0.5)
    expect(Math.abs(m.lon)).toBeCloseTo(180, 5)
  })
})
