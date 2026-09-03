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

  it('closed panes come back fresh: no sessionRef, same cwd/mode', () => {
    const [tab] = buildRecoveryPlan(inv([pane({ ledgerState: 'closed', mode: 'claude' })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.sessionRef).toBeUndefined()
    expect(content).toMatchObject({ mode: 'claude', initialCwd: '/w' })
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
    const [tab] = buildRecoveryPlan(inv([pane({ kind: 'fresh-agent',
      payload: { sessionRef: { provider: 'freshclaude', sessionId: 'F1' }, restoreError: 'stale' }, mode: null, cwd: null })]))
    const content = (tab.layout as { content: Record<string, unknown> }).content
    expect(content.restoreError).toBeUndefined()
    expect(content).toMatchObject({ kind: 'fresh-agent', sessionRef: { provider: 'freshclaude', sessionId: 'F1' } })
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

  // Delta-r2 Finding 3 regression sentinel: the trailing-tab machinery is
  // gone — the literal tab title can never be produced again. (The placement
  // tests above pin the behavior; this pins the machinery's removal.)
  it('the plan builder module no longer contains the trailing-tab title', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    // cwd is the vitest config `root` (the project root) for this suite.
    const src = await readFile(join(process.cwd(), 'src/lib/recovery/build-recovery-plan.ts'), 'utf8')
    expect(src.includes('Recovered sessions')).toBe(false)
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

  it('countRecoverablePanes sums device panes and ledgerOnly', () => {
    expect(countRecoverablePanes(inv([pane(), pane({ paneId: 'p2' })], [{ provider: 'codex', sessionId: 'C9', mode: 'codex', cwd: null }]))).toBe(3)
  })

  it('countRecoverablePanes counts a joined row identically (placement changes the total by nothing)', () => {
    expect(countRecoverablePanes(inv([pane()], [
      { provider: 'claude', sessionId: 'S9', mode: 'claude', cwd: '/j', tabKey: 'k' },
    ]))).toBe(2)
  })
})
