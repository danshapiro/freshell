import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * The 2026-09-20 daemon-death incident class, end to end (the cloud-legal
 * leg): a freshopencode pane whose snapshot GET first answers the typed 409
 * RESTORE_UNAVAILABLE (ownerKind fresh-agent + the coordinator's CURRENT
 * ownerGeneration — the exact envelope the Rust server mints for a session
 * key that stayed Live{FreshAgent} across the daemon death) must NOT
 * dead-end on the dismiss-only banner. It drives the documented recovery
 * ONCE per pane identity: refresh the observed owner fence from the
 * refusal's own generation, send ONE generation-fenced freshAgent.attach,
 * and refetch through the 200.
 *
 * Mechanics follow freshopencode-model-picker.spec.ts exactly — every fetch
 * is routed and the sidecar is suppressed through the test harness — so the
 * spec needs no opencode binary and no provider-boot timing: the explicitly
 * cloud-legal pattern (playwright.cloud.config.ts:36-38). It must never
 * join CLOUD_SKIP_SPECS / LOCAL_ONLY_SPECS or match a CLOUD_SKIP_TITLES
 * pattern.
 */

const SESSION_ID = 'ses_e2e_409'
const RECOVERED_TEXT = 'Recovered transcript after the fenced attach and refetch.'
/** The pane's OWN stale Live{FreshAgent, gen 1} claim — the incident shape. */
const SEEDED_RECORD_EPOCH = 1
const SEEDED_RECORD_GENERATION = 1
/**
 * The refusal names the coordinator's CURRENT generation — newer than the
 * client's stale record. The recovery attach MUST carry this generation (the
 * fence binds to the refusal, not the possibly-stale record), which is what
 * makes the post-409 recovery attach distinguishable from the mount attach
 * in the WS spy (LB-09: a bare attach-count assertion is vacuous — the mount
 * attach also appears in the spy log).
 */
const REFUSAL_OWNER_GENERATION = 2

/** A minimal valid FreshAgentSnapshot (schema-complete: tokenUsage is
 * required by FreshAgentSnapshotSchema) whose assistant turn is the
 * recovered transcript the 200 refetch must render. */
function recoveredSnapshot() {
  return {
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: SESSION_ID,
    sessionId: SESSION_ID,
    revision: 2,
    latestTurnId: 'msg_recovered_1',
    status: 'idle',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: true,
      questions: true,
      fork: true,
    },
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    pendingApprovals: [],
    pendingQuestions: [],
    turns: [
      { id: 'msg_user_1', turnId: 'msg_user_1', role: 'user', summary: 'go', items: [{ id: 'user-text', kind: 'text', text: 'go' }] },
      { id: 'msg_recovered_1', turnId: 'msg_recovered_1', role: 'assistant', summary: RECOVERED_TEXT, items: [{ id: 'assistant-text', kind: 'text', text: RECOVERED_TEXT }] },
    ],
  }
}

async function enableFreshClientsAndOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: true, opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function routeFileApis(page: Page, cwd: string): Promise<void> {
  await page.route('**/api/files/candidate-dirs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ directories: ['/tmp'] }),
    })
  })
  await page.route('**/api/files/validate-dir', async (route) => {
    const body = route.request().postDataJSON() as { path?: string }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, resolvedPath: body?.path ?? cwd }),
    })
  })
}

/**
 * Seed the runtime-owner record the incident premise needs: the session key
 * stayed Live{FreshAgent, gen 1} while the daemon was dead, so the client
 * holds a stale owner record the 409's fence must refresh (applyRefusalFence
 * is advance-only on the EXISTING record — without it there is no fence to
 * refresh and the recovery attach would go out unfenced).
 */
async function seedIncidentOwnerRecord(page: Page): Promise<void> {
  await page.evaluate((record) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'freshAgent/applyRuntimeOwner',
      payload: record,
    })
  }, {
    type: 'session.runtimeOwner',
    provider: 'opencode',
    sessionId: SESSION_ID,
    epoch: SEEDED_RECORD_EPOCH,
    generation: SEEDED_RECORD_GENERATION,
    ownerKind: 'fresh-agent',
    operationId: 'e2e-incident-live-claim',
    transition: 'handoff-committed',
  })
}

