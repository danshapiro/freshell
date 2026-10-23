// Checkpoint identity at the SDK replay boundary (pure; used by index.mjs).
//
// A checkpointed send carries a v4 uuid on its SDKUserMessage. The CLI echoes
// a message it takes back as a user row with `isReplay: true` and that uuid
// (the sidecar opts in with `replay-user-messages`). Only that replay binds the
// attempt to its native turn id: assistant, tool and result frames, ordinary
// user rows, and replays of uuids we did not send are never identity evidence.

export const MAX_PENDING_CHECKPOINT_ATTEMPTS = 128

export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

/** The checkpoint attempt of a `send` request, or undefined when it is absent or incomplete. */
export function checkpointAttemptOf(raw) {
  return raw && isUuid(raw.uuid)
    && typeof raw.logicalAttemptId === 'string' && raw.logicalAttemptId.length > 0
    && typeof raw.requestId === 'string' && raw.requestId.length > 0
    ? { uuid: raw.uuid, logicalAttemptId: raw.logicalAttemptId, requestId: raw.requestId }
    : undefined
}

/**
 * Remember an attempt until its replay arrives. The set is bounded: an evicted
 * attempt simply never gets an identity, which is never approximated by
 * request order or prompt text.
 */
export function rememberCheckpointAttempt(pending, attempt) {
  pending.delete(attempt.uuid)
  pending.set(attempt.uuid, attempt)
  while (pending.size > MAX_PENDING_CHECKPOINT_ATTEMPTS) {
    pending.delete(pending.keys().next().value)
  }
}

/** The `sdk.checkpointTurnIdentity` frame this SDK message proves, consuming its attempt; else undefined. */
export function takeCheckpointIdentity(pending, sessionId, msg) {
  if (msg?.type !== 'user' || msg.isReplay !== true || msg.message?.role !== 'user' || !isUuid(msg.uuid)) return undefined
  const attempt = pending.get(msg.uuid)
  if (!attempt) return undefined
  pending.delete(msg.uuid)
  return {
    type: 'sdk.checkpointTurnIdentity',
    sessionId,
    logicalAttemptId: attempt.logicalAttemptId,
    requestId: attempt.requestId,
    nativeTurnId: msg.uuid,
    displayTurnId: msg.uuid,
  }
}
