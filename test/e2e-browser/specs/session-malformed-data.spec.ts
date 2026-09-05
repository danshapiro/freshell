import fs from 'fs/promises'
import path from 'path'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'

/**
 * SESSION-16 — "Tolerate malformed and partially written provider data."
 *
 * Playwright validation (deferred-posture probe, per the df1 campaign policy: authored +
 * this spec is NOT iterated to green by the worker):
 *
 *   "Seed healthy, empty, truncated, malformed, and invalid-UTF-8 records for every
 *   provider, assert healthy sidebar/search remains usable, then complete a partial
 *   record and observe one live addition without restart."
 *
 * Seeded classes (per provider, sharing the `s16-campaign` marker prefix):
 *  - healthy (must render),
 *  - quarantine classes (must NEVER render): 0-byte, whitespace/all-malformed lines,
 *    well-formed-but-cwd-less (R10b discovery gate), truncated-without-a-complete-line,
 *    NULL/empty opencode `directory` row, malformed/empty/`working_dir`-less amplifier
 *    metadata.json,
 *    truncated-with-valid-prefix (parseable prefix indexed), invalid-UTF-8 payload
 *    (lossy U+FFFD read — Node `fs.readFile(f, 'utf8')` parity).
 *  - one partially-written claude record completed MID-TEST by appending the missing
 *    bytes — exactly one live sidebar addition, no reload (Rust: periodic sweep +
 *    passes only if the completing write moves the exclude→include transition).
 *
 * Parity anchors: crate-level pins in
 * `crates/freshell-sessions/tests/malformed_data_quarantine.rs` (Rust, real SessionIndex
 * sweeps) and the frozen-behavior control
 * provider modules). Both legs of THIS spec exercise the REAL servers over an isolated
 *
 * Visibility discipline: the sidebar's DEFAULT browse projection hides non-interactive
 * sessions (SESSION-15's local filters), so every record this spec asserts as VISIBLE
 * two-turn realism). Quarantine-marker records also carry markers in the first user
 * message / `name` field so a quarantine regression would render an assertable string.
 */

// ── Seeded identities ────────────────────────────────────────────────────────

const CLAUDE_HEALTHY_ID = '00000000-0000-4000-8000-16000000a111'
const CLAUDE_PREFIX_ID = '00000000-0000-4000-8000-16000000b222' // truncated w/ valid prefix — renders
const CLAUDE_UTF8_ID = '00000000-0000-4000-8000-16000000c333' // invalid UTF-8 — renders (lossy)
const CLAUDE_PARTIAL_ID = '00000000-0000-4000-8000-16000000d444' // completed mid-test
const CODEX_SESSION_ID = 'codex-s16-gamma-0001'
const OPENCODE_SESSION_ID = 'oc-s16-delta-0001'
const AMPLIFIER_SESSION_ID = 'amp-s16-epsilon-0001'

// Titles / markers (all share the `s16-campaign` prefix).
const T = {
  claudeHealthy: 's16-campaign alpha request 1',
  claudePrefix: 's16-campaign prefix-kept marker',
  claudeUtf8: 's16-campaign utf8 marker',
  claudeCwdless: 's16-campaign cwdless marker', // would-be title — must never render
  codexHealthy: 's16-campaign gamma request',
  opencodeHealthy: 's16-campaign delta row',
  opencodeNullCwd: 's16-campaign delta nullcwd marker', // quarantined row — never renders
  amplifierHealthy: 's16-campaign epsilon',
  amplifierCwdless: 's16-campaign amp cwdless marker', // quarantined doc — never renders
  claudePartial: 's16-campaign partial-completed marker', // absent, then live-added
}

/** Two-turn claude JSONL doc (interactive per the default browse filter). A
 * `tailLines` suffix can inject a record whose bytes are truncated later. */
