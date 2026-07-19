import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/**
 * TERM-28 (Rust only) -- `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`,
 * grep TERM-28.
 *
 * portable-pty 0.8.1's own `CommandBuilder::search_path` (unix) resolves a
 * bare relative command name against the spawn's cwd BEFORE `$PATH`, using a
 * bare `Path::exists()` check with no `is_file`/executable-bit validation --
 * so a same-named DIRECTORY in the launch cwd shadows the real executable
 * (observed: opening an Amplifier session in `~/code` execs the
 * `~/code/amplifier` repo directory instead of the real `amplifier` binary,
 * failing `EACCES`). Worse, because portable-pty's `pre_exec` closure closes
 * the forked child's own internal spawn-status pipe (`close_random_fds`),
 * that failure can't be reported back and the child aborts raw
 * (`fatal runtime error: assertion failed: output.write(&bytes).is_ok(),
 * aborting`) straight into the user's pane instead of a clean spawn error.
 *
 * The fix (`crates/freshell-platform/src/path.rs`'s `resolve_program_via_path`,
 * wired in at `crates/freshell-terminal/src/pty.rs`'s `PtyTerminal::spawn_with_sink`):
 * resolve a bare command name to an absolute path via a `$PATH`-ONLY search
 * (cwd never consulted) BEFORE portable-pty ever sees it, and fail cleanly
 * (`io::ErrorKind::NotFound`, surfaced via the existing `wrap_terminal_spawn_error`
 * -> `PTY_SPAWN_FAILED` path) when no `$PATH` entry has a match.
 *
 * This spec is registered ONLY under the `rust-chromium` project
 * (`playwright.config.ts`): the bug is unix-portable-pty-specific and legacy
 * node-pty is unaffected (bare names go straight to PATH search, no cwd-first
 * branch) -- not a parity gap to gate per-assertion, a Rust-only regression.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')

/** Same copy-then-chmod install pattern as `amplifier-restore-rust.spec.ts`. */
async function installFakeAmplifierCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'amplifier')
  await fs.copyFile(FAKE_AMPLIFIER_CLI_SOURCE, target)
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
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

async function bootAndConnect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await selectShellIfPickerShowing(page)
  return harness
}

/**
 * Open a new Amplifier pane (splitting the current terminal, same as
 * `amplifier-restore-rust.spec.ts`'s `openAmplifierPane`), but override the
 * "Starting directory" combobox with an explicit `cwd` instead of accepting
 * its pre-filled default -- `DirectoryPicker.tsx`'s input is a plain editable
 * combobox; typing an absolute path puts it in "path mode"
 * (`PATH_INPUT_PATTERN`) and Enter submits that typed value directly
 * (`handleInputKeyDown` -> `handleConfirm`), not a listbox suggestion.
 */
async function openAmplifierPaneWithCwd(page: import('@playwright/test').Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Amplifier$/i }).click({ force: true })
  const combobox = page.getByRole('combobox', { name: /Starting directory for Amplifier/i })
  await combobox.fill(cwd)
  await combobox.press('Enter')
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findAmplifierLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'amplifier')
}

/**
 * Open a new Amplifier pane at `cwd` and return the newly-added leaf, the
 * same before/after-diff pattern `amplifier-restore-rust.spec.ts` uses.
 */
async function openAmplifierPaneAndGetLeaf(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
  cwd: string,
): Promise<any> {
  const before = findAmplifierLeaves(await harness.getPaneLayout(tabId))
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openAmplifierPaneWithCwd(page, cwd)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  return expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const newLeaf = findAmplifierLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
    return newLeaf?.content?.terminalId ? newLeaf : null
  }, { timeout: 15_000 }).not.toBeNull().then(async () => {
    const layout = await harness.getPaneLayout(tabId)
    return findAmplifierLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
  })
}

/** Seed `codingCli.enabledProviders: ['amplifier']` so the picker offers it -- same as `amplifier-restore-rust.spec.ts`. */
async function enableAmplifierProvider(homeDir: string): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
    version: 1,
    settings: {
      codingCli: { enabledProviders: ['amplifier'] },
    },
  }, null, 2))
}

