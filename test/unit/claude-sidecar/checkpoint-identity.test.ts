// @vitest-environment node
//
// The sidecar's checkpoint identity binding as a pure function: a checkpointed
// send carries a v4 uuid, and only the CLI's replay of that exact uuid
// (isReplay, role user) binds the attempt. The process-level replay test
// (user-message-replay.test.ts) drives the shapes the real CLI produces; this
// file also pins the shapes it never produces (a non-replay row carrying our
// uuid), which only a hand-made message can reach.

import { describe, expect, it } from 'vitest'
// @ts-expect-error JavaScript sidecar module has no declaration file.
import { checkpointAttemptOf, MAX_PENDING_CHECKPOINT_ATTEMPTS, rememberCheckpointAttempt, takeCheckpointIdentity } from '../../../crates/freshell-claude-sidecar/checkpoint-identity.mjs'

const UUID = 'b3eaf0e1-c8fe-4fb3-8802-b3ce52ca0b16'
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const attempt = { uuid: UUID, requestId: 'send-1', logicalAttemptId: 'attempt-1' }

function userRow(overrides: Record<string, unknown> = {}) {
  return { type: 'user', isReplay: true, uuid: UUID, message: { role: 'user', content: [{ type: 'text', text: 'same prompt' }] }, parent_tool_use_id: null, ...overrides }
}

function pendingWithAttempt() {
  const pending = new Map()
  rememberCheckpointAttempt(pending, checkpointAttemptOf(attempt))
  return pending
}

describe('checkpoint identity binding', () => {
  it.each([
    { mode: 'match', row: userRow(), shouldBind: true },
    { mode: 'mismatch', row: userRow({ uuid: OTHER }), shouldBind: false },
    { mode: 'ordinary', row: userRow({ isReplay: false }), shouldBind: false },
    { mode: 'assistant role', row: userRow({ message: { role: 'assistant', content: [] } }), shouldBind: false },
    { mode: 'not a uuid', row: userRow({ uuid: 'claude-native-turn' }), shouldBind: false },
  ])('$mode replay binds only its own correlated user row', ({ row, shouldBind }) => {
    const pending = pendingWithAttempt()
    const frame = takeCheckpointIdentity(pending, 'session-1', row)
    if (shouldBind) {
      expect(frame).toEqual({
        type: 'sdk.checkpointTurnIdentity',
        sessionId: 'session-1',
        logicalAttemptId: 'attempt-1',
        requestId: 'send-1',
        nativeTurnId: UUID,
        displayTurnId: UUID,
      })
      expect(pending.size).toBe(0)
      // The attempt binds once: a second replay of the same uuid is not evidence again.
      expect(takeCheckpointIdentity(pending, 'session-1', row)).toBeUndefined()
    } else {
      expect(frame).toBeUndefined()
      expect(pending.size).toBe(1)
    }
  })

  it('accepts only a complete attempt with a uuid, a logical attempt id and a request id', () => {
    expect(checkpointAttemptOf({ ...attempt, extra: 'dropped' })).toEqual(attempt)
    expect(checkpointAttemptOf(undefined)).toBeUndefined()
    expect(checkpointAttemptOf({ ...attempt, uuid: 'not-a-uuid' })).toBeUndefined()
    expect(checkpointAttemptOf({ ...attempt, logicalAttemptId: '' })).toBeUndefined()
    expect(checkpointAttemptOf({ ...attempt, requestId: 7 })).toBeUndefined()
  })

  it('keeps a bounded set of pending attempts, evicting the oldest (eviction means no identity, never a guess)', () => {
    const pending = new Map()
    const uuids: string[] = []
    for (let i = 0; i <= MAX_PENDING_CHECKPOINT_ATTEMPTS; i++) {
      const uuid = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      uuids.push(uuid)
      rememberCheckpointAttempt(pending, { uuid, requestId: `r${i}`, logicalAttemptId: `a${i}` })
    }
    expect(pending.size).toBe(MAX_PENDING_CHECKPOINT_ATTEMPTS)
    expect(takeCheckpointIdentity(pending, 's', userRow({ uuid: uuids[0] }))).toBeUndefined()
    expect(takeCheckpointIdentity(pending, 's', userRow({ uuid: uuids[1] }))).toMatchObject({ requestId: 'r1' })
  })

  it('re-registering an attempt refreshes its place instead of duplicating it', () => {
    const pending = new Map()
    rememberCheckpointAttempt(pending, attempt)
    rememberCheckpointAttempt(pending, { uuid: OTHER, requestId: 'send-2', logicalAttemptId: 'attempt-2' })
    rememberCheckpointAttempt(pending, attempt)
    expect([...pending.keys()]).toEqual([OTHER, UUID])
  })
})
