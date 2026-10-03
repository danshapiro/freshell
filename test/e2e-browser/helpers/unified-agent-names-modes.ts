import { expect, type Browser } from './fixtures.js'
import type { SessionNameRef } from '../../shared/session-names.js'
import {
  type UnifiedAgentMode,
  bootUnifiedNamesServer,
  connectUnifiedPage,
  createNamedAgent,
  expectRenameOnlyContextMenu,
  expectSharedName,
  isFreshPlaceholderSessionId,
  modeFixture,
  renameThroughCanonicalApi,
  renameThroughCli,
  renameThroughHistoryView,
  renameThroughMcp,
  renameThroughOverview,
  renameThroughPaneContextMenu,
  renameThroughPaneHeader,
  renameThroughPaneRoute,
  renameThroughSessionRoute,
  renameThroughSidebarMenu,
  renameThroughTabEdit,
  renameThroughTabRoute,
  renameThroughTerminalRoute,
  refreshHandle,
  sendFirstMessage,
  startFakeGemini,
  startFakeOneCliGeminiProxy,
  type FakeGemini,
  type FakeOneCliGeminiProxy,
  type NamedAgentHandle,
  type UnifiedNamesServer,
} from './unified-agent-names.js'

/**
 * UNIFIED AGENT NAMES (plan Task 8) — the six-mode browser acceptance,
 * split per coordinator ruling (task-008-decisions.md, Ruling 1): the
 * cloud lane packs whole spec FILES per task, so one 36-case file starved
 * a single 2-CPU Cloud Run task and its naming-bind lanes converged past
 * every assert window. Each mode now lives in its own spec file
 * (unified-agent-names-<mode>.spec.ts) so the 4-shard topology can
 * actually divide the load; the six cross-mode cases live in
 * unified-agent-names-cross-mode.spec.ts. The 36 case names are unchanged
 * — this module holds the five per-mode journeys verbatim, and every mode
 * spec registers them with `defineUnifiedAgentModeJourneys(mode)`.
 *
 * For each of the six scoped modes (claude/codex/opencode terminal CLIs
 * and freshclaude/freshcodex/freshopencode) five named journeys prove the
 * unified contract on an OWNED real Rust server with deterministic
 * provider fixtures: activity-driven shared naming, rename convergence
 * through every applicable entry, the pre-durable pending-name lifecycle,
 * cross-browser and unloaded-history convergence, and manual-name
 * protection against late generation and conversation switches.
 *
 * Never a live target: every server here is spawned by a spec on an
 * ephemeral loopback port and stopped by its recorded PID.
 */

export const AI_NAME = 'Sardine factory fix'

export interface Journey {
  server: UnifiedNamesServer
  gemini: FakeGemini | null
  oneCliGeminiProxy: FakeOneCliGeminiProxy | null
  cleanup: () => Promise<void>
}

export async function bootJourney(mode: UnifiedAgentMode, opts: {
  gemini?: FakeGemini | null
  oneCliGeminiProxy?: FakeOneCliGeminiProxy | null
  directFallbackKey?: string
  env?: Record<string, string>
  setupHome?: (homeDir: string) => Promise<void>
} = {}): Promise<Journey> {
  const oneCliEnv = opts.oneCliGeminiProxy
    ? {
        FRESHELL_GEMINI_BASE_URL: 'http://generativelanguage.googleapis.com/v1beta',
        HTTP_PROXY: opts.oneCliGeminiProxy.proxyUrl,
        http_proxy: opts.oneCliGeminiProxy.proxyUrl,
        NO_PROXY: '',
        no_proxy: '',
        GOOGLE_GENERATIVE_AI_API_KEY: opts.directFallbackKey ?? 'unified-names-direct-fallback-sentinel',
      }
    : {}
  const server = await bootUnifiedNamesServer({
    mode,
    gemini: opts.gemini ?? null,
    env: { ...oneCliEnv, ...(opts.env ?? {}) },
    setupHome: opts.setupHome,
  })
  return {
    server,
    gemini: opts.gemini ?? null,
    oneCliGeminiProxy: opts.oneCliGeminiProxy ?? null,
    cleanup: async () => {
      await server.stop()
      await opts.gemini?.close().catch(() => {})
      await opts.oneCliGeminiProxy?.close().catch(() => {})
    },
  }
}

export async function connect(journey: Journey, browser: Browser) {
  return connectUnifiedPage({ browser, info: journey.server.info })
}

