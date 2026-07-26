import { useEffect } from 'react'
import { useStore } from '../state/store'
import { autoTuneLimits } from '../services/appActions'

/**
 * Keep the write limits fitted to the files that are loaded, for as long as the
 * user has not chosen values themselves. Mounted once, at the top of the app:
 * the fit has to happen whether or not the limits dialog is open.
 *
 * Re-runs on every import update and on setting changes that move the estimate
 * (write mode, the fast paths). Convergence is guaranteed because the tune is a
 * no-op once the fit is already in place.
 */
export function useAutoLimits(): void {
  const photos = useStore((s) => s.photos)
  const settings = useStore((s) => s.settings)
  const scanning = useStore((s) => s.scanning)
  useEffect(() => {
    autoTuneLimits()
  }, [photos, settings, scanning])
}
