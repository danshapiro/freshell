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
})