export async function resolveSessionId(journey: Journey, handle: NamedAgentHandle): Promise<string> {
  // The materialization bind is server-async: poll the naming authority
  // (through redirects) until the durable identity resolves. The intervals
  // stay ≥500ms — the read route shares the API rate limiter (300-token
  // bucket, 5/sec refill), and a default-interval poll (100ms) drains it,
  // rate-limiting the LATER assertions in the same journey.
  let resolved = ''
  await expect.poll(async () => {
    // A placeholder-shaped handle id is NOT a durable identity — fall
    // through to the naming authority's redirect instead of trusting it.
    if (handle.sessionId && !isFreshPlaceholderSessionId(handle.sessionId)) { resolved = handle.sessionId; return resolved }
    if (handle.nameRef && handle.nameRef.kind === 'session') { resolved = handle.nameRef.sessionId; return resolved }
    if (!handle.nameRef) return ''
    const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ refs: [handle.nameRef] }),
    })
    if (!response.ok) return ''
    const payload = await response.json() as { names: Array<{ record: { ref: SessionNameRef }; redirects: Array<{ to: SessionNameRef }> }> }
    const update = payload.names[0]
    if (!update) return ''
    if (update.record.ref.kind === 'session') { resolved = update.record.ref.sessionId; return resolved }
    const redirect = update.redirects?.find((r) => r.to.kind === 'session')
    resolved = redirect ? (redirect.to as { sessionId: string }).sessionId : ''
    return resolved
  }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBeTruthy()
  return resolved
}

