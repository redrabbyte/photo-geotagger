/**
 * Video thumbnails: MP4/MOV carry no embedded preview image, but the browser
 * can decode a frame itself. A detached <video> element streams the file via
 * an object URL (range reads — multi-GB clips never load fully), seeks a
 * little into the clip, and the frame is downscaled to a WebP thumb.
 * Main thread only (no <video> in workers); callers should serialize calls.
 * Returns undefined when the codec cannot be decoded (e.g. HEVC without
 * hardware support) or decoding stalls.
 */
const STEP_TIMEOUT_MS = 10_000

function nextEvent(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`video ${event} timeout`))
    }, STEP_TIMEOUT_MS)
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(video.error ?? new Error('video decode error'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener(event, onEvent)
      video.removeEventListener('error', onError)
    }
    video.addEventListener(event, onEvent, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

export async function captureVideoFrame(file: File, targetWidth = 320): Promise<Blob | undefined> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'metadata'
  try {
    video.src = url
    await nextEvent(video, 'loadedmetadata')
    if (!video.videoWidth || !video.videoHeight) return undefined
    // A second in: past black-from-standby starts, still cheap to seek.
    video.currentTime = Math.min(1, (video.duration || 2) / 2)
    await nextEvent(video, 'seeked')

    const width = Math.min(targetWidth, video.videoWidth)
    const scale = width / video.videoWidth
    const canvas = new OffscreenCanvas(width, Math.max(1, Math.round(video.videoHeight * scale)))
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  } catch {
    return undefined
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
