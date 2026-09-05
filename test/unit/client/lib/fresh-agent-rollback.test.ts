import { describe, expect, it } from 'vitest'
import {
  buildRollbackFrame,
  gateRollbackCommand,
  asRollbackAck,
  isRollbackErrorEvent,
  ROLLBACK_BUSY_UNDO_NOTICE,
  ROLLBACK_BUSY_REDO_NOTICE,
  REDO_CODEX_UNSUPPORTED_NOTICE,
  REDO_DESTROYED_NOTICE,
  rollbackUnsupportedNotice,
} from '@/lib/fresh-agent-rollback'

const idleCapable = {
  direction: 'undo' as const,
  provider: 'opencode', providerLabel: 'OpenCode',
  capabilityUndo: true, capabilityRedo: true, canRedo: true,
  isBusy: false, hasRolledBackTurns: true,
}

describe('gateRollbackCommand', () => {
  it('sends when idle and capable', () => {
    expect(gateRollbackCommand(idleCapable)).toEqual({ kind: 'send' })
  })
  it('rejects mid-turn with the steer/queue pointer (decision 7)', () => {
    expect(gateRollbackCommand({ ...idleCapable, isBusy: true })).toEqual({ kind: 'reject', notice: ROLLBACK_BUSY_UNDO_NOTICE })
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', isBusy: true })).toEqual({ kind: 'reject', notice: ROLLBACK_BUSY_REDO_NOTICE })
  })
  it('rejects explicitly when the provider lacks the capability (decision 9)', () => {
    expect(gateRollbackCommand({ ...idleCapable, capabilityUndo: false })).toEqual({ kind: 'reject', notice: rollbackUnsupportedNotice('OpenCode') })
    expect(gateRollbackCommand({ ...idleCapable, capabilityUndo: undefined })).toEqual({ kind: 'reject', notice: rollbackUnsupportedNotice('OpenCode') })
  })
  it('codex redo gets the explicit decision-5 copy, not a generic rejection', () => {
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', provider: 'codex', providerLabel: 'Codex', capabilityRedo: false }))
      .toEqual({ kind: 'reject', notice: REDO_CODEX_UNSUPPORTED_NOTICE })
  })
  it('redo with a destroyed/absent boundary says so (decision 5)', () => {
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', canRedo: false }))
      .toEqual({ kind: 'reject', notice: REDO_DESTROYED_NOTICE })
    expect(gateRollbackCommand({ ...idleCapable, direction: 'redo', canRedo: true, hasRolledBackTurns: false }))
      .toEqual({ kind: 'reject', notice: 'Nothing to redo.' })
  })
})

describe('buildRollbackFrame', () => {
  it('builds the frozen undo frame', () => {
    expect(buildRollbackFrame({ direction: 'undo', requestId: 'r1', sessionId: 's1', sessionType: 'freshcodex', provider: 'codex' }))
      .toEqual({ type: 'freshAgent.undo', requestId: 'r1', sessionId: 's1', sessionType: 'freshcodex', provider: 'codex' })
  })
  it('builds a toTurn redo frame', () => {
    expect(buildRollbackFrame({ direction: 'redo', requestId: 'r2', sessionId: 's1', sessionType: 'freshopencode', provider: 'opencode', mode: 'toTurn', turnId: 'msg_u2', cwd: '/w' }))
      .toEqual({ type: 'freshAgent.redo', requestId: 'r2', sessionId: 's1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w', mode: 'toTurn', turnId: 'msg_u2' })
  })
})

describe('wire guards', () => {
  it('parses acks and ignores everything else', () => {
    expect(asRollbackAck({ type: 'freshAgent.rolledBack', requestId: 'r1', removedPromptText: 'p' })?.kind).toBe('freshAgent.rolledBack')
    expect(asRollbackAck({ type: 'freshAgent.redone', requestId: 'r2' })?.kind).toBe('freshAgent.redone')
    expect(asRollbackAck({ type: 'freshAgent.session.changed' })).toBeNull()
    expect(asRollbackAck(null)).toBeNull()
  })
  it('detects rollback-marked error events only', () => {
    expect(isRollbackErrorEvent({ type: 'freshAgent.error', rollback: true, code: 'BUSY_TURN' })).toBe(true)
    expect(isRollbackErrorEvent({ type: 'freshAgent.error', code: 'BUSY_TURN' })).toBe(false)
    expect(isRollbackErrorEvent({ type: 'freshAgent.error', rollback: true, code: 'INVALID_SESSION_ID' })).toBe(true)
  })
})
