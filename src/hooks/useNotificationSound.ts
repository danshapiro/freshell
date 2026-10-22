import { useCallback, useEffect, useRef } from 'react'
import { useAppSelector } from '@/store/hooks'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('useNotificationSound')

const NOTIFICATION_SOUND_SRC = '/your-code-is-ready.mp3'

/**
 * Per-ring safety backstop. Progression is driven by completion signals
 * (`ended`, `pause`, the fallback tone's `ended`); this timer only releases a
 * ring whose completion signal never arrives (e.g. an OS audio interruption
 * pauses the element without `ended`), so one dead ring can never silence
 * every later bell for the life of the page. The chime is ~1.03 s and the
 * fallback tone 0.12 s, so 5 s never cuts an honest ring short.
 */
export const RING_WATCHDOG_MS = 5_000

/**
 * Play the built-in fallback tone (the chime file is unusable — a rejected
 * play() never fires `ended`) and invoke `onDone` when the tone COMPLETES.
 * The OscillatorNode is an AudioScheduledSourceNode and fires `ended` at its
 * stop time — that completion signal drives ring-queue progression, never a
 * fixed timeout. Returns false when no completion signal can ever fire right
 * now — no audio machinery exists at all, or the context is (or remains)
 * autoplay-suspended, its clock frozen — so the caller advances the queue
 * immediately instead of stalling every later honest ring behind a dead one.
 */
function playFallbackTone(ctxRef: { current: AudioContext | null }, onDone: () => void): boolean {
  try {
    const AudioContextImpl = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextImpl) return false

    if (!ctxRef.current) {
      ctxRef.current = new AudioContextImpl()
    }

    const ctx = ctxRef.current
    // An autoplay-suspended context (created before user activation) never
    // advances its clock, so a tone's `ended` would NEVER fire and the dead
    // ring would wedge the whole queue. Best-effort resume; if the context
    // is (or remains) suspended, treat this ring as dead — return false so
    // the caller advances the queue exactly like the no-machinery path (a
    // later user-gesture resume lets the NEXT ring's tone play normally).
    if (ctx.state === 'suspended') {
      try {
        void ctx.resume().catch(() => {})
      } catch {
        // best-effort only — a context that cannot resume stays suspended
      }
      if (ctx.state === 'suspended') return false
    }

    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.value = 880
    gain.gain.value = 0.05

    oscillator.connect(gain)
    gain.connect(ctx.destination)

    oscillator.addEventListener('ended', onDone, { once: true })
    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.12)
    return true
  } catch {
    return false
  }
}

type RingAttempt = {
  /** Arm the watchdog and play the chime. Call once. */
  start: () => void
  /** Silently stop tracking this ring (unmount): clears the watchdog and
   * guarantees `onDone` never fires. Idempotent. */
  dispose: () => void
}

/**
 * One ring's lifecycle: play a fresh chime, substitute the fallback tone when
 * the chime cannot play, and call `onDone` exactly once when the ring is over —
 * on the chime's `ended`/`pause`, on the fallback tone's completion, when no
 * completion signal can ever fire, or (backstop only) when RING_WATCHDOG_MS
 * elapses without any of those.
 */
function createRingAttempt(ctxRef: { current: AudioContext | null }, onDone: () => void): RingAttempt {
  let finished = false
  // Arm the fallback at most once per ring — the chime can fail via the
  // play() rejection AND a media `error`/`abort` event for the same dead ring.
  let fallbackArmed = false
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const settle = (notify: boolean) => {
    if (finished) return
    finished = true
    if (watchdog !== null) {
      clearTimeout(watchdog)
      watchdog = null
    }
    if (notify) onDone()
  }
  const finish = () => settle(true)

  const armFallback = () => {
    if (fallbackArmed) return
    fallbackArmed = true
    // A spurious `error` after a successful `ended` must not play an
    // audible stray tone for the already-finished ring.
    if (finished) return
    if (!playFallbackTone(ctxRef, finish)) finish()
  }

  const start = () => {
    watchdog = setTimeout(() => {
      watchdog = null
      if (finished) return
      log.warn({ event: 'notification_ring_watchdog_fired', stage: fallbackArmed ? 'fallback' : 'chime' })
      finish()
    }, RING_WATCHDOG_MS)

    try {
      // A FRESH Audio instance per ring — restarting one shared element would
      // truncate an in-flight chime.
      const audio = new Audio(NOTIFICATION_SOUND_SRC)
      audio.preload = 'auto'
      audio.volume = 1
      audio.addEventListener('ended', finish, { once: true })
      // Per the HTML spec a natural end fires `pause` then `ended`; an external
      // pause (e.g. an OS audio interruption) fires `pause` alone. Either way
      // the ring is over — `finish` is idempotent.
      audio.addEventListener('pause', finish, { once: true })
      audio.addEventListener('error', armFallback, { once: true })
      // An aborted fetch never plays the chime: substitute the tone.
      audio.addEventListener('abort', armFallback, { once: true })
      const pending = audio.play()
      if (pending) {
        pending.catch(armFallback)
      }
    } catch {
      armFallback()
    }
  }

  return { start, dispose: () => settle(false) }
}

export function useNotificationSound() {
  const soundEnabled = useAppSelector((s) => s.settings.settings.notifications?.soundEnabled ?? true)
  const audioContextRef = useRef<AudioContext | null>(null)
  const queueLengthRef = useRef(0)
  const activeRingRef = useRef<RingAttempt | null>(null)
  const drainRef = useRef<() => void>(() => {})

  useEffect(() => {
    return () => {
      queueLengthRef.current = 0
      const ring = activeRingRef.current
      activeRingRef.current = null
      ring?.dispose()

      const ctx = audioContextRef.current
      audioContextRef.current = null
      if (ctx) {
        void ctx.close().catch(() => {})
      }
    }
  }, [])

  const drain = useCallback(() => {
    if (activeRingRef.current) return
    if (queueLengthRef.current <= 0) return
    queueLengthRef.current -= 1
    const ring = createRingAttempt(audioContextRef, () => {
      if (activeRingRef.current === ring) activeRingRef.current = null
      drainRef.current()
    })
    // Occupy the slot BEFORE starting: a ring that settles synchronously (no
    // audio machinery) re-enters drain from inside start().
    activeRingRef.current = ring
    ring.start()
  }, [])

  useEffect(() => {
    drainRef.current = drain
  }, [drain])

  const play = useCallback(() => {
    if (typeof window === 'undefined') return
    if (!soundEnabled) return
    // Unbounded queue: every honest event enqueues a ring — dropping bells for
    // large bursts would silence events the user was never told about.
    queueLengthRef.current += 1
    drain()
  }, [soundEnabled, drain])

  return { play }
}
