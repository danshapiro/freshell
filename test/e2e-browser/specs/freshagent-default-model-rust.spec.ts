/**
 * FRESH-PANE DEFAULT MODEL (G11) — PW-RUST e2e.
 *
 * The model saved for Freshclaude/Kilroy (the model dialog and the settings
 * popover save it as `freshAgent.providers[type].modelSelection`) must reach
 * the sidecar for:
 *   1. a NEW pane created through the picker, and
 *   2. a pane created to RESUME a session from the sidebar — which starts on
 *      the CURRENT saved default, not the model the conversation last used
 *      (decision D2, matching `claude --resume`).
 *
 * The spec drives the real Rust server + real browser UI against the
 * deterministic fake Claude-SDK sidecar and asserts the EXACT `create` frame
 * the server wrote to the sidecar's stdin (FRESHELL_FAKE_STDIN raw audit).
 * The saved default is written through the real `PATCH /api/settings` route
 * and observed in the client's settings before any pane is created.
 *
 * Pre-fix, both create frames carried the registry default `opus[1m]`.
 *
 * CLOUD-LEGALITY: no idle-grace or timing dependencies — every wait is a poll
 * on observed state (stdin audit rows, pane layout, sidebar rows).
 *
 * Helpers are copied, not imported, per this suite's per-spec-ownership
 * convention (donor: fresh-agent-control-rust.spec.ts — boot, stdin audit,
 * pane bootstrap; auto-title-rust.spec.ts — sidebar row click).
 */
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, GEMINI_STRIP_ENV_PREFIXES } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLAUDE_SIDECAR_FIXTURE = path.resolve(__dirname, '../fixtures/providers/fake-claude-sdk-sidecar.mjs')

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Flavour = 'freshclaude' | 'kilroy'

// ── Copied helpers ──────────────────────────────────────────────────────────

async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

function readJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((row) => row !== null)
}

/** Read the sidecar raw-stdin audit, JSON-parsing each recorded frame. */
function readStdinFrames(stdinLog: string): any[] {
  return readJsonl(stdinLog)
    .map((row) => {
      try {
        return JSON.parse(row.line)
      } catch {
        return null
      }
    })
    .filter((frame) => frame !== null)
}

