import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * Composer uploads use the Rust server's supported
 * `/api/fresh-agent/attachments` endpoint. Each test owns its Rust server and
 * fake Codex app-server, so it exercises the browser upload path without a
 * shared server matrix or restart.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

async function startAttachmentWall(sharedRoot: string): Promise<{
  server: E2eServerHandle
  info: E2eServerInfo
  homeDir: string
}> {
  const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
  let homeDir = ''
  const server = await createE2eServerHandle(process.env, {
    construct: {
      env: { CODEX_CMD: fakeCodexPath },
      setupHome: async (isolatedHome) => {
        homeDir = isolatedHome
        const freshellDir = path.join(isolatedHome, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            freshAgent: { enabled: true },
            codingCli: {
              enabledProviders: ['codex'],
              providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
            },
          },
        }, null, 2))
      },
    },
  })
  const info = await server.start()
  return { server, info, homeDir }
}

async function openFreshCodex(page: import('@playwright/test').Page, info: E2eServerInfo, projectCwd: string): Promise<{
  paneRoot: import('@playwright/test').Locator
  harness: TestHarness
  tabId: string
}> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: false, codex: true },
    })
  })

  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
  const directoryInput = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
  await expect(directoryInput).toBeVisible({ timeout: 10_000 })
  await directoryInput.fill(projectCwd)
  await directoryInput.press('Enter')

  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect(paneRoot).toBeVisible({ timeout: 15_000 })
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId!)
    return findFreshAgentLeaf(layout)?.content?.status
  }, { timeout: 20_000 }).toBe('idle')
  return { paneRoot, harness, tabId: tabId! }
}

test.describe('Agent attachments (Rust)', () => {
  test('attaching files through the composer stores them under sanitized names', async ({ page }) => {
    test.setTimeout(90_000)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agent11-attach-'))
    const projectCwd = path.join(sharedRoot, 'project')
    try {
      await fs.mkdir(projectCwd, { recursive: true })
      const { server, info, homeDir } = await startAttachmentWall(sharedRoot)
      try {
        const { paneRoot } = await openFreshCodex(page, info, projectCwd)
        const attachmentsDir = path.join(homeDir, '.freshell', 'attachments')
        const fileInput = paneRoot.locator('input[type="file"]')
        const list = paneRoot.getByRole('list', { name: 'Attachments' })

        await fileInput.setInputFiles({
          name: 'note.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello attachment'),
        })
        await expect.poll(async () => list.getByRole('listitem').count(), { timeout: 15_000 }).toBe(1)
        await expect.poll(async () => paneRoot.getByLabel('uploading').count(), { timeout: 15_000 }).toBe(0)
        await expect(list.getByRole('listitem').first())
          .toHaveAttribute('title', /[0-9a-f]{8}-note\.txt$/, { timeout: 15_000 })
        const savedName: string = await expect.poll(async () => {
          const entries = await fs.readdir(attachmentsDir).catch(() => [] as string[])
          return entries.find((entry) => /^[0-9a-f]{8}-note\.txt$/.test(entry)) ?? null
        }, { timeout: 15_000 }).not.toBeNull().then(async () => {
          const entries = await fs.readdir(attachmentsDir)
          return entries.find((entry) => /^[0-9a-f]{8}-note\.txt$/.test(entry))!
        })
        await expect(fs.readFile(path.join(attachmentsDir, savedName), 'utf8'))
          .resolves.toBe('hello attachment')

        await fileInput.setInputFiles({
          name: '../../etc/secret.txt',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('x'),
        })
        await expect.poll(async () => (await fs.readdir(attachmentsDir)).length, { timeout: 15_000 }).toBe(2)
        const entries = await fs.readdir(attachmentsDir)
        const traversal = entries.find((entry) => entry.endsWith('-secret.txt'))
        expect(traversal).toBeTruthy()
        expect(traversal).not.toContain('..')
        expect(path.dirname(path.join(attachmentsDir, traversal!))).toBe(attachmentsDir)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('an oversized upload shows a visible error and stores nothing', async ({ page }) => {
    test.setTimeout(90_000)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agent11-oversize-'))
    const projectCwd = path.join(sharedRoot, 'project')
    try {
      await fs.mkdir(projectCwd, { recursive: true })
      const { server, info, homeDir } = await startAttachmentWall(sharedRoot)
      try {
        const { paneRoot } = await openFreshCodex(page, info, projectCwd)
        const attachmentsDir = path.join(homeDir, '.freshell', 'attachments')
        const fileInput = paneRoot.locator('input[type="file"]')
        const list = paneRoot.getByRole('list', { name: 'Attachments' })

        await fileInput.setInputFiles({
          name: 'huge.txt',
          mimeType: 'application/octet-stream',
          buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 7),
        })
        await expect(list.getByText(/exceeds the 10 MB attachment size limit/))
          .toBeVisible({ timeout: 30_000 })
        const entries = await fs.readdir(attachmentsDir).catch(() => [] as string[])
        expect(entries.some((entry) => entry.includes('huge'))).toBe(false)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
