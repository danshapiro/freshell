import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * OPENCODE TERMINAL RESTORE -- restore-across-server-restart acceptance
 * scenario for opencode TERMINAL panes on the Rust port
 * (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md`).
 *
 * KNOWN DIVERGENCE (rust-only, by design -- see `playwright.config.ts`'s
 * `rust-chromium`-only `testMatch` entry for this file, and
 * `amplifier-restore-rust.spec.ts`'s identical divergence note): legacy has
 * NO opencode terminal<->session association anywhere (spec §2) --
 * `server/coding-cli/amplifier-session-locator.ts` on `origin/main` is
 * amplifier-ONLY, and `opencode-session-controller.ts` binds the
 * freshopencode CHAT sidecar (`opencode serve`), never a raw terminal PTY.
 * This is not a parity gap to gate per-assertion; it is a capability that
 * does not exist in legacy, designed by analogy to the amplifier-locator
 * precedent, and this spec is scoped to the Rust project only rather than
 * pretending legacy participates.
 *
 * The fix under test (spec §4-5, Slices A+B): a Rust-side `OpencodeLocator`
 * (`crates/freshell-sessions/src/opencode_locator.rs`) correlates a fresh
 * opencode PTY's first Enter/submit with the new root `session` row opencode
 * writes into its SQLite `opencode.db`, binds the terminal's identity
 * (`crate::identity`), and broadcasts `terminal.session.associated` +
 * `terminal.meta.updated` -- the SAME wire messages the frozen client's
 * generic `reconcileTerminalSessionAssociation` + restore machinery already
 * handle for every other provider. No client/shared changes were needed;
 * this scenario is the proof.
 *
 * Row-timing note (spec §4.4 OPEN QUESTION): this fixture models the
 * ENTER-anchored shape (the session row is written on the pane's first
 * Enter, exactly like `fake-amplifier-cli.mjs`) so the scenario has a clean,
 * symmetric negative control (a pane that never types never gets a row,
 * never associates). The SPAWN-anchored shape (a row written before any
 * Enter) is separately and deterministically proven by
 * `opencode_locator.rs`'s own unit test
 * (`row_created_at_spawn_before_any_enter_resolves_via_spawn_window`), which
 * controls row-vs-arm timing to the millisecond -- something this e2e,
 * driving a real browser + WS round trip, cannot do reliably.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')

/**
 * Install the fake opencode CLI as an executable named `opencode` in a
 * throwaway bin dir, then point `OPENCODE_CMD` at it -- same copy-then-chmod
 * pattern `amplifier-restore-rust.spec.ts`'s `installFakeAmplifierCli` uses.
 */
async function installFakeOpencodeTerminal(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fs.copyFile(FAKE_OPENCODE_TERMINAL_SOURCE, target)
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
 * Open a NEW pane via the picker and select the "OpenCode" provider option.
 * Selecting a coding-CLI provider opens a follow-up "Starting directory for
 * OpenCode" combobox (`src/components/panes/DirectoryPicker.tsx`),
 * pre-filled with the CURRENT directory and already focused. Pressing Enter
 * submits the combobox's own pre-filled value directly, accepting the
 * current directory as-is (mirrors `amplifier-restore-rust.spec.ts`'s
 * `openAmplifierPane`).
 */
async function openOpencodePane(page: import('@playwright/test').Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
}

/** Flatten a pane layout tree into its leaf nodes. */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Every opencode-mode terminal leaf currently in a tab's layout. */
function findOpencodeLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'opencode')
}

/**
 * Open a new opencode pane (splitting the current terminal) and return the
 * NEWLY-added opencode leaf -- identified by diffing the leaf set before vs
 * after, since a fresh opencode pane's `content.terminalId` isn't known
 * until the create round-trip completes.
 */
async function openOpencodePaneAndGetLeaf(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const before = findOpencodeLeaves(await harness.getPaneLayout(tabId))
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openOpencodePane(page)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  return expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const newLeaf = findOpencodeLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
    return newLeaf?.content?.terminalId ? newLeaf : null
  }, { timeout: 15_000 }).not.toBeNull().then(async () => {
    const layout = await harness.getPaneLayout(tabId)
    return findOpencodeLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
  })
}

test.describe('OpenCode Terminal Restore (Rust only)', () => {
  test.setTimeout(120_000)

  test('an opencode terminal pane restores across a server restart via `opencode --session <id>`, and a never-submitted pane restores fresh', async ({ page, e2eServerKind }) => {
    // This spec is registered ONLY under the `rust-chromium` project
    // (`playwright.config.ts`), but assert the precondition explicitly so a
    // future accidental `MATRIX_SPECS` inclusion fails loudly instead of
    // silently no-op'ing on legacy.
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-terminal-restore-'))
    const argLogPath = path.join(sharedRoot, 'fake-opencode-terminal-argv.jsonl')
    try {
      const fakeOpencodePath = await installFakeOpencodeTerminal(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            OPENCODE_CMD: fakeOpencodePath,
            FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
          },
          // PanePicker only renders a CLI option when THREE conditions all
          // hold (`src/components/panes/PanePicker.tsx`'s `cliOptions`
          // filter): `availableClis[name]`, `enabledProviders.includes(name)`,
          // and NOT `disabledExtensions.includes(name)`. Seeded here the same
          // way `amplifier-restore-rust.spec.ts` seeds `enabledProviders` for
          // `amplifier`.
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['opencode'] },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // `availableClis` is populated by the SERVER's `which`/`where.exe`
        // probe (`crates/freshell-server/src/extensions.rs`'s
        // `detect_available_clis_live`), whose spec list is derived from
        // GENUINELY DISCOVERED CLI extension manifests --
        // `extensions/opencode/freshell.json` is a real `category: "cli"`
        // manifest (`command: "opencode"`, `envVar: "OPENCODE_CMD"`), so the
        // server's live boot-time detection already discovers and probes
        // opencode via the `OPENCODE_CMD` override this test sets.
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // -------------------------------------------------------------
        // Positive case: a fresh opencode pane that DOES submit a prompt.
        // -------------------------------------------------------------
        const positiveLeaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
        const terminalIdBefore: string = positiveLeaf.content.terminalId
        const positivePaneId: string = positiveLeaf.id
        expect(terminalIdBefore).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          return typeof buffer === 'string' && buffer.includes('opencode> ')
        }, { timeout: 15_000 }).toBe(true)

        // The pane's first Enter/submit -- this is the locator's Enter<->
        // row correlation trigger (spec §4.4). Only two `.xterm` containers
        // exist at this point (the original shell pane + this freshly-created
        // one), and this one was just added, so `.last()` unambiguously
        // targets it.
        await page.locator('.xterm').last().click()
        await page.keyboard.type('hello opencode')
        await page.keyboard.press('Enter')

        // The fixture's session-created marker proves the CLI itself wrote
        // its session row. Strip newlines before matching -- xterm wraps
        // long lines at the terminal's column width.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return /opencode: session ses_e2e_\S+ started/.test(unwrapped)
        }, { timeout: 15_000 }).toBe(true)

        /** Re-read the (possibly reshuffled) leaf for a given pane id. */
        async function findLeafById(tid: string, paneId: string): Promise<any> {
          const layout = await harness.getPaneLayout(tid)
          return collectLeaves(layout).find((leaf) => leaf.id === paneId)
        }

        // The association broadcast (`terminal.session.associated` +
        // `terminal.meta.updated`, Slice B) must reach the client and be
        // folded into the pane's persisted identity -- proven here via the
        // SAME `pane.content.sessionRef`/`resumeSessionId` fields the
        // frozen client's generic `reconcileTerminalSessionAssociation`
        // writes for every other provider (spec §1).
        const associatedSessionId: string = await expect.poll(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId
        })
        expect(associatedSessionId).toMatch(/^ses_e2e_/)
        const positiveLeafAfterAssociation = await findLeafById(tabId!, positivePaneId)
        expect(positiveLeafAfterAssociation?.content?.sessionRef?.provider).toBe('opencode')

        // Persisted across a reload too (the client's persist middleware +
        // localStorage round trip that the restore chain depends on).
        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // -------------------------------------------------------------
        // Negative control: a SECOND opencode pane that never submits.
        // Proves the locator never false-binds an un-submitted terminal
        // (spec §5.2 step 5 analog) -- opened alongside the positive-case
        // pane so both restore in the SAME server restart below.
        // -------------------------------------------------------------
        const neverSubmittedLeaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
        const neverSubmittedTerminalIdBefore: string = neverSubmittedLeaf.content.terminalId
        const neverSubmittedPaneId: string = neverSubmittedLeaf.id
        expect(neverSubmittedTerminalIdBefore).toBeTruthy()
        expect(neverSubmittedPaneId).not.toBe(positivePaneId)

        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // -------------------------------------------------------------
        // Full server restart (not a client reload) -- PTYs are lost;
        // opencode must respawn with `--session <id>` for the associated
        // pane, and fresh (no `--session`) for the never-submitted one.
        // -------------------------------------------------------------
        if (!server.restart) {
          throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
        }
        await server.restart()

        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // Positive case: the restored pane's PTY receives
        // `opencode --session <id>` -- proven two independent ways: (1) the
        // fixture's own greppable stdout marker, scoped to THIS pane's
        // terminal, and (2) the argv log the fixture writes on every
        // invocation (independent of terminal-buffer scraping).
        await expect(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          expect(leaf?.content?.status).not.toBe('error')
          expect(leaf?.content?.terminalId).toBeTruthy()
        }).toPass({ timeout: 30_000 })

        const restoredTerminalId: string | undefined = (await findLeafById(tabId!, positivePaneId))?.content?.terminalId
        expect(restoredTerminalId).toBeTruthy()
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(restoredTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`opencode: resumed session ${associatedSessionId}`)
        }, { timeout: 20_000 }).toBe(true)

        const recordedArgvLines: string[] = await expect.poll(async () => {
          const raw = await fs.readFile(argLogPath, 'utf8').catch(() => '')
          return raw ? raw.trim().split('\n') : []
        }, { timeout: 20_000 }).not.toEqual([]).then(async () => {
          const raw = await fs.readFile(argLogPath, 'utf8')
          return raw.trim().split('\n')
        })
        const resumeInvocations = recordedArgvLines
          .map((line) => JSON.parse(line) as { argv: string[] })
          .filter((entry) => {
            const idx = entry.argv.indexOf('--session')
            return idx >= 0 && entry.argv[idx + 1] === associatedSessionId
          })
        expect(resumeInvocations.length).toBeGreaterThan(0)

        // Negative case: the never-submitted pane restores FRESH -- no
        // `--session` argv naming its (nonexistent) session, never a blank
        // error state either. This is the "zero candidates -> keep
        // watching, no bind" guarantee proven end-to-end.
        await expect(async () => {
          const leaf = await findLeafById(tabId!, neverSubmittedPaneId)
          expect(leaf?.content?.status).not.toBe('error')
          expect(leaf?.content?.terminalId).toBeTruthy()
          // A fresh (non-resuming) opencode launch never carries a
          // sessionRef/resumeSessionId -- this pane never submitted, so the
          // locator never armed a Located association for it.
          expect(leaf?.content?.sessionRef).toBeUndefined()
          expect(leaf?.content?.resumeSessionId).toBeUndefined()
        }).toPass({ timeout: 30_000 })

        const restoredNeverSubmittedTerminalId: string | undefined =
          (await findLeafById(tabId!, neverSubmittedPaneId))?.content?.terminalId
        expect(restoredNeverSubmittedTerminalId).toBeTruthy()
        await expect.poll(async () => {
          const buffer = await page.evaluate((id: string) => {
            return (window as any).__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id)
          }, restoredNeverSubmittedTerminalId!)
          return typeof buffer === 'string' && buffer.includes('opencode> ')
        }, { timeout: 15_000 }).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
