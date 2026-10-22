import path from 'node:path'
import { spawn } from 'node:child_process'
import { test, expect } from '../helpers/fixtures.js'
import {
  REPO_ROOT,
  bootUnifiedNamesServer,
  connectUnifiedPage,
  createNamedAgent,
  expectSharedName,
  paneContentFromLayoutSnapshot,
  renameThroughTabEdit,
  type NamedAgentHandle,
  type UnifiedNamesServer,
} from '../helpers/unified-agent-names.js'

/**
 * Name-reliability Task 4 (RC5): an automation rename reports whether it
 * applied. A Claude pane the user named "LotL" in the UI keeps that name
 * when an agent runs `freshell rename-tab "Bot name"`, and the built CLI
 * says so on stderr (`name not applied: protected_name`); on a fresh pane
 * the same call applies.
 *
 * Owned server only: the spec boots its own Rust server on an ephemeral
 * loopback port with an isolated home (the fake Claude CLI wired through
 * `modeFixture`), and stops it by its recorded PID.
 */

test.setTimeout(240_000)

async function runCli(
  server: UnifiedNamesServer,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliBin = path.join(REPO_ROOT, 'dist', 'tools', 'freshell-cli', 'index.js')
  const attempt = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      env: { ...process.env, FRESHELL_URL: server.info.baseUrl, FRESHELL_TOKEN: server.info.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')) }, 60_000)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  // The CLI shares the API rate-limit bucket with the page's own traffic:
  // retry a transient 429 a bounded few times.
  let run = await attempt()
  for (let tries = 0; tries < 5 && run.code !== 0 && /rate_limited/.test(run.stderr + run.stdout); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    run = await attempt()
  }
  return run
}

/**
 * The CLI addresses a pane through the SERVER's layout mirror, which adopts
 * a UI-created agent pane only when the browser's layout sync lands (the
 * handle is read from the browser's own state, so it can be ready first).
 * Until then the tab route sees a plain tab and renames its layout label —
 * the documented capture-less behavior, not the naming record. An agent
 * can only act on panes the server knows, so wait for that first.
 */
async function waitForServerNamingIdentity(server: UnifiedNamesServer, handle: NamedAgentHandle): Promise<void> {
  await expect.poll(async () => {
    const content = await paneContentFromLayoutSnapshot(server, handle.tabId, handle.paneId).catch(() => null)
    return Boolean(content && (content.nameRef || (typeof content.namingHandle === 'string' && content.namingHandle)))
  }, {
    message: `the server's layout mirror knows pane ${handle.paneId}'s naming identity`,
    timeout: 30_000,
    intervals: [250, 500, 1_000],
  }).toBe(true)
}

test.describe('automation rename outcome', () => {
  test('a refused automation rename says so, and on a fresh pane it applies', async ({ browser }) => {
    const server = await bootUnifiedNamesServer({ mode: 'claude' })
    try {
      const { page, harness, context } = await connectUnifiedPage({ browser, info: server.info })

      // The user names the first pane in the UI.
      const first = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server })
      expect(first.nameRef).toBeTruthy()
      await renameThroughTabEdit(page, first.tabId, 'LotL')
      await expectSharedName(harness, first.nameRef!, 'LotL', {
        page, server, tabId: first.tabId, surfaces: ['http', 'redux', 'pane', 'tab'],
      })

      // An agent's automatic rename is refused, and the CLI says why.
      await waitForServerNamingIdentity(server, first)
      const refused = await runCli(server, ['rename-tab', '--target', first.tabId, 'Bot name'])
      expect(refused.code, refused.stderr).toBe(0)
      expect(refused.stderr).toContain('name not applied: protected_name')
      await page.waitForTimeout(2_000)
      await expectSharedName(harness, first.nameRef!, 'LotL', {
        page, server, tabId: first.tabId, surfaces: ['http', 'redux', 'pane', 'tab'],
      })

      // On a fresh pane (its folder name is only a fallback) it applies.
      const second = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server })
      expect(second.nameRef).toBeTruthy()
      await waitForServerNamingIdentity(server, second)
      const applied = await runCli(server, ['rename-tab', '--target', second.tabId, 'Bot name'])
      expect(applied.code, applied.stderr).toBe(0)
      expect(applied.stderr).not.toContain('name not applied')
      // The response reached the naming record (the tab route nests the
      // update under `data.sessionName`) and says it applied — not a
      // layout-label rename, which carries no outcome at all.
      const appliedBody = JSON.parse(
        applied.stdout.slice(applied.stdout.indexOf('{'), applied.stdout.lastIndexOf('}') + 1),
      ) as {
        data?: { sessionName?: { outcome?: { applied?: boolean } } }
      }
      expect(appliedBody.data?.sessionName?.outcome?.applied, applied.stdout).toBe(true)
      await expectSharedName(harness, second.nameRef!, 'Bot name', {
        page, server, tabId: second.tabId, surfaces: ['http', 'redux', 'tab'],
      })
      await context.close()
    } finally {
      await server.stop()
    }
  })
})
