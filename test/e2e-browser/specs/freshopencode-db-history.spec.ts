import { expect, test, type Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'
import { RustServer } from '../helpers/rust-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

type FakeAuditEvent = {
  event?: string
  sessionId?: string
  prompt?: string
  omitRunSessionId?: boolean
}

type FreshOpencodePaneState = {
  sessionId?: string
  resumeSessionId?: string
  status?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

async function installFakeOpencode(binDir: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fsp.copyFile(fakeOpencodeSource, target)
  await fsp.chmod(target, 0o755)
}

function createSetupHome(sharedOpencodeDataDir: string) {
  return async (homeDir: string): Promise<void> => {
    const xdgShare = path.join(homeDir, '.local', 'share')
    const opencodeLink = path.join(xdgShare, 'opencode')
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(xdgShare, { recursive: true })
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.mkdir(sharedOpencodeDataDir, { recursive: true })
    await fsp.rm(opencodeLink, { recursive: true, force: true }).catch(() => {})
    await fsp.symlink(sharedOpencodeDataDir, opencodeLink, 'dir')
    await fsp.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: {
          enabledProviders: ['opencode'],
          providers: {
            opencode: {},
          },
        },
        freshAgent: { enabled: true },
      },
    }, null, 2))
  }
}

function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
  env?: Record<string, string>
}) {
  return {
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      FRESHELL_LOG_DIR: input.logsDir,
      ...(input.env ?? {}),
    },
  }
}

async function readAuditEvents(auditLogPath: string): Promise<FakeAuditEvent[]> {
  try {
    const text = await fsp.readFile(auditLogPath, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeAuditEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function enableFreshOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
}

async function getFreshOpencodePaneState(page: Page): Promise<FreshOpencodePaneState> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const findFreshOpencode = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.provider === 'opencode') {
        return node.content
      }
      if (node.type === 'split') return findFreshOpencode(node.children?.[0]) ?? findFreshOpencode(node.children?.[1])
      return undefined
    }
    return findFreshOpencode(state?.panes?.layouts?.[activeTabId]) ?? {}
  })
}

async function sendFreshAgentPrompt(page: Page, prompt: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: 'Chat message input' })
  await expect(textbox).toBeVisible({ timeout: 15_000 })
  await expect(textbox).not.toBeDisabled({ timeout: 15_000 })
  await textbox.fill(prompt)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function seedLegacyOpencodeSession(input: {
  sharedOpencodeDataDir: string
  cwd: string
  sessionId: string
  title: string
  prompt: string
  response: string
  createdAt: number
}): Promise<void> {
  await fsp.mkdir(input.sharedOpencodeDataDir, { recursive: true })
  const db = new DatabaseSync(path.join(input.sharedOpencodeDataDir, 'opencode.db'))
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id text PRIMARY KEY,
        worktree text
      );
      CREATE TABLE IF NOT EXISTS session (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        workspace_id text,
        parent_id text,
        slug text NOT NULL,
        directory text NOT NULL,
        path text,
        title text NOT NULL,
        version text NOT NULL,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        metadata text,
        cost real NOT NULL DEFAULT 0,
        tokens_input integer NOT NULL DEFAULT 0,
        tokens_output integer NOT NULL DEFAULT 0,
        tokens_reasoning integer NOT NULL DEFAULT 0,
        tokens_cache_read integer NOT NULL DEFAULT 0,
        tokens_cache_write integer NOT NULL DEFAULT 0,
        revert text,
        permission text,
        agent text,
        model text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        time_compacting integer,
        time_archived integer
      );
      CREATE TABLE IF NOT EXISTS message (
        id text PRIMARY KEY,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `)
    db.prepare('INSERT OR REPLACE INTO project (id, worktree) VALUES (?, ?)').run('proj-legacy', input.cwd)
    db.prepare(`
      INSERT OR REPLACE INTO session (
        id, project_id, workspace_id, parent_id, slug, directory, path, title, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        metadata, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write, revert, permission, agent, model, time_created, time_updated,
        time_compacting, time_archived
      )
      VALUES (?, 'proj-legacy', NULL, NULL, ?, ?, ?, ?, 'fake-opencode-e2e',
        NULL, 0, 0, 0, NULL, NULL, 0, 0, 0, 0, 0, 0, NULL, NULL, 'fake',
        ?, ?, ?, NULL, NULL)
    `).run(
      input.sessionId,
      input.sessionId,
      input.cwd,
      input.cwd,
      input.title,
      JSON.stringify({ providerID: 'opencode', modelID: 'fake-opencode' }),
      input.createdAt,
      input.createdAt + 2_000,
    )

    const userMessageId = `${input.sessionId}_legacy_user`
    const assistantMessageId = `${input.sessionId}_legacy_assistant`
    db.prepare('INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
      .run(userMessageId, input.sessionId, input.createdAt, input.createdAt, JSON.stringify({ role: 'user' }))
    db.prepare('INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${userMessageId}_part`, userMessageId, input.sessionId, input.createdAt, input.createdAt, JSON.stringify({ type: 'text', text: input.prompt }))
    db.prepare('INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
      .run(assistantMessageId, input.sessionId, input.createdAt + 1_000, input.createdAt + 1_000, JSON.stringify({ role: 'assistant' }))
    db.prepare('INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${assistantMessageId}_part`, assistantMessageId, input.sessionId, input.createdAt + 1_000, input.createdAt + 1_000, JSON.stringify({ type: 'text', text: input.response }))
  } finally {
    db.close()
  }
}

