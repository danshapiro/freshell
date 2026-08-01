import { describe, expect, it } from 'vitest'
import {
  BUSY_DEADMAN_MS,
  PENDING_SUBMIT_GATE_MS,
  PENDING_SNAPSHOT_GRACE_MS,
  CodexActivityTracker,
} from '../../../../server/coding-cli/codex-activity-tracker'
import type { CodexTaskEventSnapshot, CodingCliSession, ProjectGroup } from '../../../../server/coding-cli/types'

function createSession(
  sessionId: string,
  codexTaskEvents?: CodexTaskEventSnapshot,
  overrides: Partial<CodingCliSession> = {},
): CodingCliSession {
  return {
    provider: 'codex',
    sessionId,
    projectPath: '/repo/project',
    lastActivityAt: 1_000,
    cwd: '/repo/project',
    ...(codexTaskEvents ? { codexTaskEvents } : {}),
    ...overrides,
  }
}

function createProjects(...sessions: CodingCliSession[]): ProjectGroup[] {
  return [{ projectPath: '/repo/project', sessions }]
}

describe('CodexActivityTracker', () => {
  it('marks a resume-bound Codex terminal busy immediately when the bound snapshot is unresolved', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'resume',
      session: createSession('session-1', {
        latestTaskStartedAt: 110,
        latestTaskCompletedAt: 100,
      }),
      at: 1_000,
    })

    expect(tracker.getActivity('term-1')).toMatchObject({
      terminalId: 'term-1',
      sessionId: 'session-1',
      phase: 'busy',
      acceptedStartAt: 110,
      lastSeenTaskStartedAt: 110,
      lastSeenTaskCompletedAt: 100,
    })
    expect(tracker.isPromptBlocked('term-1')).toBe(true)
  })

  it('moves a bound Codex terminal into pending on newline input', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      lastSubmitAt: 1_100,
      pendingUntil: 1_100 + PENDING_SUBMIT_GATE_MS,
    })
    expect(tracker.isPromptBlocked('term-1')).toBe(true)
  })

  it('does not treat bracketed paste with embedded newlines as a submit', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\x1b[200~foo\nbar\x1b[201~', at: 1_100 })

    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(tracker.getActivity('term-1')?.lastSubmitAt).toBeUndefined()
    expect(tracker.getActivity('term-1')?.pendingSubmitAt).toBeUndefined()
    expect(tracker.isPromptBlocked('term-1')).toBe(false)
  })

  it('promotes pending to busy when a later task_started arrives for the bound session', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\n', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_150,
      lastSeenTaskStartedAt: 1_150,
    })
    expect(tracker.isPromptBlocked('term-1')).toBe(true)
  })

  it('keeps prompt blocking past the submit gate when a fresher snapshot still has no start or clear signal', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\n', at: 1_100 })

    expect(tracker.isPromptBlocked('term-1', 1_100 + PENDING_SUBMIT_GATE_MS + 1)).toBe(true)
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'pending' })

    tracker.reconcileProjects(
      createProjects(createSession('session-1', undefined, { lastActivityAt: 9_000 })),
      9_000,
    )

    expect(tracker.isPromptBlocked('term-1', 9_000)).toBe(true)
    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      lastSubmitAt: 1_100,
    })
    expect(tracker.isPromptBlocked('term-1', 1_100 + PENDING_SNAPSHOT_GRACE_MS + 1)).toBe(false)
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
  })

  it('promotes a submitted turn to busy when the first fresh snapshot arrives after the submit gate', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\n', at: 1_100 })

    expect(tracker.isPromptBlocked('term-1', 1_100 + PENDING_SUBMIT_GATE_MS + 1)).toBe(true)

    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
      }, { lastActivityAt: 9_000 })),
      9_000,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_150,
      lastSeenTaskStartedAt: 1_150,
    })
    expect(tracker.isPromptBlocked('term-1', 9_000)).toBe(true)
  })

  it('promotes an idle resume-bound terminal to busy when an unresolved snapshot arrives after bind', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'resume',
      session: undefined,
      at: 1_000,
    })

    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_150,
      lastSeenTaskStartedAt: 1_150,
    })
    expect(tracker.isPromptBlocked('term-1', 1_200)).toBe(true)
  })

  it('ignores newline input for unbound terminals', () => {
    const tracker = new CodexActivityTracker()

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })

    expect(tracker.getActivity('term-1')).toBeUndefined()
    expect(tracker.isPromptBlocked('term-1')).toBe(false)
  })

  it('seeds watermarks on late association after an unbound first turn without retroactively pulsing', () => {
    const tracker = new CodexActivityTracker()

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_050 })
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1', {
        latestTaskStartedAt: 1_060,
      }),
      at: 1_100,
    })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_060 })),
      1_200,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastSeenTaskStartedAt: 1_060,
    })
  })

  it('keeps a queued submit pending when an association-bound unresolved older turn clears first', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1', {
        latestTaskStartedAt: 1_060,
        latestTaskCompletedAt: 1_000,
      }),
      at: 1_100,
    })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      latentAcceptedStartAt: 1_060,
    })
    expect(tracker.getActivity('term-1')?.acceptedStartAt).toBeUndefined()
    expect(tracker.isPromptBlocked('term-1', 1_100)).toBe(false)

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_200 })
    tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_200,
      pendingUntil: 1_250 + PENDING_SUBMIT_GATE_MS,
    })
    expect(tracker.getActivity('term-1')?.latentAcceptedStartAt).toBeUndefined()
    expect(tracker.isPromptBlocked('term-1', 1_250)).toBe(true)

    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_260,
        latestTaskCompletedAt: 1_250,
      }, { lastActivityAt: 1_300 })),
      1_300,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_260,
      lastSeenTaskStartedAt: 1_260,
    })
  })

  it('clears busy immediately when BEL arrives on raw output', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_250,
    })
    expect(tracker.isPromptBlocked('term-1')).toBe(false)
  })

  it('refreshes busy liveness on ordinary output so long turns do not expire early', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )

    tracker.noteOutput({ terminalId: 'term-1', data: 'streaming...\n', at: 10_000 })
    tracker.expire(10_000 + BUSY_DEADMAN_MS - 1)

    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(tracker.isPromptBlocked('term-1', 10_000 + BUSY_DEADMAN_MS - 1)).toBe(true)

    tracker.expire(10_000 + BUSY_DEADMAN_MS + 1)

    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'unknown' })
  })

  it('refreshes pending liveness on ordinary output so long turns do not unblock after the snapshot grace', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteOutput({ terminalId: 'term-1', data: 'streaming output', at: 10_000 })

    expect(tracker.isPromptBlocked('term-1', 1_100 + PENDING_SNAPSHOT_GRACE_MS + 1)).toBe(true)
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'pending' })

    tracker.expire(10_000 + BUSY_DEADMAN_MS + 1)

    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(tracker.isPromptBlocked('term-1', 10_000 + BUSY_DEADMAN_MS + 1)).toBe(false)
  })

  it('does not downgrade a busy turn to pending when extra newline input arrives mid-turn', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })
    tracker.expire(1_300 + PENDING_SUBMIT_GATE_MS + 1)

    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(tracker.isPromptBlocked('term-1', 1_300 + PENDING_SUBMIT_GATE_MS + 1)).toBe(true)
  })

  it('preserves the earliest pending submit boundary when repeated newlines arrive before task_started is indexed', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_200 })

    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
      }, { lastActivityAt: 9_000 })),
      9_000,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_150,
      lastSubmitAt: 1_200,
    })
  })

  it('keeps a resubmitted turn pending when task_complete clears the earlier pending turn before any task_started is indexed', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_200 })

    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskCompletedAt: 1_250,
      })),
      1_250,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_200,
      lastSubmitAt: 1_200,
      pendingUntil: 1_250 + PENDING_SUBMIT_GATE_MS,
    })
    expect(tracker.isPromptBlocked('term-1', 1_250)).toBe(true)
  })

  it('keeps a later bound submit pending if the prior turn clears before the next task_started arrives', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTaskCompletedAt: 1_250,
      })),
      1_400,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      lastSubmitAt: 1_300,
      pendingUntil: 1_400 + PENDING_SUBMIT_GATE_MS,
      acceptedStartAt: undefined,
    })
    expect(tracker.isPromptBlocked('term-1', 1_400)).toBe(true)
  })

  it('keeps a queued follow-up submit pending after a long busy turn clears', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 }, { lastActivityAt: 1_200 })),
      1_200,
    )

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTaskCompletedAt: 10_000,
      }, { lastActivityAt: 10_050 })),
      10_050,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_300,
      pendingUntil: 10_050 + PENDING_SUBMIT_GATE_MS,
      acceptedStartAt: undefined,
    })
    expect(tracker.isPromptBlocked('term-1', 10_050)).toBe(true)

    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 10_060,
        latestTaskCompletedAt: 10_000,
      }, { lastActivityAt: 10_100 })),
      10_100,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 10_060,
      lastSeenTaskStartedAt: 10_060,
    })
  })

  it('consumes multiple turn-complete bells from one output chunk', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })
    tracker.noteOutput({ terminalId: 'term-1', data: '\x07\x07', at: 1_400 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_400,
    })
    expect(tracker.getActivity('term-1')?.acceptedStartAt).toBeUndefined()
    expect(tracker.getActivity('term-1')?.pendingSubmitAt).toBeUndefined()
    expect(tracker.isPromptBlocked('term-1', 1_400)).toBe(false)
  })

  it('clears a coalesced leading BEL even when prompt redraw output follows in the same chunk', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteOutput({ terminalId: 'term-1', data: '\x07$ ', at: 1_150 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_150,
    })
    expect(tracker.isPromptBlocked('term-1', 1_150)).toBe(false)
  })

  it('clears busy when the completion BEL is coalesced after the final visible output', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.noteOutput({ terminalId: 'term-1', data: 'done\x07', at: 1_250 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_250,
    })
    expect(tracker.isPromptBlocked('term-1')).toBe(false)
  })

  it('still clears when consecutive control bytes precede a leading completion BEL', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteOutput({ terminalId: 'term-1', data: '\r\n\x07$ ', at: 1_150 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_150,
    })
    expect(tracker.isPromptBlocked('term-1', 1_150)).toBe(false)
  })

  it('does not clear prompt gating when BEL is embedded in visible output content', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteOutput({ terminalId: 'term-1', data: 'partial\x07response', at: 1_150 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_100,
    })
    expect(tracker.isPromptBlocked('term-1', 1_150)).toBe(true)
  })

  it('clears busy activity when a CSI sequence is split across chunks before the completion BEL', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_120 })),
      1_150,
    )

    tracker.noteOutput({ terminalId: 'term-1', data: '\x1b[', at: 1_200 })
    tracker.noteOutput({ terminalId: 'term-1', data: '0m\x07', at: 1_250 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_250,
    })
    expect(tracker.isPromptBlocked('term-1', 1_250)).toBe(false)
  })

  it('preserves pending state across a same-session rebind and seeds the older unresolved turn as latent', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'resume',
      session: createSession('session-1', {
        latestTaskStartedAt: 1_050,
        latestTaskCompletedAt: 1_000,
      }),
      at: 1_200,
    })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_100,
      latentAcceptedStartAt: 1_050,
    })

    tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_100,
      pendingUntil: 1_250 + PENDING_SUBMIT_GATE_MS,
    })
    expect(tracker.getActivity('term-1')?.latentAcceptedStartAt).toBeUndefined()
  })

  it('clears a pending bound turn immediately when BEL arrives before task_started is indexed', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_150 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      pendingUntil: undefined,
      lastClearedAt: 1_150,
    })
    expect(tracker.isPromptBlocked('term-1', 1_150)).toBe(false)
  })

  it('clears a pending bound turn when the first indexed snapshot already includes start and completion', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_120,
        latestTaskCompletedAt: 1_140,
      })),
      1_200,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      pendingUntil: undefined,
      lastSeenTaskStartedAt: 1_120,
      lastSeenTaskCompletedAt: 1_140,
      lastClearedAt: 1_200,
    })
    expect(tracker.isPromptBlocked('term-1', 1_200)).toBe(false)
  })

  it('does not let an older clear clear a newer accepted start', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTaskCompletedAt: 1_100,
      })),
      1_200,
    )

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_315,
        latestTaskCompletedAt: 1_100,
      })),
      1_350,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_315,
        latestTaskCompletedAt: 1_312,
      })),
      1_400,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 1_315,
      lastSeenTaskCompletedAt: 1_312,
    })
    expect(tracker.isPromptBlocked('term-1', 1_400)).toBe(true)
  })

  it('keeps unknown fail-closed when later output arrives without a new exact start', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.expire(1_200 + BUSY_DEADMAN_MS + 1)

    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'unknown' })
    expect(tracker.isPromptBlocked('term-1', 1_200 + BUSY_DEADMAN_MS + 1)).toBe(false)

    tracker.noteOutput({ terminalId: 'term-1', data: 'still running...\n', at: 1_200 + BUSY_DEADMAN_MS + 2 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'unknown',
      lastObservedAt: 1_200 + BUSY_DEADMAN_MS + 1,
    })
    expect(tracker.isPromptBlocked('term-1', 1_200 + BUSY_DEADMAN_MS + 2)).toBe(false)
  })

  it('quarantines a stale accepted start when unknown resubmits enter pending', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.expire(1_200 + BUSY_DEADMAN_MS + 1)

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'unknown',
      acceptedStartAt: 1_150,
    })

    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_300,
      latentAcceptedStartAt: 1_150,
    })
    expect(tracker.getActivity('term-1')?.acceptedStartAt).toBeUndefined()

    tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_350 })

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_300,
      pendingUntil: 1_350 + PENDING_SUBMIT_GATE_MS,
    })
    expect(tracker.getActivity('term-1')?.latentAcceptedStartAt).toBeUndefined()
    expect(tracker.isPromptBlocked('term-1', 1_350)).toBe(true)
  })

  it('clears busy from task_complete when BEL is missed', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTaskCompletedAt: 1_175,
      })),
      1_300,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastSeenTaskCompletedAt: 1_175,
      lastClearedAt: 1_300,
    })
  })

  it('clears busy from turn_aborted when BEL is missed', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTurnAbortedAt: 1_180,
      })),
      1_300,
    )

    expect(tracker.getActivity('term-1')).toMatchObject({
      phase: 'idle',
      lastSeenTurnAbortedAt: 1_180,
      lastClearedAt: 1_300,
    })
  })

  it('clears state on unbind and exit, and allows a later rebind to start fresh', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.unbindTerminal({ terminalId: 'term-1', at: 1_200 })

    expect(tracker.getActivity('term-1')).toBeUndefined()

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-2',
      reason: 'association',
      session: createSession('session-2'),
      at: 1_300,
    })

    expect(tracker.getActivity('term-1')).toMatchObject({
      sessionId: 'session-2',
      phase: 'idle',
    })

    tracker.noteExit({ terminalId: 'term-1', at: 1_400 })
    expect(tracker.getActivity('term-1')).toBeUndefined()
  })

  it('marks a spontaneous exit removal so the death bell can ring, while unbind stays flag-less', () => {
    const tracker = new CodexActivityTracker()
    const changes: Array<{ upsert: unknown[]; remove: string[]; spontaneousExitRemovals?: string[] }> = []
    tracker.on('changed', (change) => changes.push(change))

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteExit({ terminalId: 'term-1', at: 1_100, spontaneous: true })
    expect(changes.at(-1)).toEqual({
      upsert: [],
      remove: ['term-1'],
      spontaneousExitRemovals: ['term-1'],
    })

    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-2',
      reason: 'association',
      session: createSession('session-2'),
      at: 1_200,
    })
    tracker.unbindTerminal({ terminalId: 'term-1', at: 1_300 })
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['term-1'] })
  })

  it('expires stale pending back to idle after the fresh-snapshot grace and stale busy to unknown', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-pending',
      sessionId: 'session-pending',
      reason: 'association',
      session: createSession('session-pending'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-pending', data: '\r', at: 1_100 })
    tracker.expire(1_100 + PENDING_SNAPSHOT_GRACE_MS + 1)

    expect(tracker.getActivity('term-pending')).toMatchObject({ phase: 'idle' })

    tracker.bindTerminal({
      terminalId: 'term-busy',
      sessionId: 'session-busy',
      reason: 'association',
      session: createSession('session-busy'),
      at: 2_000,
    })
    tracker.noteInput({ terminalId: 'term-busy', data: '\r', at: 2_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-busy', { latestTaskStartedAt: 2_150 })),
      2_200,
    )
    tracker.expire(2_200 + BUSY_DEADMAN_MS + 1)

    expect(tracker.getActivity('term-busy')).toMatchObject({ phase: 'unknown' })
    expect(tracker.isPromptBlocked('term-busy')).toBe(false)
  })

  it('keeps pending prompt blocking until a fresh snapshot or grace expiry during prompt-block checks', () => {
    const tracker = new CodexActivityTracker()

    tracker.bindTerminal({
      terminalId: 'term-pending',
      sessionId: 'session-pending',
      reason: 'association',
      session: createSession('session-pending'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-pending', data: '\r', at: 1_100 })

    expect(tracker.isPromptBlocked('term-pending', 1_100 + PENDING_SUBMIT_GATE_MS - 1)).toBe(true)
    expect(tracker.isPromptBlocked('term-pending', 1_100 + PENDING_SUBMIT_GATE_MS + 1)).toBe(true)
    expect(tracker.isPromptBlocked('term-pending', 1_100 + PENDING_SNAPSHOT_GRACE_MS + 1)).toBe(false)
    expect(tracker.getActivity('term-pending')).toMatchObject({ phase: 'idle' })
  })

  describe('turn.complete emission (server-authoritative)', () => {
    function collectCompletions(tracker: CodexActivityTracker): Array<{ terminalId: string; sessionId?: string; at: number }> {
      const events: Array<{ terminalId: string; sessionId?: string; at: number }> = []
      tracker.on('turn.complete', (e) => events.push(e))
      return events
    }

    it('emits one turn.complete when a busy turn clears via a live BEL', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })), 1_200)
      tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })

      expect(events).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_250, completionSeq: 1 }])
      expect(tracker.listLatestCompletions()).toEqual([{
        terminalId: 'term-1',
        at: 1_250,
        completionSeq: 1,
      }])
    })

    it('promotes busy from app-server turn started and clears from turn completed', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })

      tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', at: 1_100 })

      expect(tracker.getActivity('term-1')).toMatchObject({
        phase: 'busy',
        acceptedStartAt: 1_100,
        lastSeenTaskStartedAt: 1_100,
      })
      expect(tracker.isPromptBlocked('term-1')).toBe(true)

      tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', at: 1_200 })

      expect(tracker.getActivity('term-1')).toMatchObject({
        phase: 'idle',
        lastClearedAt: 1_200,
        lastSeenTaskCompletedAt: 1_200,
      })
      expect(tracker.getActivity('term-1')?.acceptedStartAt).toBeUndefined()
      expect(events).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_200, completionSeq: 1 }])
    })

    it('does not double-emit when app-server completion is followed by BEL and JSONL completion', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })

      tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', at: 1_100 })
      tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', at: 1_200 })
      tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })
      tracker.reconcileProjects(createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_100,
        latestTaskCompletedAt: 1_220,
      })), 1_300)

      expect(events).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_200, completionSeq: 1 }])
      expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    })

    it('clears a pending submit from app-server completion even when turn started was missed', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })

      tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', at: 1_200 })

      expect(tracker.getActivity('term-1')).toMatchObject({
        phase: 'idle',
        lastClearedAt: 1_200,
        lastSeenTaskCompletedAt: 1_200,
      })
      expect(events).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_200, completionSeq: 1 }])
    })

    it('does not emit completion when a no-op pending submit decays to idle', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })

      tracker.expire(1_100 + PENDING_SNAPSHOT_GRACE_MS + 1)

      expect(tracker.getActivity('term-1')).toMatchObject({
        phase: 'idle',
        pendingSubmitAt: undefined,
      })
      expect(events).toEqual([])
    })

    it('does not emit on a stray BEL while idle', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })

      expect(events).toHaveLength(0)
    })

    it('emits once when the JSONL task_complete clears a busy turn and the BEL was missed', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })), 1_200)
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_150, latestTaskCompletedAt: 1_175 })), 1_300)

      expect(events).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_300, completionSeq: 1 }])
    })

    it('does not double-emit when a live BEL clears the turn and a later reconcile sees the JSONL completion', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })), 1_200)
      tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_250 })
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_150, latestTaskCompletedAt: 1_175 })), 1_300)

      expect(events).toHaveLength(1)
    })

    it('emits exactly one completion at final idle for back-to-back queued submits (none on the re-arm)', () => {
      const tracker = new CodexActivityTracker()
      const events = collectCompletions(tracker)
      tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', session: createSession('session-1'), at: 1_000 })
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })), 1_200)
      // queue a second submit while busy
      tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_300 })
      // first turn's BEL clears turn1 but re-arms to pending (turn2 queued) → NO completion yet
      tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_400 })
      expect(events).toHaveLength(0)
      // turn2 starts, then finishes → final idle → exactly one completion
      tracker.reconcileProjects(createProjects(createSession('session-1', { latestTaskStartedAt: 1_410 })), 1_450)
      tracker.noteOutput({ terminalId: 'term-1', data: '\x07', at: 1_500 })

      expect(events).toEqual([{ terminalId: 'term-1', sessionId: 'session-1', at: 1_500, completionSeq: 1 }])
    })
  })
})

