import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FreshAgentChildObservationSchema, type FreshAgentChildRead, type FreshAgentChildObservation, type FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import { api } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { FreshAgentAsyncQuestionContext } from './FreshAgentItemCard.js'
import { FreshAgentTranscript } from './FreshAgentTranscript.js'

export type FreshAgentChildParent = Omit<FreshAgentChildRead, 'childThreadId'> & { provider: 'codex'; sessionType: 'freshcodex' }

const MAX_READS = 5
const log = createLogger('FreshAgentChildObserver')

export function FreshAgentChildObserver({ parent, childThreadId, onClose }: { parent: FreshAgentChildParent; childThreadId: string; onClose: () => void }) {
  const [observation, setObservation] = useState<FreshAgentChildObservation>()
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot>()
  const [refresh, setRefresh] = useState(0)
  const [stale, setStale] = useState(false)
  const close = useRef<HTMLButtonElement>(null)
  const scope = `${parent.parentSessionId}:${childThreadId}`
  const previousScope = useRef(scope)
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let reads = 0
    if (previousScope.current !== scope) { setSnapshot(undefined); previousScope.current = scope }
    setObservation(undefined)
    setStale(true)
    const unavailable = (): FreshAgentChildObservation => ({ parentThreadId: parent.parentSessionId, childThreadId, status: 'unavailable', reason: 'source_unavailable', retryable: true })
    const read = async () => {
      reads++
      let next: FreshAgentChildObservation
      try {
        const params = new URLSearchParams()
        if (parent.observedEpoch !== undefined) params.set('observedEpoch', String(parent.observedEpoch))
        if (parent.observedGeneration !== undefined) params.set('observedGeneration', String(parent.observedGeneration))
        const query = params.size ? `?${params}` : ''
        const response = await api.get(`/api/fresh-agent/threads/freshcodex/codex/${encodeURIComponent(parent.parentSessionId)}/children/${encodeURIComponent(childThreadId)}${query}`, { signal: controller.signal })
        next = FreshAgentChildObservationSchema.parse(response)
        // The parent supplies its canonical native identity and current fence.
        if (next.parentThreadId !== parent.parentSessionId || next.childThreadId !== childThreadId) throw new Error('Child observation identity mismatch')
      } catch (error) {
        if (controller.signal.aborted) return
        log.warn('Child observation source unavailable', { provider: 'codex', parentSessionId: parent.parentSessionId, childThreadId, observedEpoch: parent.observedEpoch, observedGeneration: parent.observedGeneration, errorName: error instanceof Error ? error.name : 'unknown' })
        next = unavailable()
      }
      if (controller.signal.aborted) return
      if (next.status === 'pending' && reads >= MAX_READS) next = { ...next, status: 'unavailable', reason: 'history_unavailable', retryable: true }
      setObservation(next)
      if ('snapshot' in next) { setSnapshot(next.snapshot); setStale(false) } else { setStale(true) }
      const retry = next.status === 'live' || next.status === 'pending' || (next.status === 'unavailable' && next.retryable)
      if (retry && reads < MAX_READS) timer = setTimeout(() => { void read() }, 1000)
    }
    void read()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [scope, parent.parentSessionId, parent.observedEpoch, parent.observedGeneration, childThreadId, refresh])
  const ephemeral = observation?.status === 'unavailable' && observation.reason === 'ephemeral_history_unavailable'
  const availability = ephemeral ? 'Codex does not expose history for this ephemeral child. Its activity remains in the parent conversation.' : observation?.status === 'unavailable' ? 'Child history is unavailable.' : observation?.status === 'pending' ? 'Waiting for child history to be saved.' : observation?.status === 'live' ? 'Observed live child history. Observation does not control the child.' : observation?.status === 'saved' ? 'Saved child history.' : 'Reading child history.'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The modal container owns Escape and focus wrapping for its native controls, following ConfirmModal; keyboard and focus-return behavior is covered by observer tests. */}
      <section role="dialog" aria-modal="true" aria-label="Child conversation" className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded border bg-background shadow-xl" onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        if (event.key === 'Tab') {
          const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]')).filter((node) => !node.hasAttribute('disabled'))
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
        <div className="flex items-center justify-between border-b p-3"><div><h2>Child conversation</h2><p className="text-xs text-muted-foreground">Read-only · {childThreadId}</p></div><button ref={close} type="button" onClick={onClose} aria-label="Close child conversation">Close</button></div>
        <div role="status" className="px-3 py-2 text-sm">
          {snapshot && stale ? `Previously available content. ${availability}` : availability}
          {!ephemeral && observation && observation.status !== 'pending' ? <button type="button" className="ml-2 underline" onClick={() => setRefresh((value) => value + 1)}>Refresh child history</button> : null}
        </div>
        {snapshot ? <FreshAgentAsyncQuestionContext.Provider value={{}}><div className="min-h-0 overflow-auto"><FreshAgentTranscript turns={snapshot.turns} agentLabel="Freshcodex" sessionId={childThreadId} canFork={false} canRollback={false} canRedo={false} showTranscriptMinimap={false} /></div></FreshAgentAsyncQuestionContext.Provider> : null}
      </section>
    </div>, document.body,
  )
}
