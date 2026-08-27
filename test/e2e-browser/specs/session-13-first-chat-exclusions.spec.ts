import fs from 'fs/promises'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

/**
 * SESSION-13 — "Restore the two server-wide first-chat exclusion controls.
 * Preserve `excludeFirstChatSubstrings` and `excludeFirstChatMustStart` in
 * `config.json`, replicate them to every client, and apply them to complete
 * multi-provider data."
 *
 * Checklist validation text mirrored by this spec:
 *   "Seed start/middle/no-match sessions across providers, edit both
 *   controls in A, assert exact membership in A and B, reload/restart, and
 *   verify the shared values and results persist."
 *
 * Routed through the generalized `E2eServerHandle`/`rustFixture` seam
 * (HARNESS-02) so this SAME spec exercises the legacy Node server or the
 * owned Rust server depending on the active project. Fixture shapes are
 * copied from `session-directory-matrix.spec.ts` (themselves pinned against
 * both servers' real parsers): a Claude `system/init` + user/assistant turn
 * pair + `summary` JSONL, a Codex `session_meta` + `response_item` pair, an
 * Amplifier `metadata.json` + `transcript.jsonl` pair, and an OpenCode
 * `opencode.db` row.
 *
 * The OpenCode seed is the deliberate "data-absent" control: neither
 * server's opencode lister populates `firstUserMessage`, so these controls
 * must never hide it, whatever the filter configuration.
 *
 * Editing is done through the REAL Settings UI controls in context A
 * (Workspace section): the exclusion textarea (aria-label "Sidebar first
 * chat exclusion substrings", debounced 500ms via
 * `scheduleServerTextSettingSave`, `SettingsView.tsx:30`) and the mustStart
 * toggle (aria-label "Require first chat exclusion substring at start",
 * immediate `applyServerSetting`).
 */

const MARKER = '__S13EXCL__'

// ── seeded session identities ────────────────────────────────────────────
// start:  first user message STARTS with the marker
// middle: first user message contains the marker only mid-string
// plain:  no marker anywhere (per-provider control)
// opencode: no firstUserMessage data at all (cross-provider control)
const CLAUDE_START_ID = '00000000-0000-4000-8000-0000000c5111'
const CLAUDE_MIDDLE_ID = '00000000-0000-4000-8000-0000000c5222'
const CLAUDE_PLAIN_ID = '00000000-0000-4000-8000-0000000c5333'
const CODEX_START_ID = 'codex-s13-start-0001'
const CODEX_MIDDLE_ID = 'codex-s13-middle-0002'
const CODEX_PLAIN_ID = 'codex-s13-plain-0003'
const AMP_START_ID = 'amp-s13-start-0001'
const AMP_MIDDLE_ID = 'amp-s13-middle-0002'
const AMP_PLAIN_ID = 'amp-s13-plain-0003'
const OPENCODE_CONTROL_ID = 'oc-s13-control-0001'

// Two turns per Claude session (not one, copied from
// session-directory-matrix.spec.ts): legacy `claude.ts:478` classifies a
// session with <= 1 user message as NON-interactive, and the sidebar's
// default `showNoninteractiveSessions: false` would hide it regardless of
// any exclusion knobs — the first user message stays line 1 of the
// conversation either way, so the exclusion fixture is unaffected.
function claudeJsonl(input: { sessionId: string; cwd: string; firstUser: string; title: string }): string {
  const lines = [
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
  for (let turn = 1; turn <= 2; turn += 1) {
    const userUuid = `${input.sessionId}-user-${turn}`
    const assistantUuid = `${input.sessionId}-assistant-${turn}`
    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: turn === 1 ? input.firstUser : `${input.title} follow-up ${turn}` },
      uuid: userUuid,
      timestamp: `2026-07-16T08:0${turn}:01.000Z`,
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
        content: [{ type: 'text', text: `${input.title} reply ${turn}` }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: assistantUuid,
      timestamp: `2026-07-16T08:0${turn}:02.000Z`,
    }))
    previousUuid = assistantUuid
  }
  lines.push(JSON.stringify({
    type: 'summary',
    summary: input.title,
    leafUuid: previousUuid,
  }))
  return `${lines.join('\n')}\n`
}

