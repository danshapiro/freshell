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
})
