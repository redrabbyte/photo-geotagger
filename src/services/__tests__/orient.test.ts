import { describe, it, expect } from 'vitest'
import {
  needsManualOrientation,
  normalizeOrientation,
  orientationMatrix,
  orientedSize,
} from '../exif/orient'

describe('normalizeOrientation', () => {
  it('accepts numbers 1-8 and exifr translated strings', () => {
    expect(normalizeOrientation(6)).toBe(6)
    expect(normalizeOrientation(1)).toBe(1)
    expect(normalizeOrientation('Rotate 90 CW')).toBe(6)
    expect(normalizeOrientation('Rotate 270 CW')).toBe(8)
    expect(normalizeOrientation('Horizontal (normal)')).toBe(1)
    expect(normalizeOrientation(0)).toBeUndefined()
    expect(normalizeOrientation(9)).toBeUndefined()
    expect(normalizeOrientation('sideways')).toBeUndefined()
    expect(normalizeOrientation(undefined)).toBeUndefined()
  })
})

describe('orientedSize / orientationMatrix', () => {
  it('swaps dimensions for the 90° family only', () => {
    expect(orientedSize(6, 400, 300)).toEqual({ width: 300, height: 400 })
    expect(orientedSize(8, 400, 300)).toEqual({ width: 300, height: 400 })
    expect(orientedSize(3, 400, 300)).toEqual({ width: 400, height: 300 })
    expect(orientedSize(1, 400, 300)).toEqual({ width: 400, height: 300 })
  })

  it('maps source corners into the upright frame', () => {
    const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    // Rotate 90 CW (6): source top-right (w,0) becomes upright bottom-right.
    const m6 = orientationMatrix(6, 400, 300)
    expect(apply(m6, 0, 0)).toEqual([300, 0])
    expect(apply(m6, 400, 300)).toEqual([0, 400])
    // Rotate 180 (3): corners swap.
    const m3 = orientationMatrix(3, 400, 300)
    expect(apply(m3, 0, 0)).toEqual([400, 300])
    expect(apply(m3, 400, 300)).toEqual([0, 0])
    // Identity for normal orientation.
    expect(orientationMatrix(1, 400, 300)).toEqual([1, 0, 0, 1, 0, 0])
  })
})

describe('needsManualOrientation', () => {
  it('skips rotation when the decoder already rotated a 90°-family image', () => {
    expect(needsManualOrientation(6, 400, 300)).toBe(true) // still landscape → rotate
    expect(needsManualOrientation(6, 300, 400)).toBe(false) // already portrait
    expect(needsManualOrientation(3, 400, 300)).toBe(true) // 180° undetectable → apply
    expect(needsManualOrientation(1, 400, 300)).toBe(false)
  })
})
