import { isMobileDevice } from '@/lib/mobile-device'

const HAPTIC_PULSE_MS = 10

export function triggerHapticFeedback(): void {
  if (typeof navigator === 'undefined') return
  if (!isMobileDevice()) return
  if (typeof navigator.vibrate !== 'function') return

  try {
    navigator.vibrate(HAPTIC_PULSE_MS)
  } catch {
    // Ignore unsupported/device-level failures.
  }
}
