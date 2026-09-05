import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * CODEX TERMINAL RESTORE (Lane B2) -- restore-across-server-restart
 * acceptance scenario for codex TERMINAL panes on the Rust port: a fresh
 * WS-created codex pane gains its identity SERVER-SIDE (the rollout
 * locator), then resumes across a full server restart via
 * `codex ... resume <id>`.
 *
 * KNOWN DIVERGENCE (rust-only, by design -- see `playwright.config.ts`'s
 * `opencode-terminal-restore-rust.spec.ts`'s identical divergence note):
 * identity there depended on the client's `terminal.codex.durability.updated`
 * candidate path, which the Rust implementation no longer exposes. This is not a
 * parity gap to gate per-assertion; it is a capability that exists only on
 * the Rust port, designed by analogy to the amplifier/opencode locator
 * precedents, and this spec is scoped to the Rust project only rather than
 *
 * The fix under test (Tasks 1-7 of the codex rollout locator pipeline): the
 * Rust server arms fresh WS-created codex panes at create; the pane's first
 * Enter re-snapshots known_files and opens the submit window; the 150ms
 * sweep resolves the NEW rollout JSONL under CODEX_HOME/sessions (first-line
 * session_meta `payload.id` is the identity), adopts it (identity registry +
 * terminal meta + pane ledger + broadcasts + activity bind), and broadcasts
 * `terminal.session.associated` + `terminal.meta.updated` -- the SAME wire
 * messages the frozen client's generic
 * `reconcileTerminalSessionAssociation` + restore machinery already handle
 * for every other provider. No client/shared changes were needed; this
 * scenario is the proof.
 *
 * Row-timing note (mirrors the donor spec's fixture-shape note): the Task 8
 * fixture models the ENTER-anchored shape (the rollout is written on the
 * pane's first Enter, exactly like real codex -- the rollout materializes
 * only at the first user prompt) so the scenario has a clean, symmetric
 * negative control (a pane that never types never gets a rollout, never
 * associates). Finer-grained rollout-vs-arm timing races are separately and
 * deterministically proven by the locator's own Rust unit tests, which
 * control timing to the millisecond -- something this e2e, driving a real
 * browser + WS round trip, cannot do reliably.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs')

/**
 * Install the fake codex CLI as an executable named `codex` in a throwaway
 * bin dir, then point `CODEX_CMD` at it -- same copy-then-chmod pattern
 * `opencode-terminal-restore-rust.spec.ts`'s `installFakeOpencodeTerminal`
 * uses (helpers are per-spec-owned by convention, copied not imported).
 */
async function installFakeCodexTerminal(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  await fs.copyFile(FAKE_CODEX_TERMINAL_SOURCE, target)
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

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/**
 * Open a NEW pane via the picker and select the "Codex CLI" provider option
 * (the manifest label in `extensions/codex-cli/freshell.json` is
 * "Codex CLI" -- `/^Codex$/` matches nothing). Selecting a coding-CLI
 * provider opens a follow-up "Starting directory for Codex CLI" combobox
 * (`src/components/panes/DirectoryPicker.tsx`), pre-filled with the CURRENT
 * directory and already focused. Pressing Enter submits the combobox's own
 * pre-filled value directly, accepting the current directory as-is (mirrors
 * `opencode-terminal-restore-rust.spec.ts`'s `openOpencodePane`).
 */
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

/** Every codex-mode terminal leaf currently in a tab's layout. */
function findCodexLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'codex')
}

/**
 * Open a new codex pane (splitting the current terminal) and return the
 * NEWLY-added codex leaf -- identified by diffing the leaf set before vs
 * after, since a fresh codex pane's `content.terminalId` isn't known until
 * the create round-trip completes.
 */
async function openCodexPaneAndGetLeaf(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const before = findCodexLeaves(await harness.getPaneLayout(tabId))
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openCodexPane(page)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  return expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const newLeaf = findCodexLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
    return newLeaf?.content?.terminalId ? newLeaf : null
  }, { timeout: 15_000 }).not.toBeNull().then(async () => {
    const layout = await harness.getPaneLayout(tabId)
    return findCodexLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test.describe('Codex Terminal Restore (Rust only)', () => {
  test.setTimeout(120_000)

  test('a fresh codex terminal pane gains server-side identity and restores across a server restart via `codex resume <id>`, and a never-submitted pane restores fresh', async ({ page }) => {
    // (`playwright.config.ts`), but assert the precondition explicitly so a
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-terminal-restore-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-terminal-argv.jsonl')
    try {
      const fakeCodexPath = await installFakeCodexTerminal(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            CODEX_CMD: fakeCodexPath,
            FAKE_CODEX_TERMINAL_ARGV_LOG: argLogPath,
            // Codex managed-launch opt-out (kata cnwc): 6a8733a3a flipped
            // FRESHELL_CODEX_MANAGED_LAUNCH's default ON (only exact "0"
            // disables, launch_plan.rs), but fake-codex-terminal.mjs only
            // speaks the plain-CLI contract (prompt + Enter-gated rollout) --
            // under the managed app-server plan every codex create 500s
            // ("creating Codex terminal: app-server error 500"). Same pin the
            // flag-flip commit set in the Rust plain-CLI unit/integration
            // suites (set_var(FRESHELL_CODEX_MANAGED_LAUNCH, "0")).
            FRESHELL_CODEX_MANAGED_LAUNCH: '0',
          },
          // PanePicker only renders a CLI option when THREE conditions all
          // hold (`src/components/panes/PanePicker.tsx`'s `cliOptions`
          // filter): `availableClis[name]`, `enabledProviders.includes(name)`,
          // and NOT `disabledExtensions.includes(name)`. Seeded here the same
          // way `opencode-terminal-restore-rust.spec.ts` seeds
          // `enabledProviders` for `opencode`.
          setupHome: async (homeDir) => {
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

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // `availableClis` is populated by the SERVER's `which`/`where.exe`
        // probe (`crates/freshell-server/src/extensions.rs`'s
        // `detect_available_clis_live`), whose spec list is derived from
        // GENUINELY DISCOVERED CLI extension manifests --
        // `extensions/codex-cli/freshell.json` is a real `category: "cli"`
        // manifest (`command: "codex"`, `envVar: "CODEX_CMD"`), so the
        // server's live boot-time detection already discovers and probes
        // codex via the `CODEX_CMD` override this test sets.
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // -------------------------------------------------------------
        // Positive case: a fresh codex pane that DOES submit a prompt.
        // -------------------------------------------------------------
        const positiveLeaf = await openCodexPaneAndGetLeaf(page, harness, tabId!)
        const terminalIdBefore: string = positiveLeaf.content.terminalId
        const positivePaneId: string = positiveLeaf.id
        expect(terminalIdBefore).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          return typeof buffer === 'string' && buffer.includes('codex> ')
        }, { timeout: 15_000 }).toBe(true)

        // The pane's first Enter/submit -- this is the locator's submit
        // trigger: the server re-snapshots known_files and opens the 2s
        // submit window; the fixture writes the rollout on this Enter. Only
        // two `.xterm` containers exist at this point (the original shell
        // pane + this freshly-created one), and this one was just added, so
        // `.last()` unambiguously targets it.
        await page.locator('.xterm').last().click()
        await page.keyboard.type('hello codex')
        await page.keyboard.press('Enter')

        // The fixture's session-created marker proves the CLI itself wrote
        // its rollout JSONL. Strip newlines before matching -- xterm wraps
        // long lines at the terminal's column width.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return /codex: session \S+ started/.test(unwrapped)
        }, { timeout: 15_000 }).toBe(true)

        /** Re-read the (possibly reshuffled) leaf for a given pane id. */
        async function findLeafById(tid: string, paneId: string): Promise<any> {
          const layout = await harness.getPaneLayout(tid)
          return collectLeaves(layout).find((leaf) => leaf.id === paneId)
        }

        // The SERVER-SIDE identity capture proof. NO client candidate can
        // exist here: the Rust server never emits
        // `terminal.codex.durability.updated`, so the frozen client's codex
        // candidate sender never fires -- identity arriving at all IS the
        // server-locator proof. The client path is already validated (A7):
        // the frozen client applies `terminal.session.associated`
        // provider-generically (`App.tsx:1004-1017` -> panesSlice
        // `sessionRef`, `resumeSessionId` cleared), and its conflict guard
        // only drops a push when the pane ALREADY holds a DIFFERENT
        // sessionRef -- impossible for fresh panes (the locator arms only
        // unbound panes).
        const associatedSessionId: string = await expect.poll(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId
        })
        expect(associatedSessionId).toMatch(UUID_RE)
        const positiveLeafAfterAssociation = await findLeafById(tabId!, positivePaneId)
        expect(positiveLeafAfterAssociation?.content?.sessionRef?.provider).toBe('codex')

        // Persisted across a reload too (the client's persist middleware +
        // localStorage round trip that the restore chain depends on).
        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // -------------------------------------------------------------
        // Negative control: a SECOND codex pane that never submits.
        // Proves the locator never false-binds an un-submitted terminal --
        // the fixture writes no rollout without an Enter -- opened alongside
        // the positive-case pane so both restore in the SAME server restart
        // below.
        // -------------------------------------------------------------
        const neverSubmittedLeaf = await openCodexPaneAndGetLeaf(page, harness, tabId!)
        const neverSubmittedTerminalIdBefore: string = neverSubmittedLeaf.content.terminalId
        const neverSubmittedPaneId: string = neverSubmittedLeaf.id
        expect(neverSubmittedTerminalIdBefore).toBeTruthy()
        expect(neverSubmittedPaneId).not.toBe(positivePaneId)

        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // -------------------------------------------------------------
        // Full server restart (not a client reload) -- PTYs are lost; codex
        // must respawn with `resume <id>` for the associated pane, and
        // fresh (no `resume`) for the never-submitted one.
        // -------------------------------------------------------------
        if (!server.restart) {
          throw new Error('Owned Rust E2eServerHandle does not implement restart()')
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
        // `codex ... resume <id>` -- proven two independent ways: (1) the
        // fixture's own greppable stdout marker, scoped to THIS pane's
        // terminal, and (2) the argv log the fixture writes on every
        // invocation (independent of terminal-buffer scraping).
        await expect(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          expect(leaf?.content?.status).not.toBe('error')
          expect(leaf?.content?.terminalId).toBeTruthy()
        }).toPass({ timeout: 30_000 })

        // WAVE-B INTEGRATION NOTE (B1 reconcile adoption x this spec): on the
        // page.reload path the pane's terminalId can change ONCE MORE after
        // it first turns truthy -- a transient pre-verdict create is replaced
        // when the pane.reconcile respawn verdict folds (reconcileEpoch bump,
        // panesSlice.resetPaneForReconcileCreate). Poll the pane's CURRENT
        // terminal each iteration instead of sampling the first terminalId,
        // so the assertion targets the converged state the verdict produces.
        await expect.poll(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          const currentTerminalId = leaf?.content?.terminalId
          if (!currentTerminalId) return false
          const buffer = await harness.getTerminalBuffer(currentTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${associatedSessionId}`)
        }, { timeout: 20_000 }).toBe(true)

        // codex's `resumeArgs: ["resume", "{{sessionId}}"]` is a SUBCOMMAND
        // appended LAST (after `-c` overrides) -- assert the ADJACENT PAIR
        // anywhere in argv, never `argv[0]`.
        const entries = await readArgvLog(argLogPath)
        const resumed = entries.some((e) => {
          const i = e.argv.indexOf('resume')
          return i !== -1 && e.argv[i + 1] === associatedSessionId
        })
        expect(resumed).toBe(true)

        // Negative case: the never-submitted pane restores FRESH -- no
        // `resume` argv naming its (nonexistent) session, never a blank
        // error state either. This is the "zero candidates -> keep
        // watching, no bind" guarantee proven end-to-end.
        await expect(async () => {
          const leaf = await findLeafById(tabId!, neverSubmittedPaneId)
          expect(leaf?.content?.status).not.toBe('error')
          expect(leaf?.content?.terminalId).toBeTruthy()
          // A fresh (non-resuming) codex launch never carries a
          // sessionRef/resumeSessionId -- this pane never submitted, so the
          // locator never resolved an association for it.
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
          return typeof buffer === 'string' && buffer.includes('codex> ')
        }, { timeout: 15_000 }).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
