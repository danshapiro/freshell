import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * AMPLIFIER RESTORE -- restore-across-server-restart acceptance scenario for
 * the Rust port (`docs/plans/2026-07-18-amplifier-restore-spec.md`).
 *
 * KNOWN DIVERGENCE (rust-only, by design -- see `playwright.config.ts`'s
 * `rust-chromium`-only `testMatch` entry for this file, and
 * `session-directory-matrix.spec.ts`'s identical divergence note): this
 * checked-out branch's `server/` tree (legacy Node implementation, FROZEN
 * for this task) predates upstream `origin/main` commit `05c6b1fa`
 * ("feat(amplifier): durable session tracking via events.jsonl", #514) --
 * legacy has NO amplifier provider registered at all, so this scenario
 * cannot run there. This is not a parity gap to gate per-assertion; it is an
 * absent feature on this branch, and this spec is scoped to the Rust
 * project only rather than pretending legacy participates.
 *
 * The fix under test (spec §4.2, Slices A+B): a Rust-side
 * `AmplifierLocator` (`crates/freshell-sessions/src/amplifier_locator.rs`)
 * correlates a fresh amplifier PTY's first Enter/submit with the new
 * session dir amplifier lazily creates, binds the terminal's identity
 * (`crate::identity`), and broadcasts `terminal.session.associated` +
 * `terminal.meta.updated` -- the SAME wire messages the frozen client's
 * generic `reconcileTerminalSessionAssociation` + restore machinery already
 * handle for every other provider. No client/shared changes were needed;
 * this scenario is the proof.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')

/**
 * Install the fake amplifier CLI as an executable named `amplifier` in a
 * throwaway bin dir, then point `AMPLIFIER_CMD` at it -- same
 * copy-then-chmod pattern `opencode-restart-recovery.spec.ts`'s
 * `installFakeOpencode` uses for `fake-opencode.cjs` (a plain copy is safe
 * here: this fixture has no bare ESM import specifiers that would break
 * outside its home directory, unlike `fake-app-server.mjs`'s `ws` import,
 * which is why THAT fixture uses a re-exec wrapper instead).
 */
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
 * Open a NEW pane via the picker and select the "Amplifier" provider option.
 * Selecting a coding-CLI provider opens a follow-up "Starting directory for
 * Amplifier" combobox (`src/components/panes/DirectoryPicker.tsx`),
 * pre-filled with the CURRENT directory and already focused. Its listbox
 * options are typeahead SUBDIRECTORY suggestions (e.g. `.freshell`,
 * `.landscape`), not alternatives to the pre-filled value -- clicking one
 * would launch the pane in the WRONG (sub)directory. Pressing Enter instead
 * submits the combobox's own pre-filled value directly
 * (`DirectoryPicker.tsx`'s `handleInputKeyDown`, `event.key === 'Enter'`),
 * accepting the current directory as-is.
 */
async function openAmplifierPane(page: import('@playwright/test').Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Amplifier$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for Amplifier/i }).press('Enter')
}

/**
 * Flatten a pane layout tree into its leaf nodes. `openPanePicker` always
 * SPLITS the currently-visible terminal rather than opening a new tab (it
 * only falls back to "Add pane" when no `.xterm` is visible yet), so both
 * amplifier panes in this scenario end up as sibling leaves under ONE tab's
 * split tree, not two separate tabs -- mirrors `restore-matrix.spec.ts`'s
 * `findFreshAgentLeaf` helper, generalized to return every matching leaf.
 */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Every amplifier-mode terminal leaf currently in a tab's layout. */
function findAmplifierLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'amplifier')
}

/**
 * Open a new amplifier pane (splitting the current terminal) and return the
 * NEWLY-added amplifier leaf -- identified by diffing the leaf set before vs
 * after, since a fresh amplifier pane's `content.terminalId` isn't known
 * until the create round-trip completes.
 */
