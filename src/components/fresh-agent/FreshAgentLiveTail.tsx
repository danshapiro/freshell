import { memo, useContext, useLayoutEffect, useMemo } from 'react'
import type { FreshAgentTranscriptItem, FreshAgentTurn } from '@shared/fresh-agent-contract'
import { useAppSelector } from '@/store/hooks'
import type { FreshAgentLiveSession, LiveBlock, LiveRetry } from '@/store/freshAgentLiveTypes'
import { isLiveBlockLanded, type LandedTranscript } from '@/lib/fresh-agent-landed-transcript'
import {
  buildTranscriptLayout,
  FreshAgentTurnArticle,
  selectLiveActivityBlockIdFromLayout,
  TranscriptFollowContext,
  type TurnActionProps,
} from './FreshAgentTranscript'

/** The live response is not a turn yet: it offers no turn actions. */
const NO_TURN_ACTIONS: TurnActionProps = { canFork: false }

const LIVE_TURN_ID = '__live-tail'

/**
 * Which of the tail's turns a component shows: the turn that ended (blocks
 * whose result arrived, waiting for their lines to land), the turn running
 * now (its blocks and the retry in progress), or both, in that order.
 */
export type LiveTailPart = 'ended' | 'running' | 'all'

function inPart(block: LiveBlock, part: LiveTailPart): boolean {
  if (part === 'all') return true
  return part === 'ended' ? block.ended === true : block.ended !== true
}

function liveItemId(block: LiveBlock): string {
  return `live:${block.messageId ?? 'unknown'}:${block.index}`
}

/** "overloaded (529) · retrying in 1s" — what failed and when the CLI tries again. */
export function describeRetry(retry: LiveRetry): string | undefined {
  const cause = [
    retry.error,
    typeof retry.errorStatus === 'number' ? `(${retry.errorStatus})` : undefined,
  ].filter(Boolean).join(' ')
  const wait = typeof retry.delayMs === 'number'
    ? `retrying in ${Math.max(1, Math.round(retry.delayMs / 1000))}s`
    : undefined
  const text = [cause, wait].filter(Boolean).join(' · ')
  return text || undefined
}

function blockItem(block: LiveBlock): FreshAgentTranscriptItem {
  const id = liveItemId(block)
  switch (block.kind) {
    case 'text':
      return { id, kind: 'text', text: block.text }
    case 'thinking':
      return { id, kind: 'thinking', text: block.text }
    case 'tool_use':
      return {
        id,
        kind: 'tool_use',
        toolUseId: block.toolUseId ?? id,
        name: block.name ?? 'Tool',
        ...(block.input !== undefined ? { input: block.input as never } : {}),
      }
  }
}

/**
 * The live tail's one synthetic turn: the blocks whose transcript line is not
 * on screen yet (a block the rendered snapshot already shows is hidden in the
 * same frame), then the API retry in progress — the newest thing happening,
 * so it is the strip's live row.
 */
export function buildLiveTailTurn(
  tail: FreshAgentLiveSession | undefined,
  landed: LandedTranscript,
  part: LiveTailPart = 'all',
): FreshAgentTurn | null {
  if (!tail) return null
  const items: FreshAgentTranscriptItem[] = tail.blocks
    .filter((block) => inPart(block, part) && !isLiveBlockLanded(block, landed))
    .map(blockItem)
  if (tail.retry && part !== 'ended') {
    const error = describeRetry(tail.retry)
    items.push({ id: `${LIVE_TURN_ID}:retry`, kind: 'retry', attempt: tail.retry.attempt, ...(error ? { error } : {}) })
  }
  if (items.length === 0) return null
  return { id: LIVE_TURN_ID, turnId: LIVE_TURN_ID, role: 'assistant', source: 'live', summary: '', items }
}

/**
 * Whether the tail renders anything: an unlanded block with visible content
 * (a tool shows from its start; text and thinking once they have text) or a
 * retry. A cheap store-selector predicate — it avoids building the layout.
 */
export function liveTailShowsContent(
  tail: FreshAgentLiveSession | undefined,
  landed: LandedTranscript,
  part: LiveTailPart = 'all',
): boolean {
  if (!tail) return false
  if (tail.retry && part !== 'ended') return true
  return tail.blocks.some((block) => (
    inPart(block, part)
    && !isLiveBlockLanded(block, landed)
    && (block.kind === 'tool_use' || block.text.trim().length > 0)
  ))
}

/** A cheap fingerprint of what the tail shows: it changes whenever the tail grows. */
function tailSignature(turn: FreshAgentTurn | null): string {
  if (!turn) return ''
  return turn.items.map((item) => {
    if (item.kind === 'text' || item.kind === 'thinking') return `${item.id}:${item.text.length}`
    if (item.kind === 'retry') return `${item.id}:${item.attempt}`
    if (item.kind === 'tool_use') return `${item.id}:${item.input === undefined ? 0 : 1}`
    return item.id
  }).join('|')
}

/**
 * What a running turn shows before its transcript lines land in a snapshot
 * (transcript-live plan §4.4): streaming text and thinking, a tool that just
 * started, and an API retry in progress. It selects only its own session's
 * tail, so a token re-renders this component alone, and it renders through
 * the transcript's own layout and turn article, so live content looks exactly
 * like the durable turn that replaces it.
 */
function FreshAgentLiveTailImpl({
  sessionKey,
  landed,
  part = 'all',
  agentLabel,
  expandThinking = false,
  expandTools = false,
}: {
  sessionKey: string
  /** What the rendered snapshot already shows. */
  landed: LandedTranscript
  /** The tail's turns this component shows (both by default). */
  part?: LiveTailPart
  agentLabel?: string
  expandThinking?: boolean
  expandTools?: boolean
}) {
  const tail = useAppSelector((state) => state.freshAgentLive?.bySession[sessionKey])
  const follow = useContext(TranscriptFollowContext)
  const turn = useMemo(() => buildLiveTailTurn(tail, landed, part), [tail, landed, part])
  const layout = useMemo(() => {
    if (!turn) return null
    const built = buildTranscriptLayout([turn])
    return {
      blocks: built.layouts[0]?.blocks ?? [],
      liveActivityBlockId: selectLiveActivityBlockIdFromLayout(built.layouts, [turn], true, built.tail),
    }
  }, [turn])
  const signature = tailSignature(turn)
  const requestFollow = follow?.requestFollow

  useLayoutEffect(() => {
    if (signature) requestFollow?.()
  }, [requestFollow, signature])

  if (!turn || !layout || layout.blocks.length === 0) return null
  const continuesAssistant = follow?.lastTurnRole === 'assistant'
  return (
    <FreshAgentTurnArticle
      live
      turn={turn}
      actionTurn={turn}
      blocks={layout.blocks}
      actions={NO_TURN_ACTIONS}
      agentLabel={agentLabel}
      showTimecodes={false}
      expandThinking={expandThinking}
      expandTools={expandTools}
      showHeader={!continuesAssistant}
      continuation={continuesAssistant}
      liveActivityBlockId={layout.liveActivityBlockId}
      isStreamingLastTurn
      index={-1}
    />
  )
}

export const FreshAgentLiveTail = memo(FreshAgentLiveTailImpl)
