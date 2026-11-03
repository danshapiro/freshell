import { describe, expect, it } from 'vitest'
import { analyzeFreshAgentAttachRounds } from '../../e2e-browser/helpers/fresh-agent-attach-rounds.js'

const target = {
  sessionId: 'ses-shared',
  provider: 'claude',
  sessionType: 'freshclaude',
  viewId: 'view-target',
  tabId: 'tab-target',
  paneId: 'pane-target',
}

const attach = (epoch: number | null, generation: number | null, overrides: Record<string, unknown> = {}) => ({
  direction: 'sent',
  type: 'freshAgent.attach',
  sessionId: target.sessionId,
  provider: target.provider,
  sessionType: target.sessionType,
  viewId: target.viewId,
  tabId: target.tabId,
  paneId: target.paneId,
  ...(epoch === null ? {} : { observedEpoch: epoch }),
  ...(generation === null ? {} : { observedGeneration: generation }),
  ...overrides,
})

const ready = (bootId = 'boot-one') => ({
  direction: 'received',
  type: 'ready',
  bootId,
  serverInstanceId: 'server-one',
})

const request = (reconcileId = 'reconcile-one', panes = [targetPane()]) => ({
  direction: 'sent',
  type: 'pane.reconcile.request',
  reconcileId,
  panes,
})

const targetPane = () => ({
  paneKey: `${target.tabId}:${target.paneId}`,
  kind: 'fresh-agent',
  mode: target.provider,
  createRequestId: 'create-target',
  sessionRef: { provider: target.provider, sessionId: target.sessionId },
})

const created = (overrides: Record<string, unknown> = {}) => ({
  direction: 'received',
  type: 'freshAgent.created',
  requestId: 'create-target',
  viewId: target.viewId,
  sessionId: target.sessionId,
  sessionType: target.sessionType,
  provider: target.provider,
  runtimeProvider: 'claude',
  sessionRef: { provider: target.provider, sessionId: target.sessionId },
  ...overrides,
})

const committedOwner = (overrides: Record<string, unknown> = {}) => ({
  direction: 'received',
  type: 'session.runtimeOwner',
  provider: target.provider,
  sessionId: target.sessionId,
  epoch: 2,
  generation: 1,
  ownerKind: 'fresh-agent',
  operationId: 'recovery-operation',
  transition: 'handoff-committed',
  ...overrides,
})

const result = (
  reconcileId = 'reconcile-one',
  verdict = 'attach',
  overrides: Record<string, unknown> = {},
) => ({
  direction: 'received',
  type: 'pane.reconcile.result',
  reconcileId,
  bootId: 'boot-one',
  serverInstanceId: 'server-one',
  verdicts: [{ paneKey: `${target.tabId}:${target.paneId}`, verdict,
    sessionRef: { provider: target.provider, sessionId: target.sessionId } }],
  ...overrides,
})

