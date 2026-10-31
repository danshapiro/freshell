/** Preserve the typed automation receipt without forwarding provider payloads. */
export function automationErrorReceipt(error: unknown): Record<string, string | number | boolean> | undefined {
  if (!error || typeof error !== 'object' || !('details' in error)) return undefined
  const details = error.details
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
  const body = details as Record<string, unknown>
  if (typeof body.code !== 'string') return undefined
  const receipt: Record<string, string | number | boolean> = { code: body.code }
  for (const key of ['sessionId', 'requestId', 'incarnationId', 'submittedTurnId', 'ownerKind']) {
    if (typeof body[key] === 'string' && body[key].length > 0) receipt[key] = body[key]
  }
  if (!receipt.incarnationId && !receipt.ownerKind) return undefined
  if (typeof body.retryable === 'boolean') receipt.retryable = body.retryable
  for (const key of ['ownerEpoch', 'ownerGeneration', 'retryAfterMs']) {
    if (typeof body[key] === 'number' && Number.isFinite(body[key])) receipt[key] = body[key]
  }
  return receipt
}
