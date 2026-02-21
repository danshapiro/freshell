import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TerminalAttachedStartMessage,
  TerminalAttachedChunkMessage,
  TerminalAttachedEndMessage,
  TerminalExitMessage,
} from '@shared/ws-protocol'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('ChunkedAttach')

export const ATTACH_FRAME_SEND_TIMEOUT_MS = 30_000
export const ATTACH_RECONNECT_MIN_DELAY_MS = 5_000
export const ATTACH_CHUNK_TIMEOUT_MS = 35_000

type SnapshotState = 'idle' | 'pending' | 'complete' | 'degraded'

type ChunkLifecycleMessage = TerminalAttachedStartMessage | TerminalAttachedChunkMessage | TerminalAttachedEndMessage | TerminalExitMessage

type InflightSequence = {
  chunks: string[]
  totalCodeUnits: number
  totalChunks: number
  receivedChunks: number
  generation: number
}

type UseChunkedAttachArgs = {
  activeTerminalId: string | undefined
  activeTerminalIdRef: { current: string | undefined }
  setIsAttaching: (value: boolean) => void
  applySnapshot: (snapshot: string) => void
  markRunning: () => void
  wsSend: (msg: { type: 'terminal.attach'; terminalId: string }) => void
}

type UseChunkedAttachResult = {
  snapshotState: SnapshotState
  snapshotWarning: string | null
  handleChunkLifecycleMessage: (msg: unknown) => boolean
  markSnapshotChunkedCreated: () => void
  bumpConnectionGeneration: () => void
  clearChunkedAttachState: () => void
}

function isChunkLifecycleMessage(msg: unknown): msg is ChunkLifecycleMessage {
  if (!msg || typeof msg !== 'object') return false
  const type = (msg as { type?: unknown }).type
  return (
    type === 'terminal.attached.start' ||
    type === 'terminal.attached.chunk' ||
    type === 'terminal.attached.end' ||
    type === 'terminal.exit'
  )
}

