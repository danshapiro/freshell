/**
 * P1.8 pane-identity ledger — SIGKILL durability walls (spec §4.2).
 *
 * Wall 1 (`SIGKILL-within-5s-of-pane-creation`): by the time a pane exists,
 * its identity row (or pending marker) is on disk — an abrupt SIGKILL
 * moments after creation loses nothing, and the restarted server's boot
 * scan preserves (never quarantines, never sweeps) the evidence.
 *
 * Wall 2 (`SIGKILL-between-spawn-and-identity-resolution`): in the managed
 * codex topology, identity resolves at the first managed handshake
 * (`thread/started` from the proxy candidate). A pane killed BEFORE ever
 * being submitted leaves a durable pending marker that SURVIVES the restart
 * boot scan — fresh-by-race stays distinguishable from fresh-by-intent.
 *
 * Fixture shapes (fake CLIs, temp-home seeding, restart choreography)
 * mirror compound-restart-rust.spec.ts; helpers are copied, not imported,
 * per this suite's per-spec-ownership convention.
 */
import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

function seedConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] } },
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Select a shell for the boot tab's picker (copied from
 * compound-restart-rust.spec.ts, per-spec-ownership convention). Load-bearing
 * for the CLI-pane creates below: on a truly clean boot the DirectoryPicker
 * combobox is EMPTY (`/api/files/candidate-dirs` returns [] with no live
 * terminals, and no tab/global cwd preference exists), so a bare Enter hits
 * `handleConfirm('')` -> "directory not found" and no pane is ever created.
 * A live shell terminal's cwd becomes the tab's directory preference, which
 * pre-fills the combobox (the sibling specs' choreography).
 */
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

async function openCliPane(page: import('@playwright/test').Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const out: string[] = []
    for (const entry of await fs.readdir(dir, { recursive: true })) {
      out.push(String(entry))
    }
    return out
  } catch {
    return []
  }
}

/** Poll (5s wall) for a predicate over the ledger dir. */
async function within5s(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`5s durability wall breached: ${what}`)
}

// The walls below assert RAW ledger file state after SIGKILL; the harness
// auto-decline watcher would answer the recovery offer first, and the
// decline routes through terminal.kill, which deletes the pending marker
// (crates/freshell-ws/src/terminal.rs). Keep decline manual here.
test.use({ recoveryOfferHandling: 'manual' })