/**
 * Create a freshopencode pane through the picker (the model-picker pattern)
 * and hand it the durable ses_* session — the pane a user re-opens from a
 * persisted layout while the server-side key is still Live{FreshAgent}.
 * Sweeping caveat: the picker pane is REPLACED by the real fresh-agent pane
 * with a NEW pane id on selection, so the suppression flag and the session
 * handoff must target the post-creation fresh-agent leaf in
 * state.panes.layouts, never an id captured from the picker DOM.
 */
async function createFreshopencodePaneWithDurableSession(page: Page, cwd: string): Promise<void> {
  // Suppress ALL fresh-agent network effects BEFORE the pane exists: creation
  // fires its session-create effect immediately, and a per-pane flag set after
  // the fact races it. Every freshAgent.* frame then lands in the harness's
  // sent-message spy (getSentWsMessages) instead of the wire — including the
  // mount attach AND the post-409 recovery attach this spec counts.
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(true)
  })
  const picker = await openPanePicker(page)
  await expect(picker.getByRole('button', { name: /^Freshopencode$/i })).toBeVisible({ timeout: 10_000 })
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })

  await page.evaluate((session) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) return
    const state = harness.getState()
    const tabId = state.tabs.activeTabId as string | undefined
    if (!tabId) return
    // The tab may be a SPLIT (terminal + fresh pane), so walk the tree for
    // the fresh-agent leaf rather than assuming the root is a leaf.
    type LayoutNode = { id: string; type: string; content?: { kind?: string }; children?: LayoutNode[] }
    const findFreshLeaf = (node: LayoutNode | undefined): LayoutNode | undefined => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
      for (const child of node.children ?? []) {
        const found = findFreshLeaf(child)
        if (found) return found
      }
      return undefined
    }
    const leaf = findFreshLeaf(state.panes.layouts[tabId] as LayoutNode | undefined)
    if (!leaf) return
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId: leaf.id,
        content: {
          ...leaf.content,
          sessionId: session.sessionId,
          sessionRef: { provider: 'opencode', sessionId: session.sessionId },
          resumeSessionId: session.sessionId,
          status: 'idle',
        },
      },
    })
  }, { sessionId: SESSION_ID })
}

/** The active tab's fresh-agent leaf content, via the harness store. */
async function readFreshAgentPaneContent(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) return undefined
    const state = harness.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    if (!tabId) return undefined
    type LayoutNode = { id: string; type: string; content?: { kind?: string }; children?: LayoutNode[] }
    const findFreshLeaf = (node: LayoutNode | undefined): LayoutNode | undefined => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
      for (const child of node.children ?? []) {
        const found = findFreshLeaf(child)
        if (found) return found
      }
      return undefined
    }
    return findFreshLeaf(state.panes.layouts[tabId] as LayoutNode | undefined)?.content as Record<string, unknown> | undefined
  })
}