function buildClaudeDoc(input: {
  sessionId: string
  cwd?: string
  userTexts: [string, string]
  omitCwd?: boolean
  tailTruncatedLine?: boolean
}): string {
  const cwdFields = input.omitCwd ? {} : { cwd: input.cwd }
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: input.sessionId,
      uuid: `${input.sessionId}-system`,
      timestamp: '2026-08-01T08:00:00.000Z',
      ...cwdFields,
      git: { branch: 'main', dirty: false },
    }),
  ]
  input.userTexts.forEach((text, i) => {
    lines.push(JSON.stringify({
      sessionId: input.sessionId,
      type: 'user',
      message: { role: 'user', content: text },
      uuid: `${input.sessionId}-u${i}`,
      timestamp: `2026-08-01T08:0${i + 1}:01.000Z`,
      ...cwdFields,
    }))
    lines.push(JSON.stringify({
      sessionId: input.sessionId,
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-opus-4-6-20260301', content: [{ type: 'text', text: `${text} — reply` }] },
      uuid: `${input.sessionId}-a${i}`,
      timestamp: `2026-08-01T08:0${i + 1}:02.000Z`,
      ...cwdFields,
    }))
  })
  if (input.tailTruncatedLine) {
    const extra = claudeUserLine(input.sessionId, input.cwd ?? '/x', '2026-08-01T08:09:01.000Z', 's16-campaign cut tail')
    lines.push(extra.slice(0, Math.floor(extra.length * 2 / 3)))
  }
  return lines.join('\n') + '\n'
}

function claudeUserLine(sessionId: string, cwd: string, timestamp: string, text: string): string {
  return JSON.stringify({
    cwd,
    sessionId,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `${sessionId}-${timestamp}`,
    timestamp,
  }) + '\n'
}

function codexHealthyDoc(sessionId: string, cwd: string): string {
  return [
    JSON.stringify({
      timestamp: '2026-08-02T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd },
    }),
    JSON.stringify({
      timestamp: '2026-08-02T08:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: T.codexHealthy }] },
    }),
  ].join('\n') + '\n'
}

function amplifierMetadata(id: string, workingDir: string | undefined, name: string): string {
  return JSON.stringify({
    session_id: id,
    ...(workingDir ? { working_dir: workingDir } : {}),
    created: '2026-08-03T08:00:00.000Z',
    description_updated_at: '2026-08-03T08:00:02.000Z',
    name,
    description: `${name} summary`,
  })
}

const SIDEBAR_TIMEOUT = 15_000