test.describe('Freshopencode DB history restore', () => {
  test.setTimeout(180_000)

  test('restores Freshopencode turns from DB history when export is truncated', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-db-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const prompt = 'Persist this Freshopencode DB turn'
    const response = 'Freshopencode DB response survived reload'
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      env: {
        FAKE_OPENCODE_TRUNCATE_EXPORT: '1',
        FAKE_OPENCODE_RESPONSE_TEXT: response,
      },
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 15_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
      })

      await sendFreshAgentPrompt(page, prompt)

      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^ses_/),
        resumeSessionId: expect.stringMatching(/^ses_/),
        sessionRef: {
          provider: 'opencode',
          sessionId: expect.stringMatching(/^ses_/),
        },
      })
      const beforeReload = await getFreshOpencodePaneState(page)
      expect(beforeReload.sessionRef?.sessionId).toBe(beforeReload.sessionId)

      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()

      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: beforeReload.sessionId,
        resumeSessionId: beforeReload.sessionId,
        sessionRef: {
          provider: 'opencode',
          sessionId: beforeReload.sessionId,
        },
      })

      const auditEvents = await readAuditEvents(auditLogPath)
      expect(auditEvents.some((event) => event.event === 'run' && event.prompt === prompt)).toBe(true)
      expect(auditEvents.some((event) => event.event === 'export')).toBe(false)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('does not materialize Freshopencode from DB rows without top-level run sessionID', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-no-session-id-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const prompt = 'Do not infer my session id'
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      env: {
        FAKE_OPENCODE_RUN_NO_SESSION_ID: '1',
      },
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await sendFreshAgentPrompt(page, prompt)

      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.find((event) => event.event === 'run' && event.prompt === prompt) ?? null
      }, { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^ses_/),
        omitRunSessionId: true,
      })

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
        resumeSessionId: expect.stringMatching(/^freshopencode-/),
        sessionRef: {
          provider: 'opencode',
          sessionId: expect.stringMatching(/^freshopencode-/),
        },
        status: 'idle',
      })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('repairs a persisted legacy placeholder from a unique DB session', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-legacy-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const sessionId = 'ses_legacy_unique'
    const placeholderId = 'freshopencode--legacyUnique'
    const prompt = 'Which skills come from public repos'
    const response = 'Only the unique legacy DB session should render'
    const tabCreatedAt = Date.now()
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)
    await seedLegacyOpencodeSession({
      sharedOpencodeDataDir,
      cwd,
      sessionId,
      title: 'Skills from public repos',
      prompt,
      response,
      createdAt: tabCreatedAt + 60_000,
    })

    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      env: {
        FAKE_OPENCODE_TRUNCATE_EXPORT: '1',
      },
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)

      await page.evaluate(({ cwd, placeholderId, tabCreatedAt }) => {
        const harness = window.__FRESHELL_TEST_HARNESS__
        harness?.dispatch({
          type: 'tabs/addTab',
          payload: {
            id: 'tab-legacy-freshopencode',
            title: 'Identifying skills from GitHub repos',
            mode: 'shell',
            status: 'running',
          },
        })
        harness?.dispatch({
          type: 'tabs/updateTab',
          payload: {
            id: 'tab-legacy-freshopencode',
            updates: {
              title: 'Identifying skills from GitHub repos',
              createdAt: tabCreatedAt,
            },
          },
        })
        harness?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: 'tab-legacy-freshopencode',
            paneId: 'pane-legacy-freshopencode',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshopencode',
              provider: 'opencode',
              createRequestId: '-legacyUnique',
              sessionRef: { provider: 'opencode', sessionId: placeholderId },
              initialCwd: cwd,
              status: 'connected',
            },
          },
        })
        harness?.dispatch({ type: 'tabs/setActiveTab', payload: 'tab-legacy-freshopencode' })
      }, { cwd, placeholderId, tabCreatedAt })

      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(response)).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId,
        resumeSessionId: sessionId,
        sessionRef: {
          provider: 'opencode',
          sessionId,
        },
      })

      const auditEvents = await readAuditEvents(auditLogPath)
      expect(auditEvents.some((event) => event.event === 'export')).toBe(false)
      expect(auditEvents.some((event) => event.event === 'run')).toBe(false)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
