/**
 * EXIF orientation handling for thumbnails/previews. RAW embedded preview
 * JPEGs usually carry NO orientation of their own (the tag lives in the
 * RAW's IFD), so the browser's automatic 'from-image' handling does nothing
 * and portrait shots render sideways — these helpers apply the photo's
 * orientation manually on a canvas.
 */

const BY_NAME: Record<string, number> = {
  'horizontal (normal)': 1,
  'mirror horizontal': 2,
  'rotate 180': 3,
  'mirror vertical': 4,
  'mirror horizontal and rotate 270 cw': 5,
  'rotate 90 cw': 6,
  'mirror horizontal and rotate 90 cw': 7,
  'rotate 270 cw': 8,
}

/** exifr yields the Orientation tag as a number or a translated string. */
export function normalizeOrientation(value: unknown): number | undefined {
  if (typeof value === 'number' && value >= 1 && value <= 8) return value
  if (typeof value === 'string') return BY_NAME[value.trim().toLowerCase()]
  return undefined
}

/** Output dimensions after applying the orientation (90°-family swaps). */
export function orientedSize(orientation: number, width: number, height: number): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
}

/** Canvas transform matrix [a,b,c,d,e,f] mapping source pixels upright. */
export function orientationMatrix(orientation: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, w, 0]
    case 3:
      return [-1, 0, 0, -1, w, h]
    case 4:
      return [1, 0, 0, -1, 0, h]
    case 5:
      return [0, 1, 1, 0, 0, 0]
    case 6:
      return [0, 1, -1, 0, h, 0]
    case 7:
      return [0, -1, -1, 0, h, w]
    case 8:
      return [0, -1, 1, 0, 0, w]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/**
 * Whether the orientation must be applied by hand. When the blob carries its
 * own EXIF, the decoder already rotated it ('from-image' default) — for the
 * 90°-family that is detectable from the decoded dimensions.
 */
export function needsManualOrientation(orientation: number, bitmapW: number, bitmapH: number): boolean {
  if (orientation <= 1 || orientation > 8) return false
  if (orientation >= 5) return bitmapW > bitmapH
  return true
}

/** Draw with orientation applied, optionally scaled to a target width. */
export async function orientedBlob(
  bitmap: ImageBitmap,
  orientation: number,
  targetWidth?: number,
  quality = 0.8
): Promise<Blob | undefined> {
  const out = orientedSize(orientation, bitmap.width, bitmap.height)
  const scale = targetWidth ? Math.min(1, targetWidth / out.width) : 1
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(out.width * scale)),
    Math.max(1, Math.round(out.height * scale))
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.scale(scale, scale)
  ctx.transform(...orientationMatrix(orientation, bitmap.width, bitmap.height))
  ctx.drawImage(bitmap, 0, 0)
  return canvas.convertToBlob({ type: 'image/webp', quality })
}

/**
 * Orient (and optionally downscale) an image blob. Returns undefined when
 * nothing needs doing — the caller keeps the original blob.
 */
export async function orientBlob(blob: Blob, orientation: number | undefined, targetWidth?: number): Promise<Blob | undefined> {
  const o = orientation ?? 1
  const bitmap = await createImageBitmap(blob)
  try {
    const manual = needsManualOrientation(o, bitmap.width, bitmap.height)
    if (!manual && (!targetWidth || bitmap.width <= targetWidth)) return undefined
    return await orientedBlob(bitmap, manual ? o : 1, targetWidth)
  } finally {
    bitmap.close()
  }
}