describe('thread-scoped app-server turn events (kata codex-turn-thread-scope)', () => {
  it('ignores a sub-agent thread completion mid-parent-turn (spike scenario D)', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'thread-parent',
      reason: 'association',
      session: createSession('thread-parent'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'thread-parent', turnId: 'turn-parent', at: 1_100 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })

    // Sub-agent child thread completes while the parent turn is running.
    tracker.onTurnCompleted({
      terminalId: 'term-1',
      threadId: 'thread-child',
      turnId: 'turn-child',
      status: 'completed',
      at: 1_200,
    })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(completions).toEqual([])

    // The parent's real completion still rings exactly once.
    tracker.onTurnCompleted({
      terminalId: 'term-1',
      threadId: 'thread-parent',
      turnId: 'turn-parent',
      status: 'completed',
      at: 1_300,
    })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([{ terminalId: 'term-1', sessionId: 'thread-parent', at: 1_300, completionSeq: 1 }])
  })

  it('ignores a foreign thread turn start', () => {
    const tracker = new CodexActivityTracker()
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'thread-parent',
      reason: 'association',
      session: createSession('thread-parent'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'thread-child', turnId: 'turn-c', at: 1_100 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
  })

  it('interrupted status clears busy without recording a completion', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'interrupted', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('records a completion when the bound thread turn fails', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'failed', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toHaveLength(1)
  })

  it('failed with a queued submit behaves exactly like completed with a queued submit', () => {
    const tracker1 = new CodexActivityTracker()
    const completions1: unknown[] = []
    tracker1.on('turn.complete', (event) => completions1.push(event))
    tracker1.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker1.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker1.noteInput({ terminalId: 'term-1', data: '\r', at: 1_150 })
    tracker1.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'completed', at: 1_200 })

    const tracker2 = new CodexActivityTracker()
    const completions2: unknown[] = []
    tracker2.on('turn.complete', (event) => completions2.push(event))
    tracker2.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker2.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker2.noteInput({ terminalId: 'term-1', data: '\r', at: 1_150 })
    tracker2.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'failed', at: 1_200 })

    expect(completions1).toEqual(completions2)
  })

  it('does not advance lastSeenTaskCompletedAt on interrupted or failed turns', () => {
    const tracker = new CodexActivityTracker()
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })

    // First, a completed turn sets the timestamp
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'completed', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ lastSeenTaskCompletedAt: 1_200 })

    // An interrupted turn should NOT advance the timestamp
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', at: 1_300 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', status: 'interrupted', at: 1_400 })
    expect(tracker.getActivity('term-1')).toMatchObject({ lastSeenTaskCompletedAt: 1_200 })

    // A failed turn should NOT advance the timestamp
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-3', at: 1_500 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-3', status: 'failed', at: 1_600 })
    expect(tracker.getActivity('term-1')).toMatchObject({ lastSeenTaskCompletedAt: 1_200 })

    // Another completed turn SHOULD advance the timestamp
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-4', at: 1_700 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-4', status: 'completed', at: 1_800 })
    expect(tracker.getActivity('term-1')).toMatchObject({ lastSeenTaskCompletedAt: 1_800 })
  })

  it('inProgress status is a strict no-op', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'inProgress', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(completions).toEqual([])
  })

  it('absent status still records a completion (older protocol forms)', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toHaveLength(1)
  })

  it('ignores a stale completion for a previous turn id', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', at: 1_100 })
    // Late echo for an OLDER turn while turn-2 runs: no-op by construction.
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'completed', at: 1_150 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(completions).toEqual([])
    // turn-2's real completion still rings.
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', status: 'completed', at: 1_300 })
    expect(completions).toHaveLength(1)
  })

  it('clears the in-flight turn id at accepted completion so the next turn is not swallowed', () => {
    // start turn-1, complete it (status 'completed'); start turn-2, complete
    // turn-2 — assert the second completion records (not rejected as stale).
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    // start turn-1 and complete it
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'completed', at: 1_200 })
    expect(completions).toHaveLength(1)
    // currentTurnId should have been cleared after turn-1 completed
    expect(tracker.getActivity('term-1')?.currentTurnId).toBeUndefined()
    // start turn-2 and complete it
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', at: 1_300 })
    expect(tracker.getActivity('term-1')?.currentTurnId).toBe('turn-2')
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', status: 'completed', at: 1_400 })
    // second completion should have recorded
    expect(completions).toHaveLength(2)
    // and currentTurnId should have been cleared again
    expect(tracker.getActivity('term-1')?.currentTurnId).toBeUndefined()
  })
})

