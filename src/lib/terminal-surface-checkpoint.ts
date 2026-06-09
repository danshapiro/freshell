export type TerminalBufferType = 'normal' | 'alternate' | 'unknown'
export type TerminalGeometryAuthority = 'single_client' | 'server_stream' | 'multi_client_unknown'

export type TerminalSurfaceCheckpoint = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  attachRequestId: string
  parserAppliedSeq: number
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
  bufferType: TerminalBufferType
  parserIdle: boolean
}

export type CheckpointDeltaReplayInput = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
  requireParserIdle: boolean
}

export type CheckpointDeltaReplayDecision =
  | { ok: true; sinceSeq: number }
  | {
      ok: false
      reason:
        | 'missing_checkpoint'
        | 'terminal_changed'
        | 'stream_changed'
        | 'server_changed'
        | 'surface_changed'
        | 'geometry_changed'
        | 'geometry_authority_unknown'
        | 'scrollback_changed'
        | 'xterm_version_changed'
        | 'parser_busy'
        | 'no_applied_sequence'
    }

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizeCheckpoint(input: TerminalSurfaceCheckpoint): TerminalSurfaceCheckpoint {
  return {
    ...input,
    streamId: input.streamId ?? null,
    surfaceEpoch: normalizeNonNegativeInteger(input.surfaceEpoch),
    parserAppliedSeq: normalizeNonNegativeInteger(input.parserAppliedSeq),
    cols: normalizeNonNegativeInteger(input.cols),
    rows: normalizeNonNegativeInteger(input.rows),
    geometryEpoch: normalizeNonNegativeInteger(input.geometryEpoch),
    scrollback: normalizeNonNegativeInteger(input.scrollback),
  }
}

function normalizeReplayInput(input: CheckpointDeltaReplayInput): CheckpointDeltaReplayInput {
  return {
    ...input,
    streamId: input.streamId ?? null,
    surfaceEpoch: normalizeNonNegativeInteger(input.surfaceEpoch),
    cols: normalizeNonNegativeInteger(input.cols),
    rows: normalizeNonNegativeInteger(input.rows),
    geometryEpoch: normalizeNonNegativeInteger(input.geometryEpoch),
    scrollback: normalizeNonNegativeInteger(input.scrollback),
  }
}

export function createTerminalSurfaceCheckpoint(
  input: TerminalSurfaceCheckpoint,
): TerminalSurfaceCheckpoint {
  return normalizeCheckpoint(input)
}

export function canUseCheckpointForDeltaReplay(
  checkpoint: TerminalSurfaceCheckpoint | null | undefined,
  input: CheckpointDeltaReplayInput,
): CheckpointDeltaReplayDecision {
  if (!checkpoint) return { ok: false, reason: 'missing_checkpoint' }

  const current = normalizeReplayInput(input)
  const saved = normalizeCheckpoint(checkpoint)

  if (saved.terminalId !== current.terminalId) {
    return { ok: false, reason: 'terminal_changed' }
  }
  // Stream identity is required for v2 delta replay. A missing/null stream id
  // is a protocol failure, not a compatible legacy identity.
  if (!saved.streamId || !current.streamId) {
    return { ok: false, reason: 'stream_changed' }
  }
  if (saved.streamId !== current.streamId) {
    return { ok: false, reason: 'stream_changed' }
  }
  if (
    saved.serverInstanceId !== current.serverInstanceId
    || (saved.serverBootId ?? null) !== (current.serverBootId ?? null)
  ) {
    return { ok: false, reason: 'server_changed' }
  }
  if (saved.surfaceEpoch !== current.surfaceEpoch) {
    return { ok: false, reason: 'surface_changed' }
  }
  if (
    saved.cols !== current.cols
    || saved.rows !== current.rows
    || saved.geometryEpoch !== current.geometryEpoch
  ) {
    return { ok: false, reason: 'geometry_changed' }
  }
  if (
    saved.geometryAuthority === 'multi_client_unknown'
    || current.geometryAuthority === 'multi_client_unknown'
    || saved.geometryAuthority !== current.geometryAuthority
  ) {
    return { ok: false, reason: 'geometry_authority_unknown' }
  }
  if (saved.scrollback !== current.scrollback) {
    return { ok: false, reason: 'scrollback_changed' }
  }
  if (saved.xtermVersion !== current.xtermVersion) {
    return { ok: false, reason: 'xterm_version_changed' }
  }
  if (current.requireParserIdle && !saved.parserIdle) {
    return { ok: false, reason: 'parser_busy' }
  }
  if (saved.parserAppliedSeq <= 0) {
    return { ok: false, reason: 'no_applied_sequence' }
  }

  return { ok: true, sinceSeq: saved.parserAppliedSeq }
}
