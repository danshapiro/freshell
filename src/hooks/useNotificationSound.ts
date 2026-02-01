import { useCallback, useEffect, useRef } from 'react'

type AudioContextCtor = typeof AudioContext

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  return ctor ?? null
}

export function useNotificationSound() {
  const ctxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    return () => {
      const ctx = ctxRef.current
      if (!ctx) return
      ctxRef.current = null
      void ctx.close().catch(() => {})
    }
  }, [])

  const play = useCallback(() => {
    try {
      const AudioContextImpl = getAudioContextCtor()
      if (!AudioContextImpl) return

      if (!ctxRef.current) {
        ctxRef.current = new AudioContextImpl()
      }

      const ctx = ctxRef.current
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()

      oscillator.type = 'sine'
      oscillator.frequency.value = 880
      gain.gain.value = 0.05

      oscillator.connect(gain)
      gain.connect(ctx.destination)

      oscillator.start()
      oscillator.stop(ctx.currentTime + 0.12)
    } catch {
      // Best-effort: ignore audio failures (e.g., autoplay restrictions).
    }
  }, [])

  return { play }
}