// Routed through the generalized E2eServerHandle seam (HARNESS-02) so the SAME spec
const test = base.extend({
  testServer: [async ({}, use) => {
    const server = await createE2eServerHandle(process.env, {
      construct: {
        setupHome: async (homeDir) => {
          // ── Claude corpus (`<home>/.claude/projects/s16-campaign/*.jsonl`) ──
          const claudeDir = path.join(homeDir, '.claude', 'projects', 's16-campaign')
          await fs.mkdir(claudeDir, { recursive: true })

          await fs.writeFile(
            path.join(claudeDir, `${CLAUDE_HEALTHY_ID}.jsonl`),
            buildClaudeDoc({
              sessionId: CLAUDE_HEALTHY_ID,
              cwd: '/tmp/freshell-s16/alpha',
              userTexts: [T.claudeHealthy, 's16-campaign alpha request 2'],
            }),
          )
          // Quarantine: 0-byte.
          await fs.writeFile(path.join(claudeDir, '00000000-0000-4000-8000-16000000e555.jsonl'), '')
          // Quarantine: every line malformed.
          await fs.writeFile(
            path.join(claudeDir, '00000000-0000-4000-8000-16000000f666.jsonl'),
            'not json at all\n{"unclosed":\n\x00\x01 binary junk\n',
          )
          // Quarantine: well-formed multi-turn doc with NO cwd anywhere (R10b).
          await fs.writeFile(
            path.join(claudeDir, '00000000-0000-4000-8000-16000000a777.jsonl'),
            buildClaudeDoc({
              sessionId: '00000000-0000-4000-8000-16000000a777',
              omitCwd: true,
              userTexts: [T.claudeCwdless, 's16-campaign cwdless second turn'],
            }),
          )
          // Quarantine: truncated — the whole file is ONE incomplete first line.
          const truncatedOnlyFull = claudeUserLine(
            '00000000-0000-4000-8000-16000000b888', '/tmp/freshell-s16/truncated-only',
            '2026-08-01T09:00:01.000Z', 's16-campaign never completes',
          )
          await fs.writeFile(
            path.join(claudeDir, '00000000-0000-4000-8000-16000000b888.jsonl'),
            truncatedOnlyFull.slice(0, Math.floor(truncatedOnlyFull.length / 3)),
          )
          // Tolerated: truncated with a VALID prefix (two complete turns survived; the
          // tail line is cut) — indexed, NOT quarantined.
          await fs.writeFile(
            path.join(claudeDir, `${CLAUDE_PREFIX_ID}.jsonl`),
            buildClaudeDoc({
              sessionId: CLAUDE_PREFIX_ID,
              cwd: '/tmp/freshell-s16/prefix',
              userTexts: [T.claudePrefix, 's16-campaign prefix-kept second turn'],
              tailTruncatedLine: true,
            }),
          )
          // Tolerated: invalid UTF-8 bytes inside an otherwise-valid record — lossy
          // (U+FFFD) read, NOT quarantined. First (title-bearing) turn is clean.
          await fs.writeFile(
            path.join(claudeDir, `${CLAUDE_UTF8_ID}.jsonl`),
            Buffer.concat([
              Buffer.from(buildClaudeDoc({
                sessionId: CLAUDE_UTF8_ID,
                cwd: '/tmp/freshell-s16/utf8',
                userTexts: [T.claudeUtf8, 's16-campaign utf8 second turn'],
              }), 'utf8'),
              Buffer.concat([
                Buffer.from(`{"cwd":"/tmp/freshell-s16/utf8","sessionId":"${CLAUDE_UTF8_ID}","type":"user","message":{"role":"user","content":"s16-campaign utf8 bad `, 'utf8'),
                Buffer.from([0xc3, 0x28, 0x20, 0xe2, 0x82, 0x20, 0xf0, 0x9f, 0x98]),
                Buffer.from(` end"},"uuid":"${CLAUDE_UTF8_ID}-bad","timestamp":"2026-08-01T09:30:01.000Z"}\n`, 'utf8'),
              ]),
            ]),
          )
          // Partial (completed mid-test in test 3): strict prefix of the final doc —
          // cut WITHIN LINE 1 (the init record), so the seed has ZERO complete lines and
          // is genuinely UNINDEXED at boot (a real "partially written" record). A naive
          // fraction-of-total-bytes cut would leave the init + first-turn lines COMPLETE
          // — a valid prefix (cwd present) means the record is indexed at boot with one
          // user message, i.e. non-interactive and HIDDEN by the default browse
          // projection: the completion then changes neither the index count nor (with a
          // newer codex seed present) the corpus max-lastActivityAt, so the Rust sweep
          // watcher still fires on content diffs). Verified by direct instrumentation:
          // `spawn_sessions_sweep` ticks showed len already including the seed from the
          // first tick while the API browse projection correctly hid it.
          const partialFinal = buildClaudeDoc({
            sessionId: CLAUDE_PARTIAL_ID,
            cwd: '/tmp/freshell-s16/partial',
            userTexts: [T.claudePartial, 's16-campaign partial second turn'],
          })
          const initLineEnd = partialFinal.indexOf('\n')
          await fs.writeFile(
            path.join(claudeDir, `${CLAUDE_PARTIAL_ID}.jsonl`),
            partialFinal.slice(0, Math.floor(initLineEnd / 2)),
          )

          // ── Codex corpus (`<home>/.codex/sessions/*.jsonl`) ──
          const codexDir = path.join(homeDir, '.codex', 'sessions')
          await fs.mkdir(codexDir, { recursive: true })
          await fs.mkdir('/tmp/freshell-s16/gamma', { recursive: true })
          await fs.writeFile(
            path.join(codexDir, `${CODEX_SESSION_ID}.jsonl`),
            codexHealthyDoc(CODEX_SESSION_ID, '/tmp/freshell-s16/gamma'),
          )
          await fs.writeFile(path.join(codexDir, 'codex-s16-empty.jsonl'), '')
          await fs.writeFile(path.join(codexDir, 'codex-s16-garbage.jsonl'), '!!!\n{"x":\n\x00 junk\n')
          const codexTruncFull = codexHealthyDoc('codex-s16-truncated', '/tmp/freshell-s16/codex-truncated')
          const metaEnd = codexTruncFull.indexOf('\n')
          const metaLine = codexTruncFull.slice(0, metaEnd)
          await fs.writeFile(
            path.join(codexDir, 'codex-s16-truncated.jsonl'),
            metaLine.slice(0, Math.floor(metaLine.length * 2 / 3)),
          )

          // ── OpenCode corpus (`<home>/.local/share/opencode/opencode.db`) ──
          // One healthy row + one NULL-`directory` row (the row-level quarantine class
          // — a single home has exactly one db, so db-LEVEL corruption legs live in the
          // crate tests, not here).
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
              .run('proj-s16-delta', '/tmp/freshell-s16/delta')
            db.prepare(`
              INSERT OR REPLACE INTO session
                (id, directory, title, time_created, time_updated, time_archived, project_id, parent_id)
              VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
            `).run(OPENCODE_SESSION_ID, '/tmp/freshell-s16/delta', T.opencodeHealthy, 1780000000000, 1780000000001, 'proj-s16-delta')
            db.prepare(`
              INSERT OR REPLACE INTO session
                (id, directory, title, time_created, time_updated, time_archived, project_id, parent_id)
              VALUES (?, NULL, ?, ?, ?, NULL, ?, NULL)
            `).run('oc-s16-nullcwd-0001', T.opencodeNullCwd, 1780000000002, 1780000000003, 'proj-s16-delta')
          } finally {
            db.close()
          }

          // ── Amplifier corpus (`<home>/.amplifier/projects/<slug>/sessions/<id>/`) ──
          // rust-only KNOWN DIVERGENCE is stale at df1/integration), so no kind gate.
          const ampSessionsDir = path.join(homeDir, '.amplifier', 'projects', 's16-project', 'sessions')
          const ampHealthyDir = path.join(ampSessionsDir, AMPLIFIER_SESSION_ID)
          await fs.mkdir(ampHealthyDir, { recursive: true })
          await fs.mkdir('/tmp/freshell-s16/epsilon', { recursive: true })
          await fs.writeFile(
            path.join(ampHealthyDir, 'metadata.json'),
            amplifierMetadata(AMPLIFIER_SESSION_ID, '/tmp/freshell-s16/epsilon', T.amplifierHealthy),
          )
          await fs.writeFile(
            path.join(ampHealthyDir, 'transcript.jsonl'),
            '{"role":"user","content":"s16-campaign epsilon request"}\n{"role":"assistant","content":"s16-campaign epsilon reply"}\n',
          )
          // Quarantine: malformed metadata doc.
          const ampBadDir = path.join(ampSessionsDir, 'amp-s16-malformed')
          await fs.mkdir(ampBadDir, { recursive: true })
          await fs.writeFile(path.join(ampBadDir, 'metadata.json'), '{not json at all')
          // Quarantine: empty metadata doc.
          const ampEmptyDir = path.join(ampSessionsDir, 'amp-s16-empty')
          await fs.mkdir(ampEmptyDir, { recursive: true })
          await fs.writeFile(path.join(ampEmptyDir, 'metadata.json'), '')
          // Quarantine: valid doc, no working_dir (R10b).
          const ampCwdlessDir = path.join(ampSessionsDir, 'amp-s16-cwdless')
          await fs.mkdir(ampCwdlessDir, { recursive: true })
          await fs.writeFile(
            path.join(ampCwdlessDir, 'metadata.json'),
            amplifierMetadata('amp-s16-cwdless', undefined, T.amplifierCwdless),
          )
        },
      },
    })
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],
})

