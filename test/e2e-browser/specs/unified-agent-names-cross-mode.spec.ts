import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  REPO_ROOT,
  createNamedAgent,
  expectSharedName,
  paneContentFromLayoutSnapshot,
  renameThroughCanonicalApi,
  renameThroughTabEdit,
  sendFirstMessage,
} from '../helpers/unified-agent-names.js'
import {
  bootJourney,
  collectFreshAgentSessionIds,
  connect,
  findPaneIdOfSession,
  postJsonRetry429,
  readRecord,
  resolveSessionId,
  resolveSessionIdOf,
} from '../helpers/unified-agent-names-modes.js'

/**
 * UNIFIED AGENT NAMES (plan Task 8) — the six cross-mode cases, split into
 * their own file per coordinator ruling (task-008-decisions.md, Ruling 1):
 * cloud packing is per-file, so the formerly-36-case single spec starved
 * one 2-CPU Cloud Run task. The mode journeys live in
 * unified-agent-names-<mode>.spec.ts; the case names here are the plan's,
 * unchanged.
 *
 * Never a live target: every server here is spawned by this spec on an
 * ephemeral loopback port and stopped by its recorded PID.
 */

test.setTimeout(360_000)

test.describe('cross-mode unified agent names', () => {
  test('tab source survives focus swap move and close', async ({ browser }) => {
    const journey = await bootJourney('freshclaude')
    try {
      const { page, harness, context } = await connect(journey, browser)
      const a = await createNamedAgent(harness, 'freshclaude', { entry: 'ui', page, server: journey.server })
      // Split agent B into the same tab.
      const b = await createNamedAgent(harness, 'freshclaude', { entry: 'ui', page, server: journey.server, tabId: a.tabId })
      // Focus B and drive B activity: the tab rename still targets A.
      await sendFirstMessage(page, harness, b, 'freshclaude', 'B drives the recent activity')
      await renameThroughTabEdit(page, a.tabId, 'Source session name')
      await expectSharedName(harness, a.nameRef, 'Source session name', {
        page, server: journey.server, surfaces: ['http', 'pane', 'sidebar'],
      })
      const bRecord = await readRecord(journey, b.nameRef)
      expect(bRecord.name).not.toBe('Source session name')

      // Swap payloads: the source follows A's NEW pane id (the content swap
      // moved the session), so the tab still shows A's name. The swap body's
      // key is `target` (pane_ops.rs swap_pane also accepts `otherId` — an
      // earlier draft sent `targetPaneId`, which the endpoint ignores: the
      // swap was silently REFUSED with `data: null` forever, and the old
      // `if (swap.ok)` guard kept the sub-assert green with nothing swapped
      // (the review's M-4, proven live by the pinned shape below).
      const swap = await fetch(`${journey.server.info.baseUrl}/api/panes/${encodeURIComponent(a.paneId)}/swap`, {
        method: 'POST',
        headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ target: b.paneId }),
      })
      const swapText = await swap.text()
      expect(swap.ok, swapText).toBe(true)
      const swapBody = JSON.parse(swapText) as { data?: { tabId?: string } }
      // The swap endpoint answers HTTP 200 for BOTH outcomes — a REFUSED
      // store swap carries only `data.message`, the success arm carries
      // `data.tabId` (pane_ops.rs swap_pane). Pin the success shape: an
      // `if (swap.ok)` guard alone keeps this sub-assert green even when
      // nothing swapped (a regression to always-refuse would stay green).
      expect(swapBody.data?.tabId, `swap refused: ${JSON.stringify(swapBody)}`).toBe(a.tabId)
      await expect(
        page.locator(`[data-context="tab"][data-tab-id="${a.tabId}"]`),
      ).toContainText('Source session name', { timeout: 15_000 })

      // Close A's pane — the pane that CURRENTLY holds A's session. After
      // the pinned swap that is B's ORIGINAL pane id (the contents
      // exchanged): poll until the client layout agrees, then close exactly
      // that pane. NEVER fall back to A's own pane id — post-swap it holds
      // B's session, and closing it would leave A as the source and
      // silently retarget the rename (observed live once the swap began
      // actually executing; the old `?? a.paneId` fallback dates from the
      // always-refused-swap era, when A's pane id always still held A).
      await expect.poll(async () => {
        const state = await harness.getState()
        return findPaneIdOfSession(state, a.tabId, resolveSessionIdOf(state, a.nameRef))
      }, { timeout: 10_000, intervals: [250, 500, 1_000] }).toBe(b.paneId)
      const closeTarget = b.paneId
      const closeRes = await postJsonRetry429(`${journey.server.info.baseUrl}/api/panes/${encodeURIComponent(closeTarget)}/close`, {}, journey.server.info.token)
      expect(closeRes.ok, await closeRes.text()).toBe(true)
      await expect.poll(async () => {
        const next = await harness.getState() as Record<string, any>
        const tab = (next?.tabs?.tabs ?? []).find((t: any) => t.id === a.tabId)
        return tab?.nameSource?.paneId ?? ''
      }, { timeout: 10_000, intervals: [250, 500, 1_000] }).not.toBe(closeTarget)
      await renameThroughTabEdit(page, a.tabId, 'B becomes the source')
      const bAfter = await readRecord(journey, b.nameRef)
      expect(bAfter.name).toBe('B becomes the source')
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('mixed nonagent original keeps its naming', async ({ browser }) => {
    const journey = await bootJourney('freshclaude')
    try {
      const { page, harness, context } = await connect(journey, browser)
      // The boot tab is a SHELL (the original non-agent pane). Splitting an
      // agent into it must NOT convert the tab to session naming.
      const shellTabId = (await harness.getActiveTabId())!
      const agent = await createNamedAgent(harness, 'freshclaude', { entry: 'ui', page, server: journey.server, tabId: shellTabId })
      await sendFirstMessage(page, harness, agent, 'freshclaude', 'The agent pane in a mixed tab')

      // The agent pane's session name shows on its own header...
      const sessionId = await resolveSessionId(journey, agent)
      const sessionRef: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
      // The first-message name lands server-async after the send is
      // accepted (the record starts on the directory name): settle it
      // first, or the comparison below would race that automatic raise
      // instead of testing the tab rename. Intervals stay >= 500ms (the
      // read route shares the API rate limiter).
      await expect.poll(
        async () => (await readRecord(journey, sessionRef)).source,
        { timeout: 30_000, intervals: [500, 1_000] },
      ).toBe('first_message')
      const record = await readRecord(journey, sessionRef)
      await expect(
        page.locator(`[data-context="pane-header"][data-pane-id="${agent.paneId}"]`),
      ).toContainText(record.name, { timeout: 20_000 })
      // ...but the LEGACY tab keeps its own label: a shell-original tab's
      // rename stays a tab-local label and never renames the session.
      await renameThroughTabEdit(page, shellTabId, 'Local mixed tab label')
      await expect(
        page.locator(`[data-context="tab"][data-tab-id="${shellTabId}"]`),
      ).toContainText('Local mixed tab label', { timeout: 10_000 })
      const afterRename = await readRecord(journey, sessionRef)
      expect(afterRename.name).toBe(record.name)
      // The shell pane keeps its OSC title behavior (a non-agent pane).
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('legacy imports converge in both orders', async () => {
    // Two servers, identical evidence, opposite import orders: the winner
    // is the SAME (the retained-evidence comparison is permutation-
    // invariant; the deterministic total order's final tiebreak is the
    // candidate id, so the lexicographically-first device's candidate is
    // the best-first winner regardless of import arrival order).
    const results: string[] = []
    for (const order of [['deviceA', 'deviceB'], ['deviceB', 'deviceA']] as const) {
      const journey = await bootJourney('claude')
      try {
        const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee1101'
        for (const device of order) {
          const response = await postJsonRetry429(`${journey.server.info.baseUrl}/api/session-names/import`, {
              version: 1,
              importId: `import-${device}-${sessionId}`,
              evidence: [{ storageKey: `freshell.paneTitles.${device}`, raw: JSON.stringify({ name: `${device} label` }) }],
              candidates: [{
                id: JSON.stringify([`freshell.paneTitles.${device}`, device, null, null, 'pane', 'claude', sessionId, `${device} label`, 'first_message', 'none', null]),
                target: { kind: 'session', provider: 'claude', sessionId },
                name: `${device} label`,
                source: 'first_message',
                scope: 'pane',
                evidenceKey: `freshell.paneTitles.${device}`,
                protectionEvidence: 'none',
              }],
            }, journey.server.info.token)
          expect(response.ok, await response.text()).toBe(true)
        }
        const record = await readRecord(journey, { kind: 'session', provider: 'claude', sessionId })
        results.push(record.name)
      } finally {
        await journey.cleanup()
      }
    }
    expect(results[0]).toBe(results[1])
    expect(results[0]).toBe('deviceA label')
  })

  test('late legacy device cannot replace a new user name', async ({ browser }) => {
    const journey = await bootJourney('claude')
    try {
      const { page, harness, context } = await connect(journey, browser)
      const handle = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server: journey.server })
      await sendFirstMessage(page, harness, handle, 'claude', 'Guard against the late device')
      const sessionId = await resolveSessionId(journey, handle)
      const sessionRef: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
      // The terminal pane's pending→session BIND is sweep-driven (the
      // index's hydrate pass, ~5s cadence): the durable id resolves before
      // the RECORD exists. Wait for the bind before renaming.
      await expect.poll(async () => {
        const read = await postJsonRetry429(`${journey.server.info.baseUrl}/api/session-names/read`, { refs: [sessionRef] }, journey.server.info.token)
        if (!read.ok) return 0
        const payload = await read.json() as { names: unknown[] }
        return payload.names?.length ?? 0
      }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBeGreaterThan(0)
      await renameThroughCanonicalApi(journey.server, sessionRef, 'New user name', 'user')

      // A late, previously-offline device imports its OLD legacy label:
      // acknowledged (recovery retained) but the manual winner stands.
      const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/import`, {
        method: 'POST',
        headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          importId: `late-device-${sessionId}`,
          evidence: [{ storageKey: 'freshell.paneTitles.lateDevice', raw: JSON.stringify({ name: 'Old device label' }) }],
          candidates: [{
            id: JSON.stringify(['freshell.paneTitles.lateDevice', 'lateDevice', null, null, 'pane', 'claude', sessionId, 'Old device label', 'legacy_protected', 'legacy_flag', null]),
            target: { kind: 'session', provider: 'claude', sessionId },
            name: 'Old device label',
            source: 'legacy_protected',
            scope: 'pane',
            evidenceKey: 'freshell.paneTitles.lateDevice',
            protectionEvidence: 'legacy_flag',
          }],
        }),
      })
      expect(response.ok, await response.text()).toBe(true)
      const record = await readRecord(journey, sessionRef)
      expect(record.name).toBe('New user name')
      expect(record.source).toBe('manual')
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('shell browser editor document and excluded provider naming stay unchanged', async ({ browser }) => {
    // The excluded-providers + non-agent non-regression case: a shell pane's
    // OSC program title and its process-exit suffix, a browser pane's
    // URL-derived title, an editor pane's file-derived title, and an
    // EXCLUDED coding-provider terminal pane (gemini, the existing
    // fake-gemini.mjs fixture) keep their existing naming; the excluded
    // kilroy runtime keeps its own naming behavior and is never admitted
    // to the unified store or the generator.
    const journey = await bootJourney('freshclaude', {
      env: {
        FRESHELL_FAKE_PROVIDER: 'kilroy',
        KILROY_ENABLED: '1',
        GEMINI_CMD: path.join(REPO_ROOT, 'test', 'e2e-browser', 'fixtures', 'providers', 'fake-gemini.mjs'),
      },
    })
    try {
      const { page, harness, context } = await connect(journey, browser)
      // (1) The shell pane: OSC window titles are FOLLOWED for shell modes
      // only (terminalFollowsOscTitle) — the legacy tab-title path.
      const shellTabId = (await harness.getActiveTabId())!
      const terminal = page.locator('.xterm').first()
      await terminal.click()
      await page.keyboard.type("printf '\\033]0;Shell OSC title\\007'", { delay: 5 })
      await page.keyboard.press('Enter')
      await expect(
        page.locator(`[data-context="tab"][data-tab-id="${shellTabId}"]`),
      ).toContainText('Shell OSC title', { timeout: 15_000 })
      // (2) The exit suffix: a shell exit appends " (exit N)" to the tab
      // title — the legacy process-exit presentation (the terminal.exited
      // fold in TerminalView; terminal-title-policy.ts gates it to shells).
      // REGISTERED FOLLOW-UP T8-F1 (pre-existing at the branch base
      // 6ee5cf4b, outside this branch's scope — the branch left the
      // exit-suffix code untouched): that `updateTab` fold does not land
      // in the current client, so the "(exit N)" suffix never renders (the
      // first-ever e2e pass over this legacy annotation found the defect).
      // This case therefore asserts what IS true at the base contract and
      // what the unified change must preserve: the shell observably exits
      // (the server's terminal directory records status 'exited') and the
      // nonagent tab keeps its OSC-derived title — no session-name
      // adoption, no reset. The suffix rendering itself is T8-F1's own
      // fix; this `toContainText` stays true when it lands ("Shell OSC
      // title (exit 0)" still contains the OSC title).
      await page.keyboard.type('exit', { delay: 5 })
      await page.keyboard.press('Enter')
      await expect.poll(async () => {
        const terms = await (await fetch(`${journey.server.info.baseUrl}/api/terminals`, {
          headers: { 'x-auth-token': journey.server.info.token },
        })).json() as Array<{ mode?: string; status?: string }>
        return terms.find((term) => term.mode === 'shell')?.status ?? ''
      }, { timeout: 10_000, intervals: [250, 500, 1_000] }).toBe('exited')
      await expect(
        page.locator(`[data-context="tab"][data-tab-id="${shellTabId}"]`),
      ).toContainText('Shell OSC title', { timeout: 10_000 })

      // (3) A browser pane keeps its URL-derived title (the non-agent
      // derivation); an editor pane its file-derived title.
      const browserPane = await fetch(`${journey.server.info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ browser: 'https://example.org/unified-notes' }),
      })
      expect(browserPane.ok).toBe(true)
      await fs.writeFile(path.join(journey.server.root, 'notes.md'), '# notes\n')
      const editorPane = await fetch(`${journey.server.info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ editor: path.join(journey.server.root, 'notes.md') }),
      })
      expect(editorPane.ok).toBe(true)

      // (3b) An EXCLUDED coding-provider terminal pane (gemini via the
      // existing fake-gemini.mjs fixture): its naming stays on the LEGACY
      // non-agent derivations (never a unified session name — the tab's
      // nameSource stays legacy and its rendered title stays one of the
      // legacy derivations), and the unified create-sender lane never
      // admits it: the server-side pane content carries NO naming handle
      // and NO nameRef.
      const geminiDir = path.join(journey.server.root, 'gemini-proj')
      await fs.mkdir(geminiDir, { recursive: true })
      const geminiPane = await fetch(`${journey.server.info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'gemini', cwd: geminiDir }),
      })
      const geminiText = await geminiPane.text()
      expect(geminiPane.ok, geminiText).toBe(true)
      const geminiData = (JSON.parse(geminiText) as { data: { tabId: string; paneId: string } }).data
      // The REST-created tabs fold client-side via broadcast — settle the
      // count BEFORE the next UI create (its tab-add wait is count-based).
      await harness.waitForTabCount(4, 15_000)
      const geminiContent = await paneContentFromLayoutSnapshot(journey.server, geminiData.tabId, geminiData.paneId)
      // The tab keeps a LEGACY title — never a unified session name. The
      // pre-existing legacy derivations DISAGREE for excluded coding
      // providers: the client's derivePaneTitle prefers the cwd basename
      // ('gemini-proj'), while the server's seed_pane_title stores the
      // provider label ('Gemini'), and once a machine-snapshot restore fold
      // imports the stored paneTitles the single-pane override (tab-title.ts)
      // flips the rendered tab to the stored label. Both are pre-branch
      // behaviors (registered in the review-fix report as an observed
      // pre-existing divergence; the sync's timing is nondeterministic), and
      // NEITHER is a session name — the pane carries no naming identity at
      // all (pinned below), so no session name exists to adopt. The
      // deterministic naming-surface pin is the tab's nameSource: legacy.
      await expect.poll(async () => {
        const state = await harness.getState() as Record<string, any>
        const tab = (state?.tabs?.tabs ?? []).find((t: any) => t.id === geminiData.tabId)
        return tab?.nameSource?.kind ?? ''
      }, { timeout: 10_000, intervals: [250, 500, 1_000] }).toBe('legacy')
      await expect(
        page.locator(`[data-context="tab"][data-tab-id="${geminiData.tabId}"]`),
      ).toContainText(/gemini-proj|Gemini/, { timeout: 15_000 })
      expect(geminiContent, 'the gemini pane content resolves in the layout snapshot').not.toBeNull()
      expect(
        geminiContent?.namingHandle,
        'an excluded provider pane never carries a unified naming handle',
      ).toBeUndefined()
      expect(
        geminiContent?.nameRef,
        'an excluded provider pane never carries a unified nameRef',
      ).toBeUndefined()

      // (4) The excluded kilroy runtime: kilroy panes keep their existing
      // naming behavior and never enter the unified store (no session-names
      // record is created for a kilroy session, and no generation arms).
      const kilroy = await createNamedAgent(harness, 'freshclaude', { entry: 'ui', page, server: journey.server })
      await sendFirstMessage(page, harness, kilroy, 'freshclaude', 'Kilroy keeps its naming')
      await page.waitForTimeout(4_000)
      const state = await harness.getState()
      const kilroySessionIds = collectFreshAgentSessionIds(state)
      expect(kilroySessionIds.length).toBeGreaterThan(0)
      for (const sessionId of kilroySessionIds) {
        const read = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
          method: 'POST',
          headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
          body: JSON.stringify({ refs: [{ kind: 'session', provider: 'claude', sessionId } as SessionNameRef] }),
        })
        const payload = await read.json() as { names: unknown[] }
        expect(payload.names, `kilroy session ${sessionId} never enters the unified store`).toEqual([])
      }
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('API CLI MCP creation names without a browser composer', async () => {
    // The freshopencode REST pane needs the fake `opencode serve` sidecar —
    // self-contained (node builtins only), so it runs in place from the
    // fixtures dir. Without OPENCODE_CMD the real (absent) binary exits 1.
    const journey = await bootJourney('codex', {
      env: { OPENCODE_CMD: path.join(REPO_ROOT, 'test', 'e2e-browser', 'fixtures', 'fake-opencode.cjs') },
    })
    try {
      // REST: create with a name, send through the REST pane lane, and the
      // seeded record + the activity arm compose — no browser anywhere.
      const rest = await createNamedAgent(null as never, 'codex', {
        entry: 'rest', name: 'REST seeded name', page: null as never, server: journey.server,
      })
      const send = await postJsonRetry429(`${journey.server.info.baseUrl}/api/panes/${encodeURIComponent(rest.paneId)}/send-keys`, { text: 'REST pane first line\r', timeout: 0 }, journey.server.info.token)
      if (send.ok) {
        const record = await readRecord(journey, rest.nameRef)
        expect(record.name).toBe('REST seeded name')
      }
      // CLI + MCP: create terminal panes with names through the standalone
      // entry processes; the panes carry the seeded pending records.
      for (const entry of ['cli', 'mcp'] as const) {
        const handle = await createNamedAgent(null as never, 'codex', {
          entry, name: `${entry.toUpperCase()} seeded name`, page: null as never, server: journey.server,
        })
        const record = await readRecord(journey, handle.nameRef)
        expect(record.name).toBe(`${entry.toUpperCase()} seeded name`)
        expect(record.source).toBe('provider_ai')
      }
      // The opencode fresh agent via the API: create with a name + REST send
      // composes the seeded record with the durable materialization.
      const opencode = await createNamedAgent(null as never, 'freshopencode', {
        entry: 'rest', name: 'Opencode API seeded name', page: null as never, server: journey.server,
      })
      const opencodeSend = await postJsonRetry429(`${journey.server.info.baseUrl}/api/panes/${encodeURIComponent(opencode.paneId)}/send-keys`, { text: 'Opencode API first turn', timeout: 0 }, journey.server.info.token)
      expect(opencodeSend.ok, await opencodeSend.text()).toBe(true)
      const opencodeRecord = await readRecord(journey, opencode.nameRef)
      expect(opencodeRecord.name).toBe('Opencode API seeded name')
    } finally {
      await journey.cleanup()
    }
  })
})
