import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WsCapture, type WsFrame } from '../helpers/ws-capture.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')
const SESSION_MARKER_RE = /opencode: session (ses_e2e_\S+) started/

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

/**
 * Write one opencode rebind signal the way the TUI plugin does:
 * <terminalId>__<nonce>.json into the server's signal dir, atomically
 * (tmp + rename; the 1s sweep filters on the .json extension so it can
 * never read a torn file). Returns the final path so consumption
 * (act-then-delete) is assertable.
 */
async function writeOpencodeSignal(
  homeDir: string,
  terminalId: string,
  seq: number,
  sessionId: string,
): Promise<string> {
  const dir = path.join(homeDir, '.freshell', 'session-signals', 'opencode')
  await fs.mkdir(dir, { recursive: true })
  // Timestamp-first, zero-padded: lexicographic order == emission order,
  // digits and '-' only so the nonce can never contain the __ delimiter.
  const nonce = `${String(Date.now()).padStart(14, '0')}-${String(seq).padStart(6, '0')}-${process.pid}`
  const name = `${terminalId}__${nonce}`
  const tmpPath = path.join(dir, `${name}.json.tmp`)
  const finalPath = path.join(dir, `${name}.json`)
  await fs.writeFile(tmpPath, JSON.stringify({ session_id: sessionId, source: 'opencode-tui-plugin' }))
  await fs.rename(tmpPath, finalPath)
  return finalPath
}

/**
 * Seed a real root `session` row for `sessionId` into the fake's
 * `<homeDir>/.local/share/opencode/opencode.db` (the server's
 * `applyIsolatedHomeEnvironment` pins `XDG_DATA_HOME` to
 * `<homeDir>/.local/share`, so this is the SAME db the fake CLI writes and
 * the server's `OpencodeSource` index scans). Schema mirrors
 * `fake-opencode-terminal.mjs`'s `writeSessionRow` exactly.
 *
 * Why the spec needs this: in production the TUI plugin only ever signals
 * session ids opencode has ALREADY persisted to disk. A signal-minted id
 * with no disk row is unrealistic — and the reconcile existence probe
 * (`crates/freshell-server/src/existence.rs`) correctly adjudicates such an
 * id `dead_session`/`session_not_on_disk` on the post-restart respawn path,
 * parking the pane in the Dead-sessions dialog instead of resuming it. So
 * every id this spec writes into a signal is seeded on disk first, modeling
 * the real drifted-session shape end to end.
 */
async function seedOpencodeSessionRow(homeDir: string, sessionId: string, directory: string): Promise<void> {
  const dataHome = path.join(homeDir, '.local', 'share', 'opencode')
  await fs.mkdir(dataHome, { recursive: true })
  const db = new DatabaseSync(path.join(dataHome, 'opencode.db'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER
      );
    `)
    const now = Date.now()
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run(
      `proj-${sessionId}`,
      directory,
    )
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version,
         time_created, time_updated, time_archived)
       VALUES (?, ?, NULL, ?, ?, ?, 'opencode-rebind-e2e-seed', ?, ?, NULL)`,
    ).run(sessionId, `proj-${sessionId}`, sessionId, directory, sessionId, now, now)
  } finally {
    db.close()
  }
}

