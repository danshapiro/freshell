import { describe, it, expect, vi } from 'vitest'
import { buildRecoveryPlan, countRecoverablePanes } from '@/lib/recovery/build-recovery-plan'
import type { RecoveryInventory } from '@/lib/recovery/types'

vi.mock('nanoid', () => { let n = 0; return { nanoid: () => `nid-${++n}` } })

const pane = (over: Partial<RecoveryInventory['device']['tabs'][0]['panes'][0]> = {}) => ({
  paneId: 'p1', kind: 'terminal', mode: 'shell', shell: null, cwd: '/w',
  payload: {}, sessionRef: null, ledgerState: 'unknown' as const, live: false, ...over,
})
const inv = (panes: unknown[], ledgerOnly: unknown[] = []): RecoveryInventory => ({
  recoverable: true, contentId: 'cid',
  device: { deviceId: 'd', deviceLabel: 'l', capturedAt: 1, tabs: [{ tabKey: 'k', tabName: 'work', panes }] },
  otherDevices: [], ledgerOnly,
} as RecoveryInventory)

const leavesOf = (node: any): any[] =>
  !node ? [] : node.type === 'leaf' ? [node] : (node.children ?? []).flatMap(leavesOf)

describe('buildRecoveryPlan', () => {
  it('single terminal pane -> one tab, leaf layout, cwd + mode carried', () => {
    const [tab] = buildRecoveryPlan(inv([pane()]))
    expect(tab.title).toBe('work')
    expect(tab.layout.type).toBe('leaf')
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'terminal', mode: 'shell', initialCwd: '/w' })
    expect(content.sessionRef).toBeUndefined()
  })

  it('ledger-corrected sessionRef is used verbatim (authority chain applied server-side)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ sessionRef: { provider: 'claude', sessionId: 'S2' }, ledgerState: 'bound', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toEqual({ provider: 'claude', sessionId: 'S2' })
  })

  // Delta-r6 F1 (closed verdicts are NOT restorable): the server's correlation
  // work marks a pane whose session was closed between the last registry push
  // and the browser-state loss with `ledgerState: "closed"` and a null
  // effective sessionRef. Such a pane must be EXCLUDED from the plan, the
  // advertised count, and the offer listing — accepting the offer restores
  // exactly the sessions that were genuinely open. (The pre-fix behavior
  // rebuilt a closed pane fresh — a never-open replacement session.)
  it('a closed-verdict pane is EXCLUDED from the plan and the count', () => {
    const inventory = inv([
      pane(),
      pane({ paneId: 'p2', ledgerState: 'closed', mode: 'claude' }),
    ])
    const [tab] = buildRecoveryPlan(inventory)
    const contents = leavesOf(tab.layout).map((l) => l.content)
    expect(contents).toHaveLength(1)
    expect(contents[0]).toMatchObject({ kind: 'terminal', mode: 'shell', initialCwd: '/w' })
    expect(countRecoverablePanes(inventory)).toBe(1)
  })

  it('a tab whose every snapshot pane is closed produces NO plan (never an empty chain) and no count', () => {
    const inventory = inv([pane({ ledgerState: 'closed', mode: 'claude' })])
    expect(buildRecoveryPlan(inventory)).toHaveLength(0)
    expect(countRecoverablePanes(inventory)).toBe(0)
  })

  // F1, the payload-divergence arm: a closed fresh-agent pane whose untouched
  // snapshot payload still carries the stale sessionRef must never reclaim the
  // killed session — the pane is excluded wholesale (the null top-level
  // verdict ref is never overridden by the payload copy).
  it('a closed fresh-agent pane is excluded even though its payload still carries the stale sessionRef', () => {
    const inventory = inv([
      pane(),
      pane({
        paneId: 'p2',
        kind: 'fresh-agent',
        mode: null,
        payload: {
          sessionType: 'freshclaude',
          provider: 'claude',
          sessionRef: { provider: 'claude', sessionId: 'KILLED' },
        },
        sessionRef: null,
        ledgerState: 'closed',
      }),
    ])
    const [tab] = buildRecoveryPlan(inventory)
    const contents = leavesOf(tab.layout).map((l) => l.content)
    expect(contents).toHaveLength(1)
    expect(contents.every((c) => c.kind !== 'fresh-agent')).toBe(true)
    expect(countRecoverablePanes(inventory)).toBe(1)
  })

  // The "plain un-correlated panes unchanged" guarantee (F1's scope bound): a
  // pane with NO snapshot claim and NO correlation verdict (ledgerState
  // "unknown", null ref) still rebuilds fresh with cwd/mode and no resume
  // sessionRef — the pre-fix "come back fresh" behavior lives HERE, not on
  // closed verdicts.
  it('plain un-correlated panes (unknown verdict, no claim) still come back fresh: no sessionRef, same cwd/mode', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ ledgerState: 'unknown', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toBeUndefined()
    expect(content).toMatchObject({ mode: 'claude', initialCwd: '/w' })
  })

  // Delta-r6 F2 (server-authoritative verdicts beat the stale payload copy):
  // the server deliberately leaves the snapshot payload untouched and puts
  // the D4-corrected identity at the TOP level — a superseded pane's payload
  // sessionRef names the OLD session while the top-level ref names the
  // corrected successor. The fresh-agent reconstruction must resume the
  // top-level ref (FreshAgentView sends content.sessionRef in
  // freshAgent.create) — never the payload's stale one.
  it('a superseded fresh-agent pane resumes the TOP-LEVEL corrected sessionRef, not the payload copy', () => {
    const [tab] = buildRecoveryPlan(inv([pane({
      kind: 'fresh-agent',
      mode: null,
      payload: {
        sessionType: 'freshclaude',
        provider: 'claude',
        initialCwd: '/proj',
        sessionRef: { provider: 'claude', sessionId: 'OLD' },
      },
      sessionRef: { provider: 'claude', sessionId: 'S2' },
      ledgerState: 'bound',
    })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionRef: { provider: 'claude', sessionId: 'S2' },
      initialCwd: '/proj',
    })
  })

  // F2, the no-divergence control: a fresh-agent pane whose verdict simply
  // confirms the claim restores with that (identical) ref — authority and
  // payload agree, behavior matches the pre-fix shape.
  it('a fresh-agent pane whose top-level verdict ref matches the payload restores with it (no divergence)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({
      kind: 'fresh-agent',
      mode: null,
      payload: {
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses_1' },
      },
      sessionRef: { provider: 'opencode', sessionId: 'ses_1' },
      ledgerState: 'bound',
    })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({
      kind: 'fresh-agent',
      sessionRef: { provider: 'opencode', sessionId: 'ses_1' },
    })
  })

  // F2, the live arm: the top-level `live` verdict marks a fresh-agent pane
  // whose session is still running on the server (D7) — restoring it would
  // RESUME the live session. Non-restorable: excluded from the plan and the
  // count, exactly like a closed verdict. (Live TERMINAL panes keep the D7
  // behavior — recreated fresh without the resume ref — pinned by the
  // dedicated test below.)
  it('a LIVE fresh-agent pane is EXCLUDED from the plan and the count (never resumed mid-flight)', () => {
    const inventory = inv([
      pane(),
      pane({
        paneId: 'p2',
        kind: 'fresh-agent',
        mode: null,
        payload: {
          sessionType: 'freshclaude',
          provider: 'claude',
          sessionRef: { provider: 'claude', sessionId: 'LIVE' },
        },
        sessionRef: { provider: 'claude', sessionId: 'LIVE' },
        ledgerState: 'bound',
        live: true,
      }),
    ])
    const [tab] = buildRecoveryPlan(inventory)
    const contents = leavesOf(tab.layout).map((l) => l.content)
    expect(contents).toHaveLength(1)
    expect(contents.every((c) => c.kind !== 'fresh-agent')).toBe(true)
    expect(countRecoverablePanes(inventory)).toBe(1)
  })

  it('three panes -> right-leaning binary split chain', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ paneId: 'a' }), pane({ paneId: 'b' }), pane({ paneId: 'c' })]))
    expect(tab.layout.type).toBe('split')
    const root = tab.layout as { children: [{ type: string }, { type: string }] }
    expect(root.children[0].type).toBe('leaf')
    expect(root.children[1].type).toBe('split')
  })

  it('live panes are recreated WITHOUT resume: sessionRef stripped, cwd/mode kept (D7)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ sessionRef: { provider: 'claude', sessionId: 'S2' }, ledgerState: 'bound', mode: 'claude', live: true })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toBeUndefined()
    expect(content).toMatchObject({ kind: 'terminal', mode: 'claude', initialCwd: '/w' })
  })

  it('non-terminal kinds pass payload through', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'browser', payload: { url: 'https://x.test' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'browser', url: 'https://x.test' })
  })

  it('editor panes get the required content default (buffer text is never captured)', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'editor', payload: { filePath: '/f.txt' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ kind: 'editor', filePath: '/f.txt', content: '' })
  })

  it('fresh-agent restoreError is stripped so normalize keeps the sessionRef', () => {
    // Delta-r6 F2: the effective ref lives at the TOP level (the payload's
    // copy is ignored); the fixture carries the agree-on-both-sides real
    // shape (a payload restoreError arriving with a "bound" verdict).
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'fresh-agent',
      payload: { sessionType: 'freshclaude', provider: 'claude', sessionRef: { provider: 'claude', sessionId: 'F1' }, restoreError: 'stale' },
      sessionRef: { provider: 'claude', sessionId: 'F1' }, ledgerState: 'bound', mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.restoreError).toBeUndefined()
    expect(content).toMatchObject({ kind: 'fresh-agent', sessionRef: { provider: 'claude', sessionId: 'F1' } })
  })

  it('extension and picker payloads pass through', () => {
    const [tab] = buildRecoveryPlan(inv([
      pane({ paneId: 'x1', kind: 'extension', payload: { extensionId: 'ext.foo' }, mode: null, cwd: null }),
      pane({ paneId: 'x2', kind: 'picker', payload: {}, mode: null, cwd: null }),
    ]))
    const root = tab.layout as { children: [{ content: Record<string, unknown> }, { content: Record<string, unknown> }] }
    expect(root.children[0].content).toMatchObject({ kind: 'extension', extensionId: 'ext.foo' })
    expect(root.children[1].content).toMatchObject({ kind: 'picker' })
  })

  // Missing-tabKey pin (D8, delta-r2 Finding 3): a stamp-less row (pre-upgrade
  // or a straggler the server's placement clause should have excluded) has no
  // join target, so it is NOT placed anywhere — the client must not resurrect
  // the trailing-tab pattern for stamp-less/mismatched leftovers.
  it('ledgerOnly entries without a stamped tabKey are NOT placed (no trailing tab)', () => {
    const plans = buildRecoveryPlan(inv([pane()], [{ provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x' }]))
    expect(plans).toHaveLength(1)
    expect(plans[0].title).toBe('work')
    expect(leavesOf(plans[0].layout)).toHaveLength(1)
    // The unplaced row restores nowhere — closest thing to it is absent.
    const allLeafContents = plans.flatMap((p) => leavesOf(p.layout).map((l) => l.content))
    expect(allLeafContents.every((c) => (c as { sessionRef?: { sessionId: string } }).sessionRef?.sessionId !== 'C9')).toBe(true)
  })

  it('a ledgerOnly row whose tabKey matches a restored tab joins that tab (rightmost leaf), no trailing tab', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'claude', sessionId: 'S9', mode: 'claude', cwd: '/j', tabKey: 'k' },
    ]))
    expect(plans).toHaveLength(1)
    expect(plans[0].title).toBe('work')
    expect(plans[0].sourceTabKey).toBe('k')
    const contents = leavesOf(plans[0].layout).map((l) => l.content)
    expect(contents).toHaveLength(2)
    // Snapshot panes first; the joined row lands rightmost in the existing chain.
    expect(contents[0]).toMatchObject({ kind: 'terminal', mode: 'shell', initialCwd: '/w' })
    expect(contents[1]).toMatchObject({
      kind: 'terminal', mode: 'claude', initialCwd: '/j',
      sessionRef: { provider: 'claude', sessionId: 'S9' },
    })
  })

  it('a ledgerOnly row whose tabKey matches no restored tab is NOT placed (no trailing tab)', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x', tabKey: 'd:t-gone' },
    ]))
    expect(plans).toHaveLength(1)
    const leaves = leavesOf(plans[0].layout)
    expect(leaves).toHaveLength(1)
    // The unmatched row joins nothing and produces no extra tab.
    const allLeafContents = plans.flatMap((p) => leavesOf(p.layout).map((l) => l.content))
    expect(allLeafContents.every((c) => (c as { sessionRef?: { sessionId: string } }).sessionRef?.sessionId !== 'C9')).toBe(true)
  })

  it('a tabKey naming a tab with no snapshot panes is NOT placed (no plan exists for it)', () => {
    const inventory = inv([pane()], [
      { provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x', tabKey: 'k-empty' },
    ])
    inventory.device!.tabs.push({ tabKey: 'k-empty', tabName: 'empty', panes: [] })
    const plans = buildRecoveryPlan(inventory)
    expect(plans).toHaveLength(1)
    expect(plans[0].title).toBe('work')
    expect(leavesOf(plans[0].layout)).toHaveLength(1)
  })

  it('a mixed cohort joins the matched row and leaves the unmatched one unplaced (single device plan, no trailing tab)', () => {
    const plans = buildRecoveryPlan(inv([pane(), pane({ paneId: 'p2' })], [
      { provider: 'claude', sessionId: 'S9', mode: 'claude', cwd: '/j', tabKey: 'k' },
      { provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x', tabKey: 'd:t-gone' },
    ]))
    expect(plans).toHaveLength(1)
    expect(plans[0].title).toBe('work')
    const deviceContents = leavesOf(plans[0].layout).map((l) => l.content)
    expect(deviceContents).toHaveLength(3)
    expect(deviceContents[2]).toMatchObject({ sessionRef: { provider: 'claude', sessionId: 'S9' } })
    // The unmatched codex row restores nowhere.
    expect(deviceContents.every((c) => (c as { sessionRef?: { sessionId: string } }).sessionRef?.sessionId !== 'C9')).toBe(true)
  })

  // Finding 2 (delta-r1): a kept fresh-agent ledger row must restore as a
  // fresh-agent pane RESUME (the FreshAgentView create effect drives the
  // sessionRef resume from the content) — never as a terminal shell: the
  // row's mode is a fresh-agent session type ("freshopencode"), not a
  // terminal CLI mode, so packaging it as terminalContent silently spawns a
  // bare shell in place of the agent pane.
  it('a ledgerOnly fresh-agent row restores as a resume-capable fresh-agent pane, not a shell', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'opencode', sessionId: 'ses_123', mode: 'freshopencode', cwd: '/proj', tabKey: 'k', paneKind: 'fresh-agent' },
    ]))
    expect(plans).toHaveLength(1)
    const contents = leavesOf(plans[0].layout).map((l) => l.content)
    expect(contents).toHaveLength(2)
    const entryContent = contents[1]
    expect(entryContent.kind).toBe('fresh-agent')
    expect(entryContent).toMatchObject({
      sessionType: 'freshopencode',
      provider: 'opencode',
      status: 'creating',
      initialCwd: '/proj',
      sessionRef: { provider: 'opencode', sessionId: 'ses_123' },
    })
    expect(typeof entryContent.createRequestId).toBe('string')
    // Never a faux terminal: no terminal-only fields on the fresh-agent leaf.
    expect(entryContent.mode).toBeUndefined()
    expect(entryContent.shell).toBeUndefined()
  })

  // Focused-ep1 Finding B: a kept fresh-agent ledger row's RECORDED settings
  // must ride the resume — the rebuilt pane carries its ORIGINAL
  // model/effort/sandbox/permissionMode (the FreshAgentView create effect
  // sends them with the sessionRef resume) instead of silently adopting
  // CURRENT defaults (freshcodex would otherwise deterministically resume as
  // gpt-5.5/max).
  it('a ledgerOnly fresh-agent row with recorded settings restores content carrying them', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'codex', sessionId: 'thr_42', mode: 'freshcodex', cwd: '/proj', tabKey: 'k',
        paneKind: 'fresh-agent', model: 'gpt-5.3-codex', effort: 'high',
        sandbox: 'workspace-write', permissionMode: 'on-request' },
    ]))
    expect(plans).toHaveLength(1)
    const contents = leavesOf(plans[0].layout).map((l) => l.content)
    expect(contents).toHaveLength(2)
    expect(contents[1]).toMatchObject({
      kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex',
      model: 'gpt-5.3-codex', effort: 'high',
      sandbox: 'workspace-write', permissionMode: 'on-request',
      initialCwd: '/proj',
      sessionRef: { provider: 'codex', sessionId: 'thr_42' },
    })
  })

  it('a ledgerOnly fresh-agent row WITHOUT recorded settings behaves exactly as before', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'opencode', sessionId: 'ses_123', mode: 'freshopencode', cwd: '/proj', tabKey: 'k', paneKind: 'fresh-agent' },
    ]))
    const entryContent = leavesOf(plans[0].layout).map((l) => l.content)[1]
    expect(entryContent.kind).toBe('fresh-agent')
    // Absent settings stay absent — today's defaulting path, unchanged.
    expect(entryContent.model).toBeUndefined()
    expect(entryContent.effort).toBeUndefined()
    expect(entryContent.sandbox).toBeUndefined()
    expect(entryContent.permissionMode).toBeUndefined()
  })

  // Defense-in-depth (same regime as the sessionType fallback): an out-of-union
  // sandbox value (corrupt/pre-schema row) must never make the restored leaf
  // fail pane validation — drop the FIELD, never the pane.
  it('a ledgerOnly fresh-agent row with an out-of-union sandbox drops the field, not the pane', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'codex', sessionId: 'thr_7', mode: 'freshcodex', cwd: '/x', tabKey: 'k',
        paneKind: 'fresh-agent', model: 'm1', sandbox: 'docker' },
    ]))
    const entryContent = leavesOf(plans[0].layout).map((l) => l.content)[1]
    expect(entryContent).toMatchObject({ kind: 'fresh-agent', model: 'm1' })
    expect(entryContent.sandbox).toBeUndefined()
  })

  // Focused-ep1-r5 Finding 3 (provider consistency): a row whose `mode`
  // stamps a fresh-agent session type from a DIFFERENT provider lane than
  // the row's `provider` (malformed/pre-schema data) must NOT rebuild as a
  // resumable pane — the built content would dispatch the sessionRef to the
  // wrong provider, which filters the mismatched ref and silently mints a
  // fresh, non-resume session. Like a closed/live row, the pane rebuilds
  // carrying the row's recorded flavor + settings WITHOUT the resume ref
  // (the plan builder's existing convention for unresumable content — no
  // new error surface).
  it('a ledgerOnly fresh-agent row whose mode names a different provider lane is NOT rebuilt as a resumable pane', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'opencode', sessionId: 'ses_mm', mode: 'freshcodex', cwd: '/proj', tabKey: 'k',
        paneKind: 'fresh-agent', model: 'm1', effort: 'high' },
    ]))
    expect(plans).toHaveLength(1)
    const entryContent = leavesOf(plans[0].layout).map((l) => l.content)[1]
    expect(entryContent.kind).toBe('fresh-agent')
    expect(entryContent.sessionRef).toBeUndefined()
    // The pane keeps the row's recorded flavor + settings — a fresh pane of
    // the stamped flavor, never a wrong-provider resume dispatch.
    expect(entryContent).toMatchObject({
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'm1',
      effort: 'high',
      initialCwd: '/proj',
    })
  })

  it('a plain CLI ledgerOnly row still builds terminal content (finding-2 regime is fresh-agent-only)', () => {
    const plans = buildRecoveryPlan(inv([pane()], [
      { provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x', tabKey: 'k' },
      { provider: 'claude', sessionId: 'K7', mode: 'kilroy', cwd: '/y', tabKey: 'k', paneKind: 'fresh-agent' },
    ]))
    const contents = leavesOf(plans[0].layout).map((l) => l.content)
    expect(contents).toHaveLength(3)
    expect(contents[1]).toMatchObject({
      kind: 'terminal', mode: 'codex', initialCwd: '/x',
      sessionRef: { provider: 'codex', sessionId: 'C9' },
    })
    expect(contents[2]).toMatchObject({
      kind: 'fresh-agent', sessionType: 'kilroy', provider: 'claude', initialCwd: '/y',
      sessionRef: { provider: 'claude', sessionId: 'K7' },
    })
  })

  it('countRecoverablePanes counts a joined row identically (placement changes the total by nothing)', () => {
    expect(countRecoverablePanes(inv([pane()], [
      { provider: 'claude', sessionId: 'S9', mode: 'claude', cwd: '/j', tabKey: 'k' },
    ]))).toBe(2)
  })

  // Delta-r4 Finding 2 (offer count/plan consistency): the prompt's count must
  // equal what the accept path can actually place. Against an OLDER server
  // (a supported client-only deploy — additive protocol, rows without tabKey)
  // the offer can still carry unplaceable rows; counting them advertises N
  // while the plan restores fewer. The count consumes the SAME placement
  // predicate as the listing and the plan.
  it('countRecoverablePanes counts only PLACEABLE ledgerOnly rows (mixed cohort)', () => {
    const inventory = inv([pane(), pane({ paneId: 'p2' })], [
      { provider: 'claude', sessionId: 'S9', mode: 'claude', cwd: '/j', tabKey: 'k' }, // joins
      { provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x', tabKey: 'd:t-gone' }, // no join target
      { provider: 'opencode', sessionId: 'O1', mode: 'opencode', cwd: '/y' }, // no tabKey at all
    ])
    // 2 snapshot panes + the 1 placeable row; the 2 unplaceable rows count for nothing.
    expect(countRecoverablePanes(inventory)).toBe(3)
  })

  it('the advertised count equals exactly the panes the accept path produces', () => {
    const inventory = inv([pane(), pane({ paneId: 'p2' })], [
      { provider: 'claude', sessionId: 'S9', mode: 'claude', cwd: '/j', tabKey: 'k' }, // joins
      { provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: '/x', tabKey: 'd:t-gone' }, // unplaceable
    ])
    const plans = buildRecoveryPlan(inventory)
    const produced = plans.flatMap((p) => leavesOf(p.layout)).length
    expect(produced).toBe(3)
    expect(countRecoverablePanes(inventory)).toBe(produced)
  })
})