test.describe('pane-identity ledger restart durability', () => {
  test.setTimeout(180_000)

  test('identity rows are durable within seconds of pane creation and survive SIGKILL', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ledger-e2e-'))
    let capturedHome = ''
    try {
      const argLog = path.join(sharedRoot, 'claude-argv.jsonl')
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
      // Dual-role: the Rust codex terminal lane boots a 'codex app-server'
      // sidecar first; a terminal-only fake dies on it (PTY_SPAWN_FAILED).
      const fakeCodex = await installDualRoleCodexCli(path.join(sharedRoot, 'bin'), path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs'))
      const seed = seedConfig()
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude, CODEX_CMD: fakeCodex, FAKE_CLAUDE_ARGV_LOG: argLog },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')

        // Claude pane: identity is pre-allocated at create — the binding
        // row must hit disk within the 5s wall. Button label is the
        // extension manifest's "Claude CLI" (extensions/claude-code/
        // freshell.json; /^Claude$/ matches nothing).
        await openCliPane(page, /^Claude CLI$/i)
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'bindings', 'claude'))).some((f) => f.endsWith('.json')),
          'claude binding row on disk',
        )

        // Codex pane: identity in flight — the pending marker must hit
        // disk within the same wall. Manifest label is "Codex CLI"
        // (extensions/codex-cli/freshell.json).
        await openCliPane(page, /^Codex CLI$/i)
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'pending'))).some((f) => f.endsWith('.json')),
          'codex pending marker on disk',
        )

        // The claude row records the SAME session id the client saw
        // (the fake claude's argv log carries --session-id <uuid>).
        const argvRaw = await fs.readFile(argLog, 'utf8').catch(() => '')
        const argvEntries = argvRaw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] })
        const sessionArg = argvEntries.flatMap((e) => {
          const i = e.argv.indexOf('--session-id')
          return i >= 0 ? [e.argv[i + 1]] : []
        })[0]
        expect(sessionArg, 'fake claude received a pre-allocated --session-id').toBeTruthy()
        const claudeRows = await listFiles(path.join(ledgerDir, 'bindings', 'claude'))
        expect(claudeRows.some((f) => f.includes(sessionArg!))).toBe(true)

        // --- THE WALL: SIGKILL moments after creation, then revive. ---
        await server.restartAbrupt()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        // Everything survived the boot scan: the claude binding row is
        // intact, the codex fresh-by-race marker was PRESERVED (never
        // swept merely because the terminal isn't live), and nothing was
        // quarantined.
        const allFiles = await listFiles(ledgerDir)
        expect(allFiles.filter((f) => f.startsWith('pending') && f.endsWith('.json')).length).toBeGreaterThan(0)
        expect(allFiles.some((f) => f.includes('.quarantined-'))).toBe(false)
        const claudeRowsAfter = await listFiles(path.join(ledgerDir, 'bindings', 'claude'))
        expect(claudeRowsAfter.some((f) => f.includes(sessionArg!))).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('SIGKILL inside the opencode locator window leaves a durable fresh-by-race marker', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ledger-locator-'))
    let capturedHome = ''
    try {
      const fakeOpencode = await installFakeCli(path.join(sharedRoot, 'bin'), 'opencode', 'fake-opencode-terminal.mjs')
      const seed = seedConfig()
      // ROW GATE (REQUIRED for this wall's premise): the fake opencode
      // WRITES a real sqlite identity row on its FIRST stdin data unless
      // FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH is set and the gate file
      // never exists (fake-opencode-terminal.mjs:113-142). Point it at a
      // path we NEVER create, so identity deterministically never resolves
      // and the pending marker is the only evidence — no race against the
      // SIGKILL.
      const rowGate = path.join(sharedRoot, 'row-gate-never-created')
      const server = new RustServer({
        env: { OPENCODE_CMD: fakeOpencode, FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH: rowGate },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
        await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'pending'))).some((f) => f.endsWith('.json')),
          'opencode pending marker on disk',
        )

        // SIGKILL INSIDE the locator window (no sqlite rows exist for the
        // fake, so identity never resolves — the marker is the only
        // evidence identity was in flight).
        await server.restartAbrupt()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        // The restarted boot scan PRESERVED the marker (fresh-by-race
        // distinguishable from fresh-by-intent) — and nothing bound it.
        const pending = (await listFiles(path.join(ledgerDir, 'pending'))).filter((f) => f.endsWith('.json'))
        expect(pending.length).toBeGreaterThan(0)
        const bindings = await listFiles(path.join(ledgerDir, 'bindings'))
        expect(bindings.filter((f) => f.endsWith('.json'))).toHaveLength(0)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('SIGKILL between spawn and identity resolution leaves a durable fresh-by-race marker', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ledger-locator-'))
    let capturedHome = ''
    try {
      // Dual-role: the Rust codex terminal lane boots a 'codex app-server'
      // sidecar first; a terminal-only fake dies on it (PTY_SPAWN_FAILED).
      const fakeCodex = await installDualRoleCodexCli(path.join(sharedRoot, 'bin'), path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs'))
      const seed = seedConfig()
      const server = new RustServer({
        env: { CODEX_CMD: fakeCodex },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')
        await openCliPane(page, /^Codex CLI$/i)
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'pending'))).some((f) => f.endsWith('.json')),
          'codex pending marker on disk',
        )

        // Identity window semantics in the managed topology (codex terminal
        // v2): the proxy candidate binds identity at the pane's FIRST managed
        // handshake (`thread/started` after the first Enter). A pane that is
        // spawned and NEVER submitted is exactly the fresh-by-race shape this
        // wall protects: pending marker, zero bindings. SIGKILL here, without
        // touching the pane, and the restarted boot scan must PRESERVE the
        // marker (never sweep, never quarantine) and land NO binding row for
        // it. (Bindings live under bindings/<provider>/<session>.json — the
        // listFiles below is intentionally NOT recursive: a file at that path
        // means the marker consumed correctly, which did not happen.)
        await server.restartAbrupt()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        const pending = (await listFiles(path.join(ledgerDir, 'pending'))).filter((f) => f.endsWith('.json'))
        expect(pending.length).toBeGreaterThan(0)
        // Bindings are nested as bindings/<provider>/<session-id>.json —
        // check the FULL tree for any binding row (the penultimate shape of
        // "identity resolved"), which must be empty here.
        const bindingRows = (await fs.readdir(path.join(ledgerDir, 'bindings'), { recursive: true }).catch(() => []))
          .map(String)
          .filter((f) => f.endsWith('.json'))
        expect(bindingRows).toHaveLength(0)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
