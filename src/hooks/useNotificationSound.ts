import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { useAppSelector } from '@/store/hooks'

const NOTIFICATION_SOUND_SRC = '/your-code-is-ready.mp3'

function createFallbackTone(ctxRef: MutableRefObject<AudioContext | null>) {
  try {
    const AudioContextImpl = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
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
    // Best-effort.
  }
}

export function useNotificationSound() {
  const soundEnabled = useAppSelector((s) => s.settings.settings.notifications?.soundEnabled ?? true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    return () => {
      const audio = audioRef.current
      if (audio) {
        audio.pause()
        audio.src = ''
        audioRef.current = null
      }

      const ctx = audioContextRef.current
      if (ctx) {
        audioContextRef.current = null
        void ctx.close().catch(() => {})
      }
    }
  }, [])

  const play = useCallback(() => {
    if (typeof window === 'undefined') return
    if (!soundEnabled) return

    try {
      if (!audioRef.current) {
        const audio = new Audio(NOTIFICATION_SOUND_SRC)
        audio.preload = 'auto'
        audio.volume = 1
        audioRef.current = audio
      }

      const audio = audioRef.current
      audio.pause()
      audio.currentTime = 0
      void audio.play().catch(() => {
        createFallbackTone(audioContextRef)
      })
    } catch {
      createFallbackTone(audioContextRef)
    }
  }, [soundEnabled])

  return { play }
}
