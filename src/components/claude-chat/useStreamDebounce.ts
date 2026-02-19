import { useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 50
const FLUSH_THRESHOLD = 200

/**
 * Debounces streaming text updates to limit markdown re-parsing frequency.
 * Flushes every DEBOUNCE_MS (periodic) or immediately when the buffer delta
 * exceeds FLUSH_THRESHOLD chars. Returns the debounced text string for rendering.
 *
 * Uses a ref for latest text so the periodic timer always reads current content,
 * avoiding stale closures and ensuring ~20fps updates during continuous streaming.
 */
export function useStreamDebounce(text: string, active: boolean): string {
  const [debouncedText, setDebouncedText] = useState(text)
  const lastFlushedLenRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevActiveRef = useRef(active)
  const latestTextRef = useRef(text)
  latestTextRef.current = text

  useEffect(() => {
    // When streaming is inactive, always show final text and reset
    if (!active) {
      setDebouncedText(text)
      lastFlushedLenRef.current = text.length
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      prevActiveRef.current = active
      return
    }

    // Reset on new stream start to prevent stale text from previous stream.
    // Without this, React batching could leave debouncedText holding old
    // content for a render frame when streamingActive transitions true.
    if (!prevActiveRef.current && active) {
      setDebouncedText(text) // text is '' at stream start
      lastFlushedLenRef.current = text.length
      prevActiveRef.current = active
      return
    }
    prevActiveRef.current = active

    const delta = text.length - lastFlushedLenRef.current

    // Flush immediately if buffer is large enough
    if (delta >= FLUSH_THRESHOLD) {
      setDebouncedText(text)
      lastFlushedLenRef.current = text.length
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }

    // Start periodic timer if not already running. Timer reads latest text
    // from ref, so it flushes current content even if text changed after
    // the timer was set. This prevents trailing-edge starvation where
    // continuous small updates would keep pushing the timer back.
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        setDebouncedText(latestTextRef.current)
        lastFlushedLenRef.current = latestTextRef.current.length
        timerRef.current = null
      }, DEBOUNCE_MS)
    }

    // No cleanup here — timer must survive re-renders to achieve periodic
    // flushing. Only cancelled explicitly (flush/deactivation) or on unmount.
  }, [text, active])

  // Clean up on unmount only
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return debouncedText
}
