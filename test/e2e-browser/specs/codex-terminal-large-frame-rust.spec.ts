/**
 * Codex proxy large-frame incident fidelity (plan §5 "E2E coverage",
 * docs/plans/2026-10-20-codex-proxy-ws-frame-cap.md).
 *
 * The 2026-10-19 incident: the real codex TUI polls `plugin/list`
 * (~2x/second while the composer is active) on the SAME persistent proxy
 * connection it started its thread on. The response crossed the proxy's
 * tokio-tungstenite 16 MiB default frame cap (~17.8 MB single frame), the
 * upstream read failed with a Capacity error, and the hub tore down both
 * sides in a ~1.5 s reconnect loop — visible as blinking panes plus a
 * `codex_proxy_repair_trigger` log flood ("upstream connection errored" +
 * "client connection errored" per cycle).
 *
 * This spec recreates that exact flow end-to-end with the dual-role
 * fixtures, both knobs opt-in and off by default:
 * - fake app-server: `behavior.pluginListResponseBytes` answers plugin/list
 *   with a deterministic 20 MiB single-frame response;
 * - fake terminal: `FAKE_CODEX_TERMINAL_PLUGIN_LIST=1` (via
 *   installDualRoleCodexCli's terminalEnv) makes it request plugin/list ON
 *   THE SAME persistent proxy connection after the managed handshake,
 *   consume the full response, echo `codex: plugin list consumed <N>
 *   bytes`, then prove same-socket liveness with a follow-up RPC echoed as
 *   `codex: followup rpc ok {...}` — and skip the fixture's usual
 *   post-handshake ws.close().
 *
 * GREEN (once the server fix lands) asserts all markers plus a clean server
 * log. Against the UNFIXED server this spec is RED in exactly the
 * incident's signature — the plugin/list marker never arrives (the 20 MiB
 * frame dies at the proxy's transport cap) while the server log shows
 * codex_proxy_repair_trigger churn — and the marker poll's failure message
 * carries that churn census, so the RED run is self-evidencing.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** The incident-class payload: 20 MiB in ONE frame (real catalog: 17.8 MB). */
const PLUGIN_LIST_RESPONSE_BYTES = 20 * 1024 * 1024
/** Pinned thread id — proves the handshake round-tripped THROUGH the proxy
 *  (a failed handshake falls back to a random uuid in the marker). */
const FAKE_THREAD_ID = 'thread-large-frame-1'

/** Dismiss the boot tab's picker into a shell (copied from
 *  pane-ledger-restart-rust.spec.ts; a live shell gives the tab the
 *  directory preference the Codex CLI DirectoryPicker combobox needs). */
async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

/** Open a NEW codex pane via the picker (manifest label is "Codex CLI" —
 *  /^Codex$/ matches nothing; see codex-terminal-restore-rust.spec.ts). */
async function openCodexPane(page: import('@playwright/test').Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Codex CLI$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for Codex CLI/i }).press('Enter')
}

/** Flatten a pane layout tree into its leaf nodes. */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Every codex-mode terminal leaf in a tab's layout. */
function findCodexLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'codex')
}

/** Open a new codex pane and return the NEWLY-added leaf (diff-detect — a
 *  fresh pane's terminalId isn't known until the create round-trip). */
async function openCodexPaneAndGetLeaf(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const beforeIds = new Set(findCodexLeaves(await harness.getPaneLayout(tabId)).map((leaf) => leaf.id))
  await openCodexPane(page)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    return findCodexLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))?.content?.terminalId ?? null
  }, { timeout: 15_000 }).toBeTruthy()
  const layout = await harness.getPaneLayout(tabId)
  return findCodexLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))!
}

/** The pane's terminal buffer with xterm's line-wrap newlines (and any \r
 *  from wrapping) stripped, so a wrapped marker line matches `.includes`
 *  (restore-spec poll pattern, hardened to strip \r too). */
async function unwrappedBuffer(harness: TestHarness, terminalId: string): Promise<string> {
  const buffer = await harness.getTerminalBuffer(terminalId)
  return typeof buffer === 'string' ? buffer.replace(/[\r\n]/g, '') : ''
}

/** Concatenate every file in the server's log dir (copied from
 *  create-rate-limit-ladder-rust.spec.ts). */
async function readServerLogs(logsDir: string): Promise<string> {
  const files = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const f of files) {
    combined += await fs.readFile(path.join(logsDir, f), 'utf8').catch(() => '')
  }
  return combined
}

/** Census of the incident's log signature, for failure diagnostics: how
 *  many codex_proxy_repair_trigger lines the run produced, plus samples. */