function codexJsonl(input: { sessionId: string; cwd: string; firstUser: string }): string {
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-18T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: input.sessionId, cwd: input.cwd },
    }),
    JSON.stringify({
      timestamp: '2026-07-18T08:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input.firstUser }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-18T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `${input.sessionId} reply` }],
      },
    }),
  ]
  return `${lines.join('\n')}\n`
}

async function seedAmplifierSession(
  homeDir: string,
  input: { sessionId: string; slug: string; cwd: string; name: string; firstUser: string },
): Promise<void> {
  const sessionDir = path.join(
    homeDir, '.amplifier', 'projects', input.slug, 'sessions', input.sessionId,
  )
  await fs.mkdir(sessionDir, { recursive: true })
  await fs.writeFile(
    path.join(sessionDir, 'metadata.json'),
    JSON.stringify({
      session_id: input.sessionId,
      working_dir: input.cwd,
      created: '2026-07-19T08:00:00.000Z',
      description_updated_at: '2026-07-19T08:00:02.000Z',
      name: input.name,
      description: `${input.name} summary`,
    }),
  )
  await fs.writeFile(
    path.join(sessionDir, 'transcript.jsonl'),
    [
      JSON.stringify({ role: 'user', content: input.firstUser }),
      JSON.stringify({ role: 'assistant', content: `${input.name} reply` }),
    ].join('\n') + '\n',
  )
  // FIXTURE REALISM (copied from session-directory-matrix.spec.ts): the
  // amplifier recency formula folds sidecar mtimes into lastActivityAt; pin
  // them to the seeded metadata timestamp so the fixture matches what it
  // claims.
  const seeded = new Date('2026-07-19T08:00:02.000Z')
  await fs.utimes(path.join(sessionDir, 'metadata.json'), seeded, seeded)
  await fs.utimes(path.join(sessionDir, 'transcript.jsonl'), seeded, seeded)
}

