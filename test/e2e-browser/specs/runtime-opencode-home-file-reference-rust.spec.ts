/**
 * Local-only regression for the operator-home soul mounts: a freshopencode
 * soul whose staged opencode config references its API key via `{file:}`
 * under the operator's home must boot and stay alive — the supervisor
 * bind-mounts the home read-only into the soul at its own path, with tmpfs
 * masks over the operator's secret directories. Pre-fix, the `{file:}`
 * target is unreadable to the 65534:0 child: the soul's opencode bridge dies
 * with the production incident's "Configuration is invalid ... bad file
 * reference" (the reference rides the OPENCODE_CONFIG_CONTENT inline lane,
 * which has no fallback), so no native session ever materializes.
 *
 * Requires the host rootless Docker daemon (registered in LOCAL_ONLY_SPECS).
 * The API key is fake on purpose: the first turn may fail auth, but the child
 * must be alive — that is the pre-fix/post-fix distinction.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'
import { executeAction } from '../../../tools/freshell-mcp/freshell-tool.js'
import { test } from '../helpers/fixtures.js'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'

const OPERATOR_HOME_SUBDIRECTORY = 'operator-home'

function dataOf(result: any): any {
  return result?.data?.data ?? result?.data ?? result
}

async function waitFor<T>(description: string, probe: () => Promise<T | null>, timeout = 240_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function sessionFor(page: Page, sessionId: string): Promise<any | null> {
  return page.evaluate((id) => {
    const sessions = window.__FRESHELL_TEST_HARNESS__?.getState()?.freshAgent?.sessions ?? {}
    return Object.values(sessions).find((session: any) => (
      session.sessionId === id || session.threadId === id || session.cliSessionId === id
    )) ?? null
  }, sessionId)
}

test.describe.serial('freshopencode operator-home {file:} references', () => {
  test('freshopencode soul resolves {file:} API key references under the operator home', async ({ page }) => {
    test.setTimeout(900_000)
    validateFreshAgentIngressInventory(process.cwd())
    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 5, {}, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750',
    }, 'release', {
      enabledProviders: [],
      freshAgentModes: ['freshopencode'],
      providerSettings: { freshopencode: { model: 'openai/gpt-5.6-luna' } },
    }, undefined, OPERATOR_HOME_SUBDIRECTORY)
    try {
      const info = await rig.start()
      const home = rig.operatorHomePath
      if (!home) throw new Error('rig started without an operator home')
      const testRoot = rig.runtime.testRoot

      // Home fixtures — created AFTER rig.start() (prepare() wipes and
      // recreates testRoot) and BEFORE the pane launch (the web server stages
      // the user-provider root at pane creation). The harness umask is 0077,
      // so EVERY directory the 65534:0 child must traverse gets an explicit
      // mode, including the harness-created testRoot ancestors. The
      // `.freshell` mask destination and its config.json canary come from the
      // rig's own web-home writes; their modes are fixed up — like the key and
      // the canary files, which get explicit fsp.chmod because Node applies
      // the process umask (0077) to writeFileSync's mode, leaving requested
      // 0640 files at 0600, where a canary `cat` would throw for the WRONG
      // reason (EACCES, not mask-absence) and the canaries would not test the
      // control-plane boundary. The chmods keep every canary genuinely
      // readable, so the failures below are attributable ONLY to the tmpfs
      // masks.
      await fsp.mkdir(path.join(home, '.amplifier', 'onecli'), { recursive: true })
      await fsp.mkdir(path.join(home, '.config', 'gcloud'), { recursive: true })
      await fsp.mkdir(path.join(home, '.config', 'opencode'), { recursive: true })
      await fsp.writeFile(path.join(home, '.amplifier', 'ms-runpod.key'), 'e2e-key-not-real', { mode: 0o640 })
      await fsp.chmod(path.join(home, '.amplifier', 'ms-runpod.key'), 0o640)
      await fsp.writeFile(path.join(home, '.amplifier', 'onecli', 'canary'), 'canary', { mode: 0o640 })
      await fsp.chmod(path.join(home, '.amplifier', 'onecli', 'canary'), 0o640)
      await fsp.writeFile(path.join(home, '.config', 'gcloud', 'canary'), 'canary', { mode: 0o640 })
      await fsp.chmod(path.join(home, '.config', 'gcloud', 'canary'), 0o640)
      await fsp.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), `${JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          openai: {
            name: 'OpenAI',
            options: { apiKey: `{file:${home}/.amplifier/ms-runpod.key}` },
          },
        },
        // Native provider id: validates offline against the pinned image's
        // bundled models.dev snapshot.
        model: 'openai/gpt-5.6-luna',
      }, null, 2)}\n`)
      for (const directory of [
        home,
        path.join(home, '.amplifier'),
        path.join(home, '.amplifier', 'onecli'),
        path.join(home, '.config'),
        path.join(home, '.config', 'gcloud'),
        path.join(home, '.freshell'),
        testRoot,
        path.dirname(testRoot),
      ]) {
        await fsp.chmod(directory, 0o750)
      }
      await fsp.chmod(path.join(home, '.freshell', 'config.json'), 0o640)

      // The production layout nests the workspace INSIDE the operator home
      // (/home/dan/code/...): the soul mounts the home read-only at its
      // canonical path PLUS the deeper read-write workspace bind, which must
      // shadow the RO parent over its subtree. Launch into a nested workspace
      // so the regression exercises that shape, not an out-of-home cwd. The
      // workspace is group-writable (0770) — under the rootless mapping the
      // child's gid 0 is the operator's group, the same group-write posture
      // production repos rely on.
      const workspace = path.join(home, 'code', 'workspace')
      await fsp.mkdir(workspace, { recursive: true })
      await fsp.chmod(path.join(home, 'code'), 0o750)
      await fsp.chmod(workspace, 0o770)

      process.env.FRESHELL_URL = info.baseUrl
      process.env.FRESHELL_TOKEN = info.token
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      await new TestHarness(page).waitForConnection()

      const created = dataOf(await executeAction('new-tab', {
        agent: 'opencode',
        cwd: workspace,
        model: 'openai/gpt-5.6-luna',
      }))
      if (!created?.paneId || !created?.sessionId) throw new Error('MCP new-tab did not create a fresh-agent pane')
      const paneId = created.paneId as string
      const sessionId = created.sessionId as string
      const tabId = created.tabId as string
      // Agent-driven tab creation is focus-neutral (activate:false); the
      // app's first-time default tab can win the boot race, so select the
      // created tab explicitly (the sanctioned focus verb) before composer
      // interaction.
      if (tabId) await executeAction('select-tab', { target: tabId })
      try {
        // The composer's ready state is its enabled textarea (aria-label
        // "Chat message input"; placeholder "Send a message — …").
        const pane = page.locator(`[data-pane-id="${paneId}"]`)
        const composer = pane.getByRole('textbox', { name: 'Chat message input' })
        await expect(composer).toBeVisible({ timeout: 120_000 })
        await expect(composer).toBeEnabled({ timeout: 120_000 })
        await composer.fill('ping')
        await composer.press('Enter')

        // nativeSessionId materializes only after the first send; the turn
        // may fail auth (the key is fake) but the child must be alive.
        // Pre-fix, the soul's opencode bridge dies with the incident's
        // config error before any native session materializes.
        const view: ManagedRuntimeView = await waitFor('fresh-agent view with a native session id', async () => {
          const current = await rig.runningViewForFreshSession(sessionId)
          return current?.nativeSessionId ? current : null
        })
        const soulRef = view.containerId
        if (!soulRef) throw new Error('managed fresh-agent view has no enclosure')

        const paneText = String(dataOf(await executeAction('capture-pane', { target: paneId, S: -200 })))
        expect(paneText).not.toContain('Configuration is invalid')
        expect(paneText).not.toContain('bad file reference')

        // POSITIVE CONTROL — the child (65534:0) reads the unmasked 0640 key
        // without throwing: traversal and group-read work, so the canary
        // throws below are attributable ONLY to the masks. The helper is
        // synchronous and throws on nonzero exit, so assert throws — never
        // promise rejections.
        expect(() => rig.ownedProviderExec(soulRef, ['cat', `${home}/.amplifier/ms-runpod.key`])).not.toThrow()
        // Mask proof — a working mask leaves each canary ABSENT (empty
        // tmpfs dir), so `cat` exits nonzero and the helper throws. A
        // readable canary would return a string and not throw.
        for (const secret of [
          `${home}/.freshell/config.json`,
          `${home}/.amplifier/onecli/canary`,
          `${home}/.config/gcloud/canary`,
        ]) {
          expect(() => rig.ownedProviderExec(soulRef, ['cat', secret])).toThrow()
        }
      } catch (error) {
        // Surface the rendered pane, session state, and each incarnation's
        // terminal spool so a failure shows the provider's own error text —
        // pre-fix, that is the production incident's "Configuration is
        // invalid ... bad file reference" from the opencode TUI stream.
        const captured = await executeAction('capture-pane', { target: paneId, S: -200 }).catch(() => null)
        if (typeof captured === 'string' && captured.trim()) {
          console.log(`[operator-home-e2e] pane capture on failure:\n${captured}`)
        }
        const session = await sessionFor(page, sessionId).catch(() => null)
        if (session) {
          console.log(`[operator-home-e2e] session state on failure: ${JSON.stringify({
            error: session.error,
            sessionError: session.sessionError,
            status: session.status,
          })}`)
        }
        for (const row of await rig.inventory().catch(() => [])) {
          if (!row.containerId || !row.incarnationId) continue
          const spool = path.join(
            rig.runtime.runtimeDir(rig.supervisor, row.incarnationId),
            'terminal-spool-current.jsonl',
          )
          try {
            const frames = await fsp.readFile(spool, 'utf8')
            const text = frames
              .split('\n')
              .filter(Boolean)
              .map((line) => {
                try {
                  return String(JSON.parse(line).frame.data)
                } catch {
                  return ''
                }
              })
              .join('')
              // Strip ANSI/OSC control sequences for readable console output.
              .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
              .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
              .replace(/\u001b[P>][^\u001b\\]*\u001b\\/g, '')
            if (text.trim()) console.log(`[operator-home-e2e] terminal spool on failure (${row.launchState}):\n${text.trim()}`)
          } catch {}
        }
        throw error
      }
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
