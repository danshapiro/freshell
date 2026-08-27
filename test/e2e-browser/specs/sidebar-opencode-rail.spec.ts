import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * SIDEBAR OPENCODE RAIL -- the user-level proof for the two sidebar bugs
 * fixed in `fix/sidebar-opencode-rail-fixes`. Runs against BOTH real
 * servers (default `chromium` project = Node, `Rust browser lane` = Rust);
 * Node parity is part of the fix, so this spec is registered in the
 * Rust browser lane `testMatch` rather than `RUST_ONLY_SPECS`.
 *
 *   - Bug 2: OpenCode's catch-all "global" project stores `worktree = '/'`.
 *     Treating that placeholder as a real checkout put every global-project
 *     session under a literal '/' group instead of its own directory. The
 *     fix treats '/' as absent so the session's real cwd is used --
 *     asserted here as "the root session is visible AND badged with its
 *     real directory leaf (`timeline`)".
 *   - Bug 1: a live terminal whose resume target is an opencode SUBAGENT
 *     (child, `parent_id NOT NULL`) session grew its own rail entry that
 *     the `showSubagents` filter could not hide, because the classification
 *     never reached the client. The fix carries `resumeTargetIsSubagent`
 *     server -> `/api/terminals` -> the sidebar selector's `isSubagent`.
 *     Both client pathways are exercised: the manufactured live-terminal
 *     row (background terminal) and the tab/pane FALLBACK row (a terminal
 *     opened into a pane that carries `sessionRef`).
 *
 * This spec NEVER touches a live/self-hosted server: `createE2eServerHandle`
 * boots an isolated instance on an ephemeral port with its own HOME.
 *
 * STATUS (2026-08-07): GREEN on BOTH projects. The `chromium` (Node) leg
 * was RED at authoring on a real product gap: the Node server's
 * `buildLiveTerminalSessionItem` (`server/session-directory/service.ts`)
 * fabricated a session item for every running terminal without ever
 * setting `isSubagent`, so the default-visibility filter could not drop
 * it. Fixed by mirroring the Rust projection (`session_directory.rs`
 * `build_live_terminal_session_item`, commit 238f16bd): the registry's
 * `resumeTargetIsSubagent` now flows through `TerminalMeta` into the
 * fabricated item's `isSubagent`.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')

const ROOT_ID = 'ses_e2erailroot1'
const CHILD_ID = 'ses_e2erailchild1'
/**
 * A SECOND subagent child, for the paned variant. Two children (rather
 * than two terminals on one child) are required: a `terminal.create` whose
 * resume target already has a canonical running owner is REUSED, not
 * duplicated (`getCanonicalRunningTerminalBySession` /
 * `attachReusedTerminal`, ws-handler.ts). One live terminal per session is
 * correct product behavior, so the paned leg targets its own child.
 */
const CHILD2_ID = 'ses_e2erailchild2'
const ROOT_TITLE = 'Rail e2e global root session'
const CHILD_TITLE = 'Rail e2e subagent child session'
const CHILD2_TITLE = 'Rail e2e subagent child session two'
/**
 * The paned child-target pane's `initialCwd` leaf. `derivePaneTitle` names
 * non-shell terminals by their working-directory leaf, so this string
 * becomes the pane title and therefore the FALLBACK rail row's title --
 * giving the "no rail entry for the child-target terminal" assertion a
 * unique, greppable name to negate instead of the generic provider label
 * "OpenCode" (which the tab strip and the pane picker also render).
 *
 * Deliberately NOT created on disk: the directory picker enumerates real
 * directories under the isolated home into <option> elements, which would
 * make a page-wide text search for this leaf match unconditionally.
 */
const CHILD_PANE_DIR_LEAF = 'railsubagentpane'
/**
 * The cwd BOTH child-target terminals are spawned in. It is the leaf a rail
 * row for such a terminal is grouped/badged by, whichever pathway builds it
 * -- the server-fabricated live-terminal session item
 * (`buildLiveTerminalSessionItem` on Node / `build_live_terminal_session_item`
 * on Rust both derive `projectPath` from the terminal's cwd) or the client's
 * own manufactured row. Pinning the cwd makes "no rail row for a
 * subagent-target terminal" expressible as one deterministic, role-scoped
 * absence instead of a guess about titles.
 */