const test = base.extend({
  testServer: [async ({}, use) => {
    const server = await createE2eServerHandle(process.env, {
      construct: {
        setupHome: async (homeDir) => {
          // Standard settings boilerplate (network configured + one provider
          // cwd), mirroring settings-persistence-split.spec.ts.
          //
          // IDEMPOTENT on purpose: `RustServer.restart()` re-runs `boot()`,
          // which re-invokes `setupHome` (`rust-server.ts:466`; its own
          // comment claims "the isolated HOME is never touched" — an
          // the former Node fixture restart path, which skipped
          // setupHome entirely). A blind rewrite here would CLOBBER the
          // PATCHed `config.json` the restart leg exists to verify. The
          // transcript seeds below are byte-identical rewrites and safe to
          // repeat; the config write is the stateful one, so it is guarded
          // on absence. (Flagged as a harness finding in the item evidence.)
          const freshellDir = path.join(homeDir, '.freshell')
          const configPath = path.join(freshellDir, 'config.json')
          await fs.mkdir(freshellDir, { recursive: true })
          if (!(await fs.stat(configPath).catch(() => null))) {
            await fs.writeFile(configPath, JSON.stringify({
              version: 1,
              settings: {
                network: { configured: true, host: '127.0.0.1' },
                codingCli: { providers: { claude: { cwd: homeDir } } },
              },
            }, null, 2))
          }

          // ── Claude seeds ──
          const claudeSeeds = [
            { id: CLAUDE_START_ID, dir: 's13-claude-start', first: `${MARKER} claude alpha request`, title: 's13 claude alpha start' },
            { id: CLAUDE_MIDDLE_ID, dir: 's13-claude-middle', first: `please run ${MARKER} claude beta request`, title: 's13 claude beta middle' },
            { id: CLAUDE_PLAIN_ID, dir: 's13-claude-plain', first: 'a plain claude gamma request', title: 's13 claude gamma plain' },
          ]
          for (const seed of claudeSeeds) {
            const projectDir = path.join(homeDir, '.claude', 'projects', seed.dir)
            await fs.mkdir(projectDir, { recursive: true })
            await fs.writeFile(
              path.join(projectDir, `${seed.id}.jsonl`),
              claudeJsonl({ sessionId: seed.id, cwd: `/tmp/freshell-s13/${seed.dir}`, firstUser: seed.first, title: seed.title }),
            )
          }

          // ── Codex seeds ──
          const codexDir = path.join(homeDir, '.codex', 'sessions')
          await fs.mkdir(codexDir, { recursive: true })
          const codexSeeds = [
            { id: CODEX_START_ID, dir: 's13-codex-start', first: `${MARKER} codex delta start request` },
            { id: CODEX_MIDDLE_ID, dir: 's13-codex-middle', first: `please run ${MARKER} codex epsilon middle request` },
            { id: CODEX_PLAIN_ID, dir: 's13-codex-plain', first: 'a plain codex zeta request' },
          ]
          for (const seed of codexSeeds) {
            await fs.mkdir(`/tmp/freshell-s13/${seed.dir}`, { recursive: true })
            await fs.writeFile(
              path.join(codexDir, `${seed.id}.jsonl`),
              codexJsonl({ sessionId: seed.id, cwd: `/tmp/freshell-s13/${seed.dir}`, firstUser: seed.first }),
            )
          }

          // ── Amplifier seeds ──
          const ampSeeds = [
            { id: AMP_START_ID, slug: 's13-amp-start', name: 's13 amp eta start', first: `${MARKER} amplifier eta start request` },
            { id: AMP_MIDDLE_ID, slug: 's13-amp-middle', name: 's13 amp theta middle', first: `please run ${MARKER} amplifier theta middle request` },
            { id: AMP_PLAIN_ID, slug: 's13-amp-plain', name: 's13 amp iota plain', first: 'a plain amplifier iota request' },
          ]
          for (const seed of ampSeeds) {
            await fs.mkdir(`/tmp/freshell-s13/${seed.slug}`, { recursive: true })
            await seedAmplifierSession(homeDir, {
              sessionId: seed.id,
              slug: seed.slug,
              cwd: `/tmp/freshell-s13/${seed.slug}`,
              name: seed.name,
              firstUser: seed.first,
            })
          }

          // ── OpenCode control (no firstUserMessage data on either server) ──
          const opencodeDataDir = path.join(homeDir, '.local', 'share', 'opencode')
          await fs.mkdir(opencodeDataDir, { recursive: true })
          await fs.mkdir('/tmp/freshell-s13/s13-opencode', { recursive: true })
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
              .run('proj-s13-control', '/tmp/freshell-s13/s13-opencode')
            // The title EMBEDS the marker on purpose: first-chat exclusion
            // must operate on firstUserMessage only — with no such data this
            // session stays visible even though its title contains the
            // marker string.
            db.prepare(`
              INSERT OR REPLACE INTO session
                (id, directory, title, time_created, time_updated, time_archived, project_id, parent_id)
              VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
            `).run(
              OPENCODE_CONTROL_ID,
              '/tmp/freshell-s13/s13-opencode',
              `s13 opencode ${MARKER} control`,
              1774000000000,
              1774000000001,
              'proj-s13-control',
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

async function waitForReady(page: any): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(
    () => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 },
  )
}

async function getResolvedSettings(page: any) {
  return page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings ?? null)
}

async function pollServerSidebarSettings(page: any) {
  // Debounced PATCH + broadcast settle asynchronously; poll the resolved
  // server-backed settings tree until it carries the exclusion values this
  // spec sets.
  await expect.poll(async () => {
    const s = await getResolvedSettings(page)
    return {
      substrings: s?.sidebar?.excludeFirstChatSubstrings ?? null,
      mustStart: s?.sidebar?.excludeFirstChatMustStart ?? null,
    }
  }, { timeout: 15_000 }).toEqual({
    substrings: [MARKER],
    mustStart: true,
  })
}

// Exact-membership assertion over the whole seeded matrix.
async function assertMembership(
  page: any,
  expected: { visible: string[]; hidden: string[] },
): Promise<void> {
  for (const id of expected.visible) {
    await expect(
      page.locator(`[data-session-id="${id}"]`),
      `expected session ${id} to be VISIBLE`,
    ).toBeVisible({ timeout: 10_000 })
  }
  for (const id of expected.hidden) {
    await expect(
      page.locator(`[data-session-id="${id}"]`),
      `expected session ${id} to be HIDDEN`,
    ).toHaveCount(0)
  }
}

const ALL_VISIBLE = {
  visible: [
    CLAUDE_START_ID, CLAUDE_MIDDLE_ID, CLAUDE_PLAIN_ID,
    CODEX_START_ID, CODEX_MIDDLE_ID, CODEX_PLAIN_ID,
    AMP_START_ID, AMP_MIDDLE_ID, AMP_PLAIN_ID,
    OPENCODE_CONTROL_ID,
  ],
  hidden: [] as string[],
}

// Contains-mode (`mustStart` false): start AND middle hidden, per provider.
const CONTAINS_MODE = {
  visible: [CLAUDE_PLAIN_ID, CODEX_PLAIN_ID, AMP_PLAIN_ID, OPENCODE_CONTROL_ID],
  hidden: [CLAUDE_START_ID, CLAUDE_MIDDLE_ID, CODEX_START_ID, CODEX_MIDDLE_ID, AMP_START_ID, AMP_MIDDLE_ID],
}

// Prefix-mode (`mustStart` true): only the start sessions stay hidden.
const PREFIX_MODE = {
  visible: [
    CLAUDE_MIDDLE_ID, CLAUDE_PLAIN_ID,
    CODEX_MIDDLE_ID, CODEX_PLAIN_ID,
    AMP_MIDDLE_ID, AMP_PLAIN_ID,
    OPENCODE_CONTROL_ID,
  ],
  hidden: [CLAUDE_START_ID, CODEX_START_ID, AMP_START_ID],
}

test.describe('SESSION-13 first-chat exclusion controls', () => {
  test.setTimeout(180_000)

  test('server-wide first-chat exclusions replicate and apply across providers, profiles, reload, and restart', async ({ browser, page: pageA, serverInfo, testServer }) => {
    await pageA.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(pageA)

    // All ten seeds visible before any exclusion is configured.
    await expect(pageA.getByTestId('sidebar-session-list')).toBeVisible({ timeout: 15_000 })
    await assertMembership(pageA, ALL_VISIBLE)

    // ── Edit control 1 in A (real UI): the substrings textarea. ──
    await pageA.getByRole('button', { name: /settings/i }).click()
    await pageA.getByRole('tab', { name: /^Workspace$/i }).click()
    const textarea = pageA.getByLabel('Sidebar first chat exclusion substrings')
    await textarea.fill(MARKER)

    // Contains-mode takes effect in A once the debounced PATCH lands (poll
    // the resolved server settings, then assert exact sidebar membership).
    await expect.poll(async () => {
      const s = await getResolvedSettings(pageA)
      return s?.sidebar?.excludeFirstChatSubstrings ?? null
    }, { timeout: 15_000 }).toEqual([MARKER])
    await assertMembership(pageA, CONTAINS_MODE)

    // ── Edit control 2 in A (real UI): the mustStart toggle. ──
    await pageA.getByRole('button', { name: /settings/i }).click()
    await pageA.getByRole('tab', { name: /^Workspace$/i }).click()
    await pageA.getByLabel('Require first chat exclusion substring at start').click()
    await pollServerSidebarSettings(pageA)
    await assertMembership(pageA, PREFIX_MODE)
    // Close the settings dialog so it cannot occlude sidebar rows later.
    await pageA.keyboard.press('Escape')

    // ── Exact membership in B (fresh isolated profile, same server). ──
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    try {
      await pageB.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      await waitForReady(pageB)
      await pollServerSidebarSettings(pageB)
      await assertMembership(pageB, PREFIX_MODE)
    } finally {
      await contextB.close()
    }

    // ── Reload A: shared values and results persist. ──
    await pageA.reload()
    await waitForReady(pageA)
    await pollServerSidebarSettings(pageA)
    await assertMembership(pageA, PREFIX_MODE)

    // ── Restart the server: config.json persistence + re-derived results. ──
    if (!testServer.restart) {
      throw new Error('E2eServerHandle does not implement restart()')
    }
    await testServer.restart()
    await expect.poll(() =>
      pageA.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()),
    { timeout: 30_000 }).toBe('ready')
    await pollServerSidebarSettings(pageA)
    await assertMembership(pageA, PREFIX_MODE)

    // Disk bytes: the shared values live server-wide in config.json.
    const configPath = path.join(serverInfo.homeDir, '.freshell', 'config.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
    expect(config.settings.sidebar.excludeFirstChatSubstrings).toEqual([MARKER])
    expect(config.settings.sidebar.excludeFirstChatMustStart).toBe(true)
  })
})