test.describe('TERM-28: bare-command $PATH resolution (Rust only)', () => {
  test.setTimeout(120_000)

  test('a same-named directory in the launch cwd never shadows the real $PATH CLI', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-term28-shadow-'))
    const argLogPath = path.join(sharedRoot, 'fake-amplifier-argv.jsonl')
    try {
      // The real fixture CLI lives on a $PATH entry, NOT via AMPLIFIER_CMD --
      // an env-var override would hand `resolve_coding_cli_command` an
      // already-distinct string, sidestepping the bug entirely. The bug is
      // specifically about the manifest's BARE `defaultCommand` ("amplifier"),
      // so AMPLIFIER_CMD must stay unset here.
      const binDir = path.join(sharedRoot, 'bin')
      await installFakeAmplifierCli(binDir)

      // The exact reported repro shape: a launch cwd that itself contains a
      // subdirectory named exactly like the CLI (a stand-in for
      // `~/code/amplifier`, an Amplifier repo checkout shadowing the
      // `amplifier` binary).
      const launchCwd = path.join(sharedRoot, 'cwd')
      await fs.mkdir(launchCwd, { recursive: true })
      await fs.mkdir(path.join(launchCwd, 'amplifier'), { recursive: true })

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            // Prepend the fixture's bin dir so the bare "amplifier" default
            // command resolves there -- deterministic regardless of whatever
            // real `amplifier` binary this host may also have installed.
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            FAKE_AMPLIFIER_ARGV_LOG: argLogPath,
          },
          setupHome: enableAmplifierProvider,
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const leaf = await openAmplifierPaneAndGetLeaf(page, harness, tabId!, launchCwd)
        const terminalId: string = leaf.content.terminalId
        expect(terminalId).toBeTruthy()

        // The REAL $PATH fixture ran (its fresh-launch prompt), proving the
        // cwd-resident `amplifier/` directory was never even considered --
        // never treated as a spawn target, and never fell through to a
        // shell/error state pretending to be it.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('amplifier> ')
        }, { timeout: 15_000 }).toBe(true)

        // The pane must never show the raw portable-pty abort text this bug
        // used to produce when the shadowing directory was mis-resolved as a
        // spawn target and `exec` failed post-fork.
        const bufferAfterPrompt = await harness.getTerminalBuffer(terminalId)
        expect(bufferAfterPrompt).not.toContain('fatal runtime error')
        expect(bufferAfterPrompt).not.toContain('assertion failed')

        // Independent, non-DOM confirmation: the fixture's own argv log
        // proves a real process invocation happened (not a directory-exec
        // failure that never got this far).
        const recordedArgvLines: string[] = await expect.poll(async () => {
          const raw = await fs.readFile(argLogPath, 'utf8').catch(() => '')
          return raw ? raw.trim().split('\n') : []
        }, { timeout: 15_000 }).not.toEqual([]).then(async () => {
          const raw = await fs.readFile(argLogPath, 'utf8')
          return raw.trim().split('\n')
        })
        expect(recordedArgvLines.length).toBeGreaterThan(0)

        // The pane is genuinely running, not stuck in an error/creating state.
        expect(leaf.content.status).not.toBe('error')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('a genuinely missing bare CLI command surfaces a clean, legacy-compatible spawn error (never a raw abort)', async ({ e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    // This scenario is driven over a RAW WebSocket connection
    // (`terminal.create`), not the browser UI/PanePicker: the picker only
    // offers a CLI option when the server's OWN boot-time `which`/`where.exe`
    // probe (`detect_available_clis_live`) found it, cached client-side
    // (`src/App.tsx`'s `setAvailableClis`) -- so a command that is missing
    // from the very start would never even show a selectable button, and a
    // UI-driven test could never reach the pane-creation code path at all.
    // The fix under test is entirely server-side (`crates/freshell-platform`
    // / `crates/freshell-terminal`), so exercising the WS protocol directly
    // -- the same pattern `ws-ping-pong-matrix.spec.ts` uses -- proves the
    // real behavior without fighting UI availability heuristics that exist
    // purely as a UX nicety, not a server-side guarantee.
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-term28-missing-'))
    try {
      // AMPLIFIER_CMD names a bare command that exists nowhere on $PATH and
      // nowhere on disk -- the "genuinely missing" case, as distinct from
      // the shadowed-by-a-cwd-directory case above. `resolve_coding_cli_command`
      // resolves `command = env[AMPLIFIER_CMD]` verbatim (still a bare
      // name, still exercising the SAME $PATH-only resolver), so this
      // proves the resolver's clean-failure path independent of the
      // shadowing scenario.
      const missingCommandName = 'totally-missing-freshell-cli-term28'

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            AMPLIFIER_CMD: missingCommandName,
          },
          setupHome: enableAmplifierProvider,
        },
      })
      const info = await server.start()

      try {
        const ws = new WebSocket(info.wsUrl)
        const ready = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out waiting for ready')), 10_000)
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'hello', token: info.token, protocolVersion: WS_PROTOCOL_VERSION }))
          })
          ws.on('message', (raw) => {
            const message = JSON.parse(String(raw))
            if (message?.type === 'ready') {
              clearTimeout(timeout)
              resolve()
            }
          })
          ws.on('error', (err) => {
            clearTimeout(timeout)
            reject(err)
          })
        })
        await ready

        try {
          const requestId = 'term28-missing-cli-request'
          const responsePromise = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out waiting for terminal.create response')), 20_000)
            function onMessage(raw: WebSocket.RawData) {
              const message = JSON.parse(String(raw))
              if (
                (message?.type === 'error' || message?.type === 'terminal.created')
                && message?.requestId === requestId
              ) {
                clearTimeout(timeout)
                ws.removeListener('message', onMessage)
                resolve(message)
              }
            }
            ws.on('message', onMessage)
          })

          ws.send(JSON.stringify({
            type: 'terminal.create',
            requestId,
            mode: 'amplifier',
            shell: 'system',
            cwd: sharedRoot,
          }))

          const response = await responsePromise

          // Never the raw portable-pty abort text, and never a bare-command
          // launch that happens to succeed some other way.
          expect(response.type).toBe('error')
          expect(response.code).toBe('PTY_SPAWN_FAILED')
          expect(String(response.message)).not.toContain('fatal runtime error')
          expect(String(response.message)).not.toContain('assertion failed')

          // The legacy-compatible, reference-exact `wrap_terminal_spawn_error`
          // ENOENT message (`crates/freshell-ws/src/terminal.rs`, mirroring
          // `server/terminal-registry.ts:465-472`'s `wrapTerminalSpawnError`).
          expect(response.message).toMatch(
            new RegExp(
              `Could not start Amplifier: "${missingCommandName}" could not be started because the executable or working directory was not found on the server\\. Reinstall it or set AMPLIFIER_CMD to the correct executable\\.`,
            ),
          )
        } finally {
          ws.close()
        }
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