async function waitForStdinFrame(
  stdinLog: string,
  pred: (frame: any) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<any> {
  let found: any = null
  await expect
    .poll(
      () => {
        found = readStdinFrames(stdinLog).find(pred) ?? null
        return Boolean(found)
      },
      { timeout: timeoutMs, message: `timed out waiting for ${what} in ${stdinLog}` },
    )
    .toBe(true)
  return found
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

async function paneLeaf(harness: TestHarness, tabId: string): Promise<any> {
  return findFreshAgentLeaf(await harness.getPaneLayout(tabId))
}

async function waitForPaneStatus(harness: TestHarness, tabId: string, wanted: string): Promise<void> {
  await expect
    .poll(async () => (await paneLeaf(harness, tabId))?.content?.status ?? null, { timeout: 30_000 })
    .toBe(wanted)
}

/** Save the fresh-pane default model through the real settings route, then
 * wait until the client has folded it (settings.updated broadcast). */
async function saveDefaultModel(
  info: E2eServerInfo,
  harness: TestHarness,
  flavour: Flavour,
  modelId: string,
): Promise<void> {
  const res = await fetch(`${info.baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
    body: JSON.stringify({
      freshAgent: { providers: { [flavour]: { modelSelection: { kind: 'exact', modelId } } } },
    }),
  })
  expect(res.ok, `PATCH /api/settings failed: ${res.status}`).toBe(true)
  await expect
    .poll(
      async () => (await harness.getSettings())?.freshAgent?.providers?.[flavour]?.modelSelection?.modelId ?? null,
      { timeout: 15_000, message: `the client folds the saved ${flavour} default` },
    )
    .toBe(modelId)
}

async function bootLane(page: Page, flavour: Flavour): Promise<{
  server: RustServer
  info: E2eServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  stdinLog: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-default-model-${flavour}-`))
  const projectDir = path.join(sharedRoot, 'project')
  await fs.mkdir(projectDir, { recursive: true })
  const stdinLog = path.join(sharedRoot, 'sidecar-stdin.jsonl')
  const server = new RustServer({
    env: {
      FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR_FIXTURE,
      FRESHELL_CLAUDE_NODE: process.execPath,
      FRESHELL_FAKE_PROVIDER: flavour,
      FRESHELL_FAKE_STDIN: stdinLog,
      FRESHELL_FAKE_EVENTS: path.join(sharedRoot, 'sidecar-events.jsonl'),
      ...(flavour === 'kilroy' ? { KILROY_ENABLED: '1' } : {}),
    },
    stripEnvPrefixes: flavour === 'kilroy' ? [...GEMINI_STRIP_ENV_PREFIXES] : undefined,
    setupHome: async (homeDir) => {
      const freshellDir = path.join(homeDir, '.freshell')
      await fs.mkdir(freshellDir, { recursive: true })
      await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
        version: 1,
        settings: {
          codingCli: { enabledProviders: ['claude'] },
          freshAgent: { enabled: true },
          // The fixture conversation never gets a title, and the default
          // hideEmptySessions drops an untitled row once its pane closes;
          // keep it listed so the sidebar can resume it.
          sidebar: { hideEmptySessions: false },
        },
      }, null, 2))
    },
  })
  try {
    const info = await server.start()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await page.evaluate(() => {
      ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'connection/setAvailableClis',
        payload: { claude: true },
      })
    })
    return { server, info, harness, sharedRoot, projectDir, stdinLog }
  } catch (error) {
    await server.stop().catch(() => {})
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Append one user/assistant exchange to the session's CLI transcript
 * (`~/.claude/projects/<mangled cwd>/<id>.jsonl`, parentUuid-chained like
 * the CLI and the fake sidecar write it). */
async function appendTranscriptExchange(
  homeDir: string,
  cwd: string,
  sessionId: string,
  userText: string,
): Promise<void> {
  const file = path.join(homeDir, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const existing = existsSync(file) ? readJsonl(file) : []
  let parentUuid: string | null = existing.length > 0 ? existing[existing.length - 1]?.uuid ?? null : null
  const lines = (['user', 'assistant'] as const).map((role) => {
    const uuid = randomUUID()
    const line = {
      type: role,
      uuid,
      parentUuid,
      timestamp: new Date().toISOString(),
      cwd,
      message: { role, content: [{ type: 'text', text: role === 'user' ? userText : 'Fixture reply' }] },
    }
    parentUuid = uuid
    return JSON.stringify(line)
  })
  await fs.appendFile(file, `${lines.join('\n')}\n`)
}

const LABELS: Record<Flavour, string> = { freshclaude: 'Freshclaude', kilroy: 'Kilroy' }

async function runDefaultModelJourney(page: Page, flavour: Flavour): Promise<void> {
  const lane = await bootLane(page, flavour)
  try {
    const { harness, info, stdinLog } = lane
    const label = LABELS[flavour]
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()

    // ── 1. A NEW pane starts on the saved default ──────────────────────────
    await saveDefaultModel(info, harness, flavour, 'sonnet')

    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: new RegExp(`^${label}$`) }).click({ force: true })
    const directoryInput = page.getByLabel(new RegExp(`^Starting directory for ${label}$`, 'i'))
    await expect(directoryInput).toBeVisible({ timeout: 15_000 })
    await directoryInput.fill(lane.projectDir)
    await directoryInput.press('Enter')
    const paneRoot = page.locator('[data-context="fresh-agent"]').last()
    await expect(paneRoot).toBeVisible({ timeout: 15_000 })

    const freshCreate = await waitForStdinFrame(
      stdinLog,
      (frame) => frame?.type === 'create' && !frame?.resumeSessionId,
      `the new ${label} pane's sidecar create`,
    )
    expect(freshCreate.model, 'a new pane starts on the saved default model').toBe('sonnet')

    let durableId = ''
    await expect
      .poll(async () => {
        durableId = (await paneLeaf(harness, tabId))?.content?.sessionRef?.sessionId ?? ''
        return durableId
      }, { timeout: 30_000 })
      .toMatch(CANONICAL_UUID_RE)
    await waitForPaneStatus(harness, tabId, 'idle')

    // A past exchange in the conversation's on-disk transcript (the shape the
    // CLI writes), so the session directory keeps listing the conversation
    // after its pane closes. This step deliberately does not depend on the
    // fake sidecar's turn lanes: the resume path is what is under test.
    await appendTranscriptExchange(info.homeDir, lane.projectDir, durableId, 'hello default model')

    const sidebarRow = page.locator(`[data-context="sidebar-session"][data-session-id="${durableId}"]`)
    await expect(sidebarRow, 'the session has a sidebar row').toBeVisible({ timeout: 30_000 })

    // ── 2. A RESUMED pane starts on the CURRENT saved default (D2) ─────────
    // Change the saved default AFTER the conversation ran on sonnet: the
    // resume must follow the saved default, not the conversation's model.
    await saveDefaultModel(info, harness, flavour, 'haiku')

    // Close the pane (kills its live session) so the sidebar click resumes
    // the conversation into a NEW pane instead of focusing the open one.
    const paneId = (await paneLeaf(harness, tabId))?.id as string
    expect(paneId).toBeTruthy()
    await page
      .locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)
      .getByRole('button', { name: 'Close pane' })
      .click()
    await expect
      .poll(async () => (await paneLeaf(harness, tabId))?.id ?? null, { timeout: 15_000 })
      .toBeNull()

    await sidebarRow.click()
    const resumeCreate = await waitForStdinFrame(
      stdinLog,
      (frame) => frame?.type === 'create' && frame?.resumeSessionId === durableId,
      `the resumed ${label} pane's sidecar create`,
      30_000,
    )
    expect(resumeCreate.model, 'a resumed pane starts on the current saved default model').toBe('haiku')

    const resumedLeaf = findFreshAgentLeaf(await harness.getPaneLayout((await harness.getActiveTabId())!))
    expect(resumedLeaf?.content?.sessionType).toBe(flavour)
    expect(resumedLeaf?.content?.model).toBe('haiku')
  } finally {
    await lane.server.stop().catch(() => {})
    await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
  }
}

test.describe('fresh-pane default model (G11)', () => {
  test.setTimeout(180_000)

  test('freshclaude: new and resumed panes start on the saved default model', async ({ page }) => {
    await runDefaultModelJourney(page, 'freshclaude')
  })

  test('kilroy: new and resumed panes start on the saved default model', async ({ page }) => {
    await runDefaultModelJourney(page, 'kilroy')
  })
})
