import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import type { Browser } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  UNIFIED_AGENT_MODES,
  type UnifiedAgentMode,
  bootUnifiedNamesServer,
  connectUnifiedPage,
  createNamedAgent,
  expectSharedName,
  modeFixture,
  refreshHandle,
  renameThroughCanonicalApi,
  renameThroughPaneHeader,
  sendFirstMessage,
  startFakeGemini,
  type FakeGemini,
  type NamedAgentHandle,
  type UnifiedNamesServer,
} from '../helpers/unified-agent-names.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * UNIFIED AGENT NAMES (plan Task 8) — the disposable-lifecycle restart
 * acceptance: eight cases, one per mode plus the migration-crash and the
 * native-write-in-flight specials.
 *
 * Every case runs against OWNED servers this spec boots on ephemeral
 * loopback ports (a persistent scratch HOME for restart survival, a live
 * fake Gemini for the generation lanes) and stops by its recorded PID —
 * never a live target; the destructive restarts here are `RustServer`
 * restart()/restartAbrupt() on processes this spec spawned. Ordinary
 * reconnect is the page's own WS reconnect (no reload), matching the
 * compound-restart contract.
 *
 * Per mode, the case walks the full pre-durable → restart → recovery →
 * materialization → post-durable → restart → second-browser arc:
 *   1. rename BEFORE durable materialization (the pane's pending binding),
 *   2. restart while still zero-turn/pending,
 *   3. recover, and assert the SAME handle/name through runtime-ID API
 *      reads and the restored UI,
 *   4. materialize, and assert ONE atomic pending→session redirect,
 *   5. close/reopen the session, restart after durability, and restore
 *      through a second browser (reminted pane ids, retained name),
 *   6. assert the generation never re-arms (the "no budget reset"
 *      observable: the manual winner stops generation; a restart + more
 *      activity never refires the Gemini request counter),
 *   7. a deliberate user rename still converges both browsers.
 * The deliberate-new-conversation contrast lives in the freshclaude case
 * (a minted conversation gets its own name; the old session keeps it).
 *
 * PRODUCT RESIDUAL (no-modal contract, freshcodex case): with the blocking
 * DeadSessionPanel modal removed, a dead freshcodex session's durable name
 * no longer carries onto a remint through pane chrome. The modal's "Start
 * fresh here" was the one remint verb that preserved the pane's naming
 * identity (resetFreshAgentPaneForReconcileCreate); the only in-pane remint
 * left is the composer's /new, which starts a NEW conversation with the
 * name record STRANDED, and the pane's close button ends the session. The
 * freshcodex case therefore ends at the recovered-name assertion (the pane
 * keeps its manual name while the restoreError banner stands) and drops
 * the materialization steps no honest existing-chrome route reaches.
 */

const AI_NAME = 'Never fired AI name'
const PENDING_NAME = 'Pre-restart pending name'
const MANUAL_AFTER_RESTARTS = 'Manual after restarts'

test.setTimeout(360_000)

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface Journey {
  server: UnifiedNamesServer
  gemini: FakeGemini | null
  homeRoot: string
  cleanup: () => Promise<void>
}

async function bootRestartJourney(
  mode: UnifiedAgentMode,
  opts: { gemini?: FakeGemini | null; env?: Record<string, string>; setupHome?: (homeDir: string) => Promise<void> } = {},
): Promise<Journey> {
  const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-unified-restart-'))
  const homeDir = path.join(homeRoot, 'home')
  await fs.mkdir(homeDir, { recursive: true })
  const server = await bootUnifiedNamesServer({
    mode,
    gemini: opts.gemini ?? null,
    env: opts.env,
    homeDir,
    setupHome: opts.setupHome,
  })
  return {
    server,
    gemini: opts.gemini ?? null,
    homeRoot,
    cleanup: async () => {
      await server.stop().catch(() => {})
      await fs.rm(homeRoot, { recursive: true, force: true }).catch(() => {})
      await opts.gemini?.close().catch(() => {})
    },
  }
}

async function waitWsReady(page: Page, timeoutMs = 90_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as unknown as { __FRESHELL_TEST_HARNESS__?: { getWsReadyState: () => string } })
        .__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

interface NameUpdate {
  record: { name: string; source: string; revision: number; ref: SessionNameRef }
  redirects?: Array<{ from: SessionNameRef; to: SessionNameRef; revision: number }>
  nativeSync?: { status: string; reason?: string }
}

async function readUpdate(journey: Journey, ref: SessionNameRef): Promise<NameUpdate> {
  // A rate-limited read (the shared API bucket) is transient: retry a
  // bounded few times instead of failing the journey on the limiter.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ refs: [ref] }),
    })
    if (response.ok) {
      const payload = await response.json() as { names: NameUpdate[] }
      expect(payload.names[0], `the record for ${JSON.stringify(ref)} resolves`).toBeTruthy()
      return payload.names[0]
    }
    if (attempt >= 5 || response.status !== 429) {
      expect(response.ok, await response.text()).toBe(true)
      throw new Error('unreachable')
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/** Wait for the materialization bind: poll the naming authority until the
 * pane's pre-durable handle redirects onto its durable session record, and
 * answer that bound update. The pane's CONTENT carries the runtime
 * sessionRef BEFORE this bind (freshcodex's `freshAgent.created` already
 * names the prospective thread id, and the rollout-verified bind only fires
 * once the first turn completes), so a session-kind ref is not a naming
 * target until this resolves — a rename addressed to it earlier is a
 * truthful 404 NAME_NOT_FOUND. */
async function waitForMaterializationBind(journey: Journey, pendingRef: SessionNameRef): Promise<NameUpdate> {
  let bound: NameUpdate | null = null
  await expect.poll(async () => {
    bound = await readUpdate(journey, pendingRef)
    return bound.record.ref.kind
  }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBe('session')
  return bound!
}

function sameRef(a: SessionNameRef, b: SessionNameRef): boolean {
  if (a.kind === 'pending' && b.kind === 'pending') return a.id === b.id
  if (a.kind === 'session' && b.kind === 'session') return a.provider === b.provider && a.sessionId === b.sessionId
  return false
}

async function resolveSessionId(journey: Journey, ref: SessionNameRef): Promise<string> {
  if (ref.kind === 'session') return ref.sessionId
  const update = await readUpdate(journey, ref)
  if (update.record.ref.kind === 'session') return update.record.ref.sessionId
  const redirect = update.redirects?.find((r) => r.to.kind === 'session')
  return redirect ? (redirect.to as { sessionId: string }).sessionId : ''
}

async function closeActiveTab(page: Page, harness: TestHarness, tabId: string): Promise<void> {
  const tab = page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
  await tab.getByRole('button', { name: /close/i }).click()
  await expect(tab).toHaveCount(0, { timeout: 15_000 })
}

async function reopenFromSidebar(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(
    page.locator('[data-context="pane-header"]:visible').first(),
  ).toBeVisible({ timeout: 30_000 })
}

// ---------------------------------------------------------------------------
// The six per-mode restart cases
// ---------------------------------------------------------------------------

for (const mode of UNIFIED_AGENT_MODES) {
  test.describe(`[${mode}] unified agent names restart`, () => {
    test('pending rename survives a zero-turn restart and the durable session restores', async ({ browser }) => {
      const gemini = await startFakeGemini(AI_NAME)
      const journey = await bootRestartJourney(mode, { gemini })
      try {
        const fixture = await modeFixture(mode)
        const a = await connectUnifiedPage({ browser, info: journey.server.info })
        let handle = await createNamedAgent(a.harness, mode, { entry: 'ui', page: a.page, server: journey.server })
        handle = await refreshHandle(a.harness, handle, mode)
        const originalRef = handle.nameRef
        expect(originalRef, 'the create admitted a naming identity').toBeTruthy()

        // (1) Rename BEFORE durable materialization, through the pane's own
        // UI entry (the pre-bind seam: the pane's pending binding is the
        // only target that exists yet).
        await renameThroughPaneHeader(a.page, PENDING_NAME)
        await expect(
          a.page.locator('[data-context="pane-header"]:visible').first(),
        ).toContainText(PENDING_NAME)
        const before = await readUpdate(journey, originalRef!)
        expect(before.record.name).toBe(PENDING_NAME)
        expect(before.record.source).toBe('manual')

        // (2) Restart while still zero-turn/pending (owned server, same
        // home/port/token). The page must recover on its own WS reconnect.
        await journey.server.server.restart()
        await waitWsReady(a.page)

        // freshcodex: the REAL app-server's prospective-start semantics
        // leave a zero-turn thread with NO rollout artifact on disk -- the
        // recovery inventory correctly reports it dead (session_not_on_
        // disk). The blocking DeadSessionPanel modal is GONE (no-modal
        // contract): the pane itself announces the death through its
        // restoreError banner, and resolution stays with the existing pane
        // chrome -- never a dialog.
        if (mode === 'freshcodex') {
          // Verdict sync (bounded): the dead verdict folds onto the pane
          // as the durable restoreError latch.
          await expect.poll(async () => {
            const layout = await a.harness.getPaneLayout(handle.tabId)
            const content = layout?.content ?? null
            return content?.restoreError?.reason ?? null
          }, { timeout: 45_000 }).toBe('durable_artifact_missing')
          // The pane's own banner announces the death (FreshAgentView's
          // durable_artifact_missing restoreError text, role="alert").
          await expect(
            a.page.getByRole('alert').filter({
              hasText: 'This session cannot be resumed because the saved session artifact is no longer available.',
            }),
          ).toBeVisible({ timeout: 10_000 })
          // NEVER a modal: zero Dead sessions dialogs.
          await expect(a.page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
        }

        // (3) The recovered UI still shows the name...
        await expect(
          a.page.locator('[data-context="pane-header"]:visible').first(),
        ).toContainText(PENDING_NAME, { timeout: 45_000 })
        // ...and the runtime-ID API read resolves the SAME handle/name
        // (nothing was re-minted or lost through the restart).
        const afterRestart = await readUpdate(journey, originalRef!)
        expect(afterRestart.record.name).toBe(PENDING_NAME)
        expect(afterRestart.record.revision).toBeGreaterThanOrEqual(before.record.revision)

        // (4)-(9) need the MATERIALIZED durable session. freshcodex: the
        // zero-turn thread is DEAD after the restart and, with the modal
        // gone, no honest existing-chrome route reaches a materialization
        // anymore -- the modal's "Start fresh here" was the one remint verb
        // that preserved the pane's naming identity
        // (resetFreshAgentPaneForReconcileCreate); the only in-pane remint
        // left is the composer's /new, which starts a NEW conversation with
        // the name record STRANDED (see the header residual note). The
        // freshcodex journey therefore ENDS at step (3): the pane keeps its
        // manual name while the death banner stands.
        if (mode !== 'freshcodex') {
          // (4) Materialize on the recovered runtime: the first real input
          // creates the durable identity and the store transfers the pending
          // record in ONE atomic redirect.
          await sendFirstMessage(a.page, a.harness, handle, mode, 'Materialize after the restart')
          handle = await refreshHandle(a.harness, handle, mode)
          let sessionId = ''
          await expect.poll(async () => {
            sessionId = (handle.sessionId
              ?? (handle.nameRef?.kind === 'session' ? handle.nameRef.sessionId : ''))
              || await resolveSessionId(journey, originalRef!)
            return sessionId
          }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toBeTruthy()
          const sessionRef: SessionNameRef = { kind: 'session', provider: fixture.provider, sessionId }
          if (originalRef!.kind === 'pending') {
            // The pane's CONTENT materializes (the runtime frame folds the
            // durable sessionRef) BEFORE the naming bind redirects the
            // pending record — wait for the redirect to land before the
            // atomicity asserts.
            const viaPending = await waitForMaterializationBind(journey, originalRef!)
            // One atomic redirect: the pending ref resolves to the durable
            // record, and the redirect is recorded on the same revision.
            expect(viaPending.record.ref).toEqual(sessionRef)
            expect(viaPending.record.name).toBe(PENDING_NAME)
            expect(
              viaPending.redirects?.some((r) => sameRef(r.from, originalRef!) && sameRef(r.to, sessionRef)),
              'the pending→session redirect is present',
            ).toBe(true)
            const viaSession = await readUpdate(journey, sessionRef)
            expect(viaSession.record.name).toBe(PENDING_NAME)
            expect(viaSession.record.revision).toBe(viaPending.record.revision)
          } else {
            // An already-durable zero-turn identity (opencode's admitted
            // pre-POST variant): the name carried across the restart.
            const viaSession = await readUpdate(journey, sessionRef)
            expect(viaSession.record.name).toBe(PENDING_NAME)
          }

          // (5) Close the tab, reopen the durable session from the sidebar —
          // the reopened pane/tab have NEW (reminted) ids and the SAME name.
          // A second turn first: the directory listing's parity filter hides
          // a single-turn transcript (non-interactive), and the reopen's row
          // comes from the directory once the pane is closed.
          await sendFirstMessage(a.page, a.harness, handle, mode, 'A second turn makes the exchange real')
          const originalTabId = handle.tabId
          const originalPaneId = handle.paneId
          await closeActiveTab(a.page, a.harness, originalTabId)
          await reopenFromSidebar(a.page, sessionId)
          const reopenedTabId = (await a.harness.getActiveTabId())!
          expect(reopenedTabId).not.toBe(originalTabId)
          await expect(
            a.page.locator('[data-context="pane-header"]:visible').first(),
          ).toContainText(PENDING_NAME, { timeout: 30_000 })
          const reopenedPaneId = ((await a.harness.getPaneLayout(reopenedTabId))?.id ?? '') as string
          expect(reopenedPaneId).toBeTruthy()
          expect(reopenedPaneId).not.toBe(originalPaneId)
          // The reopened tab is session-owned: its label follows the session.
          await expect(
            a.page.locator(`[data-context="tab"][data-tab-id="${reopenedTabId}"]`),
          ).toContainText(PENDING_NAME, { timeout: 30_000 })
          // The reopened pane is the new send target.
          handle = { ...handle, tabId: reopenedTabId, paneId: reopenedPaneId }

          // (6) Restart AFTER durability; restore through a second browser.
          await journey.server.server.restart()
          await waitWsReady(a.page)
          const b = await connectUnifiedPage({ browser, info: journey.server.info })
          try {
            // Both browsers show the SAME saved name everywhere.
            await expectSharedName(a.harness, sessionRef, PENDING_NAME, {
              page: a.page, server: journey.server, surfaces: ['http', 'redux', 'pane', 'sidebar'],
            })
            await expectSharedName(b.harness, sessionRef, PENDING_NAME, {
              page: b.page, server: journey.server, surfaces: ['http', 'redux', 'sidebar'],
            })
            await expect(
              b.page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`),
            ).toContainText(PENDING_NAME, { timeout: 30_000 })

            // (7) No budget reset / no re-arm: the manual winner stops
            // generation, so more activity plus the restart never refires it.
            expect(gemini.requests.length).toBe(0)
            await sendFirstMessage(a.page, a.harness, handle, mode, 'More activity after the restarts')
            await a.page.waitForTimeout(8_000)
            expect(gemini.requests.length, 'a manual winner + a restart never re-arms generation').toBe(0)
            const settled = await readUpdate(journey, sessionRef)
            expect(settled.record.name).toBe(PENDING_NAME)
            expect(settled.record.source).toBe('manual')

            // (8) A deliberate user rename post-restart converges everywhere.
            await renameThroughCanonicalApi(journey.server, sessionRef, MANUAL_AFTER_RESTARTS, 'user')
            await expectSharedName(a.harness, sessionRef, MANUAL_AFTER_RESTARTS, {
              page: a.page, server: journey.server, tabId: reopenedTabId, sessionId,
            })
            await expect(
              b.page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`),
            ).toContainText(MANUAL_AFTER_RESTARTS, { timeout: 30_000 })

            // (9) The deliberate-new-conversation contrast (freshclaude —
            // the mode with the in-pane control): a MINTED conversation is a
            // NEW session identity; it never inherits the old session's name,
            // while the established session keeps its manual name.
            if (mode === 'freshclaude') {
              // The pane's REAL conversation-switch control: the `/new` slash
              // command in the composer (the Start-new-conversation button
              // only renders on stuck/ended states).
              const paneRoot = a.page.locator('[data-context="fresh-agent"]').last()
              const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
              await composer.fill('/new')
              await paneRoot.getByRole('button', { name: 'Send' }).click()
              await expect(
                a.page.locator('[data-context="pane-header"]:visible').first(),
              ).not.toContainText(MANUAL_AFTER_RESTARTS, { timeout: 45_000 })
              const oldKept = await readUpdate(journey, sessionRef)
              expect(oldKept.record.name).toBe(MANUAL_AFTER_RESTARTS)
              expect(oldKept.record.source).toBe('manual')
            }
          } finally {
            await b.context.close()
          }
        }
        await a.context.close()
      } finally {
        await journey.cleanup()
      }
    })
  })
}

// ---------------------------------------------------------------------------
// The crash-after-migration-commit case (second same-home server + idle
// browser through reconciliation and alias-path locking)
// ---------------------------------------------------------------------------

test.describe('unified agent names migration crash', () => {
  test('crash after the migration commit: a second same-home server and an idle browser converge and the legacy alias stays locked', async ({ browser }) => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-unified-migration-'))
    const homeDir = path.join(homeRoot, 'home')
    const projectDir = path.join(homeRoot, 'proj')
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee2201'
    const migratedName = 'Migrated winner label'
    const staleName = 'Stale device revival label'
    try {
      await fs.mkdir(homeDir, { recursive: true })
      await fs.mkdir(projectDir, { recursive: true })
      // The seed evidence the boot consolidation reads: a legacy
      // config.sessionOverrides row (a user-titled override) for a REAL
      // claude session (an ordinary user transcript the index adopts).
      const mangled = projectDir.replace(/[^A-Za-z0-9]/g, '-')
      const transcriptDir = path.join(homeDir, '.claude', 'projects', mangled)
      await fs.mkdir(transcriptDir, { recursive: true })
      // TWO user-authored records: the directory listing's parity filter
      // hides a single-turn transcript (non-interactive), and the idle
      // browser's sidebar row comes from that listing.
      await fs.writeFile(path.join(transcriptDir, `${sessionId}.jsonl`), [
        JSON.stringify({
          type: 'user',
          uuid: '11111111-2222-4333-8444-555555555555',
          parentUuid: null,
          timestamp: '2026-09-18T07:30:00.000Z',
          cwd: projectDir,
          sessionId,
          isSidechain: false,
          message: { role: 'user', content: 'Migration crash probe' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: '11111111-2222-4333-8444-555555555556',
          parentUuid: '11111111-2222-4333-8444-555555555555',
          timestamp: '2026-09-18T07:31:00.000Z',
          cwd: projectDir,
          sessionId,
          isSidechain: false,
          message: { role: 'user', content: 'A second turn keeps the session listed' },
        }),
      ].map((line) => `${line}\n`).join(''))

      const seedConfig = async (title: string) => {
        const configPath = path.join(homeDir, '.freshell', 'config.json')
        let config: Record<string, unknown> = {}
        try {
          config = JSON.parse(await fs.readFile(configPath, 'utf8'))
        } catch {
          config = { version: 1, settings: {} }
        }
        const settings = (config.settings ?? {}) as Record<string, unknown>
        settings.codingCli = { enabledProviders: ['claude'] }
        config.settings = settings
        config.sessionOverrides = {
          [`claude:${sessionId}`]: { titleOverride: title, titleSource: 'user' },
        }
        await fs.writeFile(configPath, JSON.stringify(config, null, 2))
      }

      // Server A: the boot consolidation runs before the listener binds —
      // once start() resolves, the migration receipt is committed.
      const serverA = await bootUnifiedNamesServer({
        mode: 'claude',
        homeDir,
        setupHome: async () => { await seedConfig(migratedName) },
      })
      try {
        const ref: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
        const readOn = async (server: UnifiedNamesServer) => {
          const response = await fetch(`${server.info.baseUrl}/api/session-names/read`, {
            method: 'POST',
            headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
            body: JSON.stringify({ refs: [ref] }),
          })
          // Read the body ONCE: an eagerly-evaluated `await response.text()`
          // expect-message consumes it, and the follow-up `.json()` would
          // throw "Body is unusable" on the OK path.
          const text = await response.text()
          expect(response.ok, text).toBe(true)
          const payload = JSON.parse(text) as { names: NameUpdate[] }
          return payload.names[0]
        }
        const onA = await readOn(serverA)
        expect(onA.record.name, 'the boot consolidation installed the override winner').toBe(migratedName)
        expect(onA.record.source).toBe('manual')

        // Server B: a SECOND same-home participant booted BEFORE the
        // crash — it adopts A's committed document through its own boot
        // reconciliation and holds it through A's death.
        const serverB = await bootUnifiedNamesServer({
          mode: 'claude',
          homeDir,
          setupHome: async () => { await seedConfig(migratedName) },
        })
        try {
          // An IDLE browser on B (boot + connection, no interaction).
          const idle = await connectUnifiedPage({ browser, info: serverB.info })
          try {
            const onB = await readOn(serverB)
            expect(onB.record.name).toBe(migratedName)
            expect(onB.record.revision).toBeGreaterThanOrEqual(onA.record.revision)

            // The crash AFTER the migration commit: SIGKILL + revival on
            // the same home/port (B held through the crash; the document
            // lock coordinates the two same-home participants).
            await serverA.server.restartAbrupt()
            const revived = await readOn(serverA)
            expect(revived.record.name).toBe(migratedName)
            const heldB = await readOn(serverB)
            expect(heldB.record.name, 'the second same-home server converged through the crash').toBe(migratedName)
            expect(heldB.record.revision).toBeGreaterThanOrEqual(revived.record.revision)

            // The stale legacy writer: a side-by-side process re-introduces
            // the OLD override row in config.json (the alias path). Server C
            // boots on the same home AFTER the receipt — the committed
            // migration never re-runs and the directory lane never consults
            // the migrated row again, so the stale label cannot replace the
            // canonical winner.
            await seedConfig(staleName)
            const serverC = await bootUnifiedNamesServer({
              mode: 'claude',
              homeDir,
              setupHome: async () => { await seedConfig(staleName) },
            })
            try {
              const onC = await readOn(serverC)
              expect(onC.record.name, 'the receipt-gated boot never re-imports the stale alias').toBe(migratedName)
              expect(onC.record.source).toBe('manual')
              const heldB2 = await readOn(serverB)
              expect(heldB2.record.name, 'the running same-home server keeps the winner').toBe(migratedName)
              // The idle browser's directory view shows the winner (the
              // post-receipt row never consults the override ladder).
              await expect(
                idle.page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`),
              ).toContainText(migratedName, { timeout: 30_000 })
            } finally {
              await serverC.stop().catch(() => {})
            }
          } finally {
            await idle.context.close()
          }
        } finally {
          await serverB.stop().catch(() => {})
        }
      } finally {
        await serverA.stop().catch(() => {})
      }
    } finally {
      await fs.rm(homeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ---------------------------------------------------------------------------
// The native-write-in-flight restart case (outstanding old receipt, finite
// reconciliation, source protection)
// ---------------------------------------------------------------------------

test.describe('unified agent names native write in flight', () => {
  test('a native write held across a restart reconciles finitely and the manual source survives', async ({ browser }) => {
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-unified-inflight-'))
    const homeDir = path.join(homeRoot, 'home')
    await fs.mkdir(homeDir, { recursive: true })
    const holdFile = path.join(homeRoot, 'hold-name-set.lock')
    const inflightName = 'In-flight manual name'
    // Hold every thread/name/set the fake app-server receives while the
    // hold file exists (the in-flight native write).
    await fs.writeFile(holdFile, 'held\n')
    const journey = await bootRestartJourney('freshcodex', { env: { FAKE_CODEX_HOLD_NAME_SET_FILE: holdFile } })
    try {
      const a = await connectUnifiedPage({ browser, info: journey.server.info })
      let handle = await createNamedAgent(a.harness, 'freshcodex', { entry: 'ui', page: a.page, server: journey.server })
      await sendFirstMessage(a.page, a.harness, handle, 'freshcodex', 'Materialize for the in-flight write')
      handle = await refreshHandle(a.harness, handle, 'freshcodex')
      const sessionId = handle.sessionId
        ?? (handle.nameRef?.kind === 'session' ? handle.nameRef.sessionId : '')
      expect(sessionId, 'the freshcodex pane carries its runtime thread id').toBeTruthy()
      const sessionRef: SessionNameRef = { kind: 'session', provider: 'codex', sessionId }
      // The pane names through its pre-durable handle until the first
      // turn's rollout verifies the materialization bind; only then is the
      // thread a naming target. Rename the DURABLE record (the native
      // writeback needs its verified location), and prove the handle bound
      // onto the pane's own thread.
      const pendingRef = handle.nameRef
      expect(pendingRef?.kind, 'the freshcodex pane names through its pending handle').toBe('pending')
      const bound = await waitForMaterializationBind(journey, pendingRef!)
      expect(bound.record.ref, "the handle bound onto the pane's own thread").toEqual(sessionRef)

      // The deliberate user rename: the native worker dispatches the
      // writeback, and the fake app-server HOLDS it — the receipt is
      // outstanding and the status is pending, never a fabricated success.
      await renameThroughCanonicalApi(journey.server, sessionRef, inflightName, 'user')
      let inFlight = await readUpdate(journey, sessionRef)
      expect(inFlight.record.name).toBe(inflightName)
      expect(inFlight.record.source).toBe('manual')
      await expect.poll(async () => {
        inFlight = await readUpdate(journey, sessionRef)
        return inFlight.nativeSync?.status ?? 'absent'
      }, { timeout: 30_000, intervals: [1_000, 2_000] }).not.toBe('synced')

      // Restart the OWNED server while the write is in flight. The old
      // receipt survives as an outstanding/ambiguous result: no success is
      // fabricated, the canonical winner is untouched (source protection),
      // and the pane recovers on its own reconnect.
      await journey.server.server.restart()
      await waitWsReady(a.page)
      const afterRestart = await readUpdate(journey, sessionRef)
      expect(afterRestart.record.name).toBe(inflightName)
      expect(afterRestart.record.source).toBe('manual')
      expect(afterRestart.nativeSync?.status ?? 'absent').not.toBe('synced')

      // Release the held write; the restarted server's finite
      // reconciliation (remaining cycles, no replenishment) converges the
      // native value and confirms it by readback.
      await fs.rm(holdFile, { force: true })
      let reconciled: NameUpdate | null = null
      await expect.poll(async () => {
        reconciled = await readUpdate(journey, sessionRef)
        return reconciled.nativeSync?.status ?? 'absent'
      }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toBe('synced')
      // The echoed observation stayed automatic: the canonical record keeps
      // the manual name and source through the whole reconciliation.
      expect(reconciled!.record.name).toBe(inflightName)
      expect(reconciled!.record.source).toBe('manual')
      await a.context.close()
    } finally {
      await journey.cleanup()
      await fs.rm(homeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
