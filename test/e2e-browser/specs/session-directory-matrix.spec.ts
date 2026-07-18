import fs from 'fs/promises'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

/**
 * HARNESS-02 Finding 1 -- the "session" matrix scenario category.
 *
 * Seeds the isolated HOME with real Claude Code session JSONL files (before
 * the server boots, via `construct.setupHome`) and asserts the sidebar's
 * session list discovers and renders them. Routed through the same
 * `E2eServerHandle`/`e2eServerKind` seam as `settings-persistence-split.spec.ts`
 * (HARNESS-02) so this SAME spec exercises both the legacy Node server and
 * the owned Rust server depending on the active project.
 *
 * Session-file shape is a trimmed version of
 * `perf/seed-server-home.ts`'s `buildSessionJsonl`: a `system`/`init` line,
 * `N` user/assistant turn pairs, and a trailing `summary` line. Two turns per
 * session (rather than one) so each session is unambiguously a real,
 * multi-turn conversation and not a truncated/degenerate one-liner.
 */

const SESSION_ALPHA_ID = '00000000-0000-4000-8000-0000000a1111'
const SESSION_BETA_ID = '00000000-0000-4000-8000-0000000b2222'
// SESSION-01 extension -- codex + opencode seeds, sharing the same
// `matrix-*` naming convention as the Claude alpha/beta seeds above so a
// single sidebar assertion can look for all three providers.
const CODEX_SESSION_ID = 'codex-matrix-gamma-0001'
const OPENCODE_SESSION_ID = 'oc-matrix-delta-0001'

function buildSessionJsonl(input: {
  sessionId: string
  cwd: string
  title: string
}): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: input.sessionId,
      uuid: `${input.sessionId}-system`,
      timestamp: '2026-07-16T08:00:00.000Z',
      cwd: input.cwd,
      git: { branch: 'main', dirty: false },
    }),
  ]

  let previousUuid = `${input.sessionId}-system`
  const turnCount = 2
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    const userUuid = `${input.sessionId}-user-${turnIndex + 1}`
    const assistantUuid = `${input.sessionId}-assistant-${turnIndex + 1}`

    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: `${input.title} request ${turnIndex + 1}` },
      uuid: userUuid,
      timestamp: `2026-07-16T08:0${turnIndex}:01.000Z`,
    }))

    lines.push(JSON.stringify({
      parentUuid: userUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `${input.title} reply ${turnIndex + 1}` }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: assistantUuid,
      timestamp: `2026-07-16T08:0${turnIndex}:02.000Z`,
    }))

    previousUuid = assistantUuid
  }

  lines.push(JSON.stringify({
    type: 'summary',
    summary: `${input.title} summary`,
    leafUuid: previousUuid,
  }))

  return `${lines.join('\n')}\n`
}

// Routed through the generalized E2eServerHandle seam (HARNESS-02) so this
// SAME spec exercises the legacy Node server or the owned Rust server
// depending on the active project's `e2eServerKind` option.
const test = base.extend({
  testServer: [async ({ e2eServerKind }, use) => {
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        setupHome: async (homeDir) => {
          const projectsDir = path.join(homeDir, '.claude', 'projects')

          const alphaDir = path.join(projectsDir, 'matrix-alpha-project')
          await fs.mkdir(alphaDir, { recursive: true })
          await fs.writeFile(
            path.join(alphaDir, `${SESSION_ALPHA_ID}.jsonl`),
            buildSessionJsonl({
              sessionId: SESSION_ALPHA_ID,
              cwd: '/tmp/freshell-matrix/alpha-project',
              title: 'harness-02 matrix alpha',
            }),
          )

          const betaDir = path.join(projectsDir, 'matrix-beta-project')
          await fs.mkdir(betaDir, { recursive: true })
          await fs.writeFile(
            path.join(betaDir, `${SESSION_BETA_ID}.jsonl`),
            buildSessionJsonl({
              sessionId: SESSION_BETA_ID,
              cwd: '/tmp/freshell-matrix/beta-project',
              title: 'harness-02 matrix beta',
            }),
          )

          // SESSION-01 extension -- seed a Codex session alongside Claude.
          // Shape mirrors `crates/freshell-server/src/session_directory.rs`'s
          // own `session_override_applies_to_codex_and_opencode_keys` /
          // `codex_exec_session_hidden_by_default_surfaced_with_flag` unit
          // tests: a `session_meta` record carrying `payload.id`/`cwd`, plus a
          // `response_item`/`message` record so a real title is extracted
          // (matching `extract_title_from_message` -- a bare `session_meta`
          // alone renders with no distinguishing text). `CODEX_HOME` defaults
          // to `<home>/.codex` (`session_directory::codex_home`) so no env
          // override is needed here -- the isolated `homeDir` this hook
          // receives IS that real home.
          const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
          await fs.mkdir(codexSessionsDir, { recursive: true })
          await fs.mkdir('/tmp/freshell-matrix/gamma-project', { recursive: true })
          const codexLines = [
            JSON.stringify({
              timestamp: '2026-07-18T08:00:00.000Z',
              type: 'session_meta',
              payload: { id: CODEX_SESSION_ID, cwd: '/tmp/freshell-matrix/gamma-project' },
            }),
            JSON.stringify({
              timestamp: '2026-07-18T08:00:01.000Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'harness-02 matrix gamma request 1' }],
              },
            }),
            JSON.stringify({
              timestamp: '2026-07-18T08:00:02.000Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'harness-02 matrix gamma reply 1' }],
              },
            }),
          ]
          await fs.writeFile(
            path.join(codexSessionsDir, `${CODEX_SESSION_ID}.jsonl`),
            `${codexLines.join('\n')}\n`,
          )

          // SESSION-01 extension -- seed an OpenCode session (direct-listed
          // from `opencode.db`, per `session_directory.rs`'s module doc and
          // `OpencodeSource`/`freshell_sessions::parse::default_opencode_data_home`).
          // Schema matches that same crate's
          // `session_override_applies_to_codex_and_opencode_keys` test and
          // the `fake-opencode.cjs` fixture's own `ensureSchema` -- both are
          // read by the SAME `OpencodeSource`, so this seed is exercised by
          // the real production reader, not a test-only shape.
          // `default_opencode_data_home()` resolves `$XDG_DATA_HOME/opencode`
          // (else `<realHome>/.local/share/opencode`). Both owned fixtures'
          // `applyIsolatedHomeEnvironment` (`helpers/test-server.ts`) already
          // sets `XDG_DATA_HOME` to `<homeDir>/.local/share` for every spawned
          // server, so writing the DB there keeps it inside the isolated
          // sandbox with no extra env override needed.
          const opencodeDataDir = path.join(homeDir, '.local', 'share', 'opencode')
          await fs.mkdir(opencodeDataDir, { recursive: true })
          const Database = (await import('node:sqlite')).DatabaseSync
          const db = new Database(path.join(opencodeDataDir, 'opencode.db'))
          try {
            db.exec(`
              CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
              CREATE TABLE IF NOT EXISTS session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
              );
            `)
            db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)')
              .run('proj-matrix-delta', '/tmp/freshell-matrix/delta-project')
            db.prepare(`
              INSERT OR REPLACE INTO session
                (id, directory, title, time_created, time_updated, time_archived, project_id, parent_id)
              VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
            `).run(
              OPENCODE_SESSION_ID,
              '/tmp/freshell-matrix/delta-project',
              'harness-02 matrix delta',
              1774000000000,
              1774000000001,
              'proj-matrix-delta',
            )
          } finally {
            db.close()
          }
        },
      },
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],
})

