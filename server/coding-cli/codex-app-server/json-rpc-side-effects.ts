import type { JsonRpcFrameInput } from './json-rpc-envelope.js'

export type ThreadForkRewriteResult =
  | { ok: true; raw: Buffer }
  | { ok: false; reason: 'batch_unsupported' | 'malformed_json' | 'unsafe_duplicate_key' | 'unsupported_shape' }

export type ForkResponseCandidateExtractionResult =
  | {
      ok: true
      candidate: {
        source: 'thread_fork_response'
        thread: {
          id: string
          path: string
          ephemeral: boolean
        }
      }
    }
  | {
      ok: false
      reason:
        | 'id_not_pending_fork'
        | 'batch_unsupported'
        | 'malformed_json'
        | 'missing_thread'
        | 'missing_rollout_path'
        | 'relative_rollout_path'
        | 'ephemeral_thread'
        | 'same_as_parent'
        | 'path_alias_conflict'
    }

export type ThreadForkResponseRewriteResult =
  | { ok: true; raw: Buffer }
  | { ok: false; reason: 'batch_unsupported' | 'malformed_json' | 'unsupported_shape' | 'unsafe_duplicate_key' }

export function rewriteThreadForkRequestExcludeTurns(_input: JsonRpcFrameInput): ThreadForkRewriteResult {
  throw new Error('rewriteThreadForkRequestExcludeTurns is not implemented yet.')
}

export function normalizeThreadForkResponseForTui(_input: JsonRpcFrameInput): ThreadForkResponseRewriteResult {
  throw new Error('normalizeThreadForkResponseForTui is not implemented yet.')
}

export function extractForkResponseCandidate(
  _input: JsonRpcFrameInput,
  _options: {
    parentThreadId: string
    pendingForkRequestIds: ReadonlySet<string | number>
    provenForkPathField: 'path'
  },
): ForkResponseCandidateExtractionResult {
  throw new Error('extractForkResponseCandidate is not implemented yet.')
}