async function openAmplifierPaneAndGetLeaf(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const before = findAmplifierLeaves(await harness.getPaneLayout(tabId))
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openAmplifierPane(page)
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

test.describe('Amplifier Restore (Rust only)', () => {
  test.setTimeout(120_000)

  test('an amplifier pane restores across a server restart via `amplifier resume <id>`, and a never-submitted pane restores fresh', async ({ page, e2eServerKind }) => {
    // This spec is registered ONLY under the `rust-chromium` project
    // (`playwright.config.ts`), but assert the precondition explicitly so a
    // future accidental `MATRIX_SPECS` inclusion fails loudly instead of
    // silently no-op'ing on legacy.
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amplifier-restore-'))
    const argLogPath = path.join(sharedRoot, 'fake-amplifier-argv.jsonl')
    try {
      const fakeAmplifierPath = await installFakeAmplifierCli(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            AMPLIFIER_CMD: fakeAmplifierPath,
            FAKE_AMPLIFIER_ARGV_LOG: argLogPath,
          },
          // PanePicker only renders a CLI option when THREE conditions all
          // hold (`src/components/panes/PanePicker.tsx`'s `cliOptions`
          // filter): `availableClis[name]`, `enabledProviders.includes(name)`,
          // and NOT `disabledExtensions.includes(name)`. `enabledProviders`
          // has no amplifier-friendly default, so it must be seeded here --
          // same real settings surface the FreshCodex restore-matrix
          // scenarios seed for `codingCli.enabledProviders` (there for
          // `codex`), just naming `amplifier` instead.
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['amplifier'] },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // `availableClis` is populated by the SERVER's `which amplifier`
        // probe (`crates/freshell-server/src/extensions.rs`'s
        // `detect_available_clis`), but that probe's spec derivation maps
        // 1:1 to the historical fixed CLI set (claude/codex/opencode/
        // gemini/kimi, per that module's own doc comment) and never
        // considers newer extension-provided CLIs like amplifier -- so the
        // picker would never show it regardless of `AMPLIFIER_CMD`/PATH.
        // Declare availability directly via the SAME real Redux action
        // `restore-matrix.spec.ts`'s FreshCodex scenarios use for exactly
        // this class of e2e-sandbox gap (there for codex/claude), merged
        // with whatever the server already detected so this doesn't
        // clobber real detections of other providers.
        await page.evaluate(() => {
          const harnessGlobal = (window as any).__FRESHELL_TEST_HARNESS__
          const current = harnessGlobal?.getState()?.connection?.availableClis ?? {}
          harnessGlobal?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { ...current, amplifier: true },
          })
        })

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // -------------------------------------------------------------
        // Positive case: a fresh amplifier pane that DOES submit a prompt.
        // -------------------------------------------------------------
        const positiveLeaf = await openAmplifierPaneAndGetLeaf(page, harness, tabId!)
        const terminalIdBefore: string = positiveLeaf.content.terminalId
        const positivePaneId: string = positiveLeaf.id
        expect(terminalIdBefore).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          return typeof buffer === 'string' && buffer.includes('amplifier> ')
        }, { timeout: 15_000 }).toBe(true)

        // The pane's first Enter/submit -- this is the locator's Enter<->
        // session-dir correlation trigger (spec §2.2). Any prompt text
        // works; the fixture doesn't inspect content. Only two `.xterm`
        // containers exist at this point (the original WSL pane + this
        // freshly-created one), and this one was just added, so `.last()`
        // unambiguously targets it -- same pattern already proven by
        // `restore-matrix.spec.ts`'s own terminal-restore scenario.
        await page.locator('.xterm').last().click()
        await page.keyboard.type('hello amplifier')
        await page.keyboard.press('Enter')

        // The fixture's session-created marker proves the CLI itself did
        // its lazy session-dir write. The xterm buffer WRAPS long lines at
        // the terminal's column width, which can split this marker's text
        // across a row boundary (observed: "...fake-amp-123 st\narted");
        // strip newlines before matching -- the wrap is a rendering
        // artifact, not a content difference the assertion should care
        // about.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return /amplifier: session fake-amp-\S+ started/.test(unwrapped)
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
        // writes for every other provider (spec §3.1).
        const associatedSessionId: string = await expect.poll(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? leaf?.content?.resumeSessionId
        })
        expect(associatedSessionId).toMatch(/^fake-amp-/)
        const positiveLeafAfterAssociation = await findLeafById(tabId!, positivePaneId)
        expect(positiveLeafAfterAssociation?.content?.sessionRef?.provider).toBe('amplifier')

        // Persisted across a reload too (the client's persist middleware +
        // localStorage round trip that the restore chain depends on).
        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // -------------------------------------------------------------
        // Negative control: a SECOND amplifier pane that never submits.
        // Proves the locator never false-binds an un-submitted terminal
        // (spec §5.2 step 5) -- opened alongside the positive-case pane so
        // both restore in the SAME server restart below.
        // -------------------------------------------------------------
        const neverSubmittedLeaf = await openAmplifierPaneAndGetLeaf(page, harness, tabId!)
        const neverSubmittedTerminalIdBefore: string = neverSubmittedLeaf.content.terminalId
        const neverSubmittedPaneId: string = neverSubmittedLeaf.id
        expect(neverSubmittedTerminalIdBefore).toBeTruthy()
        expect(neverSubmittedPaneId).not.toBe(positivePaneId)

        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // -------------------------------------------------------------
        // Full server restart (not a client reload) -- PTYs are lost;
        // amplifier must respawn with `resume <id>` for the associated
        // pane, and fresh (no `resume`) for the never-submitted one.
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

        // Positive case: the restored pane's PTY receives `amplifier
        // resume <id>` -- proven two independent ways: (1) the fixture's
        // own greppable stdout marker, scoped to THIS pane's terminal, and
        // (2) the argv log the fixture writes on every invocation
        // (independent of terminal-buffer scraping).
        await expect(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          expect(leaf?.content?.status).not.toBe('error')
          expect(leaf?.content?.terminalId).toBeTruthy()
        }).toPass({ timeout: 30_000 })

        const restoredTerminalId: string | undefined = (await findLeafById(tabId!, positivePaneId))?.content?.terminalId
        expect(restoredTerminalId).toBeTruthy()
        // Same xterm line-wrap caveat as the "session started" marker above
        // -- strip newlines before matching.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(restoredTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`amplifier: resumed session ${associatedSessionId}`)
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
          .filter((entry) => entry.argv[0] === 'resume')
        expect(resumeInvocations.some((entry) => entry.argv[1] === associatedSessionId)).toBe(true)

        // Negative case: the never-submitted pane restores FRESH -- no
        // `resume` argv naming its (nonexistent) session, never a blank
        // error state either. This is the `zero candidates -> keep
        // watching, no bind` guarantee proven end-to-end.
        await expect(async () => {
          const leaf = await findLeafById(tabId!, neverSubmittedPaneId)
          expect(leaf?.content?.status).not.toBe('error')
          expect(leaf?.content?.terminalId).toBeTruthy()
          // A fresh (non-resuming) amplifier launch never carries a
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
          return typeof buffer === 'string' && buffer.includes('amplifier> ')
        }, { timeout: 15_000 }).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
