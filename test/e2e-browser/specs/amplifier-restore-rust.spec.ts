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
 * the Rust port, on the LAUNCHER-ASSIGNED identity mechanism.
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
 * The mechanism under test: the Rust broker mints a UUID at amplifier
 * terminal create, pre-creates the session stub dir under
 * `<amplifier home>/projects/<cwd-slug>/sessions/<uuid>/` (metadata.json +
 * empty transcript.jsonl/events.jsonl), and ALWAYS spawns
 * `amplifier resume <uuid>` -- identity is launcher-assigned at create time
 * and lands in the pane's `content.sessionRef` BEFORE any input. There is
 * no submit-time correlation/association step anymore (the old
 * `AmplifierLocator` path is deleted). Never-used stubs are GC'd at
 * terminal exit/shutdown, and the broker re-stubs GC'd ids at create
 * (ensure-after-GC), so even a never-typed pane restores by resuming its
 * SAME id instead of hanging. Home resolution on BOTH sides (broker + fake
 * CLI) is `$FRESHELL_AMPLIFIER_HOME` else `$HOME/.amplifier`.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')

/** Launcher-assigned amplifier identity: a broker-minted UUID (v4 shape). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  test('amplifier panes restore across a server restart via `amplifier resume <id>` -- identity assigned at create, never-used panes included', async ({ page, e2eServerKind }) => {
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
            // Pin the broker's amplifier home explicitly so server and fake
            // CLI agree deterministically (validated F1: the broker never
            // reads `AMPLIFIER_HOME`; this env is captured at server boot,
            // BEFORE the events-path resolver's boot-time `amplifier_home()`
            // snapshot). Belt-and-suspenders: even without it, the harness
            // HOME sandbox (`rust-server.ts` ->
            // `applyIsolatedHomeEnvironment`) makes the `$HOME/.amplifier`
            // fallback land inside the isolated home (F7/V9).
            FRESHELL_AMPLIFIER_HOME: path.join(sharedRoot, 'amplifier-home'),
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

        // `availableClis` is populated by the SERVER's `which`/`where.exe`
        // probe (`crates/freshell-server/src/extensions.rs`'s
        // `detect_available_clis_live`), whose spec list is derived from
        // GENUINELY DISCOVERED CLI extension manifests
        // (`ExtensionRegistry::cli_detection_specs`) -- NOT the module's
        // `DEFAULT_CLI_DETECTION_SPECS` constant, which that module's own
        // doc comment says is dead reference-parity code never consulted
        // on the real boot path. `extensions/amplifier/freshell.json` is a
        // real `category: "cli"` manifest (`command: "amplifier"`,
        // `envVar: "AMPLIFIER_CMD"`), the `RustServer` fixture spawns with
        // `cwd: PROJECT_ROOT` (`test/e2e-browser/helpers/rust-server.ts`),
        // exactly where `resolve_extension_dirs`'s cwd-relative
        // `extensions/` scan looks -- so the server's live boot-time
        // detection already discovers and probes amplifier via the
        // `AMPLIFIER_CMD` override this test sets, with no client-side
        // Redux workaround needed.
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        /** Re-read the (possibly reshuffled) leaf for a given pane id. */
        async function findLeafById(tid: string, paneId: string): Promise<any> {
          const layout = await harness.getPaneLayout(tid)
          return collectLeaves(layout).find((leaf) => leaf.id === paneId)
        }

        // ── Positive pane: identity is launcher-assigned AT CREATE — no submit needed.
        // openAmplifierPaneAndGetLeaf returns the NEW pane-layout LEAF node
        // (`{ id, type: 'leaf', content: { mode, terminalId, ... } }`),
        // NOT a `{paneId, terminalId}` tuple — read its fields, don't destructure.
        const positivePane = await openAmplifierPaneAndGetLeaf(page, harness, tabId!)
        const positivePaneId: string = positivePane.id
        const terminalId: string = positivePane.content.terminalId
        const sessionId: string = await expect.poll(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(tabId!, positivePaneId)
          return leaf!.content!.sessionRef!.sessionId as string
        })
        // Server-minted UUID — NOT a fake-amp-* id minted by the CLI, and
        // present BEFORE any input (the payoff assertion the old submit-time
        // correlation mechanism could never make).
        expect(sessionId).toMatch(UUID_RE)
        const positiveLeaf = await findLeafById(tabId!, positivePaneId)
        expect(positiveLeaf?.content?.sessionRef?.provider).toBe('amplifier')

        // The PTY was spawned as `resume <sessionId>` and the fake CLI adopted it.
        // (The xterm buffer WRAPS long lines at the terminal's column width;
        // strip newlines before matching -- the wrap is a rendering artifact.)
        await expect.poll(async () =>
          ((await harness.getTerminalBuffer(terminalId)) ?? '').replace(/\n/g, ''),
        { timeout: 15_000 }).toContain(`amplifier: resumed session ${sessionId}`)

        // Type a turn → the fake CLI stamps the "used" signature. Only two
        // `.xterm` containers exist at this point (the original shell pane +
        // this freshly-created one), so `.last()` unambiguously targets it.
        await page.locator('.xterm').last().click()
        await page.keyboard.type('hello amplifier')
        await page.keyboard.press('Enter')
        await expect.poll(async () =>
          ((await harness.getTerminalBuffer(terminalId)) ?? '').replace(/\n/g, ''),
        { timeout: 15_000 }).toContain(`amplifier: turn recorded ${sessionId}`)

        // Persisted across a reload too (the client's persist middleware +
        // localStorage round trip that the restore chain depends on).
        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // ── Negative pane: never typed in, and LEFT OPEN across the restart.
        // It ALSO gets create-time identity (the old "no identity until
        // submit" behavior is gone by design). Its never-used stub is GC'd
        // at shutdown, but the persisted sessionRef triggers ensure-after-GC
        // re-stubbing under the SAME id on restore.
        const negativePane = await openAmplifierPaneAndGetLeaf(page, harness, tabId!)
        const negativePaneId: string = negativePane.id
        const negativeTerminalId: string = negativePane.content.terminalId
        const negativeSessionId: string = await expect.poll(async () => {
          const leaf = await findLeafById(tabId!, negativePaneId)
          return leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(tabId!, negativePaneId)
          return leaf!.content!.sessionRef!.sessionId as string
        })
        expect(negativeSessionId).toMatch(UUID_RE)
        expect(negativeSessionId).not.toBe(sessionId)

        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // The never-used stub dir exists on disk BEFORE the restart (the GC
        // at shutdown is what removes it -- assert the precondition so the
        // re-stub assertion below provably exercises ensure-after-GC).
        const amplifierHome = path.join(sharedRoot, 'amplifier-home')
        async function findStubDir(sid: string): Promise<string | null> {
          const projectsDir = path.join(amplifierHome, 'projects')
          const slugs = await fs.readdir(projectsDir).catch(() => [] as string[])
          for (const slug of slugs) {
            const dir = path.join(projectsDir, slug, 'sessions', sid)
            try {
              await fs.access(path.join(dir, 'metadata.json'))
              return dir
            } catch {
              /* keep looking */
            }
          }
          return null
        }
        expect(await findStubDir(negativeSessionId)).not.toBeNull()

        // -------------------------------------------------------------
        // Full server restart (not a client reload) -- PTYs are lost;
        // BOTH panes must respawn with `resume <their-id>`.
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

        // ── Restore proof, two independent ways, for BOTH panes:
        // (a) used pane resumes the SAME id;
        // (b) never-used pane (stub GC'd at shutdown) ALSO resumes its SAME
        //     id — the broker re-stubs GC'd ids at create (ensure-after-GC;
        //     Task 10's `resume_of_a_gcd_stub_is_restubbed_under_the_same_id`
        //     unit pin), so a never-typed pane restores instead of hanging.
        //     A GC'd id is never reissued as a fresh one.
        // Wait for each pane to hold a NEW terminalId (the respawn's), not
        // the persisted pre-restart one. Under the adopted reconcile client
        // the pane is non-destructive on boot: it keeps its persisted
        // terminalId + status until the verdict folds, so a "status not
        // error && terminalId truthy" gate is satisfiable by the STALE
        // pre-restart identity and racing it captures a dead terminal id
        // (the resume marker then lands in the NEW terminal's buffer,
        // invisible to a poll scoped to the stale one). Same pattern the
        // restore-contract wall's claude scenario uses: poll until the id
        // provably changed.
        for (const [paneId, sid, oldTid] of [
          [positivePaneId, sessionId, terminalId],
          [negativePaneId, negativeSessionId, negativeTerminalId],
        ] as const) {
          const restoredTerminalId: string = await expect
            .poll(async () => {
              const leaf = await findLeafById(tabId!, paneId)
              if (leaf?.content?.status === 'error') return null
              const tid = leaf?.content?.terminalId
              return tid && tid !== oldTid ? tid : null
            }, { timeout: 30_000 })
            .not.toBeNull()
            .then(async () => (await findLeafById(tabId!, paneId))!.content.terminalId)
          await expect.poll(async () =>
            ((await harness.getTerminalBuffer(restoredTerminalId)) ?? '').replace(/\n/g, ''),
          { timeout: 20_000 }).toContain(`amplifier: resumed session ${sid}`)
        }
        // The never-used pane's stub was re-created on disk under the SAME
        // id by the ensure-after-GC path.
        expect(await findStubDir(negativeSessionId)).not.toBeNull()

        // argv log: every amplifier spawn in this scenario was a resume, and
        // both ids appear as `session resume --full-history <id>` invocations
        // post-restart.
        const entries = (await fs.readFile(argLogPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] })
        const isResume = (argv: string[]) => argv[0] === 'session' && argv[1] === 'resume' && argv[2] === '--full-history'
        const resumes = entries.filter((e) => isResume(e.argv))
        expect(resumes.some((e) => e.argv[3] === sessionId)).toBe(true)
        expect(resumes.some((e) => e.argv[3] === negativeSessionId)).toBe(true)
        expect(entries.every((e) => isResume(e.argv))).toBe(true)

        // Invariant pins: the re-homed identity sweep never fires for these
        // launcher-assigned panes, and the boot layout canary stayed quiet.
        // The Rust tracing sink is `rust-server.jsonl` under `info.logsDir`
        // (`crates/freshell-server/src/logging.rs`; `info.debugLogPath` is a
        // constructed path NOTHING writes for the Rust fixture).
        const serverLogs = await fs.readFile(path.join(info.logsDir, 'rust-server.jsonl'), 'utf8').catch(() => '')
        expect(serverLogs).not.toContain('terminal_identity_unresolved')
        expect(serverLogs).not.toContain('amplifier_layout_contract_broken')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
