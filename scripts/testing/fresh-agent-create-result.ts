type FreshAgentCreateFrame = {
  type?: unknown
  requestId?: unknown
  code?: unknown
}

export type FreshAgentCreateOutcome<TFrame> =
  | { kind: 'created'; reply: TFrame }
  | { kind: 'failed'; code: string }

/** Find the first terminal response for one create request without retaining provider text. */
export function findFreshAgentCreateOutcome<TFrame extends FreshAgentCreateFrame>(
  frames: readonly TFrame[],
  requestId: string,
): FreshAgentCreateOutcome<TFrame> | null {
  const frame = frames.find(candidate => candidate.requestId === requestId
    && (candidate.type === 'freshAgent.created' || candidate.type === 'freshAgent.create.failed'))
  if (!frame) return null
  if (frame.type === 'freshAgent.created') return { kind: 'created', reply: frame }

  const code = typeof frame.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(frame.code)
    ? frame.code
    : 'UNKNOWN'
  return { kind: 'failed', code }
}