/** Bounded-wait NEGATIVE helper over WsCapture frames (no fixed sleeps). */
async function expectNoMatchingFrame(
  capture: WsCapture,
  pred: (frame: WsFrame) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = capture.all.find(pred)
    if (hit) {
      throw new Error(`Expected NO frame matching ${label}, but got: ${JSON.stringify(hit)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test.describe('OpenCode signal-driven rebind (Rust only)', () => {
  test.setTimeout(240_000)

  test('signal file rebinds the pane end to end: broadcast, fold, persistence, respawn argv, never-steal', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-rebind-'))
    const argLogPath = path.join(sharedRoot, 'fake-opencode-terminal-argv.jsonl')
    try {
      const fakeOpencodePath = await installFakeOpencodeTerminal(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            OPENCODE_CMD: fakeOpencodePath,
            FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
          },
          setupHome: async (homeDir: string) => {
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

      type ArgvEntry = { pid: number; t: number; argv: string[] }
      async function readArgvEntries(): Promise<ArgvEntry[]> {
        try {
          const raw = await fs.readFile(argLogPath, 'utf-8')
          return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as ArgvEntry)
        } catch {
          return []
        }
      }
      function argvValue(argv: string[], flag: string): string | undefined {
        const index = argv.indexOf(flag)
        return index >= 0 ? argv[index + 1] : undefined
      }

      // Server-side raw WS capture, opened BEFORE any opencode pane exists
      // so it sees the FIRST association frame too.
      const capture = new WsCapture(info.wsUrl, info.token)
      await capture.ready()

      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      /** Re-read the (possibly reshuffled) leaf for a given pane id. */
      async function findLeafById(tid: string, paneId: string): Promise<any> {
        const layout = await harness.getPaneLayout(tid)
        return collectLeaves(layout).find((leaf: any) => leaf.id === paneId)
      }

      /** Deterministic typing into a SPECIFIC terminal (CR as its own frame:
       *  the opencode locator's is_submit_input arms on enter-only input). */
      async function typeLineIntoTerminal(terminalId: string, text: string): Promise<void> {
        await page.evaluate(({ tid, data }) => {
          const testHarness = (window as any).__FRESHELL_TEST_HARNESS__
          if (!testHarness) throw new Error('Freshell test harness is not installed')
          testHarness.sendWsMessage({ type: 'terminal.input', terminalId: tid, data })
        }, { tid: terminalId, data: text })
        await page.evaluate(({ tid }) => {
          (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({ type: 'terminal.input', terminalId: tid, data: '\r' })
        }, { tid: terminalId })
      }

      /** Scrape the fake's fresh-session marker out of a terminal buffer. */
      async function scrapeSessionId(terminalId: string): Promise<string> {
        let sessionId: string | null = null
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          const match = SESSION_MARKER_RE.exec(unwrapped)
          sessionId = match?.[1] ?? null
          return sessionId
        }, { timeout: 30_000 }).not.toBeNull()
        return sessionId!
      }

      // ── Setup: one opencode pane, freshly bound to sesA by the locator.
      const pane1Leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const pane1Id: string = pane1Leaf.id
      const terminalId1: string = pane1Leaf.content.terminalId
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId1)
        return typeof buffer === 'string' && buffer.includes('opencode> ')
      }, { timeout: 15_000 }).toBe(true)
      await typeLineIntoTerminal(terminalId1, 'hello from the rebind spec')
      const sesA = await scrapeSessionId(terminalId1)
      await capture.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId1
          && frame.sessionRef?.sessionId === sesA,
        60_000,
        `fresh association terminal=${terminalId1} session=${sesA}`,
      )

      // ── Leg 1: signal file → rebind broadcast, exact sequence [sesA, sesB].
      // Signal payload ids must be ses_ + PURE alnum
      // (is_valid_opencode_session_id rejects underscores). Seeded on disk
      // first: the plugin only signals sessions opencode has persisted, and
      // the post-restart respawn path (Leg 5) adjudicates a diskless id
      // dead_session/session_not_on_disk instead of resuming it.
      const sesB = `ses_e2edrift${Date.now()}`
      await seedOpencodeSessionRow(info.homeDir, sesB, info.homeDir)
      const signalPath = await writeOpencodeSignal(info.homeDir, terminalId1, 1, sesB)
      const rebindFrame = await capture.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId1
          && frame.sessionRef?.sessionId === sesB,
        60_000,
        `signal rebind terminal=${terminalId1} session=${sesB}`,
      )
      expect(rebindFrame.previousSessionId).toBe(sesA)

      // Acted ⇒ deleted (act-then-delete): consumption proves the sweep ran.
      await expect.poll(async () => {
        try {
          await fs.access(signalPath)
          return 'still-present'
        } catch {
          return 'consumed'
        }
      }, { timeout: 5_000 }).toBe('consumed')

      // No frame ever reported an unbound/cleared identity between the two:
      // every association frame for this terminal carried a truthy session
      // id, and the distinct id sequence is exactly [sesA, sesB].
      const associationFrames = capture.all.filter(
        (frame) => frame.type === 'terminal.session.associated' && frame.terminalId === terminalId1,
      )
      for (const frame of associationFrames) {
        expect(frame.sessionRef?.provider).toBe('opencode')
        expect(frame.sessionRef?.sessionId).toBeTruthy()
      }
      const distinctSequence: string[] = []
      for (const frame of associationFrames) {
        const id = frame.sessionRef.sessionId as string
        if (distinctSequence[distinctSequence.length - 1] !== id) distinctSequence.push(id)
      }
      expect(distinctSequence).toEqual([sesA, sesB])

      // ── Leg 2: the browser client folded the rebind into the pane (real Redux).
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane1Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesB)

      // ── Leg 3: the pane is still interactive after the rebind.
      await page.evaluate(({ tid }) => {
        (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'terminal.input', terminalId: tid, data: 'still-interactive-after-rebind',
        })
      }, { tid: terminalId1 })
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId1)
        const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        return unwrapped.includes('still-interactive-after-rebind')
      }, { timeout: 15_000 }).toBe(true)
      const pane1AfterRebind = await findLeafById(tabId!, pane1Id)
      expect(pane1AfterRebind?.content?.status).not.toBe('error')

      // ── Leg 4: reload persistence — freshell.layout.v3 carries the new id.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane1Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesB)
      const persistedRaw: string = await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        const raw = window.localStorage.getItem('freshell.layout.v3')
        if (!raw) throw new Error('Missing persisted layout freshell.layout.v3')
        return raw
      })
      const persisted = JSON.parse(persistedRaw)
      const persistedPane1 = collectLeaves(persisted.panes?.layouts?.[tabId!])
        .find((leaf: any) => leaf.id === pane1Id)
      expect(persistedPane1?.content?.sessionRef?.sessionId).toBe(sesB)

      // ── Leg 5: server restart → respawn argv carries --session sesB, never sesA.
      const terminalIdBeforeRestart: string = (await findLeafById(tabId!, pane1Id))!.content.terminalId
      capture.close()
      if (!server.restart) {
        throw new Error('Owned Rust E2eServerHandle does not implement restart()')
      }
      await server.restart()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()

      const restoredTerminalId1: string = await expect
        .poll(async () => {
          const leaf = await findLeafById(tabId!, pane1Id)
          if (leaf?.content?.status === 'error') return null
          const tid = leaf?.content?.terminalId
          return tid && tid !== terminalIdBeforeRestart ? tid : null
        }, { timeout: 45_000 })
        .not.toBeNull()
        .then(async () => (await findLeafById(tabId!, pane1Id))!.content.terminalId)
      expect(restoredTerminalId1).not.toBe(terminalIdBeforeRestart)

      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(restoredTerminalId1)
        const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        return unwrapped.includes(`opencode: resumed session ${sesB}`)
      }, { timeout: 30_000 }).toBe(true)

      const argvEntries: ArgvEntry[] = await expect.poll(async () => {
        const entries = await readArgvEntries()
        return entries.some((entry) => argvValue(entry.argv, '--session') === sesB) ? entries : null
      }, { timeout: 30_000 }).not.toBeNull().then(readArgvEntries)
      const newestEntry = argvEntries[argvEntries.length - 1]
      expect(argvValue(newestEntry.argv, '--session')).toBe(sesB)
      expect(argvEntries.every((entry) => argvValue(entry.argv, '--session') !== sesA)).toBe(true)

      // ── Leg 6: never-steal refusal + liveness control.
      // Fresh capture: the pre-restart WS died with the old server process.
      const capture2 = new WsCapture(info.wsUrl, info.token)
      await capture2.ready()

      // Pane 2, freshly bound, then signal-rebound to the alnum-safe sesC so
      // the steal target is a LIVE-OWNED session with a signal-lane history.
      const pane2Leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const pane2Id: string = pane2Leaf.id
      const terminalId2: string = pane2Leaf.content.terminalId
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId2)
        return typeof buffer === 'string' && buffer.includes('opencode> ')
      }, { timeout: 15_000 }).toBe(true)
      await typeLineIntoTerminal(terminalId2, 'hello from pane two')
      const sesC0 = await scrapeSessionId(terminalId2)
      await capture2.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId2
          && frame.sessionRef?.sessionId === sesC0,
        60_000,
        `pane2 fresh association terminal=${terminalId2} session=${sesC0}`,
      )
      const sesC = `ses_e2eowned${Date.now()}`
      await seedOpencodeSessionRow(info.homeDir, sesC, info.homeDir)
      await writeOpencodeSignal(info.homeDir, terminalId2, 2, sesC)
      await capture2.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === terminalId2
          && frame.sessionRef?.sessionId === sesC,
        60_000,
        `pane2 signal rebind terminal=${terminalId2} session=${sesC}`,
      )

      // The steal attempt: a signal for PANE 1 naming pane-2-owned sesC.
      const stealPath = await writeOpencodeSignal(info.homeDir, restoredTerminalId1, 3, sesC)
      await expectNoMatchingFrame(
        capture2,
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === restoredTerminalId1
          && frame.sessionRef?.sessionId === sesC,
        3_000,
        `steal rebind terminal=${restoredTerminalId1} -> ${sesC}`,
      )
      // The refusal is act-then-delete: consumption proves the sweep SAW and
      // REFUSED the signal (not that it never ran).
      await expect.poll(async () => {
        try {
          await fs.access(stealPath)
          return 'still-present'
        } catch {
          return 'consumed'
        }
      }, { timeout: 5_000 }).toBe('consumed')

      // Both panes kept their identities across a reload.
      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane1Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesB)
      await expect.poll(async () => {
        const leaf = await findLeafById(tabId!, pane2Id)
        return leaf?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).toBe(sesC)

      // POSITIVE LIVENESS CONTROL: prove the same channel (same dir, same
      // sweep, same pane) was alive by rebinding pane 1 to an UNOWNED
      // session on it and observing success. Deliberately LAST: it moves
      // pane 1 off sesB after every sesB persistence assertion completed.
      // Double duty (LB9): this waitFor runs on the SAME capture2 socket as
      // the negative window above — a bus-lag close (4008, no close
      // detection in WsCapture) would have silenced capture2 and made the
      // negative vacuous, but then THIS positive proof times out and fails
      // the spec. The negative is only concluded after this succeeds.
      const sesD = `ses_e2eliveness${Date.now()}`
      await seedOpencodeSessionRow(info.homeDir, sesD, info.homeDir)
      await writeOpencodeSignal(info.homeDir, restoredTerminalId1, 4, sesD)
      await capture2.waitFor(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === restoredTerminalId1
          && frame.sessionRef?.sessionId === sesD,
        60_000,
        `post-refusal liveness control rebind terminal=${restoredTerminalId1} session=${sesD}`,
      )
      // Re-assert the negative over the FULL frame history: even while the
      // channel was provably consuming signals, no frame ever rebound pane 1
      // to the pane-2-owned sesC.
      const stealFrame = capture2.all.find(
        (frame) => frame.type === 'terminal.session.associated'
          && frame.terminalId === restoredTerminalId1
          && frame.sessionRef?.sessionId === sesC,
      )
      expect(stealFrame).toBeUndefined()

      capture2.close()
      await server.stop()
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