export function useChunkedAttach({
  activeTerminalId,
  activeTerminalIdRef,
  setIsAttaching,
  applySnapshot,
  markRunning,
  wsSend,
}: UseChunkedAttachArgs): UseChunkedAttachResult {
  const inflightChunksRef = useRef(new Map<string, InflightSequence>())
  const timeoutByTerminalRef = useRef(new Map<string, number>())
  const previousTerminalIdRef = useRef<string | undefined>(activeTerminalId)
  const connectionGenerationRef = useRef(0)
  const autoReattachGuardsRef = useRef(new Set<string>())

  const [snapshotState, setSnapshotState] = useState<SnapshotState>('idle')
  const [snapshotWarning, setSnapshotWarning] = useState<string | null>(null)

  useEffect(() => {
    if (ATTACH_CHUNK_TIMEOUT_MS < ATTACH_FRAME_SEND_TIMEOUT_MS + ATTACH_RECONNECT_MIN_DELAY_MS) {
      log.warn('[chunked-attach] timeout invariant violated')
    }
  }, [])

  const clearTerminalTimer = useCallback((terminalId: string) => {
    const timerId = timeoutByTerminalRef.current.get(terminalId)
    if (timerId === undefined) return
    window.clearTimeout(timerId)
    timeoutByTerminalRef.current.delete(terminalId)
  }, [])

  const clearTerminalState = useCallback((terminalId: string) => {
    clearTerminalTimer(terminalId)
    inflightChunksRef.current.delete(terminalId)
  }, [clearTerminalTimer])

  const clearChunkedAttachState = useCallback(() => {
    for (const timerId of timeoutByTerminalRef.current.values()) {
      window.clearTimeout(timerId)
    }
    timeoutByTerminalRef.current.clear()
    inflightChunksRef.current.clear()
    setSnapshotState('idle')
  }, [])

  const attemptAutoReattach = useCallback((terminalId: string, generation: number) => {
    const guardKey = `${terminalId}:${generation}`
    if (autoReattachGuardsRef.current.has(guardKey)) return
    autoReattachGuardsRef.current.add(guardKey)
    wsSend({ type: 'terminal.attach', terminalId })
  }, [wsSend])

  const scheduleSequenceTimeout = useCallback((terminalId: string, generation: number) => {
    clearTerminalTimer(terminalId)
    const timerId = window.setTimeout(() => {
      const sequence = inflightChunksRef.current.get(terminalId)
      if (!sequence) return
      if (sequence.generation !== generation) return

      clearTerminalState(terminalId)
      setIsAttaching(false)
      setSnapshotState('degraded')
      setSnapshotWarning('Snapshot sync timed out. Reconnecting once while keeping live output.')
      attemptAutoReattach(terminalId, generation)
    }, ATTACH_CHUNK_TIMEOUT_MS)
    timeoutByTerminalRef.current.set(terminalId, timerId)
  }, [attemptAutoReattach, clearTerminalState, clearTerminalTimer, setIsAttaching])

  const bumpConnectionGeneration = useCallback(() => {
    connectionGenerationRef.current += 1
    clearChunkedAttachState()
    autoReattachGuardsRef.current.clear()
    setIsAttaching(false)
    setSnapshotWarning(null)
  }, [clearChunkedAttachState, setIsAttaching])

  const markSnapshotChunkedCreated = useCallback(() => {
    setSnapshotState('pending')
    setSnapshotWarning(null)
    setIsAttaching(true)
  }, [setIsAttaching])

  useEffect(() => {
    const previousTerminalId = previousTerminalIdRef.current
    if (previousTerminalId && previousTerminalId !== activeTerminalId) {
      clearTerminalState(previousTerminalId)
      setSnapshotWarning(null)
      setSnapshotState('idle')
    }
    previousTerminalIdRef.current = activeTerminalId
  }, [activeTerminalId, clearTerminalState])

  useEffect(() => () => {
    clearChunkedAttachState()
  }, [clearChunkedAttachState])

  const handleChunkLifecycleMessage = useCallback((msg: unknown): boolean => {
    if (!isChunkLifecycleMessage(msg)) return false
    const currentTerminalId = activeTerminalIdRef.current

    if (msg.type === 'terminal.exit') {
      if (msg.terminalId === currentTerminalId) {
        clearTerminalState(msg.terminalId)
        setIsAttaching(false)
      }
      return false
    }

    if (!currentTerminalId) return false

    if (msg.type === 'terminal.attached.start') {
      if (msg.terminalId !== currentTerminalId) return false

      const generation = connectionGenerationRef.current
      clearTerminalState(msg.terminalId)
      inflightChunksRef.current.set(msg.terminalId, {
        chunks: [],
        totalCodeUnits: msg.totalCodeUnits,
        totalChunks: msg.totalChunks,
        receivedChunks: 0,
        generation,
      })
      setSnapshotState('pending')
      setSnapshotWarning(null)
      setIsAttaching(true)
      scheduleSequenceTimeout(msg.terminalId, generation)
      return true
    }

    if (msg.type === 'terminal.attached.chunk') {
      const inflight = inflightChunksRef.current.get(msg.terminalId)
      if (!inflight) return false
      if (inflight.generation !== connectionGenerationRef.current) return true
      inflight.chunks.push(msg.chunk)
      inflight.receivedChunks += 1
      return true
    }

    if (msg.type === 'terminal.attached.end') {
      const inflight = inflightChunksRef.current.get(msg.terminalId)
      if (!inflight) return false

      clearTerminalState(msg.terminalId)

      const reassembled = inflight.chunks.join('')
      const metadataMatches =
        inflight.totalCodeUnits === msg.totalCodeUnits &&
        inflight.totalChunks === msg.totalChunks
      const countMatches = inflight.receivedChunks === inflight.totalChunks
      const lengthMatches = reassembled.length === msg.totalCodeUnits

      if (metadataMatches && countMatches && lengthMatches) {
        applySnapshot(reassembled)
        markRunning()
        setIsAttaching(false)
        setSnapshotState('complete')
        setSnapshotWarning(null)
        return true
      }

      setIsAttaching(false)
      setSnapshotState('degraded')
      setSnapshotWarning('Snapshot sync was incomplete. Reconnecting once while keeping live output.')
      attemptAutoReattach(msg.terminalId, inflight.generation)
      return true
    }

    return false
  }, [
    activeTerminalIdRef,
    applySnapshot,
    attemptAutoReattach,
    clearTerminalState,
    markRunning,
    scheduleSequenceTimeout,
    setIsAttaching,
  ])

  return {
    snapshotState,
    snapshotWarning,
    handleChunkLifecycleMessage,
    markSnapshotChunkedCreated,
    bumpConnectionGeneration,
    clearChunkedAttachState,
  }
}
