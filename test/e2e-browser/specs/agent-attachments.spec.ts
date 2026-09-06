import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * AGENT-11 (SLICE) -- composer attachment uploads land on the server, and
 * upload failures are visible as composer error chips. This spec covers the
 * composer paperclip upload flow end to end
 * (`src/components/fresh-agent/FreshAgentComposer.tsx`'s hidden
 * `<input type="file">` -> `POST /api/fresh-agent/attachments?name=...` with
 * a raw octet-stream body): happy-path persistence under
 * `<home>/.freshell/attachments` with a uuid-prefixed, sanitized filename,
 * hostile-name traversal containment, and the oversized-file failure
 * rendering a visible "exceeds the 10 MB attachment size limit" chip while
 * storing nothing. This work covers a slice of AGENT-11 only -- it does NOT
 * take any AGENT-11 golden-checklist checkbox.
 *
 * Server-failure mapping lives in the composer's
 * `attachmentUploadErrorMessage` (maps on `res.status`, never the 413 body,
 * whose express error page is HTML), so the oversized chip text is identical
 * on both server legs -- legacy-chromium is a true parity control (the Node
 * route at `server/fresh-agent-extras-router.ts` is the behavioral oracle),
 * and the rust lane is RED until the Rust route
 * (`crates/freshell-server/src/attachments.rs`) lands.
 *
 * Cloud legality (LB-12/LB-13): NO server.restart() leg anywhere (the
 * property that got `agent-checkpoint-rewind.spec.ts` listed in
 * `CLOUD_SKIP_SPECS`); the fake codex app-server is booted exclusively via
 * the `CODEX_CMD` construct env seam (the same shape as the cloud-legal
 * `agent-continuity-matrix.spec.ts`); each test carries its own 90s
 * `test.setTimeout`, comfortably inside the 120s cloud per-test budget.
 *
 * Routed through the generalized E2eServerHandle seam (HARNESS-02) so the
 * SAME spec exercises the legacy Node server and the owned Rust server via
 * the `e2eServerKind` project option (see `playwright.config.ts`'s
 * `MATRIX_SPECS`).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Re-exec wrapper around the shared fake Codex app-server fixture (see
 * `restore-matrix.spec.ts`'s identically-purposed helper for the full
 * rationale for a wrapper rather than a raw copy -- ESM bare-specifier
 * resolution and permission bits). Duplicated here rather than imported so
 * this spec stays self-contained, matching this test directory's existing
 * convention of each spec owning its own fixture-install helper (e.g.
 * `agent-continuity-matrix.spec.ts`'s `installFakeOpencode`).
 */
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

/** Find the (first) fresh-agent leaf node within a possibly-split pane layout tree. */
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

test.describe('Agent attachments (AGENT-11 slice)', () => {
  test('attaching files through the composer stores them on the server under sanitized names', async ({ page, e2eServerKind }) => {
    // Per-test budget extended for the two real upload round trips; still
    // comfortably under the 120s cloud per-test cap (no restart leg here).
    test.setTimeout(90_000)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agent11-attach-'))
    const projectCwd = path.join(sharedRoot, 'project')
    try {
      await fs.mkdir(projectCwd, { recursive: true })

      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
      // The isolated HOME the harness forces on the server (`FRESHELL_HOME`/
      // `HOME`) is where uploads must land; capture it from the same
      // `setupHome` parameter the rewind spec receives.
      let homeDir = ''
      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
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

      try {
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

        // With no terminal/tab already open, picking a provider from the
        // very first (whole-screen) pane picker asks for a starting
        // directory FIRST (`src/components/panes/DirectoryPicker.tsx`) --
        // this is the REAL UI path that gives the pane its cwd.
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

        // Real sidecar round trip must settle before proceeding.
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')

        const attachmentsDir = path.join(homeDir, '.freshell', 'attachments')
        const fileInput = paneRoot.locator('input[type="file"]')
        const list = paneRoot.getByRole('list', { name: 'Attachments' })

        // Happy path: the upload lands on disk under a uuid-prefixed,
        // sanitized name and the chip's title shows the server-returned
        // path (the auto-retrying title assertion is the readiness gate, so
        // the spinner probe above it can never race).
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

        // Traversal attempt: the `.txt` suffix passes the client extension
        // gate (LB-6); server-side sanitization is what's under test. The
        // hostile name must be reduced to a plain basename inside the
        // attachments directory itself.
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

  test('an oversized upload shows a visible error in the composer and stores nothing', async ({ page, e2eServerKind }) => {
    test.setTimeout(90_000)
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agent11-oversize-'))
    const projectCwd = path.join(sharedRoot, 'project')
    try {
      await fs.mkdir(projectCwd, { recursive: true })

      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))
      let homeDir = ''
      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
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

      try {
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

        const attachmentsDir = path.join(homeDir, '.freshell', 'attachments')
        const fileInput = paneRoot.locator('input[type="file"]')
        const list = paneRoot.getByRole('list', { name: 'Attachments' })

        // One byte over the server's 10 MB body cap. The composer maps the
        // 413 on `res.status` (never the unparseable HTML error body), so
        // the SAME chip text renders on both server legs -- this is the
        // acceptance-grade "visible error chip for an upload failure", not
        // a silent catch.
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