export async function readRecord(journey: Journey, ref: SessionNameRef): Promise<{ name: string; source: string; ref: SessionNameRef }> {
  // A rate-limited read (shared API bucket) is transient: retry a bounded
  // few times instead of failing the journey on the limiter.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ refs: [ref] }),
    })
    if (response.ok) {
      const payload = await response.json() as { names: Array<{ record: { name: string; source: string; ref: SessionNameRef } }> }
      expect(payload.names[0]).toBeTruthy()
      return payload.names[0].record
    }
    if (attempt >= 5 || response.status !== 429) {
      expect(response.ok, `session-names read failed (${response.status})`).toBe(true)
      throw new Error('unreachable')
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/** POST with a bounded retry on the shared API rate limiter (429) — the
 * journeys' bursty REST traffic can transiently exhaust it. */
export async function postJsonRetry429(url: string, body: unknown, token: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-auth-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok || response.status !== 429 || attempt >= 5) return response
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

export function findPaneIdOfSession(state: unknown, tabId: string, sessionId: string | null): string | null {
  if (!sessionId) return null
  const layouts = (state as { panes?: { layouts?: Record<string, unknown> } })?.panes?.layouts ?? {}
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null
    const n = node as { type?: string; id?: string; content?: { sessionRef?: { sessionId?: string } }; children?: unknown[] }
    if (n.type === 'leaf' && n.content?.sessionRef?.sessionId === sessionId) return n.id ?? null
    for (const child of n.children ?? []) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(layouts[tabId] ?? null)
}

export function resolveSessionIdOf(state: unknown, ref: SessionNameRef): string | null {
  if (ref.kind === 'session') return ref.sessionId
  // The client store's redirect shape is `{ toKey, revision }` where `toKey`
  // is the canonical JSON-stringified `['session', provider, sessionId]` key
  // (sessionNamesSlice.ts's `sessionNameRefKey(redirect.to)`). An earlier
  // draft read a phantom `redirect.to.{kind,sessionId}` field that never
  // exists in the store, so this ALWAYS returned null — masked for as long
  // as the cross-mode close step fell back to the pane id it already had
  // (the swap was silently refused, pre-M-4), and exposed the moment the
  // pinned swap made the contents genuinely exchange.
  const redirects = (state as { sessionNames?: { redirects?: Record<string, { toKey?: string }> } })?.sessionNames?.redirects
  const entry = redirects?.[JSON.stringify(ref.kind === 'pending' ? ['pending', ref.id] : ['session', ref.provider, ref.sessionId])]
  const toKey = entry?.toKey
  if (typeof toKey !== 'string') return null
  try {
    const to = JSON.parse(toKey) as [string, string, string]
    return to[0] === 'session' && typeof to[2] === 'string' ? to[2] : null
  } catch {
    return null
  }
}

export function collectFreshAgentSessionIds(state: unknown): string[] {
  const sessions = (state as { freshAgent?: { sessions?: Record<string, { sessionId?: string }> } })?.freshAgent?.sessions ?? {}
  return Object.values(sessions).map((s) => s?.sessionId).filter((id): id is string => typeof id === 'string')
}

/**
 * The five per-mode journey BODIES. Each per-mode spec file declares its
 * own thin `test(...)` wrappers that call these — Playwright attributes a
 * test to the file where `test()` is CALLED, and the cloud entrypoint's
 * shard discovery matches spec files by that location
 * (docker/cloud-run/entrypoint.sh's `--list` basename extraction), so the
 * wrappers must live in the per-mode spec files themselves.
 */

export async function activityGeneratesOneSharedShortName(mode: UnifiedAgentMode, browser: Browser): Promise<void> {
  {
    const gemini = await startFakeGemini(AI_NAME)
      const journey = await bootJourney(mode, { gemini })
      try {
        const { page, harness, context } = await connect(journey, browser)
        let handle = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
        await sendFirstMessage(page, harness, handle, mode, 'Repair the sardine factory line')
        handle = await refreshHandle(harness, handle, mode)
        expect(handle.nameRef).toBeTruthy()

        // The generated short name is the ONE saved name, shared by every
        // surface (persisted record + canonical cache + pane + tab + sidebar).
        await expectSharedName(harness, handle.nameRef!, AI_NAME, {
          page, server: journey.server, tabId: handle.tabId, sessionId: handle.sessionId,
        })
        const record = await readRecord(journey, handle.nameRef)
        expect(record.source).toBe('freshell_ai')
        expect(record.name.length).toBeLessThanOrEqual(60)
        await context.close()
      } finally {
        await journey.cleanup()
      }
  }
}

export async function activityGeneratesOneSharedShortNameViaOneCliProxy(
  mode: UnifiedAgentMode,
  browser: Browser,
): Promise<void> {
  const expectedFirstMessage = 'Repair the sardine factory line'
  const proxy = await startFakeOneCliGeminiProxy(AI_NAME, expectedFirstMessage)
  const journey = await bootJourney(mode, {
    oneCliGeminiProxy: proxy,
    directFallbackKey: 'synthetic-direct-fallback-key',
  })
  try {
    const { page, harness, context } = await connect(journey, browser)
    let handle = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
    await sendFirstMessage(page, harness, handle, mode, expectedFirstMessage)
    handle = await refreshHandle(harness, handle, mode)
    expect(handle.nameRef).toBeTruthy()
    const durableSessionId = handle.sessionId
      ?? (handle.nameRef?.kind === 'session' ? handle.nameRef.sessionId : undefined)
    if (mode === 'freshcodex') {
      expect(durableSessionId, 'the fresh Codex OneCLI journey needs a durable session ID for the sidebar assertion').toBeTruthy()
    }

    await expectSharedName(harness, handle.nameRef!, AI_NAME, {
      page, server: journey.server, tabId: handle.tabId,
      sessionId: mode === 'freshcodex' ? durableSessionId : handle.sessionId,
    })
    expect(proxy.requests).toEqual([{
      destinationHostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-3.5-flash-lite:generateContent',
      hasApiKey: false,
      promptContainsExpectedFirstMessage: true,
    }])
    await context.close()
  } finally {
    await journey.cleanup()
  }
}

export async function everyApplicableRenameEntryConverges(mode: UnifiedAgentMode, browser: Browser): Promise<void> {
  {
    // The broadest case: NINE rename entries, each verified on FIVE
    // surfaces, plus (claude) the mobile sheet and the Overview card.
    // The bounded per-surface waits accumulate legitimately — the caller's
    // test wrapper gives this case double the file's default budget.
    const journey = await bootJourney(mode)
      try {
        const { page, harness, context } = await connect(journey, browser)
        const created = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
        const handle = await refreshHandle(harness, created, mode)
        await sendFirstMessage(page, harness, handle, mode, 'Converge every rename surface')
        // The directory listing's parity filter hides a single-turn
        // transcript (non-interactive — `user_message_count <= 1`), and the
        // History view lists DIRECTORY sessions (the sidebar row also comes
        // from the live registry for an open pane, but the history rename
        // needs the real entry): a second turn gives the exchange shape a
        // session a user actually renames and reopens has.
        await sendFirstMessage(page, harness, handle, mode, 'A second turn makes the exchange real')
        const sessionId = await resolveSessionId(journey, handle)
        expect(sessionId).toBeTruthy()
        const sessionRef: SessionNameRef = { kind: 'session', provider: (await modeFixture(mode)).provider, sessionId }
        const fixture = await modeFixture(mode)
        const assertAll = async (name: string) => {
          await expectSharedName(harness, sessionRef, name, {
            page, server: journey.server, tabId: handle.tabId, sessionId,
          })
        }

        // (1) The pane-header inline rename.
        await renameThroughPaneHeader(page, 'Pane Header Name')
        await assertAll('Pane Header Name')
        // (1b) The pane context menu's 'Rename pane' — the same captured-
        // target inline editor entered through the rendered accessible menu.
        await renameThroughPaneContextMenu(page, 'Context Menu Name')
        await assertAll('Context Menu Name')
        // (2) The tab inline editor — the tab rename targets the SOURCE
        // session, never a tab-local label.
        await renameThroughTabEdit(page, handle.tabId, 'Tab Edit Name')
        await assertAll('Tab Edit Name')
        // (3) The sidebar context-menu rename.
        await renameThroughSidebarMenu(page, sessionId, 'Sidebar Menu Name')
        await assertAll('Sidebar Menu Name')
        // (4) The History (Projects) inline rename.
        await renameThroughHistoryView(page, sessionId, 'History View Name', journey.server.projectDir)
        await assertAll('History View Name')
        // (5) Terminal-mode surfaces: the Overview terminal card. (Fresh
        // modes have no terminal presentation.)
        if (fixture.terminal && handle.terminalId) {
          await renameThroughOverview(page, handle.terminalId, 'Overview Card Name')
          await assertAll('Overview Card Name')
        }
        // (6) The automation surfaces — the four convenience API routes all
        // resolve to the SAME saved session name.
        await renameThroughPaneRoute(journey.server, handle.paneId, 'Pane Route Name')
        await assertAll('Pane Route Name')
        await renameThroughTabRoute(journey.server, handle.tabId, 'Tab Route Name')
        await assertAll('Tab Route Name')
        await renameThroughSessionRoute(journey.server, fixture.provider, sessionId, 'Session Route Name')
        await assertAll('Session Route Name')
        if (fixture.terminal && handle.terminalId) {
          await renameThroughTerminalRoute(journey.server, handle.terminalId, 'Terminal Route Name')
          await assertAll('Terminal Route Name')
        }
        // (7) The standalone CLI and MCP rename verbs.
        await renameThroughCli(journey.server, 'rename-pane', handle.paneId, 'CLI Rename Name')
        await assertAll('CLI Rename Name')
        await renameThroughMcp(journey.server, 'rename-pane', handle.paneId, 'MCP Rename Name')
        await assertAll('MCP Rename Name')
        // (8) An automatic API suggestion must leave the accepted manual
        // winner unchanged (an agent suggestion never acquires a user's
        // permanence)...
        await renameThroughCanonicalApi(journey.server, sessionRef, 'Agent Suggestion', 'automatic')
        await assertAll('MCP Rename Name')
        // ...while explicit user intent changes it everywhere.
        await renameThroughCanonicalApi(journey.server, sessionRef, 'Final User Name', 'user')
        await assertAll('Final User Name')
        const record = await readRecord(journey, sessionRef)
        expect(record.source).toBe('manual')
        // (9) The scoped context menu exposes Rename ONLY (no generate, no
        // reset-to-provider, no alias controls) — rendered accessible menus.
        await expectRenameOnlyContextMenu(page, sessionId)
        await context.close()
      } finally {
        await journey.cleanup()
      }
  }
}

export async function pendingNameSurvivesMaterializeAndReopen(mode: UnifiedAgentMode, browser: Browser): Promise<void> {
  {
    // No deferral knob needed: every mode's fixture has a REAL pre-durable
      // window (freshclaude's sidecar touches a 0-byte transcript at create —
      // durable content only lands at the first send; codex's deferred rollout
      // and opencode's first-input session row likewise). With the runtime id
      // already visible in the pane content, the freshclaude shape exercises
      // the rename route's pre-bind pending fallback (404-on-prospective-
      // session → the pane's own pending binding) — the exact seam the
      // T6-R3/T7 handoff journeys must prove.
      // Step timings land in the shard log (stderr): the cloud container's
      // COLD attempt legitimately sums every convergence window (the
      // verified pending->durable bind converges in 60-120s there vs
      // seconds locally), and a per-case budget dispute needs the actual
      // step arithmetic, not a timeout mystery.
      const t0 = Date.now()
      let last = t0
      const mark = (label: string): void => {
        const now = Date.now()
        console.error(`[unified-agent-names:pending:${mode}] ${label} +${now - last}ms (total ${now - t0}ms)`)
        last = now
      }
      const journey = await bootJourney(mode)
      mark('boot')
      try {
        const { page, harness, context } = await connect(journey, browser)
        mark('connect')
        const handle = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
        mark('create')

        // The pre-durable rename through the PANE-HEADER inline editor —
        // the UI entry that captures the pane's naming target (the
        // client-sender handle-stamping seam this journey is the proof for).
        const pendingName = 'Pre-durable keep me'
        await renameThroughPaneHeader(page, pendingName)
        mark('rename')

        // Materialize: the first real input creates the durable identity and
        // the store transfers the pending record atomically. The surviving
        // name IS the proof — a pane whose pending handle was lost through
        // the sender gap would materialize with a fallback name instead.
        await sendFirstMessage(page, harness, handle, mode, 'Materialize the pending identity')
        mark('send1')
        const refreshedHandle = await refreshHandle(harness, handle, mode)
        mark('refresh')
        const sessionId = await resolveSessionId(journey, refreshedHandle)
        mark('resolve')
        expect(sessionId, 'the durable identity materialized').toBeTruthy()
        const sessionRef: SessionNameRef = { kind: 'session', provider: (await modeFixture(mode)).provider, sessionId }
        await expectSharedName(harness, sessionRef, pendingName, {
          page, server: journey.server, tabId: handle.tabId, sessionId,
        })
        mark('sharedName')
        const record = await readRecord(journey, sessionRef)
        expect(record.name).toBe(pendingName)
        mark('readRecord')
        // The pending handle now redirects: both refs answer the ONE record.
        if (refreshedHandle.nameRef && refreshedHandle.nameRef.kind === 'pending') {
          const viaPending = await readRecord(journey, refreshedHandle.nameRef)
          expect(viaPending.name).toBe(pendingName)
          mark('viaPending')
        }

        // Reopen: close the tab, then resume the durable session from the
        // sidebar — the reopened pane keeps the name everywhere. A session
        // a user actually reopens has had a real EXCHANGE (the directory
        // listing's parity filter hides a single-turn transcript —
        // `user_message_count <= 1` is non-interactive), so drive a second
        // turn before closing (the fixture appends the second
        // user-authored record the real CLI would have).
        await sendFirstMessage(page, harness, refreshedHandle, mode, 'A second turn makes the exchange real')
        const tab = page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`)
        await tab.getByRole('button', { name: /close/i }).click()
        await expect(tab).toHaveCount(0, { timeout: 10_000 })
        const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
        await expect(row).toBeVisible({ timeout: 20_000 })
        await row.click()
        await expect(
          page.locator('[data-context="pane-header"]:visible').first(),
        ).toContainText(pendingName, { timeout: 20_000 })
        await context.close()
      } finally {
        await journey.cleanup()
      }
  }
}

export async function twoBrowsersAndAnloadedHistoryConverge(mode: UnifiedAgentMode, browser: Browser): Promise<void> {
  {
    const journey = await bootJourney(mode)
      try {
        const a = await connect(journey, browser)
        const b = await connect(journey, browser)
        const created = await createNamedAgent(a.harness, mode, { entry: 'ui', page: a.page, server: journey.server })
        const handle = await refreshHandle(a.harness, created, mode)
        await sendFirstMessage(a.page, a.harness, handle, mode, 'Converge two browsers')
        // The directory listing's parity filter hides a single-turn
        // transcript (non-interactive); B's sidebar row needs the real
        // EXCHANGE shape — a second user-authored record.
        await sendFirstMessage(a.page, a.harness, handle, mode, 'A second turn makes the exchange real')
        const sessionId = await resolveSessionId(journey, handle)
        expect(sessionId).toBeTruthy()
        const sessionRef: SessionNameRef = { kind: 'session', provider: (await modeFixture(mode)).provider, sessionId }

        // Browser B has the session in its sidebar but has NOT loaded the
        // history page. A's rename converges B live (canonical broadcast)
        // and B's freshly-opened history page converges too.
        const bRow = b.page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
        await expect(bRow).toBeVisible({ timeout: 20_000 })
        const newName = 'Cross browser name'
        await renameThroughPaneHeader(a.page, newName)
        await expect(bRow).toContainText(newName, { timeout: 30_000 })
        // The unloaded history page: B opens Projects for the first time
        // AFTER the rename — the row must show the renamed session.
        await b.page.getByTitle('Projects (Ctrl+B P)').click()
        // Project groups start collapsed (`expandedProjects: new Set()`):
        // expand the one holding the session (title-sync-convergence's
        // documented reveal).
        const bProjectHeader = b.page.locator(`[data-context="history-project"][data-project-path="${journey.server.projectDir}"]`)
        await expect(bProjectHeader).toBeVisible({ timeout: 15_000 })
        await bProjectHeader.click()
        const historyRow = b.page.locator(`[data-context="history-session"][data-session-id="${sessionId}"]`)
        await expect(historyRow).toContainText(newName, { timeout: 30_000 })
        // And the persisted record agrees everywhere.
        const record = await readRecord(journey, sessionRef)
        expect(record.name).toBe(newName)
        await a.context.close()
        await b.context.close()
      } finally {
        await journey.cleanup()
      }
  }
}

export async function manualNameSurvivesLateGenerationAndSwitch(mode: UnifiedAgentMode, browser: Browser): Promise<void> {
  {
    const gemini = await startFakeGemini(AI_NAME, { hold: true })
      const journey = await bootJourney(mode, { gemini })
      try {
        const { page, harness, context } = await connect(journey, browser)
        const created = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
        const handle = await refreshHandle(harness, created, mode)
        await sendFirstMessage(page, harness, handle, mode, 'Hold the generation request')
        // The generation request is provably in flight.
        await expect.poll(() => gemini.requests.length, { timeout: 30_000 }).toBeGreaterThan(0)
        // The manual rename commits mid-flight.
        const manualName = 'Manual beats late AI'
        await renameThroughPaneHeader(page, manualName)
        await expect(
          page.locator('[data-context="pane-header"]:visible').first(),
        ).toContainText(manualName, { timeout: 15_000 })
        // Release the late AI answer: the protected manual name rejects it.
        gemini.release()
        await page.waitForTimeout(3_000)
        const sessionId = await resolveSessionId(journey, handle)
        const sessionRef: SessionNameRef = { kind: 'session', provider: (await modeFixture(mode)).provider, sessionId }
        let record = await readRecord(journey, sessionRef)
        expect(record.name).toBe(manualName)
        expect(record.source).toBe('manual')

        // The conversation switch: the surface adopts the NEW session's
        // name while the old session keeps its manual name. Fresh modes use
        // the pane's Start new conversation control; terminal modes open a
        // second session in a fresh tab (the mode's own resume surface).
        // Before switching, a second turn on the OLD conversation gives its
        // transcript the real-exchange shape (the directory listing's
        // parity filter hides a single-turn session, and after the switch
        // no live pane carries the old row).
        await sendFirstMessage(page, harness, handle, mode, 'A second turn keeps the old session listed')
        const fixture = await modeFixture(mode)
        if (fixture.fresh) {
          // The pane's REAL conversation-switch control: the `/new` slash
          // command in the composer (the Start-new-conversation button only
          // renders on stuck/ended states).
          const paneRoot = page.locator('[data-context="fresh-agent"]').last()
          const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
          await composer.fill('/new')
          await paneRoot.getByRole('button', { name: 'Send' }).click()
          // The new conversation's pane leaves the manual name behind
          // (a NEW session identity with its own naming lifecycle).
          await expect(
            page.locator('[data-context="pane-header"]:visible').first(),
          ).not.toContainText(manualName, { timeout: 30_000 })
        } else {
          const second = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
          await sendFirstMessage(page, harness, second, mode, 'A second conversation')
          await expect(
            page.locator(`[data-context="tab"][data-tab-id="${second.tabId}"]`),
          ).not.toContainText(manualName, { timeout: 30_000 })
        }
        // The OLD session keeps its manual name everywhere.
        record = await readRecord(journey, sessionRef)
        expect(record.name).toBe(manualName)
        await expectSharedName(harness, sessionRef, manualName, {
          page, server: journey.server, surfaces: ['http', 'sidebar'], sessionId,
        })
        await context.close()
      } finally {
        await journey.cleanup()
      }
  }
}