describe('reconcile turn_aborted de-chime (kata codex-turn-thread-scope)', () => {
  it('turn_aborted clears busy without recording a completion', () => {
    // SEMANTIC CHANGE: shared/ws-protocol.ts terminal.idle is "never emitted
    // after crash/interrupt/exit" -- an Esc-interrupt (turn_aborted in the
    // rollout JSONL) must return the pane to idle silently.
    //
    // REFINEMENT (abortReasonIsHuman): this snapshot carries no
    // latestTurnAbortedReason (legacy line / uncertainty), which stays
    // SILENT; only a present, non-human reason rings (see tests below).
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTurnAbortedAt: 1_180,
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('a task_complete at or after an abort still records a completion', () => {
    // Tie-break: abort suppresses the chime only when STRICTLY newest.
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTaskCompletedAt: 1_180,
        latestTurnAbortedAt: 1_180,
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toHaveLength(1)
  })

  // Locked decision 2 (mirrors Rust abort_reason_is_human): reason
  // 'interrupted' or 'replaced' -> human-requested, silent; reason MISSING ->
  // legacy/uncertainty, silent; any OTHER present reason -> not
  // human-attributed, records a completion (rings). Forward-compatible: no
  // live codex writes a ring-worthy reason today.
  it('an abort with reason "interrupted" clears busy silently', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTurnAbortedAt: 1_180,
        latestTurnAbortedReason: 'interrupted',
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('an abort with reason "replaced" clears busy silently', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTurnAbortedAt: 1_180,
        latestTurnAbortedReason: 'replaced',
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('an abort with an unknown (non-human) reason records a completion', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTurnAbortedAt: 1_180,
        latestTurnAbortedReason: 'review_ended',
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toHaveLength(1)
  })
})

describe('approval pause semantics (Task 12, Node mirror of Rust Task 7)', () => {
  type Collected = {
    changes: Array<{ upsert: Array<{ phase: string }>; remove: string[] } & Record<string, unknown>>
    boundaries: Array<{ terminalId: string; at: number }>
    completions: unknown[]
  }

  function collect(tracker: CodexActivityTracker): Collected {
    const collected: Collected = { changes: [], boundaries: [], completions: [] }
    tracker.on('changed', (change) => collected.changes.push(change))
    tracker.on('attention.boundary', (event) => collected.boundaries.push(event))
    tracker.on('turn.complete', (event) => collected.completions.push(event))
    return collected
  }

  function busyUpserts(collected: Collected): unknown[] {
    return collected.changes.flatMap((change) => change.upsert.filter((record) => record.phase === 'busy'))
  }

  function bindBusy(tracker: CodexActivityTracker, reason: 'start' | 'resume' = 'start'): void {
    tracker.bindTerminal({
      terminalId: 't1',
      sessionId: 'thread-1',
      reason,
      session: createSession('thread-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 't1', threadId: 'thread-1', turnId: 'turn-1', at: 2_000 })
  }

  it('pauses busy to idle and arms an attention boundary without a turn completion', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    const collected = collect(tracker)

    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    expect(collected.changes).toHaveLength(1)
    expect(collected.changes[0]!.upsert).toEqual([expect.objectContaining({ phase: 'idle' })])
    expect(collected.boundaries).toEqual([{ terminalId: 't1', at: 3_000 }])
    expect(collected.completions).toEqual([])
  })

  it('returns to busy when the approval resolves', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })

    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 4_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'busy' })
  })

  it('stays idle on resolve when the approval arrived while already idle', () => {
    const tracker = new CodexActivityTracker()
    tracker.bindTerminal({
      terminalId: 't1',
      sessionId: 'thread-1',
      reason: 'start',
      session: createSession('thread-1'),
      at: 1_000,
    })
    const collected = collect(tracker)

    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 4_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    expect(busyUpserts(collected)).toEqual([])
  })

  it('ignores a foreign-thread approval request (sub-agent approvals must not ring the parent pane)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    const collected = collect(tracker)

    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'subagent-thread', requestId: '41', at: 3_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'busy' })
    expect(collected.changes).toEqual([])
    expect(collected.boundaries).toEqual([])
  })

  it('accepts an approval request without a threadId (the proxy is per-terminal)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    const collected = collect(tracker)

    tracker.onApprovalRequested({ terminalId: 't1', requestId: '41', at: 3_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    expect(collected.boundaries).toEqual([{ terminalId: 't1', at: 3_000 }])
  })

  it('does not let a queued submit block the approval boundary (still blocked on a human)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.noteInput({ terminalId: 't1', data: 'queued message\r', at: 2_500 })
    const collected = collect(tracker)

    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })

    expect(collected.boundaries).toEqual([{ terminalId: 't1', at: 3_000 }])
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
  })

  it('clears pending approvals at turn completion so a late resolve is a no-op', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    tracker.onTurnCompleted({
      terminalId: 't1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      at: 5_000,
    })
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    const collected = collect(tracker)

    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 6_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    expect(collected.changes).toEqual([])
  })

  // The next three tests attach the completion collector BEFORE
  // onTurnCompleted (the test above attaches it after, which masked the
  // mid-pause double-ring): a completion arriving while the approval pause
  // holds the phase at idle must be a SILENT claim -- the approval bell
  // already covers this attention event, and the surviving anchors must not
  // let a later PTY BEL echo re-mint the same physical turn.
  it('a turn completing mid-pause records nothing (status completed)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    const collected = collect(tracker)

    tracker.onTurnCompleted({
      terminalId: 't1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      at: 5_000,
    })

    expect(collected.completions).toEqual([])
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
  })

  it('a turn completing mid-pause records nothing (status failed)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    const collected = collect(tracker)

    tracker.onTurnCompleted({
      terminalId: 't1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'failed',
      at: 5_000,
    })

    expect(collected.completions).toEqual([])
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
  })

  it('a BEL echo after a mid-pause turn end mints nothing (anchors are claimed)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    const collected = collect(tracker)

    tracker.onTurnCompleted({
      terminalId: 't1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      at: 5_000,
    })
    expect(tracker.getActivity('t1')?.acceptedStartAt).toBeUndefined()
    expect(tracker.getActivity('t1')?.pendingSubmitAt).toBeUndefined()

    // The codex TUI's turn-complete BEL echo of that same physical turn.
    tracker.noteOutput({ terminalId: 't1', data: '\u0007', at: 5_100 })

    expect(collected.completions).toEqual([])
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
  })

  it('a duplicate approval request frame does not re-arm the boundary', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    const collected = collect(tracker)

    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_500 })

    expect(collected.boundaries).toEqual([{ terminalId: 't1', at: 3_000 }])
  })

  it('reconcile task_started landing mid-pause folds anchors without flipping busy (audit A9)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker, 'resume')
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    const collected = collect(tracker)

    tracker.reconcileProjects(
      createProjects(createSession('thread-1', { latestTaskStartedAt: 3_500 })),
      3_500,
    )

    expect(busyUpserts(collected)).toEqual([])
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle', acceptedStartAt: 3_500 })

    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 4_000 })
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'busy' })
  })

  it('a resume re-announce mid-pause does not promote idle to busy (audit A9)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    const collected = collect(tracker)

    tracker.bindTerminal({
      terminalId: 't1',
      sessionId: 'thread-1',
      reason: 'resume',
      session: createSession('thread-1', { latestTaskStartedAt: 2_000 }),
      at: 3_500,
    })

    expect(busyUpserts(collected)).toEqual([])
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })

    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 4_000 })
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'busy' })
  })

  it('resolve normalizes pending-submit input state planted by a mid-pause Enter (audit A9 hazard 2)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 3_500 }) // answering the approval prompt
    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 4_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'busy' })
    expect(tracker.getActivity('t1')?.pendingSubmitAt).toBeUndefined()
    expect(tracker.getActivity('t1')?.pendingUntil).toBeUndefined()
    expect(tracker.getActivity('t1')?.pendingFreshnessAt).toBeUndefined()

    const collected = collect(tracker)
    tracker.onTurnCompleted({
      terminalId: 't1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      at: 6_000,
    })

    expect(collected.completions).toHaveLength(1)
    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    const pendingUpserts = collected.changes.flatMap((change) =>
      change.upsert.filter((record) => record.phase === 'pending'))
    expect(pendingUpserts).toEqual([])
  })

  it('rebinding to a different thread drops the pause state', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })

    tracker.bindTerminal({
      terminalId: 't1',
      sessionId: 'thread-2',
      reason: 'resume',
      session: createSession('thread-2'),
      at: 4_000,
    })
    const collected = collect(tracker)

    tracker.onApprovalResolved({ terminalId: 't1', requestId: '41', at: 5_000 })

    expect(tracker.getActivity('t1')).toMatchObject({ phase: 'idle' })
    expect(collected.changes).toEqual([])
  })

  it('a removal with a non-empty pending-approval set carries approvalPendingRemovals (decision 3)', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    tracker.onApprovalRequested({ terminalId: 't1', threadId: 'thread-1', requestId: '41', at: 3_000 })
    const collected = collect(tracker)

    tracker.noteExit({ terminalId: 't1', at: 5_000, spontaneous: true })

    expect(collected.changes).toEqual([{
      upsert: [],
      remove: ['t1'],
      spontaneousExitRemovals: ['t1'],
      approvalPendingRemovals: ['t1'],
    }])
  })

  it('a removal without pending approvals omits approvalPendingRemovals', () => {
    const tracker = new CodexActivityTracker()
    bindBusy(tracker)
    const collected = collect(tracker)

    tracker.noteExit({ terminalId: 't1', at: 5_000, spontaneous: true })

    expect(collected.changes).toEqual([{
      upsert: [],
      remove: ['t1'],
      spontaneousExitRemovals: ['t1'],
    }])
  })
})