const CHILD_TERMINAL_CWD_LEAF = 'railsubagentcwd'

async function installFakeOpencodeTerminal(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fs.copyFile(FAKE_OPENCODE_TERMINAL_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
}

/**
 * Seed the ISOLATED home's opencode.db (`<homeDir>/.local/share/opencode/`,
 * where applyIsolatedHomeEnvironment pins XDG_DATA_HOME -- same pattern as
 * opencode-rebind-rust.spec.ts's seedOpencodeSessionRow) with:
 *  - the catch-all "global" project (worktree = '/'),
 *  - a ROOT session in it whose real cwd is `workDir` (Bug 2 subject),
 *  - two CHILD (parent_id = root) sessions (Bug 1 subjects: one for the
 *    background-terminal leg, one for the paned leg).
 */
async function seedOpencodeDb(homeDir: string, workDir: string): Promise<void> {
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
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run('global', '/')
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
       VALUES (?, 'global', NULL, ?, ?, ?, 'rail-e2e-seed', ?, ?, NULL)`,
    ).run(ROOT_ID, ROOT_ID, workDir, ROOT_TITLE, now, now)
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
       VALUES (?, 'global', ?, ?, ?, ?, 'rail-e2e-seed', ?, ?, NULL)`,
    ).run(CHILD_ID, ROOT_ID, CHILD_ID, workDir, CHILD_TITLE, now, now)
    db.prepare(
      `INSERT OR REPLACE INTO session
        (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived)
       VALUES (?, 'global', ?, ?, ?, ?, 'rail-e2e-seed', ?, ?, NULL)`,
    ).run(CHILD2_ID, ROOT_ID, CHILD2_ID, workDir, CHILD2_TITLE, now, now)
  } finally {
    db.close()
  }
}

