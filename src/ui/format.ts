export function formatUtc(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/** Format a signed millisecond offset as ±hh:mm:ss. */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '+'
  const abs = Math.round(Math.abs(ms) / 1000)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}`
}

/** Parse "±hh:mm:ss", "±mm:ss", "±90s", "±5m" or plain seconds into ms. */
export function parseOffset(text: string): number | undefined {
  const t = text.trim()
  if (t === '') return 0
  let m = t.match(/^([+-]?)(\d{1,3}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const sign = m[1] === '-' ? -1 : 1
    const a = parseInt(m[2], 10)
    const b = parseInt(m[3], 10)
    const c = m[4] !== undefined ? parseInt(m[4], 10) : undefined
    const seconds = c !== undefined ? a * 3600 + b * 60 + c : a * 60 + b
    return sign * seconds * 1000
  }
  m = t.match(/^([+-]?)(\d+(?:\.\d+)?)\s*(h|m|s)?$/i)
  if (m) {
    const sign = m[1] === '-' ? -1 : 1
    const v = parseFloat(m[2])
    const unit = (m[3] ?? 's').toLowerCase()
    const mult = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1
    return sign * v * mult * 1000
  }
  return undefined
}

export function formatDeltaMs(ms: number): string {
  const abs = Math.abs(ms)
  const sign = ms < 0 ? '-' : '+'
  if (abs < 1000) return `${sign}${abs}ms`
  if (abs < 120_000) return `${sign}${(abs / 1000).toFixed(1)}s`
  return `${sign}${Math.round(abs / 60_000)}min`
}

export function formatCoord(v: number, isLat: boolean): string {
  const ref = isLat ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W'
  return `${Math.abs(v).toFixed(6)}° ${ref}`
}