test.describe('Freshopencode snapshot-409 recovery (cloud-legal)', () => {
  test('freshopencode pane recovers from a snapshot 409 via fenced attach and refetch', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    test.setTimeout(120_000)
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-snapshot-409-'))

    // Route the snapshot thread path BEFORE any pane exists: the FIRST GET
    // answers the incident-class typed 409 (the snapshot_error_response
    // envelope the Rust server mints for a Live{FreshAgent} key), every
    // subsequent GET answers the recovered 200 snapshot.
    const servedStatuses: number[] = []
    const snapshotTriggers: Array<string | null> = []
    let releaseRefusal!: () => void
    const refusalGate = new Promise<void>(resolve => { releaseRefusal = resolve })
    await page.route(`**/api/fresh-agent/threads/freshopencode/opencode/${SESSION_ID}**`, async (route) => {
      snapshotTriggers.push(new URL(route.request().url()).searchParams.get('trigger'))
      if (servedStatuses.length === 0) {
        servedStatuses.push(409)
        // Mount must settle before its failure starts a recovery epoch.
        await refusalGate
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'error',
            code: 'RESTORE_UNAVAILABLE',
            message: `Session ${SESSION_ID} is still running on the server.`,
            ownerKind: 'fresh-agent',
            ownerGeneration: REFUSAL_OWNER_GENERATION,
          }),
        })
        return
      }
      servedStatuses.push(200)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(recoveredSnapshot()),
      })
    })
    await routeFileApis(page, cwd)
    await enableFreshClientsAndOpencode(page)
    await seedIncidentOwnerRecord(page)
    await createFreshopencodePaneWithDurableSession(page, cwd)
    await expect.poll(() => servedStatuses.length, { timeout: 20_000 }).toBe(1)
    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages() as Array<Record<string, unknown>>
      return sent.filter(message => message.type === 'freshAgent.attach'
        && message.sessionId === SESSION_ID
        && message.observedEpoch === SEEDED_RECORD_EPOCH
        && message.observedGeneration === SEEDED_RECORD_GENERATION).length
    }, { timeout: 20_000, message: 'the exact mount attach is observed before releasing the 409' }).toBe(1)
    releaseRefusal()

    // The mount snapshot GET landed the typed 409 (the incident premise —
    // a filter that never saw the 409 proves nothing).
    await expect.poll(() => servedStatuses[0] ?? 0, { timeout: 20_000 }).toBe(409)

    // The post-409 delta (LB-09): a freshAgent.attach carrying the refusal's
    // CURRENT generation appeared in the WS spy AFTER the 409 landed. Only
    // applyRefusalFence can mint generation 2 on the seeded gen-1 record, so
    // this frame is the recovery attach — the mount attach is the gen-1 one.
    await expect.poll(async () => {
      const sent = (await harness.getSentWsMessages()) as Array<Record<string, unknown>>
      return sent.filter((message) => (
        message?.type === 'freshAgent.attach'
        && message.observedGeneration === REFUSAL_OWNER_GENERATION
      )).length
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)

    // The recovery refetch landed and was answered 200.
    await expect.poll(() => servedStatuses[1] ?? 0, { timeout: 20_000 }).toBe(200)

    // The transcript renders from the 200 snapshot — the pane is live again.
    const transcript = page.locator('[data-context="fresh-agent-transcript"]')
    await expect(transcript.getByText(RECOVERED_TEXT)).toBeVisible({ timeout: 15_000 })

    // Settled state: exactly ONE recovery attach (the once-per-identity
    // guard), carrying the record's PRESERVED epoch and the refusal's
    // CURRENT generation, and exactly one recovery refetch (no 409 fetch
    // loop).
    const sent = (await harness.getSentWsMessages()) as Array<Record<string, unknown>>
    const attaches = sent.filter((message) => message?.type === 'freshAgent.attach')
    const mountAttaches = attaches.filter((message) => (
      message.observedEpoch === SEEDED_RECORD_EPOCH
      && message.observedGeneration === SEEDED_RECORD_GENERATION
    ))
    expect(mountAttaches.length, 'the mount attach (fenced at the seeded record) must also be in the spy — the delta is not vacuous').toBeGreaterThanOrEqual(1)
    const recoveryAttaches = attaches.filter((message) => message.observedGeneration === REFUSAL_OWNER_GENERATION)
    expect(recoveryAttaches, 'exactly one post-409 recovery attach per pane identity').toHaveLength(1)
    expect(recoveryAttaches[0]).toMatchObject({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: SESSION_ID,
      observedEpoch: SEEDED_RECORD_EPOCH,
      observedGeneration: REFUSAL_OWNER_GENERATION,
    })
    expect(servedStatuses, `one mount 409 + one recovery 200 refetch, no loop; triggers=${JSON.stringify(snapshotTriggers)}`).toEqual([409, 200])

    // The pane kept its identity (the 409 arm is NOT the 404 lost-thread
    // reset — that arm clears the session).
    const content = await readFreshAgentPaneContent(page)
    expect(content?.sessionId).toBe(SESSION_ID)
    expect(content?.status).not.toBe('create-failed')

    // No dismiss-only dead-end banner remains, and the composer is usable
    // again — the pane recovered instead of dead-ending.
    await expect(page.locator('[data-agent-error="load"], [data-agent-error="session"]')).toHaveCount(0)
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled({ timeout: 15_000 })
  })
})