test.describe('sidebar opencode rail', () => {
  test.setTimeout(240_000)

  test('global-project sessions show their real directory; subagent-target terminals stay off the rail', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-oc-rail-'))
    try {
      const fakeOpencodePath = await installFakeOpencodeTerminal(path.join(sharedRoot, 'bin'))
      let childPaneDir = ''
      let childTerminalCwd = ''
      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: { OPENCODE_CMD: fakeOpencodePath },
          setupHome: async (homeDir: string) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: { codingCli: { enabledProviders: ['opencode'] } },
            }, null, 2))
            const workDir = path.join(homeDir, 'work', 'timeline')
            await fs.mkdir(workDir, { recursive: true })
            // NOT created on disk -- see CHILD_PANE_DIR_LEAF's doc comment.
            childPaneDir = path.join(homeDir, 'work', CHILD_PANE_DIR_LEAF)
            childTerminalCwd = path.join(homeDir, 'work', CHILD_TERMINAL_CWD_LEAF)
            await fs.mkdir(childTerminalCwd, { recursive: true })
            await seedOpencodeDb(homeDir, workDir)
          },
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()

        // ── Bug 2: the root session appears, grouped/badged by its REAL
        // directory leaf ("timeline"), never literal '/'.
        //
        // The badge assertion is scoped to the sidebar ROW itself (a real
        // <button>, so a role-based locator reaches it) rather than a bare
        // `getByText('timeline')`: the directory picker renders hidden
        // <option> elements for every directory under the isolated home,
        // including .../work/timeline, which a page-wide text locator hits
        // first. The row's accessible name is title + project badge +
        // relative timestamp, so requiring "<title> timeline" in one
        // accessible name proves the badge belongs to THIS session.
        await expect(page.getByText(ROOT_TITLE)).toBeVisible({ timeout: 60_000 })
        await expect(
          page.getByRole('button', { name: new RegExp(`${ROOT_TITLE}\\s+timeline\\b`) }),
        ).toBeVisible({ timeout: 30_000 })

        // ── Bug 1 (listing side): the child sessions themselves never appear.
        expect(await page.getByText(CHILD_TITLE).count()).toBe(0)
        expect(await page.getByText(CHILD2_TITLE).count()).toBe(0)

        // ── Bug 1 (live-terminal side): create a background opencode
        // terminal targeting the CHILD session via the real WS API — the
        // shape orchestration-spawned subagent terminals take.
        await page.evaluate(({ sessionId, cwd }) => {
          (window as unknown as { __FRESHELL_TEST_HARNESS__?: { sendWsMessage: (m: unknown) => void } })
            .__FRESHELL_TEST_HARNESS__?.sendWsMessage({
              type: 'terminal.create',
              requestId: `e2e-rail-subagent-${Date.now()}`,
              mode: 'opencode',
              cwd,
              // `shell` is REQUIRED on the wire: the Node server's Zod schema
              // defaults it to 'system', but the Rust server's serde struct
              // (`freshell-protocol::client_messages::TerminalCreate`) has no
              // default, so omitting it makes the Rust server drop the frame.
              shell: 'system',
              sessionRef: { provider: 'opencode', sessionId },
            })
        }, { sessionId: CHILD_ID, cwd: childTerminalCwd })

        // Wire fact: the terminal record carries the classification.
        await expect.poll(async () => {
          const res = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': info.token },
          })
          const items = await res.json() as Array<Record<string, unknown>>
          return items.some((t) => t.mode === 'opencode' && t.resumeTargetIsSubagent === true)
        }, { timeout: 60_000 }).toBe(true)

        // User-visible fact: the rail never grows an entry for that live
        // terminal.
        //
        // The load-bearing assertion is the LAST one. Sidebar session rows
        // are <button>s whose accessible name is "<title><project
        // badge><relative time>", and the project badge for any row derived
        // from these terminals is their cwd's leaf -- pinned to
        // CHILD_TERMINAL_CWD_LEAF above. The only session that may appear is
        // the root, badged `timeline`. So a button naming this leaf can only
        // be a rail row for a subagent-target terminal, on EITHER pathway
        // (server-fabricated live session item, or client-manufactured row).
        await page.waitForTimeout(2_000) // let a terminals.changed refetch land
        expect(await page.getByText(new RegExp(CHILD_ID)).count()).toBe(0)
        expect(await page.getByText(/opencode --session/).count()).toBe(0)
        expect(await page.getByRole('button', { name: new RegExp(CHILD_TERMINAL_CWD_LEAF) }).count()).toBe(0)

        // ── Bug 1 (paned variant, V2): a child-target terminal that sits in
        // a tab/pane takes the client's FALLBACK-row pathway (sessionRef on
        // the pane content), not the manufactured-row block — assert that
        // pathway hides it too. Create a second child-target terminal, then
        // open it into a tab so the pane content carries sessionRef (the
        // session-resume open shape, tabsSlice.ts:694-717).
        const listTerminalIds = async (): Promise<string[]> => {
          const res = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': info.token },
          })
          const items = await res.json() as Array<Record<string, unknown>>
          return items.map((t) => String(t.terminalId))
        }
        const idsBefore = await listTerminalIds()
        await page.evaluate(({ sessionId, cwd }) => {
          (window as unknown as { __FRESHELL_TEST_HARNESS__?: { sendWsMessage: (m: unknown) => void } })
            .__FRESHELL_TEST_HARNESS__?.sendWsMessage({
              type: 'terminal.create',
              requestId: `e2e-rail-subagent-paned-${Date.now()}`,
              mode: 'opencode',
              cwd,
              // `shell` is REQUIRED on the wire: the Node server's Zod schema
              // defaults it to 'system', but the Rust server's serde struct
              // (`freshell-protocol::client_messages::TerminalCreate`) has no
              // default, so omitting it makes the Rust server drop the frame.
              shell: 'system',
              sessionRef: { provider: 'opencode', sessionId },
            })
        }, { sessionId: CHILD2_ID, cwd: childTerminalCwd })
        let panedTerminalId: string | undefined
        await expect.poll(async () => {
          const idsNow = await listTerminalIds()
          panedTerminalId = idsNow.find((id) => !idsBefore.includes(id))
          return panedTerminalId != null
        }, { timeout: 60_000 }).toBe(true)
        // ...and it too is classified subagent on the wire.
        await expect.poll(async () => {
          const res = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': info.token },
          })
          const items = await res.json() as Array<Record<string, unknown>>
          return items.some((t) => t.terminalId === panedTerminalId && t.resumeTargetIsSubagent === true)
        }, { timeout: 60_000 }).toBe(true)
        // Open it into a tab/pane via the harness store dispatch, mirroring
        // exactly what `openSessionTab`'s terminalId branch dispatches
        // (tabsSlice.ts:694-717): `tabs/addTab` then `panes/initLayout`,
        // with `sessionRef` on BOTH the tab and the pane content.
        await page.evaluate(({ terminalId, sessionId, initialCwd }) => {
          const harness = (window as unknown as {
            __FRESHELL_TEST_HARNESS__?: { dispatch: (a: unknown) => void }
          }).__FRESHELL_TEST_HARNESS__
          const tabId = 'e2e-rail-paned-tab'
          harness?.dispatch({
            type: 'tabs/addTab',
            payload: {
              id: tabId,
              title: 'OpenCode',
              status: 'running',
              mode: 'opencode',
              codingCliProvider: 'opencode',
              initialCwd,
              sessionRef: { provider: 'opencode', sessionId },
            },
          })
          harness?.dispatch({
            type: 'panes/initLayout',
            payload: {
              tabId,
              content: {
                kind: 'terminal',
                mode: 'opencode',
                terminalId,
                sessionRef: { provider: 'opencode', sessionId },
                initialCwd,
                status: 'running',
              },
            },
          })
        }, { terminalId: panedTerminalId!, sessionId: CHILD2_ID, initialCwd: childPaneDir })

        // POSITIVE CONTROL for the negatives below: the pane really exists,
        // carries the child sessionRef, and RENDERS under the directory-leaf
        // title. Its header is a `banner`, the rail's rows are `button`s --
        // so the string is provably present in the UI, and the button-scoped
        // absence assertion below is about the RAIL specifically, not about
        // the string being missing everywhere.
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout('e2e-rail-paned-tab')
          return layout?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 15_000 }).toBe(CHILD2_ID)
        await expect(
          page.getByRole('banner', { name: `Pane: ${CHILD_PANE_DIR_LEAF}` }),
        ).toBeVisible({ timeout: 30_000 })

        // Re-assert under default visibility: the paned child-target
        // terminal's fallback row never surfaces either.
        //
        // These are ROLE-SCOPED to `button`, unlike the background-terminal
        // leg above. Once a child-target terminal is VISIBLE in a pane, its
        // own xterm output legitimately contains the child session id (the
        // real `opencode` resume banner; the fake CLI mirrors it as
        // "opencode: resumed session <id>"), and its header legitimately
        // shows the pane title. A page-wide text search would therefore be
        // asserting the wrong thing. Sidebar session rows are <button>s,
        // the pane header is a `banner`, and the tab strip's tab renders
        // 'OpenCode' -- so a button carrying any of these names could only
        // be the rail row that must not exist.
        await page.waitForTimeout(2_000) // let the rail settle
        expect(await page.getByRole('button', { name: new RegExp(CHILD_ID) }).count()).toBe(0)
        expect(await page.getByRole('button', { name: new RegExp(CHILD2_ID) }).count()).toBe(0)
        expect(await page.getByRole('button', { name: /opencode --session/ }).count()).toBe(0)
        expect(await page.getByRole('button', { name: new RegExp(CHILD_PANE_DIR_LEAF) }).count()).toBe(0)
        expect(await page.getByRole('button', { name: new RegExp(CHILD_TERMINAL_CWD_LEAF) }).count()).toBe(0)
      } finally {
        await server.stop()
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