test.describe('Session Directory Matrix', () => {
  test('seeded Claude sessions appear in the sidebar session list', async ({ freshellPage, page }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })

    // The empty-state message must NOT be showing -- the seeded sessions
    // should have been discovered.
    await expect(page.getByText('No sessions yet')).not.toBeVisible()

    await expect(page.getByText(/harness-02 matrix alpha/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix beta/i)).toBeVisible({ timeout: 10_000 })
  })

  // SESSION-01 -- "Index Claude, Codex, OpenCode, and Amplifier histories."
  // Extends the Claude-only assertion above to the seeded Codex + OpenCode
  // sessions, proving the sidebar surfaces all three provider families in
  // one page against the SAME server (either project kind).
  test('seeded Codex and OpenCode sessions appear in the sidebar alongside Claude', async ({ freshellPage, page }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('No sessions yet')).not.toBeVisible()

    // All four titled sessions from all three providers are discoverable in
    // the SAME sidebar listing -- ordering isn't asserted here (SESSION-01's
    // "ordering" clause is int entionally left to a follow-up spec once
    // HARNESS-04's fuller corpus lands), but presence/identity is.
    await expect(page.getByText(/harness-02 matrix alpha/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix beta/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix gamma/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/harness-02 matrix delta/i)).toBeVisible({ timeout: 15_000 })
  })

  // SESSION-09 -- live sidebar updates. A session written to the isolated
  // HOME's provider directory AFTER boot (not via `setupHome`, which only
  // seeds BEFORE the server starts) must appear in the sidebar without a
  // page reload. Legacy's `SessionsSyncService` (a real filesystem watcher,
  // `server/sessions-sync/service.ts`) already does this -- this spec's
  // `legacy-chromium` run is the CONTROL proving the assertion itself is
  // sound. The Rust port has no filesystem watcher (see
  // `crates/freshell-server/src/main.rs`'s `spawn_sessions_sweep` doc
  // comment); it substitutes a periodic sweep that broadcasts
  // `sessions.changed`, which `src/App.tsx:924-932` folds into a
  // active-session-window refetch.
  test('a session written mid-test appears in the sidebar without a reload', async ({ freshellPage, page, serverInfo }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })

    // Sanity: the boot-seeded sessions are already there (same assertion as
    // the first test above) -- confirms the sidebar is live and this test
    // isn't accidentally passing on an empty/broken page.
    await expect(page.getByText(/harness-02 matrix alpha/i)).toBeVisible({ timeout: 10_000 })

    const LIVE_SESSION_ID = '00000000-0000-4000-8000-0000000c3333'
    const liveTitle = 'harness-02 matrix live-update'

    // Not present yet -- this session is written AFTER the page has already
    // loaded and rendered its initial sidebar snapshot.
    await expect(page.getByText(new RegExp(liveTitle, 'i'))).not.toBeVisible()

    // Write a NEW session into the isolated HOME's live provider directory,
    // reusing the SAME `buildSessionJsonl` seeding helper the `setupHome`
    // hook above uses (just invoked live, mid-test, instead of pre-boot).
    const projectsDir = path.join(serverInfo.homeDir, '.claude', 'projects')
    const liveDir = path.join(projectsDir, 'matrix-live-update-project')
    await fs.mkdir(liveDir, { recursive: true })
    await fs.writeFile(
      path.join(liveDir, `${LIVE_SESSION_ID}.jsonl`),
      buildSessionJsonl({
        sessionId: LIVE_SESSION_ID,
        cwd: '/tmp/freshell-matrix/live-update-project',
        title: liveTitle,
      }),
    )

    // The sidebar must discover it WITHOUT a page reload, within ~10s --
    // Playwright's `expect(...).toBeVisible` polls internally, so this
    // proves the live-update path (not just an eventual-after-reload one).
    await expect(page.getByText(new RegExp(liveTitle, 'i'))).toBeVisible({ timeout: 10_000 })
  })
})
