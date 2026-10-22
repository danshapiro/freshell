/**
 * Name-reliability Task 4: the rename outcome a scoped rename response
 * carries, read at each route's nesting — the fresh-agent pane/tab routes
 * answer `{ data: { sessionName } }`, the session/terminal routes
 * `{ sessionName }`, the canonical route the update itself.
 */

type RenameOutcomeLike = { applied?: unknown; reason?: unknown }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function outcomeOf(response: unknown): RenameOutcomeLike | undefined {
  const body = asRecord(response)
  if (!body) return undefined
  const data = asRecord(body.data)
  const candidates = [
    asRecord(data?.sessionName)?.outcome,
    asRecord(body.sessionName)?.outcome,
    body.outcome,
  ]
  for (const candidate of candidates) {
    const outcome = asRecord(candidate)
    if (outcome && typeof outcome.applied === 'boolean') return outcome
  }
  return undefined
}

/** The refusal message for a rename the server did not apply, else undefined. */
export function renameNotAppliedMessage(response: unknown): string | undefined {
  const outcome = outcomeOf(response)
  if (!outcome || outcome.applied !== false) return undefined
  const reason = typeof outcome.reason === 'string' && outcome.reason.trim() ? outcome.reason : 'unknown'
  return `name not applied: ${reason}`
}