describe('analyzeFreshAgentAttachRounds', () => {
  it('detects duplicate sends within one ready round but allows a same-fence later round', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(1, 1),
      attach(1, 1),
      request(),
      result(),
      attach(1, 1),
      ready(),
      attach(1, 1),
    ], target)

    expect(analysis.rounds.map((round) => ({
      kind: round.kind,
      bootId: round.bootId,
      reconcileId: round.reconcileId,
      attachments: round.attachments.length,
      duplicates: round.duplicateAttachments.length,
    }))).toEqual([
      { kind: 'ready', bootId: 'boot-one', reconcileId: undefined, attachments: 2, duplicates: 1 },
      { kind: 'reconcile', bootId: 'boot-one', reconcileId: 'reconcile-one', attachments: 1, duplicates: 0 },
      { kind: 'ready', bootId: 'boot-one', reconcileId: undefined, attachments: 1, duplicates: 0 },
    ])
    expect(analysis.rounds[0].attachments[0]).toMatchObject({
      observedEpoch: 1,
      observedGeneration: 1,
    })
    expect(analysis.validReconcileRoundIds).toEqual(['reconcile-one'])
  })

  it('preserves an unfenced bootstrap separately from the later authoritative fence', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(null, null),
      request(),
      result(),
      attach(2, 1),
    ], target)

    expect(analysis.rounds.map((round) => round.attachments.map((item) => [
      item.observedEpoch,
      item.observedGeneration,
    ]))).toEqual([[[null, null]], [[2, 1]]])
  })

  it('allows one null-to-fenced respawn upgrade after the matching create and committed owner', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      created(),
      committedOwner(),
      attach(2, 1),
      attach(2, 1),
    ], target)

    expect(analysis.rounds).toHaveLength(2)
    expect(analysis.rounds[1]).toMatchObject({
      kind: 'reconcile',
      targetVerdict: 'respawn',
      attachments: [
        { observedEpoch: null, observedGeneration: null },
        { observedEpoch: 2, observedGeneration: 1 },
        { observedEpoch: 2, observedGeneration: 1 },
      ],
      duplicateAttachments: [{ observedEpoch: 2, observedGeneration: 1 }],
    })
  })

  it.each([
    ['created', 'bootstrap', 'owner'],
    ['owner', 'bootstrap', 'created'],
    ['created', 'owner', 'bootstrap'],
  ])('accepts respawn authority around a queued bootstrap in wire order %s / %s / %s', (...order) => {
    const frames: Record<string, Record<string, unknown>> = {
      created: created(), owner: committedOwner(), bootstrap: attach(null, null),
    }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), request(), result('reconcile-one', 'respawn'),
      ...order.map((step) => frames[step]),
      attach(2, 1), attach(2, 1),
    ], target)
    expect(analysis.rounds[1].attachments).toHaveLength(3)
    expect(analysis.rounds[1].duplicateAttachments).toEqual([analysis.rounds[1].attachments[2]])
  })

  it.each([
    { created: false },
    { created: true, createOverrides: { viewId: 'other-view' } },
    { created: true, createOverrides: { requestId: 'other-create' } },
    { created: true, createOverrides: { sessionId: 'other-session' } },
    { created: true, createOverrides: { sessionRef: { provider: target.provider, sessionId: 'other-session' } } },
    { created: true, createOverrides: { sessionRef: null } },
    { created: true, ownerOverrides: { operationId: '' } },
    { created: true, ownerOverrides: { epoch: 3 } },
    { created: true, ownerOverrides: { ownerKind: 'terminal' } },
  ])('keeps a respawn fence upgrade duplicate without exact create/owner authority: %j', (options) => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      ...(options.created ? [created(options.createOverrides)] : []),
      committedOwner(options.ownerOverrides),
      attach(2, 1),
    ], target)

    expect(analysis.rounds[1].attachments).toHaveLength(2)
    expect(analysis.rounds[1].duplicateAttachments).toEqual([analysis.rounds[1].attachments[1]])
  })

  it('does not hide a repeated null bootstrap when later respawn authority arrives', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      attach(null, null),
      created(),
      committedOwner(),
      attach(2, 1),
    ], target)

    expect(analysis.rounds[1].duplicateAttachments).toEqual([
      analysis.rounds[1].attachments[1],
      analysis.rounds[1].attachments[2],
    ])
  })

  it('requires a respawn verdict and create/owner authority within that round for the fence upgrade', () => {
    const attachVerdict = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'attach'),
      attach(null, null),
      created(),
      committedOwner(),
      attach(2, 1),
    ], target)
    const ownerWithoutCreated = committedOwner()
    const respawnWithoutCreated = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      { ...ownerWithoutCreated, transition: 'handoff-started' },
      ownerWithoutCreated,
      attach(2, 1),
    ], target)
    const earlyAuthority = analyzeFreshAgentAttachRounds([
      ready(),
      request(),
      created(),
      committedOwner(),
      result('reconcile-one', 'respawn'),
      attach(null, null),
      attach(2, 1),
    ], target)

    expect(attachVerdict.rounds[1].duplicateAttachments).toEqual([attachVerdict.rounds[1].attachments[1]])
    expect(respawnWithoutCreated.rounds[1].duplicateAttachments).toEqual([
      respawnWithoutCreated.rounds[1].attachments[1],
    ])
    expect(earlyAuthority.rounds[1].duplicateAttachments).toEqual([earlyAuthority.rounds[1].attachments[1]])
  })

  it.each([1, 2])('allows one fenced rearm after the exact target Starting owner becomes Live (%i announcements)', (announcements) => {
    const owner = { direction: 'received', type: 'session.runtimeOwner',
      provider: target.provider, sessionId: target.sessionId, epoch: 2, generation: 1,
      ownerKind: 'fresh-agent', operationId: 'recovered-owner' }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(null, null),
      { ...owner, transition: 'handoff-started' },
      ...Array.from({ length: announcements }, () => ({ ...owner, transition: 'handoff-committed' })),
      attach(2, 1),
      attach(2, 1),
    ], target)

    expect(analysis.rounds).toHaveLength(1)
    expect(analysis.rounds[0].attachments).toHaveLength(3)
    expect(analysis.rounds[0].duplicateAttachments).toEqual([analysis.rounds[0].attachments[2]])
  })

  it.each([
    { sessionId: 'foreign-session' },
    { provider: 'foreign-provider' },
    { generation: 2 },
    { ownerKind: 'terminal' },
  ])('does not authorize a fenced rearm from another owner transition: %j', (overrides) => {
    const owner = { direction: 'received', type: 'session.runtimeOwner',
      provider: target.provider, sessionId: target.sessionId, epoch: 2, generation: 1,
      ownerKind: 'fresh-agent', operationId: 'recovered-owner', ...overrides }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), attach(null, null),
      { ...owner, transition: 'handoff-started' },
      { ...owner, transition: 'handoff-committed' },
      attach(2, 1),
    ], target)
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it('rejects malformed reconcile requests and result fields as authorization', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), attach(2, 1),
      { ...request('bad-request'), panes: [{ ...targetPane(), createRequestId: undefined }] },
      result('bad-request'),
      request('bad-result'),
      result('bad-result', 'attach', {
        verdicts: [{ paneKey: `${target.tabId}:${target.paneId}`, verdict: 'attach', reason: 7,
          sessionRef: { provider: target.provider, sessionId: target.sessionId } }],
      }),
      attach(2, 1),
    ], target)
    expect(analysis.validReconcileRoundIds).toEqual([])
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it.each([
    undefined,
    { provider: target.provider, sessionId: 'foreign-session' },
    { provider: 'foreign-provider', sessionId: target.sessionId },
  ])('does not grant an attach round without the target result identity: %j', (sessionRef) => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(), attach(2, 1), request(),
      result('reconcile-one', 'attach', {
        verdicts: [{ paneKey: `${target.tabId}:${target.paneId}`, verdict: 'attach', sessionRef }],
      }),
      attach(2, 1),
    ], target)
    expect(analysis.validReconcileRoundIds).toEqual([])
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it.each(['attach', 'respawn', 'fresh'] as const)(
    'retains an empty authorization round for a positive %s verdict',
    (verdict) => {
      const analysis = analyzeFreshAgentAttachRounds([
        ready(),
        request(),
        result('reconcile-one', verdict),
      ], target)

      expect(analysis.rounds.map((round) => ({
        kind: round.kind,
        targetVerdict: round.targetVerdict,
        attachments: round.attachments,
      }))).toEqual([
        { kind: 'ready', targetVerdict: undefined, attachments: [] },
        { kind: 'reconcile', targetVerdict: verdict, attachments: [] },
      ])
    },
  )

  it('requires a correlated, complete, positive target verdict before opening a reconcile round', () => {
    const otherPane = { ...targetPane(), paneKey: 'other-tab:other-pane' }
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      request('wrong-key', [otherPane]),
      result('wrong-key', 'attach', {
        verdicts: [{ paneKey: otherPane.paneKey, verdict: 'attach' }],
      }),
      request('bad-cardinality'),
      result('bad-cardinality', 'attach', { verdicts: [] }),
      request('mismatched-result'),
      result('foreign-result-id'),
      request('negative-target'),
      result('negative-target', 'error'),
      attach(2, 1),
      attach(2, 1),
    ], target)

    expect(analysis.validReconcileRoundIds).toEqual([])
    expect(analysis.rounds).toHaveLength(1)
    expect(analysis.rounds[0].attachments).toHaveLength(2)
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(1)
  })

  it('allows one same-fence retry after a target SESSION_RESERVED response only', () => {
    const reserved = (overrides: Record<string, unknown> = {}) => ({
      direction: 'received',
      type: 'freshAgent.event',
      sessionId: target.sessionId,
      provider: target.provider,
      sessionType: target.sessionType,
      event: { type: 'freshAgent.error', code: 'SESSION_RESERVED', ...overrides },
    })
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(null, null),
      reserved({ requestId: 'create-request' }),
      attach(null, null),
      reserved(),
      attach(null, null),
      reserved({ viewId: 'other-view' }),
      attach(null, null),
    ], target)

    expect(analysis.rounds).toHaveLength(1)
    expect(analysis.rounds[0].attachments.map((item) => item.retryAfterSessionReserved)).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(analysis.rounds[0].duplicateAttachments).toEqual([
      analysis.rounds[0].attachments[1],
      analysis.rounds[0].attachments[3],
    ])
  })

  it('does not let SESSION_RESERVED authorize a retry with a changed captured fence', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(2, 1),
      {
        direction: 'received',
        type: 'freshAgent.event',
        sessionId: target.sessionId,
        provider: target.provider,
        sessionType: target.sessionType,
        event: { type: 'freshAgent.error', code: 'SESSION_RESERVED' },
      },
      attach(2, 2),
    ], target)

    expect(analysis.rounds[0].attachments.map((item) => item.retryAfterSessionReserved)).toEqual([false, false])
    expect(analysis.rounds[0].duplicateAttachments).toEqual([analysis.rounds[0].attachments[1]])
  })

  it('ignores attach frames and reservation responses for another session or pane', () => {
    const analysis = analyzeFreshAgentAttachRounds([
      ready(),
      attach(2, 1, { viewId: 'other-view' }),
      attach(2, 1, { provider: 'opencode' }),
      {
        direction: 'received',
        type: 'freshAgent.event',
        sessionId: 'ses-other',
        provider: target.provider,
        sessionType: target.sessionType,
        event: { type: 'freshAgent.error', code: 'SESSION_RESERVED' },
      },
      attach(2, 1),
    ], target)

    expect(analysis.rounds[0].attachments).toHaveLength(1)
    expect(analysis.rounds[0].attachments[0].viewId).toBe(target.viewId)
    expect(analysis.rounds[0].duplicateAttachments).toHaveLength(0)
  })
})