/** Exact provider-qualified membership read of the directory API (the same read model
 * the sidebar consumes). */
async function directoryKeys(page: import('@playwright/test').Page, serverInfo: { baseUrl: string; token: string }): Promise<Set<string>> {
  const response = await page.request.get(
    `${serverInfo.baseUrl}/api/session-directory?priority=visible&limit=50`,
    { headers: { 'x-auth-token': serverInfo.token } },
  )
  expect(response.ok()).toBe(true)
  const payload = await response.json() as { items: Array<{ provider: string; sessionId: string }> }
  return new Set(payload.items.map((item) => `${item.provider}:${item.sessionId}`))
}

test.describe('SESSION-16 Malformed/partial provider data (sidebar remains usable)', () => {
  test('healthy records render beside every quarantine class; sidebar search stays usable', async ({ freshellPage, page, serverInfo }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    await expect(page.getByText('No sessions yet')).not.toBeVisible()

    // ── Clause 1 (UI): every provider family's healthy record renders. ──
    await expect(page.getByText(new RegExp(T.claudeHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    await expect(page.getByText(new RegExp(T.codexHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    await expect(page.getByText(new RegExp(T.opencodeHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    await expect(page.getByText(new RegExp(T.amplifierHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    // Tolerated classes render too (parity: NOT quarantined).
    await expect(page.getByText(new RegExp(T.claudePrefix, 'i'))).toBeVisible()
    await expect(page.getByText(new RegExp(T.claudeUtf8, 'i'))).toBeVisible()

    // ── Clause 2 (UI): quarantine-marker strings never render. ──
    await expect(page.getByText(new RegExp(T.claudeCwdless, 'i'))).not.toBeVisible()
    await expect(page.getByText(new RegExp(T.opencodeNullCwd, 'i'))).not.toBeVisible()
    await expect(page.getByText(new RegExp(T.amplifierCwdless, 'i'))).not.toBeVisible()

    // ── Clause 1+2 (API, exact membership): the read model contains exactly the
    // indexable seeds — never a quarantined record. ──
    const keys = await directoryKeys(page, serverInfo)
    expect(keys).toContain(`claude:${CLAUDE_HEALTHY_ID}`)
    expect(keys).toContain(`codex:${CODEX_SESSION_ID}`)
    expect(keys).toContain(`opencode:${OPENCODE_SESSION_ID}`)
    expect(keys).toContain(`amplifier:${AMPLIFIER_SESSION_ID}`)
    expect(keys).toContain(`claude:${CLAUDE_PREFIX_ID}`)
    expect(keys).toContain(`claude:${CLAUDE_UTF8_ID}`)
    // Quarantined ids never surface. (The empty/garbage/truncated files carry no
    // parseable identity at all; they are caught by the exact-membership parity anchors
    // in the crate/control tests and by the "one live addition" delta in test 3.)
    expect(keys).not.toContain('opencode:oc-s16-nullcwd-0001')
    expect(keys).not.toContain('amplifier:amp-s16-cwdless')
    expect(keys).not.toContain(`claude:${CLAUDE_PARTIAL_ID}`)

    // ── Search stays usable over the corrupted corpus (real search box). ──
    const searchBox = page.getByPlaceholder('Search...')
    await searchBox.fill('gamma request')
    await expect(page.getByText(new RegExp(T.codexHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    await expect(page.getByText(new RegExp(T.claudeHealthy, 'i'))).not.toBeVisible()
    // A quarantined marker can never be searched up.
    await searchBox.fill('cwdless marker')
    await expect(page.getByText(new RegExp(T.claudeCwdless, 'i'))).not.toBeVisible()
    await expect(page.getByText(new RegExp(T.amplifierCwdless, 'i'))).not.toBeVisible()
    // Clearing restores the healthy list (search is live/reversible).
    await page.getByLabel('Clear search').click()
    await expect(page.getByText(new RegExp(T.claudeHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
  })

  test('completing a partially-written record adds exactly one live session, no reload', async ({ freshellPage, page, serverInfo }) => {
    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    await expect(page.getByText(new RegExp(T.claudeHealthy, 'i'))).toBeVisible({ timeout: SIDEBAR_TIMEOUT })

    // The partial record has no indexable identity yet.
    await expect(page.getByText(new RegExp(T.claudePartial, 'i'))).not.toBeVisible()
    const before = await directoryKeys(page, serverInfo)
    expect(before).not.toContain(`claude:${CLAUDE_PARTIAL_ID}`)

    // The writer resumes MID-TEST: append exactly the missing tail bytes, turning the
    // strict prefix into the complete two-turn document (a real mid-write completion
    // shape — no file replace, no restart).
    const finalDoc = buildClaudeDoc({
      sessionId: CLAUDE_PARTIAL_ID,
      cwd: '/tmp/freshell-s16/partial',
      userTexts: [T.claudePartial, 's16-campaign partial second turn'],
    })
    const partialPath = path.join(
      serverInfo.homeDir, '.claude', 'projects', 's16-campaign', `${CLAUDE_PARTIAL_ID}.jsonl`,
    )
    const existing = await fs.readFile(partialPath, 'utf8')
    expect(finalDoc.startsWith(existing)).toBe(true) // seed really is a strict prefix
    await fs.appendFile(partialPath, finalDoc.slice(existing.length))

    // Clause 3: exactly ONE live addition appears without a reload — UI-level marker…
    await expect(page.getByText(new RegExp(T.claudePartial, 'i')))
      .toBeVisible({ timeout: SIDEBAR_TIMEOUT })
    // …and the API-level delta is exactly the completed record (no sibling wobble).
    await expect.poll(
      async () => {
        const after = await directoryKeys(page, serverInfo)
        return [...after].filter((key) => !before.has(key)).sort()
      },
      { timeout: SIDEBAR_TIMEOUT, intervals: [500, 1000, 2000] },
    ).toEqual([`claude:${CLAUDE_PARTIAL_ID}`])
    // Nothing healthy disappeared in the transition.
    const finalKeys = await directoryKeys(page, serverInfo)
    for (const key of before) {
      expect(finalKeys).toContain(key)
    }
  })
})
