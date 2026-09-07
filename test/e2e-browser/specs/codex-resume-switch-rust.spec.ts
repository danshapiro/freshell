import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WsCapture, type WsFrame } from '../helpers/ws-capture.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_APP_SERVER = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)
const FAKE_CODEX_TERMINAL = path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs')

/**
 * Install a DUAL-ROLE `codex` binary: argv containing `app-server` imports the
 * shared fake app-server fixture; everything else imports the terminal fake
 * (`fake-codex-terminal.mjs`) which performs the managed-topology handshake
 * (initialize → thread/start on the --remote proxy URL) and captures argv.
 * Async import (not spawnSync) so the terminal fake can stay alive and do
 * the handshake without blocking the shim's event loop.
 */
async function installDualRoleCodexDispatcher(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('app-server')) {
  await import('file://${FAKE_CODEX_APP_SERVER}')
} else {
  await import('file://${FAKE_CODEX_TERMINAL}')
}
`
  await fs.writeFile(target, script, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}

async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 2_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

/** Flatten a pane layout tree into its leaf nodes. */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Every codex-mode terminal leaf currently in a tab's layout. */
function findCodexLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'codex')
}

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ pid: number; t: number; argv: string[] }>> {
  try {
    const raw = await fs.readFile(logPath, 'utf-8')
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; t: number; argv: string[] })
  } catch {
    return []
  }
}

/** Extract the `--remote` proxy URL from an argv array. */
function proxyUrlFromArgv(argv: string[]): string | undefined {
  const idx = argv.indexOf('--remote')
  return idx >= 0 ? argv[idx + 1] : undefined
}

/** True when the argv tokens contain the adjacent pair `resume <sessionId>`. */
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

/**
 * Compute the canonical rollout path for a thread id under CODEX_HOME,
 * mirroring the fake app-server's getRolloutSessionDir + rolloutFilename
 * (UTC date, encodeURIComponent — a no-op for simple alnum ids).
 */
function canonicalRolloutPath(codexHome: string, threadId: string): string {
  const now = new Date()
  const year = String(now.getUTCFullYear())
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  return path.join(codexHome, 'sessions', year, month, day, `rollout-${encodeURIComponent(threadId)}.jsonl`)
}

/** Write a session_meta first line (the shape the indexer parses). */
async function writeSessionMeta(filePath: string, threadId: string, cwd: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const line = JSON.stringify({
    timestamp: '2026-09-06T12:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, session_id: threadId, cwd },
  })
  await fs.writeFile(filePath, `${line}\n`, 'utf8')
}

/**
 * Open a NEW pane via the picker and select the "Codex CLI" provider option
 * (the manifest label is "Codex CLI" — `/^Codex$/` matches nothing).
 */
async function openCodexPane(page: import('@playwright/test').Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Codex CLI$/i }).click({ force: true })
  const combobox = page.getByRole('combobox', { name: /Starting directory for Codex CLI/i })
  try {
    await combobox.press('Enter', { timeout: 3_000 })
  } catch {
    // No combobox shown — some configs skip the directory picker.
  }
}

test.describe('Codex in-TUI /resume rebind (Rust only)', () => {
  test.setTimeout(240_000)

  test('codex pane follows an in-TUI /resume across a server restart (rust)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-resume-switch-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    // Thread ids: A (initial) → B (resumed).
    const A = 'thread-e2e-resume-a'
    const B = 'thread-e2e-resume-b'

    try {
      const fakeCodexPath = await installDualRoleCodexDispatcher(
        path.join(sharedRoot, 'bin'),
      )

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            CODEX_CMD: fakeCodexPath,
            FAKE_CODEX_TERMINAL_ARGV_LOG: argLogPath,
            FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
            // NOTE: applyAppDataIsolation (test-server.ts) overrides CODEX_HOME
            // to <homeDir>/.codex, so the value set here is NOT what the server
            // or the fake app-server actually sees. We set it for clarity but
            // rely on info.homeDir (below) for the real rollout paths.
            CODEX_HOME: path.join(sharedRoot, 'codex-home'),
            FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
              threadStartThreadId: A,
              // threadStartRolloutPath is intentionally omitted: the fake
              // app-server computes the rollout path from CODEX_HOME (which
              // applyAppDataIsolation sets to <homeDir>/.codex), so the
              // thread/start and thread/resume responses carry the SAME
              // path the server's codex_rollout_locator walks — the
              // pre-written rollouts (below) are found by exists_for_gate.
            }),
          },
          setupHome: async (homeDir: string) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['codex'] },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      // Pre-write rollouts for A and B under the REAL CODEX_HOME — which
      // applyAppDataIsolation (test-server.ts:64) sets to <homeDir>/.codex,
      // NOT the CODEX_HOME env var set above (which is overridden). The
      // server's codex_rollout_locator walks this directory; the fake
      // app-server's getThreadHandle also computes paths from this CODEX_HOME,
      // so the thread/start and thread/resume responses carry rollout paths
      // that match these files. This is load-bearing for the F1 reconcile
      // fix: exists_for_gate() must find the rollout for B on disk after a
      // server restart, or the reconcile path adjudicates dead_session.
      const codexHome = path.join(info.homeDir, '.codex')
      await fs.mkdir(codexHome, { recursive: true })
      await writeSessionMeta(canonicalRolloutPath(codexHome, A), A, projectDir)
      await writeSessionMeta(canonicalRolloutPath(codexHome, B), B, projectDir)

      // Server-side raw WS capture, opened BEFORE any codex pane exists.
      const capture = new WsCapture(info.wsUrl, info.token)
      await capture.ready()

      // ── ARRANGE: boot the app and open a codex pane.
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      // ── LEG 1 (bind A): open a codex pane via the picker.
      const beforeLeaves = collectLeaves(await harness.getPaneLayout(tabId!))
      const beforeIds = new Set(beforeLeaves.map((l) => l.id))
      await openCodexPane(page)
      await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 30_000 })
      const paneLeaf = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const newLeaf = collectLeaves(layout).find((l) => !beforeIds.has(l.id))
        return newLeaf?.content?.terminalId ? newLeaf : null
      }, { timeout: 60_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        return collectLeaves(layout).find((l) => !beforeIds.has(l.id))!
      })
      const paneId: string = paneLeaf.id
      const terminalId1: string = paneLeaf.content.terminalId
      expect(terminalId1).toBeTruthy()

      // Type Enter to trigger the terminal fake's managed-topology handshake
      // (initialize → thread/start on the --remote proxy URL). The fake's
      // startManagedThread() is Enter-anchored, mirroring real codex.
      await page.evaluate(({ tid }) => {
        (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'terminal.input', terminalId: tid, data: '\r',
        })
      }, { tid: terminalId1 })

      // Wait for the app-server's thread/start response to bind A via the
      // proxy candidate lane (D-03 first-bind-wins for thread/start).
      await capture.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId1
          && frame.sessionRef?.sessionId === A,
        60_000,
        `LEG 1: association terminal=${terminalId1} session=${A}`,
      )

      // ── LEG 2 (the switch): the fake app-server's thread/resume response
      // carries thread.id = B (from params.threadId — the behavior knob
      // threadResumeThreadId is unset, so the fixture uses the requested id).
      // The proxy routes the D-RESUME candidate → rebind_codex_identity.
      // We drive the switch by sending thread/resume through the pane's
      // --remote proxy URL (read from the argv log the dispatcher wrote).
      const argvEntries = await expect.poll(async () => {
        const entries = await readArgvLog(argLogPath)
        return entries.some((e) => proxyUrlFromArgv(e.argv)) ? entries : null
      }, { timeout: 60_000 }).not.toBeNull().then(async () => readArgvLog(argLogPath))
      const lastEntry = argvEntries[argvEntries.length - 1]
      const proxyUrl = proxyUrlFromArgv(lastEntry.argv)
      expect(proxyUrl).toBeTruthy()

      // Dial the proxy URL from the spec process (node `ws`) and send
      // thread/resume {threadId: B}.
      const { WebSocket } = await import('ws')
      const tui = new WebSocket(proxyUrl!)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TUI proxy connect timeout')), 15_000)
        tui.on('open', () => { clearTimeout(timer); resolve() })
        tui.on('error', (err) => { clearTimeout(timer); reject(err) })
      })
      const sendRpc = (id: number, method: string, params: any) =>
        tui.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const sendNotif = (method: string) =>
        tui.send(JSON.stringify({ jsonrpc: '2.0', method }))

      // initialize → initialized → thread/resume {threadId: B}.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('initialize timeout')), 15_000)
        tui.on('message', (data) => {
          const msg = JSON.parse(String(data))
          if (msg.id === 1) {
            clearTimeout(timer)
            expect(msg.result).toBeTruthy()
            resolve()
          }
        })
        sendRpc(1, 'initialize', {})
      })
      sendNotif('initialized')
      sendRpc(2, 'thread/resume', { threadId: B })

      // Assert the rebind broadcast: terminal.session.associated with
      // sessionId B AND previousSessionId A.
      const rebindFrame = await capture.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId1
          && frame.sessionRef?.sessionId === B,
        60_000,
        `LEG 2: rebind terminal=${terminalId1} session=${B}`,
      )
      expect(rebindFrame.previousSessionId).toBe(A)

      // terminal.meta.updated for B follows.
      await capture.waitFor(
        (frame) => frame.type === 'terminal.meta.updated'
          && (frame.upsert ?? []).some((r: any) => r.terminalId === terminalId1 && r.sessionId === B),
        30_000,
        `LEG 2: meta.updated terminal=${terminalId1} session=${B}`,
      )

      // In-page Redux fold: the pane's content sessionRef is codex:B.
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const leaf = collectLeaves(layout).find((l) => l.id === paneId)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(B)

      // F3: sidebar running/attached moves old→new (acceptance bullet b).
      // Poll until settlement — the sidebar derives from the Redux fold +
      // the server's sessions index, which settle after the WS frames.
      // `data-has-tab` reflects the pane's sessionRef (the Redux fold, already
      // confirmed above) — B is linked, A is NOT. `data-is-running` for B is
      // set by the terminal.meta.updated upsert; A's stale `isRunning` is
      // cleared synchronously by the same reducer pass on the identity move
      // (49d0dd7f9), so lagging projection rows no longer render A running.
      await expect(page.getByTestId('sidebar-session-list')).toBeVisible({ timeout: 15_000 })

      // Exactly one B row.
      await expect.poll(async () => {
        return await page.locator(`[data-session-id="${B}"][data-provider="codex"]`).count()
      }, { timeout: 30_000 }).toBe(1)

      // B row is linked (data-has-tab) and running (data-is-running) —
      // the pane's tab is open and bound to B.
      const bRow = page.locator(`[data-session-id="${B}"][data-provider="codex"]`).first()
      await expect(bRow).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
      await expect(bRow).toHaveAttribute('data-is-running', 'true', { timeout: 30_000 })

      // A row is NOT linked (data-has-tab=false) — the pane's tab moved
      // away from A. This is the "stale attachment removed" assertion that
      // is true of the shipped state machine.
      await expect.poll(async () => {
        const aRow = page.locator(`[data-session-id="${A}"][data-provider="codex"]`)
        const count = await aRow.count()
        if (count === 0) return true
        return (await aRow.first().getAttribute('data-has-tab')) !== 'true'
      }, { timeout: 30_000 }).toBe(true)

      // tabs-sync persistence: flush the layout and assert the persisted
      // snapshot includes codex:B.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      const persistedRaw: string = await page.evaluate(() => {
        const raw = window.localStorage.getItem('freshell.layout.v3')
        return raw ?? ''
      })
      // F6: non-vacuous — the persisted layout MUST be present before we
      // assert its content (a conditional `if (persistedRaw)` passes
      // vacuously when the flush wrote nothing).
      expect(persistedRaw).toBeTruthy()
      const persisted = JSON.parse(persistedRaw)
      const persistedPane = collectLeaves(persisted.panes?.layouts?.[tabId!])
        .find((l: any) => l.id === paneId)
      expect(persistedPane?.content?.sessionRef?.sessionId).toBe(B)

      // ── LEG 3 (restart): restart the owned Rust server, reload, wait for
      // reconnect. Assert the pane's terminal respawned with argv whose last
      // pair is ["resume", B]; the pane layout still binds codex:B.
      tui.close()
      capture.close()
      if (!server.restart) {
        throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
      }
      await server.restart()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      // The pane's terminal should respawn with `resume B` argv.
      await expect.poll(async () => {
        const entries = await readArgvLog(argLogPath)
        return entries.some((e) => hasResumePair(e.argv, B)) ? entries : null
      }, { timeout: 60_000 }).not.toBeNull()

      const allEntries = await readArgvLog(argLogPath)
      const resumedEntry = allEntries.find((e) => hasResumePair(e.argv, B))
      expect(resumedEntry).toBeTruthy()
      expect(hasResumePair(resumedEntry!.argv, B)).toBe(true)
      // A must NEVER appear as a resume target after the switch.
      expect(allEntries.every((e) => !hasResumePair(e.argv, A))).toBe(true)

      // The pane layout still binds codex:B after restart.
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        const leaf = collectLeaves(layout).find((l) => l.id === paneId)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 45_000 }).toBe(B)

      await server.stop()
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
