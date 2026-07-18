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
// SESSION-01 review follow-up -- the 4th provider family named in the
// acceptance text (Amplifier). Seeded newest of the five so ordering
// assertions below have an unambiguous newest anchor.
const AMPLIFIER_SESSION_ID = 'amp-matrix-epsilon-0001'
const AMPLIFIER_CREATED_AT = '2026-07-19T08:00:00.000Z'
const AMPLIFIER_LAST_ACTIVITY_AT_ISO = '2026-07-19T08:00:02.000Z'

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

          // SESSION-01 review follow-up -- seed an Amplifier session, the
          // 4th provider family named in the acceptance text. Shape mirrors
          // `crates/freshell-sessions/src/amplifier.rs`'s own unit-test
          // fixtures (`sample_metadata`, `write_session`,
          // `amplifier_source_parses_fixture_session_with_first_user_message`):
          // a `metadata.json` document with `session_id`/`working_dir`/
          // `created`/`description_updated_at`/`name`/`description` fields,
          // at `<amplifier_home>/projects/<slug>/sessions/<id>/metadata.json`,
          // plus a sibling `transcript.jsonl` whose first `"role":"user"`
          // line supplies the first-user-message preview
          // (`read_first_user_message_from_transcript`,
          // `providers/amplifier.ts:106-140`). `amplifier_home()` defaults to
          // `<home>/.amplifier` (no env override needed -- same convention as
          // the Codex/OpenCode seeds above; the isolated `homeDir` IS the
          // real home for the spawned server).
          //
          // KNOWN DIVERGENCE (codex-first triage note): this checked-out
          // branch's `server/` tree (legacy Node implementation, FROZEN for
          // this task) predates upstream `origin/main` commit `05c6b1fa`
          // ("feat(amplifier): durable session tracking via events.jsonl"),
          // where `server/coding-cli/providers/amplifier.ts` was introduced
          // -- verified via `git log --oneline HEAD..origin/main --
          // server/coding-cli/providers/amplifier.ts` (6 commits touch that
          // path; the unfiltered `git log --oneline HEAD..origin/main`,
          // with no path filter, is 49 -- that broader count is NOT specific
          // to this file and should not be quoted as if it were) and by
          // grepping for zero "amplifier" occurrences under `server/` or
          // `shared/` in this checkout (`dist/server/index.js` is a
          // gitignored build artifact, absent in a fresh checkout/worktree
          // until a build is run, so it is NOT part of this verification --
          // only present here because this worktree happens to have been
          // built already). So legacy has NO Amplifier provider registered
          // at all in this branch -- not a home-layout mismatch to align, an
          // absent feature. The seed below is still written unconditionally
          // (same as every other provider seed in this hook) so a future
          // merge of that upstream commit into this branch picks it up for
          // free; the per-assertion `e2eServerKind === 'rust'` guards below
          // are where the divergence is actually handled.
          const amplifierSessionDir = path.join(
            homeDir, '.amplifier', 'projects', 'matrix-epsilon-project', 'sessions', AMPLIFIER_SESSION_ID,
          )
          await fs.mkdir(amplifierSessionDir, { recursive: true })
          await fs.mkdir('/tmp/freshell-matrix/epsilon-project', { recursive: true })
          await fs.writeFile(
            path.join(amplifierSessionDir, 'metadata.json'),
            JSON.stringify({
              session_id: AMPLIFIER_SESSION_ID,
              working_dir: '/tmp/freshell-matrix/epsilon-project',
              created: AMPLIFIER_CREATED_AT,
              description_updated_at: AMPLIFIER_LAST_ACTIVITY_AT_ISO,
              name: 'harness-02 matrix epsilon',
              description: 'harness-02 matrix epsilon summary',
            }),
          )
          await fs.writeFile(
            path.join(amplifierSessionDir, 'transcript.jsonl'),
            [
              JSON.stringify({ role: 'user', content: 'harness-02 matrix epsilon request 1' }),
              JSON.stringify({ role: 'assistant', content: 'harness-02 matrix epsilon reply 1' }),
            ].join('\n') + '\n',
          )
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
  // Extends the Claude-only assertion above to the seeded Codex + OpenCode +
  // Amplifier sessions, proving the sidebar surfaces all four provider
  // families in one page against the SAME server (either project kind).
  test('seeded Codex, OpenCode, and Amplifier sessions appear in the sidebar alongside Claude', async ({ freshellPage, page, e2eServerKind }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('No sessions yet')).not.toBeVisible()

    // Four titled sessions from the three PRE-EXISTING provider families are
    // discoverable in the SAME sidebar listing -- ordering is asserted
    // separately in the API-parity test below; this test covers
    // presence/identity only.
    await expect(page.getByText(/harness-02 matrix alpha/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix beta/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix gamma/i)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/harness-02 matrix delta/i)).toBeVisible({ timeout: 15_000 })

    // SESSION-01's 4th provider family: Amplifier -- this is the first e2e
    // proof of the Rust-side Amplifier indexing feature
    // (`crates/freshell-sessions/src/amplifier.rs`, wired as the fourth
    // session source in `crates/freshell-server/src/main.rs`).
    //
    // KNOWN DIVERGENCE (codex-first triage note): scoped to `rust-chromium`
    // only. This checked-out branch's `server/` tree (legacy Node
    // implementation, FROZEN for this task) predates upstream
    // `origin/main` commit `05c6b1fa` ("feat(amplifier): durable session
    // tracking via events.jsonl"), which is where
    // `server/coding-cli/providers/amplifier.ts` was introduced --
    // verified via `git log --oneline HEAD..origin/main --
    // server/coding-cli/providers/amplifier.ts` (6 commits touch that path,
    // at time of writing; the unfiltered `git log --oneline
    // HEAD..origin/main`, with no path filter, is 49 -- that broader count
    // is NOT specific to this file) and by grepping for zero "amplifier"
    // occurrences under `server/` or `shared/` in this checkout
    // (`dist/server/index.js`, which the `legacy-chromium` project's
    // `TestServer` runs, is a gitignored build artifact -- absent in a
    // fresh checkout/worktree until a build is run, so it's confirmatory
    // only for an already-built checkout, not a standalone proof). So on
    // `legacy-chromium` the legacy indexer has NO Amplifier provider
    // registered at all and will never surface this seed -- that is not a
    // home-layout mismatch to align (legacy and Rust already agree
    // `~/.amplifier` is the right home; see `amplifier_home()` in
    // `amplifier.rs` vs `defaultAmplifierHome()` referenced in its doc
    // comment), it is an absent feature on this branch, outside this task's
    // frozen `server/` ownership. A follow-up merge of that upstream commit
    // into this branch (or a Codex-driven port pass) would close the gap;
    // flagging it here rather than silently asserting only what happens to
    // pass.
    if (e2eServerKind === 'rust') {
      await expect(page.getByText(/harness-02 matrix epsilon/i)).toBeVisible({ timeout: 15_000 })
    }
  })

  // SESSION-01 -- API-level field-parity + ordering proof. Cheaper and more
  // precise than scraping the DOM: queries the SAME `GET /api/session-directory`
  // read model the sidebar itself calls (`querySessionDirectory` in
  // `server/session-directory/service.ts`; same route path on the Rust side
  // at `crates/freshell-server/src/session_directory.rs:315`) and asserts
  // identity (provider+sessionId), cwd/project, and lastActivityAt for each
  // seeded session, plus that the matrix sessions come back ordered by
  // lastActivityAt DESC -- the acceptance text's "ordering" clause.
  //
  // Scope note (honesty per SESSION-01's Playwright validation, which also
  // names "resumable identities"): this test proves the READ MODEL's field
  // parity and sort order only. It does NOT exercise resuming a session
  // through the UI (clicking a sidebar entry, reattaching a terminal,
  // confirming the PTY/thread reconnects, etc.) -- that remains UNPROVEN by
  // this spec and is left to a dedicated resume-flow spec. Conflating field
  // parity with a working resume flow here would overreach past what's
  // actually asserted below.
  test('session-directory API reports identity, cwd, and lastActivityAt for every seeded session, ordered by recency', async ({ freshellPage, page, serverInfo, e2eServerKind }) => {
    // Sanity: wait for the sidebar to be populated (indexer's initial scan
    // complete) before querying the API directly.
    await expect(page.getByTestId('sidebar-session-list')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/harness-02 matrix gamma/i)).toBeVisible({ timeout: 15_000 })

    const response = await page.request.get(
      `${serverInfo.baseUrl}/api/session-directory?priority=visible&limit=50`,
      { headers: { 'x-auth-token': serverInfo.token } },
    )
    expect(response.ok()).toBe(true)
    const payload = await response.json() as {
      items: Array<{
        sessionId: string
        provider: string
        projectPath: string
        cwd?: string
        title?: string
        lastActivityAt: number
      }>
    }

    // Preserve the API's OWN response order -- this is what's actually
    // being tested for the "ordering" assertions below, not a client-side
    // re-sort (which would prove nothing about the server).
    const matrixItems = payload.items.filter((item) => (item.title ?? '').startsWith('harness-02 matrix'))

    function findItem(provider: string, sessionId: string) {
      const item = matrixItems.find((i) => i.provider === provider && i.sessionId === sessionId)
      expect(item, `expected a session-directory item for ${provider}:${sessionId}`).toBeTruthy()
      return item!
    }

    // Identity + cwd/project parity for the three pre-existing providers.
    // `lastActivityAt` is only loosely checked here (finite/present) --
    // each provider's exact recency-derivation formula is outside this
    // task's frozen-file scope; the ordering assertions below cover
    // recency pragmatically instead of re-deriving each provider's formula.
    const alpha = findItem('claude', SESSION_ALPHA_ID)
    expect(alpha.projectPath).toBe('/tmp/freshell-matrix/alpha-project')
    expect(alpha.cwd).toBe('/tmp/freshell-matrix/alpha-project')
    expect(Number.isFinite(alpha.lastActivityAt)).toBe(true)

    const beta = findItem('claude', SESSION_BETA_ID)
    expect(beta.projectPath).toBe('/tmp/freshell-matrix/beta-project')

    const gamma = findItem('codex', CODEX_SESSION_ID)
    expect(gamma.projectPath).toBe('/tmp/freshell-matrix/gamma-project')
    expect(Number.isFinite(gamma.lastActivityAt)).toBe(true)

    // OpenCode's `time_updated` is a plain epoch-ms integer written
    // directly into the seed DB (no timestamp-string parsing involved) --
    // safe to assert exactly.
    const delta = findItem('opencode', OPENCODE_SESSION_ID)
    expect(delta.projectPath).toBe('/tmp/freshell-matrix/delta-project')
    expect(delta.lastActivityAt).toBe(1774000000001)

    // Ordering (both kinds): `lastActivityAt` DESC among sessions with
    // unambiguous (non-tied) timestamps -- gamma (2026-07-18) is newer than
    // delta (~Mar 2026 epoch ms). Alpha and beta share IDENTICAL seeded
    // timestamps (`buildSessionJsonl` uses the same fixed relative-time
    // scheme for both), so their mutual order is a legitimate tie and is
    // deliberately NOT asserted -- only their position relative to the
    // unambiguous pair (after gamma, before delta) is.
    const orderedIds = matrixItems.map((item) => `${item.provider}:${item.sessionId}`)
    const gammaIdx = orderedIds.indexOf(`codex:${CODEX_SESSION_ID}`)
    const alphaIdx = orderedIds.indexOf(`claude:${SESSION_ALPHA_ID}`)
    const betaIdx = orderedIds.indexOf(`claude:${SESSION_BETA_ID}`)
    const deltaIdx = orderedIds.indexOf(`opencode:${OPENCODE_SESSION_ID}`)
    expect(gammaIdx).toBeGreaterThanOrEqual(0)
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
    expect(betaIdx).toBeGreaterThanOrEqual(0)
    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(gammaIdx).toBeLessThan(alphaIdx)
    expect(gammaIdx).toBeLessThan(betaIdx)
    expect(alphaIdx).toBeLessThan(deltaIdx)
    expect(betaIdx).toBeLessThan(deltaIdx)

    // Amplifier (rust-chromium only -- see the KNOWN DIVERGENCE note in the
    // previous test): exact identity/cwd/lastActivityAt match, computed
    // directly from the metadata.json fixture seeded above -- this is this
    // task's field-parity proof for the 4th provider family. Seeded newest
    // of the five, so it must sort before gamma.
    if (e2eServerKind === 'rust') {
      const epsilon = findItem('amplifier', AMPLIFIER_SESSION_ID)
      expect(epsilon.projectPath).toBe('/tmp/freshell-matrix/epsilon-project')
      expect(epsilon.cwd).toBe('/tmp/freshell-matrix/epsilon-project')
      expect(epsilon.lastActivityAt).toBe(Date.parse(AMPLIFIER_LAST_ACTIVITY_AT_ISO))

      const epsilonIdx = orderedIds.indexOf(`amplifier:${AMPLIFIER_SESSION_ID}`)
      expect(epsilonIdx).toBeGreaterThanOrEqual(0)
      expect(epsilonIdx).toBeLessThan(gammaIdx)
    }
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

  // SESSION-07 -- "Implement full-text and user-message search with
  // complete pagination and stale-query cancellation." This is a SLICE of
  // that acceptance text, not the full PW-RUST validation (which seeds
  // 100+ sessions with distinct late user/full-text matches across all
  // four providers and races a slow query against a fast one -- deferred to
  // a dedicated future spec): it proves the REAL sidebar search box
  // (`src/components/Sidebar.tsx`'s `<input placeholder="Search...">`,
  // `filter`/`setFilter` state) actually filters the rendered session list
  // to matching titles only, across TWO different provider kinds (claude's
  // "harness-02 matrix beta" and codex's "harness-02 matrix gamma"), and
  // that clearing the search (`aria-label="Clear search"`) restores the
  // full list -- on BOTH projects, with `legacy-chromium` as the control
  // proving the assertions themselves are sound (legacy already has full
  // title-tier search; this proves the Rust port's pre-existing title-tier
  // search reaches the same real UI element identically, not just a raw
  // API check).
  test('typing into the sidebar search box filters the session list to matching titles only', async ({ freshellPage, page }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/harness-02 matrix alpha/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix beta/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix gamma/i)).toBeVisible({ timeout: 15_000 })

    const searchBox = page.getByPlaceholder('Search...')

    // First provider kind: a claude-only match hides every other seeded
    // session, including the other claude session (alpha) and codex (gamma).
    await searchBox.fill('matrix beta')
    await expect(page.getByText(/harness-02 matrix beta/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix alpha/i)).not.toBeVisible()
    await expect(page.getByText(/harness-02 matrix gamma/i)).not.toBeVisible()

    // Second provider kind: a codex-only match behaves identically --
    // search is not accidentally scoped to a single provider.
    await searchBox.fill('matrix gamma')
    await expect(page.getByText(/harness-02 matrix gamma/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix beta/i)).not.toBeVisible()
    await expect(page.getByText(/harness-02 matrix alpha/i)).not.toBeVisible()

    // Clearing the search (the real "Clear search" button) restores the
    // full, unfiltered list -- proves the filter is live/reversible, not a
    // one-way narrowing.
    await page.getByLabel('Clear search').click()
    await expect(page.getByText(/harness-02 matrix alpha/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix beta/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/harness-02 matrix gamma/i)).toBeVisible({ timeout: 10_000 })
  })
})