async function repairTriggerCensus(logsDir: string): Promise<string> {
  const logs = await readServerLogs(logsDir)
  const lines = logs.split('\n').filter((line) => line.includes('codex_proxy_repair_trigger'))
  const sample = lines.slice(0, 2).map((line) => line.slice(0, 400)).join(' | ')
  return lines.length > 0
    ? `${lines.length} codex_proxy_repair_trigger line(s); sample: ${sample}`
    : 'no codex_proxy_repair_trigger lines'
}

test.describe('Codex terminal large-frame relay (Rust only)', () => {
  test.setTimeout(180_000)

  test('a managed codex pane consumes a 20 MiB plugin/list response on its persistent proxy connection without repair churn', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-large-frame-'))
    try {
      // Dual-role: the Rust codex terminal lane boots a `codex app-server`
      // sidecar first; a terminal-only fake dies on it (PTY_SPAWN_FAILED).
      // terminalEnv reaches the TERMINAL role only (the plugin/list poll
      // mode); the app-server behavior JSON rides the server env (inherited
      // by the shim's in-process app-server role).
      const fakeCodex = await installDualRoleCodexCli(
        path.join(sharedRoot, 'bin'),
        path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs'),
        { FAKE_CODEX_TERMINAL_PLUGIN_LIST: '1' },
      )
      const server = new RustServer({
        env: {
          CODEX_CMD: fakeCodex,
          // The churn assertion greps WARN lines; an inherited
          // RUST_LOG=error would suppress them
          // (create-rate-limit-ladder-rust precedent).
          RUST_LOG: 'info',
          FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
            threadStartThreadId: FAKE_THREAD_ID,
            pluginListResponseBytes: PLUGIN_LIST_RESPONSE_BYTES,
          }),
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: { codingCli: { enabledProviders: ['codex'] } },
          }, null, 2))
        },
      })
      const info: E2eServerInfo = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // 1. Managed codex pane against the dual-role fixtures (both
        //    behavior flags on).
        const leaf = await openCodexPaneAndGetLeaf(page, harness, tabId!)
        const terminalId: string = leaf.content.terminalId
        expect(terminalId).toBeTruthy()

        // The fixture prints its prompt before any submission.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('codex> ')
        }, { timeout: 15_000 }).toBe(true)

        // 2. First terminal submission — triggers the fixture's managed
        //    initialize + thread/start handshake through the proxy.
        await page.locator('.xterm').last().click()
        await page.keyboard.type('hello codex')
        await page.keyboard.press('Enter')

        // Handshake proof: the app-server's pinned thread id in the
        // session-started marker means initialize + thread/start round-
        // tripped THROUGH THE PROXY (a failed handshake falls back to a
        // random uuid).
        await expect.poll(async () => {
          const unwrapped = await unwrappedBuffer(harness, terminalId)
          return unwrapped.includes(`codex: session ${FAKE_THREAD_ID} started`)
        }, { timeout: 30_000 }).toBe(true)

        // 3. plugin/list on the SAME persistent connection: the full 20 MiB
        //    response consumed (marker sized by the bytes actually
        //    received). RED against the unfixed server: the frame dies at
        //    the proxy's 16 MiB transport cap, the marker never arrives,
        //    and the failure message carries the repair-churn census.
        try {
          await expect.poll(async () => {
            const unwrapped = await unwrappedBuffer(harness, terminalId)
            return unwrapped.includes(`codex: plugin list consumed ${PLUGIN_LIST_RESPONSE_BYTES} bytes`)
          }, { timeout: 60_000 }).toBe(true)
        } catch {
          const census = await repairTriggerCensus(info.logsDir)
          const tail = (await unwrappedBuffer(harness, terminalId)).slice(-400)
          throw new Error(
            `plugin/list consumption marker never reached the pane `
            + `(expected "codex: plugin list consumed ${PLUGIN_LIST_RESPONSE_BYTES} bytes"). `
            + `Server log: ${census}. Pane buffer tail: ${JSON.stringify(tail)}`,
          )
        }

        // 4. Same-socket liveness: a follow-up RPC still answers after the
        //    large frame ({"data":[]} is thread/loaded/list's deterministic
        //    result under this spec's behavior flags).
        await expect.poll(async () => {
          const unwrapped = await unwrappedBuffer(harness, terminalId)
          return unwrapped.includes('codex: followup rpc ok {"data":[]}')
        }, { timeout: 30_000 }).toBe(true)

        // 5. No repair churn: the whole sequence flowed over one healthy
        //    proxy connection, so the incident's log signature is absent.
        const serverLogs = await readServerLogs(info.logsDir)
        expect(serverLogs).not.toContain('codex_proxy_repair_trigger')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
