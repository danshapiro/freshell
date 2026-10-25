/**
 * The live tail of a fresh-agent session (transcript-live plan §4.4): what a
 * running turn shows before its transcript lines land in a snapshot. Claude
 * blocks and Codex event-owned bodies stay here, with explicit provenance
 * when native saving differs or is unavailable. API retries and provider
 * notices never end a turn. This state
 * lives under its own root key so token-rate updates never touch
 * `state.freshAgent.sessions` (P3).
 */

export type LiveBlockKind = 'text' | 'thinking' | 'tool_use'

/** One streamed content block of the main thread's current API message. */
export type LiveBlock = {
  /** The API message id the block belongs to (`message_start`). */
  messageId: string | null
  /** The block's index within its message. */
  index: number
  kind: LiveBlockKind
  /** Streamed text (text and thinking blocks); empty for a tool. */
  text: string
  /** Tool name, for a tool_use block. */
  name?: string
  /** Tool use id, for a tool_use block. */
  toolUseId?: string
  /** The tool's input, once the block's assistant message carried it. */
  input?: unknown
  /** The transcript line uuid the block becomes (its assistant message's uuid). */
  uuid?: string
  /**
   * The turn the block belongs to has ended (its result arrived): nothing
   * streams into it any more, and it only waits for its line to land.
   */
  ended?: true
}

/** One stream event, reduced to what the tail renders. */
export type LiveStreamOp =
  | {
    op: 'start'
    messageId: string | null
    index: number
    kind: LiveBlockKind
    name?: string
    toolUseId?: string
  }
  | {
    op: 'delta'
    messageId: string | null
    index: number
    text: string
  }

/** The API request the CLI is retrying right now (live only; never persisted). */
export type LiveRetry = {
  attempt: number
  maxRetries?: number
  delayMs?: number
  /** HTTP status of the failed request; null for a connection error. */
  errorStatus?: number | null
  error?: string
}

export type LiveNoticeLevel = 'info' | 'warning' | 'error'

/** The account usage limit a rate-limit notice is about. */
export type LiveRateLimit = {
  status?: string
  /** When the limit resets, as the CLI reports it (epoch seconds). */
  resetsAt?: number
  rateLimitType?: string
  utilization?: number
}

/** A provider notice (rate limit, failed compaction, informational banner). */
export type LiveNotice = {
  /** Increases with every notice received, across sessions. */
  seq: number
  level: LiveNoticeLevel
  code: string
  message: string
  rateLimit?: LiveRateLimit
}

import type { TranscriptProjection } from '@/lib/fresh-agent-transcript-projection'
import type { FreshAgentTranscriptPatch } from '@shared/fresh-agent-contract'

export type FreshAgentLiveSession = {
  projection?: TranscriptProjection
  codexMetadata?: Record<string, unknown>
  unboundTranscriptPatches?: FreshAgentTranscriptPatch[]
  unboundTranscriptWatermarks?: Record<string, { revision: number; gap: boolean }>
  blocks: LiveBlock[]
  retry?: LiveRetry
  /** Transcript line uuids announced by the CLI and not yet seen in a snapshot. */
  expectedTurnIds: string[]
  notice?: LiveNotice
}

export type FreshAgentLiveState = {
  bySession: Record<string, FreshAgentLiveSession>
  noticeSeq: number
  /**
   * How many visible panes settle each session's tail (land its blocks and
   * clear it once its turn is on screen). A tail no pane settles is dropped
   * when its turn ends, so a session this client does not show never keeps
   * more than its running turn.
   */
  viewers: Record<string, number>
}
