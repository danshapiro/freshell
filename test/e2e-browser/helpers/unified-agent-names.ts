import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { RustServer } from './rust-server.js'
import { TestHarness } from './test-harness.js'
import type { E2eServerInfo } from './server-fixture-support.js'
import { selectShellFromPicker } from './test-harness.js'
import { openPanePicker } from './pane-picker.js'
import type { SessionNameRef } from '../../../shared/session-names.js'

/**
 * UNIFIED AGENT NAMES (plan Task 8) — the shared six-mode journey helper.
 *
 * One OWNED real Rust server per journey (fresh isolated HOME, ephemeral
 * loopback port, deterministic fake provider fixtures wired through the
 * production env seams), creation through the REAL entry points (UI pane
 * picker / REST / CLI / MCP), native protocol fixtures on disk (claude
 * transcripts, codex rollouts, opencode SQLite rows — never Redux
 * injection standing in for an identity lifecycle), and the shared-name
 * assertion that reads the real persisted record (HTTP + Redux) and the
 * visible surfaces (pane header, tab label, sidebar row, history row).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

export type UnifiedAgentMode =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'freshclaude'
  | 'freshcodex'
  | 'freshopencode'

export const UNIFIED_AGENT_MODES: UnifiedAgentMode[] = [
  'claude',
  'codex',
  'opencode',
  'freshclaude',
  'freshcodex',
  'freshopencode',
]

export const FAKE_GEMINI_KEY = 'unified-names-fake-gemini-key'
const GEMINI_GENERATE_PATH = '/v1beta/models/gemini-3.5-flash-lite:generateContent'

export interface FakeGemini {
  baseUrl: string
  requests: Array<{ apiKey?: string; body: string }>
  close: () => Promise<void>
  hold: boolean
  release: () => void
}

export interface FakeOneCliGeminiProxy {
  /** Ephemeral fixture setting used only to configure the owned test server. */
  proxyUrl: string
  requests: Array<{
    destinationHostname: string
    path: string
    hasApiKey: boolean
    promptContainsExpectedFirstMessage: boolean
  }>
  close: () => Promise<void>
}

/** A local fake Gemini answering the Rust-only FRESHELL_GEMINI_BASE_URL seam
 * (auto-title-rust.spec.ts's pattern): deterministic short names, an
 * optional hold for the late-generation races. */
export async function startFakeGemini(replyText: string, opts?: { hold?: boolean }): Promise<FakeGemini> {
  const requests: FakeGemini['requests'] = []
  let held = opts?.hold === true
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      requests.push({
        apiKey: typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : undefined,
        body,
      })
      if (req.method === 'POST' && req.url === GEMINI_GENERATE_PATH) {
        const answer = () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: replyText }] } }] }))
        }
        if (held) {
          const timer = setInterval(() => {
            if (!held) {
              clearInterval(timer)
              answer()
            }
          }, 20)
        } else {
          answer()
        }
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta`,
    requests,
    hold: held,
    release: () => { held = false },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Local HTTP proxy with a synthetic OneCLI authorization marker. It records
 * only safe request observations; request bodies and authorization values are
 * discarded after checking the expected prompt. */
export async function startFakeOneCliGeminiProxy(
  replyText: string,
  expectedFirstMessage: string,
): Promise<FakeOneCliGeminiProxy> {
  const requests: FakeOneCliGeminiProxy['requests'] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      let destination: URL | undefined
      try {
        destination = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
      } catch {
        destination = undefined
      }
      let promptContainsExpectedFirstMessage = false
      try {
        const parsed = JSON.parse(body) as {
          contents?: Array<{ parts?: Array<{ text?: unknown }> }>
        }
        const prompt = parsed.contents?.flatMap((content) => content.parts ?? [])
          .map((part) => typeof part.text === 'string' ? part.text : '')
          .join('\n') ?? ''
        promptContainsExpectedFirstMessage = prompt.includes(expectedFirstMessage)
      } catch {
        // The observation stays false for malformed or non-JSON requests.
      }

      requests.push({
        destinationHostname: destination?.hostname.toLowerCase() ?? '',
        path: destination ? `${destination.pathname}${destination.search}` : '',
        hasApiKey: typeof req.headers['x-goog-api-key'] === 'string',
        promptContainsExpectedFirstMessage,
      })

      if (req.method === 'POST' && destination?.pathname === GEMINI_GENERATE_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: replyText }] } }] }))
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    proxyUrl: `http://%61oc_test_marker@127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// Per-mode fixture wiring
// ---------------------------------------------------------------------------

interface ModeFixture {
  /** The provider the server must enable. */
  provider: 'claude' | 'codex' | 'opencode'
  /** Extra env for the owned Rust server (receives the journey root for
   * executable fixture copies — the extension probes need a single
   * executable path, so the fixtures are copied to <root>/bin and chmodded,
   * the restore-matrix/codex-terminal-restore precedent). */
  env: (root: string) => Promise<Record<string, string>>
  /** The pane-picker button label for a UI create. */
  pickerLabel: RegExp
  /** The picker's starting-directory input label (fresh modes only). */
  fresh?: boolean
  /** The pane-picker CLI button for the terminal modes. */
  terminal?: boolean
}

/** Copy a fixture script into the journey's bin dir, chmod it executable,
 * and return the single executable path (the CLI-extension probe's shape).
 * `deps` are sibling modules the script imports (copied beside it). */
async function executableFixture(root: string, script: string, deps: string[] = []): Promise<string> {
  const binDir = path.join(root, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  const dest = path.join(binDir, path.basename(script))
  await fs.copyFile(script, dest)
  for (const dep of deps) {
    await fs.copyFile(dep, path.join(binDir, path.basename(dep)))
  }
  await fs.chmod(dest, 0o755)
  return dest
}

/** Make a shebang `#!/usr/bin/env node` fixture spawnable as a single
 * CODEX_CMD executable. The fixture imports npm packages from the repo
 * tree (`ws`), so a plain copy into the journey bin would break module
 * resolution — instead write a tiny launcher into the bin dir that imports
 * the ORIGINAL fixture in-process (the codex-dual-role wrapper's shape:
 * one direct process, the fixture's own location governs its imports). */
async function nodeWrap(root: string, script: string): Promise<string> {
  const binDir = path.join(root, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  const dest = path.join(binDir, path.basename(script, '.mjs'))
  const fileUrl = new URL(`file://${script}`).href
  await fs.writeFile(dest, `#!/usr/bin/env node\nvoid import(${JSON.stringify(fileUrl)})\n`, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

export async function modeFixture(mode: UnifiedAgentMode): Promise<ModeFixture> {
  const providers = path.join(__dirname, '..', 'fixtures', 'providers')
  const fixtures = path.join(__dirname, '..', 'fixtures')
  switch (mode) {
    case 'claude':
      return {
        provider: 'claude',
        terminal: true,
        pickerLabel: /^Claude CLI$/,
        env: async (root) => ({
          CLAUDE_CMD: await executableFixture(root, path.join(providers, 'fake-claude.mjs'), [
            path.join(providers, 'terminal-cli.mjs'),
            path.join(providers, 'fixture-core.mjs'),
          ]),
        }),
      }
    case 'codex':
      return {
        provider: 'codex',
        terminal: true,
        pickerLabel: /^Codex CLI$/,
        env: async (root) => ({
          CODEX_CMD: await executableFixture(root, path.join(fixtures, 'fake-codex-terminal.mjs')),
          FRESHELL_CODEX_MANAGED_LAUNCH: '0',
        }),
      }
    case 'opencode':
      return {
        provider: 'opencode',
        terminal: true,
        pickerLabel: /^OpenCode$/,
        env: async (root) => ({
          OPENCODE_CMD: await executableFixture(root, path.join(fixtures, 'fake-opencode-terminal.mjs')),
        }),
      }
    case 'freshclaude':
      return {
        provider: 'claude',
        fresh: true,
        pickerLabel: /^Freshclaude$/,
        env: async () => ({
          FRESHELL_CLAUDE_SIDECAR: path.join(providers, 'fake-claude-sdk-sidecar.mjs'),
          FRESHELL_CLAUDE_NODE: process.execPath,
          FRESHELL_FAKE_PROVIDER: 'freshclaude',
        }),
      }
    case 'freshcodex':
      return {
        provider: 'codex',
        fresh: true,
        pickerLabel: /^Freshcodex$/,
        env: async (root) => ({
          CODEX_CMD: await nodeWrap(root, path.join(providers, 'fake-codex-app-server.mjs')),
          FAKE_CODEX_DEFER_ROLLOUT: '1',
        }),
      }
    case 'freshopencode':
      return {
        provider: 'opencode',
        fresh: true,
        pickerLabel: /^Freshopencode$/,
        env: async (root) => ({
          OPENCODE_CMD: await executableFixture(root, path.join(fixtures, 'fake-opencode.cjs')),
        }),
      }
  }
}

// ---------------------------------------------------------------------------
// The owned server
// ---------------------------------------------------------------------------

export interface BootUnifiedNamesOptions {
  mode?: UnifiedAgentMode
  /** Boot with the fake Gemini and a seeded key (generation cases). */
  gemini?: FakeGemini | null
  /** Extra setupHome work (e.g. seeding a second session). */
  setupHome?: (homeDir: string) => Promise<void>
  /** Extra env overlaid on the mode's fixture wiring. */
  env?: Record<string, string>
  /** A pre-chosen port (restart specs reuse it). */
  port?: number
  /** A pre-owned home dir (restart specs keep one home across restarts). */
  homeDir?: string
}

export interface UnifiedNamesServer {
  server: RustServer
  info: E2eServerInfo
  mode?: UnifiedAgentMode
  projectDir: string
  root: string
  stop: () => Promise<void>
}

export async function bootUnifiedNamesServer(opts: BootUnifiedNamesOptions = {}): Promise<UnifiedNamesServer> {
  const debugHome = process.env.FRESHELL_UNIFIED_DEBUG_HOME === '1'
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-unified-debug-home-'))
    : undefined
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-unified-names-'))
  try {
    const projectDir = path.join(root, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const env: Record<string, string> = {
      GOOGLE_GENERATIVE_AI_API_KEY: '',
      ...(opts.gemini ? { FRESHELL_GEMINI_BASE_URL: opts.gemini.baseUrl } : {}),
      ...(opts.env ?? {}),
    }
    let enabledProviders: string[] = []
    if (opts.mode) {
      const fixture = await modeFixture(opts.mode)
      enabledProviders = [fixture.provider]
      Object.assign(env, await fixture.env(root))
    }
    const server = new RustServer({
      port: opts.port,
      homeDir: opts.homeDir ?? debugHome,
      preserveHomeOnStop: Boolean(opts.homeDir) || Boolean(debugHome),
      verbose: process.env.FRESHELL_E2E_SERVER_VERBOSE === '1',
      env,
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        // The provider session roots a real machine has after ANY prior CLI
        // use. The session watcher arms inotify on EXISTING roots at startup;
        // an absent root is only re-checked every 60s (REARM_INTERVAL_SECS),
        // which would delay every fixture's first transcript discovery —
        // and with it the naming lanes' arming — past the journeys' bounded
        // windows. Pre-creating the roots is the realistic steady state,
        // not a shortcut: freshell on a used machine always finds these.
        await fs.mkdir(path.join(homeDir, '.claude', 'projects'), { recursive: true })
        await fs.mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true })
        const opencodeHome = path.join(homeDir, '.local', 'share', 'opencode')
        await fs.mkdir(opencodeHome, { recursive: true })
        // An empty SCHEMA'd opencode.db (a machine where opencode ran
        // before freshell): the watcher arms on the existing db file, so a
        // fixture's first write lands as an inotify modify — not a
        // post-boot file creation the index never refreshes. Same schema
        // as the fixtures' ensureSchema (fake-opencode.cjs's exact shape).
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(path.join(opencodeHome, 'opencode.db'))
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS project (id text PRIMARY KEY, worktree text);
            CREATE TABLE IF NOT EXISTS session (
              id text PRIMARY KEY, project_id text NOT NULL, workspace_id text,
              parent_id text, slug text NOT NULL, directory text NOT NULL, path text,
              title text NOT NULL, version text NOT NULL, share_url text,
              summary_additions integer, summary_deletions integer, summary_files integer,
              summary_diffs text, metadata text, cost real NOT NULL DEFAULT 0,
              tokens_input integer NOT NULL DEFAULT 0, tokens_output integer NOT NULL DEFAULT 0,
              tokens_reasoning integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0,
              tokens_cache_write integer NOT NULL DEFAULT 0, revert text, permission text,
              agent text, model text NOT NULL, time_created integer NOT NULL,
              time_updated integer NOT NULL, time_compacting integer, time_archived integer
            );
            CREATE TABLE IF NOT EXISTS message (
              id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
              time_updated integer NOT NULL, data text NOT NULL
            );
            CREATE TABLE IF NOT EXISTS part (
              id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
              time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
            );
            CREATE TABLE IF NOT EXISTS message_seq (session_id text PRIMARY KEY, next integer NOT NULL);
          `)
        } finally {
          db.close()
        }
        const configPath = path.join(freshellDir, 'config.json')
        const configExists = await fs.access(configPath).then(() => true, () => false)
        if (!configExists) {
          await fs.writeFile(configPath, JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders },
              freshAgent: { enabled: true },
              ...(opts.gemini ? { ai: { geminiApiKey: FAKE_GEMINI_KEY } } : {}),
            },
          }, null, 2))
        }
        await opts.setupHome?.(homeDir)
      },
    })
    const info = await server.start()
    return {
      server,
      info,
      mode: opts.mode,
      projectDir,
      root,
      stop: async () => {
        await server.stop().catch(() => {})
        if (!opts.homeDir) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

// ---------------------------------------------------------------------------
// Page boot / pane plumbing
// ---------------------------------------------------------------------------

/** Boot a fresh page against the owned server (the freshellPage fixture's
 * chain, spec-owned so a spec can hold several browsers). */
export async function connectUnifiedPage(
  opts: {
    browser: import('@playwright/test').Browser
    info: E2eServerInfo
    /** A caller-provided context (e.g. the mobile viewport context): the
     * machine registration + storage seeding still runs against it, but no
     * new context is created. */
    context?: import('@playwright/test').BrowserContext
    /** Skip the picker bootstrap (the setAvailableClis stamp + shell
     * select): a page that will not create terminals (e.g. the mobile
     * history sheet) never needs it, and the shell's xterm does not render
     * under the mobile layout. */
    skipPicker?: boolean
  },
): Promise<{ context: import('@playwright/test').BrowserContext; page: Page; harness: TestHarness }> {
  const machine = await fetch(`${opts.info.baseUrl}/api/machines`, {
    method: 'POST',
    headers: { 'x-auth-token': opts.info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ label: `unified-names-${Date.now()}` }),
  })
  if (!machine.ok) throw new Error(`machine registration failed: ${machine.status}`)
  const machineBody = await machine.json() as { machine: { id: string } }
  const { STORAGE_VERSION_KEY, STORAGE_VERSION, MACHINE_ID_STORAGE_KEY } = await import('../../../src/store/storage-keys.js')
  const context = opts.context ?? await opts.browser.newContext()
  await context.addInitScript(({ machineKey, machineId, serverOrigin, versionKey, version }) => {
    if (window.location.origin !== serverOrigin) return
    localStorage.setItem(versionKey, String(version))
    localStorage.setItem(machineKey, machineId)
  }, {
    machineKey: MACHINE_ID_STORAGE_KEY,
    machineId: machineBody.machine.id,
    serverOrigin: new URL(opts.info.baseUrl).origin,
    versionKey: STORAGE_VERSION_KEY,
    version: STORAGE_VERSION,
  })
  const page = await context.newPage()
  await page.goto(`${opts.info.baseUrl}/?token=${opts.info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  // The pane picker filters its CLI/fresh options on `availableClis`, which
  // the server derives from `which <cmd>` probes of CLAUDE_CMD/CODEX_CMD/
  // OPENCODE_CMD. The freshclaude runtime is SIDECAR-driven (no CLAUDE_CMD
  // exists), and the cloud container has none of the real CLIs on PATH —
  // so every cloud-running fresh-agent spec (fresh-agent-control-rust's
  // `enableClis` donor) stamps the map client-side after the bootstrap's
  // own fetch settles. The picker still gates on enabledProviders (seeded
  // per-mode), so the map only un-hides the mode's own runtime.
  if (!opts.skipPicker) {
    await page.evaluate((payload) => {
      ;(window as unknown as { __FRESHELL_TEST_HARNESS__?: { dispatch: (action: unknown) => void } })
        .__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'connection/setAvailableClis',
        payload,
      })
    }, { claude: true, codex: true, opencode: true })
  }
  if (!opts.skipPicker) {
    await selectShellFromPicker(page)
  }
  return { context, page, harness }
}

// ---------------------------------------------------------------------------
// The six-mode create
// ---------------------------------------------------------------------------

export interface CreateNamedAgentOptions {
  entry: 'ui' | 'rest' | 'cli' | 'mcp'
  name?: string
  nameIntent?: 'user' | 'automatic'
  firstMessage?: string
  resumeRef?: SessionNameRef
  deferMaterialization?: boolean
  /** The real surfaces the entries need (page + owned server). */
  page: Page
  server: UnifiedNamesServer
  /** Explicit cwd (defaults to the server's project dir). */
  cwd?: string
  /** Create into an existing tab instead of a fresh one (splits). */
  tabId?: string
}

export interface NamedAgentHandle {
  tabId: string
  paneId: string
  nameRef: SessionNameRef | null
  terminalId?: string
  sessionId?: string
}

/** The fresh-agent placeholder session ids (the pre-materialization
 * `fresh<type>-<createRequestId>` shape the pane content carries until the
 * provider identity lands — NOT a naming target, only its pending handle or
 * the later durable id is). */
export function isFreshPlaceholderSessionId(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string'
    && (sessionId.startsWith('freshclaude-')
      || sessionId.startsWith('freshcodex-')
      || sessionId.startsWith('freshopencode-')
      || sessionId.startsWith('kilroy-'))
}

/** Re-read the pane's live content and refresh the handle's naming identity
 * (a codex/opencode terminal pane carries no client-visible identity until
 * the first input materializes and associates the durable session, and a
 * fresh pane's content first carries only the PLACEHOLDER session id —
 * poll bounded until a real naming identity lands, then return it). */
export async function refreshHandle(
  harness: TestHarness,
  handle: NamedAgentHandle,
  mode: UnifiedAgentMode,
  timeoutMs = 45_000,
): Promise<NamedAgentHandle> {
  const readOnce = async (): Promise<NamedAgentHandle> => {
    const layout = await harness.getPaneLayout(handle.tabId)
    const content = (layout?.content ?? null) as Record<string, unknown> | null
    if (!content) return handle
    const sessionRef = content.sessionRef as { provider?: string; sessionId?: string } | undefined
    const rawSessionId = sessionRef?.sessionId ?? (typeof content.sessionId === 'string' ? content.sessionId : undefined)
    const sessionUsable = rawSessionId !== undefined && !isFreshPlaceholderSessionId(rawSessionId)
    const sessionId = sessionUsable ? rawSessionId : undefined
    const nameRef = (content.nameRef
      ?? (typeof content.namingHandle === 'string' ? { kind: 'pending', id: content.namingHandle } : null)
      ?? (sessionId && sessionRef?.provider
        ? { kind: 'session', provider: sessionRef.provider, sessionId }
        : null)) as SessionNameRef | null
    return {
      ...handle,
      nameRef,
      // A placeholder read NEVER keeps the previous handle's id: the stale
      // placeholder would short-circuit every later resolveSessionId.
      sessionId,
      terminalId: handle.terminalId,
    }
  }
  // The identity is RESOLVED only when a durable session id or a
  // session-kind ref answers — a pending ref alone means the
  // materialization bind is still in flight (freshopencode's shared
  // sidecar materializes ~1s after the send), so the poll CONTINUES
  // through the pending window instead of exiting on the first read.
  const isResolved = (candidate: NamedAgentHandle): boolean =>
    Boolean(candidate.sessionId) || candidate.nameRef?.kind === 'session'
  const first = await readOnce()
  if (isResolved(first)) return first
  const deadline = Date.now() + timeoutMs
  let latest = first
  while (!isResolved(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    latest = await readOnce()
  }
  return latest
}

async function waitForTerminalId(harness: TestHarness, tabId: string, timeoutMs = 30_000): Promise<string | undefined> {
  try {
    await expect.poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      return layout?.content?.kind === 'terminal' ? (layout.content.terminalId ?? null) : null
    }, { timeout: timeoutMs }).not.toBeNull()
    const layout = await harness.getPaneLayout(tabId)
    return layout?.content?.terminalId as string | undefined
  } catch {
    return undefined
  }
}

/** Drive the user's FIRST message through the real surface: the fresh
 * composer for fresh modes, the terminal PTY (type + Enter) for the CLI
 * modes — the input that materializes the durable session and feeds the
 * naming lanes. */
export async function sendFirstMessage(
  page: Page,
  harness: TestHarness,
  handle: NamedAgentHandle,
  mode: UnifiedAgentMode,
  text: string,
): Promise<void> {
  const fixture = await modeFixture(mode)
  if (fixture.fresh) {
    // Scope to the HANDLE'S pane: a tab can hold MULTIPLE fresh panes (a
    // split), and an unscoped ".last()" composer can deliver the text to
    // the wrong session.
    const paneRoot = page.locator(`[data-pane-id="${handle.paneId}"] [data-context="fresh-agent"], [data-pane-id="${handle.paneId}"][data-context="fresh-agent"]`).first()
    const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
    await composer.fill(text)
    await paneRoot.getByRole('button', { name: 'Send' }).click()
    return
  }
  // Terminal modes: the pane's own PTY. The create already spawned the fake
  // CLI; typing into the visible terminal delivers the first prompt.
  const terminal = page.locator(`[data-pane-id="${handle.paneId}"] .xterm`).first()
  if (!(await terminal.isVisible().catch(() => false))) {
    await page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`).click()
  }
  await terminal.click()
  await page.keyboard.type(text, { delay: 10 })
  await page.keyboard.press('Enter')
}

async function createThroughUi(options: CreateNamedAgentOptions, fixture: ModeFixture): Promise<NamedAgentHandle> {
  const { page, harness, server } = options
  const cwd = options.cwd ?? server.projectDir
  if (!options.tabId) {
    // A NEW tab whose FIRST content is the agent — the session-owned-tab
    // journey (a picker-split into the boot shell would make a mixed,
    // legacy-named tab instead).
    const addButton = page.locator('[data-context="tab-add"]')
    if (await addButton.isVisible().catch(() => false)) {
      const before = await harness.getTabCount()
      await addButton.click()
      await harness.waitForTabCount(before + 1)
    }
  }
  const collectLeafIds = (node: unknown, acc: string[] = []): string[] => {
    if (!node || typeof node !== 'object') return acc
    const n = node as { type?: string; id?: string; children?: unknown[] }
    if (n.type === 'leaf' && n.id) acc.push(n.id)
    for (const child of n.children ?? []) collectLeafIds(child, acc)
    return acc
  }
  const preExistingLeafIds = new Set(options.tabId
    ? collectLeafIds(await harness.getPaneLayout(options.tabId))
    : [])
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: fixture.pickerLabel }).click({ force: true })
  // Both fresh agents AND CLI options ask for the starting directory (the
  // CLI picker's combobox step — codex-terminal-restore's precedent).
  {
    const label = fixture.pickerLabel.source.replace('^', '').replace('$', '')
    const directoryInput = page.getByRole('combobox', { name: new RegExp(`Starting directory for ${label}`, 'i') })
    // The CLI/fresh picker step appears asynchronously after the option
    // click — wait bounded, then submit the directory.
    try {
      await directoryInput.waitFor({ state: 'visible', timeout: 10_000 })
      await directoryInput.fill(cwd)
      await directoryInput.press('Enter')
    } catch {
      // A picker variant without the directory step: the pane is already
      // being created.
    }
  }
  if (fixture.fresh) {
    await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 20_000 })
  } else {
    await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 20_000 })
  }
  const tabId = (await harness.getActiveTabId())!
  expect(tabId).toBeTruthy()
  // The pane's naming identity: read the CLIENT's pane content (the
  // authoritative pane state, no layout-sync race) — poll until the create
  // frame lands the naming identity (freshAgent.created/terminal.created
  // carry it; the pane exists before the frame folds). The layout may be a
  // SPLIT tree (an agent split into an existing tab) — walk to the
  // expected-kind leaf instead of assuming the tab is a lone pane.
  const expectedKind = fixture.fresh ? 'fresh-agent' : 'terminal'
  const collectLeaves = (node: unknown, acc: Array<{ id: string; content: Record<string, unknown> }> = []): Array<{ id: string; content: Record<string, unknown> }> => {
    if (!node || typeof node !== 'object') return acc
    const n = node as { type?: string; id?: string; content?: Record<string, unknown>; children?: unknown[] }
    if (n.type === 'leaf' && n.content && n.content.kind === expectedKind && n.id) {
      acc.push({ id: n.id, content: n.content })
    }
    for (const child of n.children ?? []) collectLeaves(child, acc)
    return acc
  }
  const findLeaf = async (): Promise<{ id: string; content: Record<string, unknown> } | null> => {
    const leaves = collectLeaves(await harness.getPaneLayout(tabId))
    // A split into a tab that already holds a same-kind pane must find
    // the NEW pane, not the pre-existing first match. NEVER fall back to a
    // pre-existing leaf: the pane may be mounted client-side while the
    // server's mirrored layout still lags (the layout mirror flush), and
    // binding the handle to the OLD pane silently retargets the whole
    // journey — its message lands in the old runtime and every record
    // read asserts the wrong session (observed as the swap-source case's
    // load-dependent bRecord failure). With no pre-existing leaves the
    // lone-pane journey's first leaf IS the new pane.
    const fresh = leaves.find((candidate) => !preExistingLeafIds.has(candidate.id))
    return fresh ?? (preExistingLeafIds.size === 0 ? leaves[0] : null)
  }
  let leaf: { id: string; content: Record<string, unknown> } | null = null
  let content: Record<string, unknown> | null = null
  let nameRef: SessionNameRef | null = null
  for (let attempt = 0; attempt < 150 && !nameRef; attempt++) {
    leaf = await findLeaf()
    content = leaf?.content ?? null
    if (content) {
      const createdAck = fixture.fresh ? content.status !== 'creating' : true
      const foldedRef = content.nameRef ?? null
      if (foldedRef && createdAck) {
        nameRef = foldedRef as SessionNameRef
      } else if (createdAck && typeof content.namingHandle === 'string' && content.namingHandle) {
        nameRef = { kind: 'pending', id: content.namingHandle }
      }
    }
    if (nameRef) break
    await page.waitForTimeout(150)
  }
  if (!leaf) {
    throw new Error(`the ${mode} pane never appeared in tab ${tabId}`)
  }
  content = leaf.content
  if (!nameRef) {
    // A codex/opencode terminal pane carries no client-visible naming
    // identity until its first input materializes the durable session —
    // the handle's identity is refreshed after materialization.
    const layoutContent = content as Record<string, unknown> | null
    const sessionRef = layoutContent?.sessionRef as { provider?: string; sessionId?: string } | undefined
    const fallback = sessionRef?.sessionId
      ? { kind: 'session', provider: sessionRef.provider ?? fixture.provider, sessionId: sessionRef.sessionId } as SessionNameRef
      : null
    if (!fallback) {
      return {
        tabId,
        paneId: leaf.id,
        nameRef: null,
        terminalId: fixture.terminal ? await waitForTerminalId(harness, tabId) : undefined,
        sessionId: undefined,
      }
    }
    nameRef = fallback
  }
  const paneId = leaf.id
  const terminalId = fixture.terminal ? await waitForTerminalId(harness, tabId) : undefined
  return {
    tabId,
    paneId,
    nameRef,
    terminalId,
    sessionId: typeof content.sessionRef === 'object' && content.sessionRef
      ? (content.sessionRef as { sessionId?: string }).sessionId
      : (typeof content.sessionId === 'string' ? content.sessionId : undefined),
  }
}

/** Read the pane content's naming identity from the server's layout
 * snapshot — the REST/CLI/MCP create answers tab/pane ids, and the
 * server-side paneContent carries the authoritative `nameRef` (or the
 * pre-durable `namingHandle`). */
/** The pane's full content object from the server's layout snapshot, or
 * null when the pane is absent — the server-authoritative view of what the
 * pane carries (the naming identity, the createRequestId — everything the
 * real client's pane mount reads). */
export async function paneContentFromLayoutSnapshot(
  server: UnifiedNamesServer,
  tabId: string,
  paneId: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${server.info.baseUrl}/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`, {
    headers: { 'x-auth-token': server.info.token },
  })
  if (!response.ok) throw new Error(`layout snapshot failed: ${response.status}`)
  const payload = await response.json() as { data?: { layouts?: Record<string, unknown> } }
  const findContent = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object') return null
    const candidate = node as Record<string, unknown>
    if (candidate.id === paneId && candidate.content && typeof candidate.content === 'object') {
      return candidate.content as Record<string, unknown>
    }
    if (Array.isArray(candidate.children)) {
      for (const child of candidate.children) {
        const found = findContent(child)
        if (found) return found
      }
    }
    return null
  }
  for (const layout of Object.values(payload.data?.layouts ?? {})) {
    const content = findContent(layout)
    if (content) return content
  }
  return null
}

async function nameRefFromLayoutSnapshot(
  server: UnifiedNamesServer,
  tabId: string,
  paneId: string,
): Promise<SessionNameRef> {
  const content = await paneContentFromLayoutSnapshot(server, tabId, paneId)
  if (content) {
    if (content.nameRef && typeof content.nameRef === 'object') {
      return content.nameRef as SessionNameRef
    }
    if (typeof content.namingHandle === 'string') {
      return { kind: 'pending', id: content.namingHandle }
    }
  }
  throw new Error(`the layout snapshot carries no naming identity for pane ${paneId}`)
}

async function createThroughRest(options: CreateNamedAgentOptions, fixture: ModeFixture): Promise<NamedAgentHandle> {
  const { server } = options
  const cwd = options.cwd ?? server.projectDir
  const body: Record<string, unknown> = { cwd, ...(options.name ? { name: options.name } : {}) }
  if (fixture.fresh) {
    if (fixture.provider !== 'opencode') {
      throw new Error(`REST creation is not a supported entry for fresh ${fixture.provider} panes (the agent API maps only opencode)`)
    }
    Object.assign(body, { agent: 'opencode' })
  } else {
    Object.assign(body, { mode: fixture.provider })
  }
  const response = await fetch(`${server.info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`REST create failed: ${response.status} ${await response.text()}`)
  const payload = await response.json() as { data: { tabId: string; paneId: string; sessionId?: string; terminalId?: string } }
  return {
    tabId: payload.data.tabId,
    paneId: payload.data.paneId,
    nameRef: await nameRefFromLayoutSnapshot(server, payload.data.tabId, payload.data.paneId),
    terminalId: payload.data.terminalId,
    sessionId: payload.data.sessionId,
  }
}

/** The plan's `createNamedAgent`: create one scoped agent session through
 * the requested REAL entry point and answer its naming identity. */
export async function createNamedAgent(
  harness: TestHarness,
  mode: UnifiedAgentMode,
  options: CreateNamedAgentOptions,
): Promise<NamedAgentHandle> {
  const fixture = await modeFixture(mode)
  const withHarness = { ...options, harness }
  switch (options.entry) {
    case 'ui':
      return createThroughUi(withHarness, fixture)
    case 'rest':
      return createThroughRest(withHarness, fixture)
    case 'cli':
    case 'mcp': {
      // The standalone clients (freshell CLI / MCP stdio) speak the same
      // REST agent API through their own entry processes: the CLI shells out
      // to dist/tools/freshell-cli, the MCP path drives the stdio server.
      const cwd = options.cwd ?? options.server.projectDir
      const body: Record<string, unknown> = { cwd, ...(options.name ? { name: options.name } : {}) }
      if (fixture.fresh) {
        if (fixture.provider !== 'opencode') {
          throw new Error(`the ${options.entry} entry cannot create fresh ${fixture.provider} panes (the agent API maps only opencode)`)
        }
        Object.assign(body, { agent: 'opencode' })
      } else {
        Object.assign(body, { mode: fixture.provider })
      }
      let tabId = ''
      let paneId = ''
      let terminalId: string | undefined
      if (options.entry === 'cli') {
        const { spawn } = await import('node:child_process')
        const cliBin = path.join(REPO_ROOT, 'dist', 'tools', 'freshell-cli', 'index.js')
        const flags = ['--cwd', String(body.cwd)]
        if (body.mode) flags.push('--mode', String(body.mode))
        if (body.agent) flags.push('--agent', String(body.agent))
        if (options.name) flags.push('--name', options.name)
        const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [cliBin, 'new-tab', ...flags], {
            env: { ...process.env, FRESHELL_URL: options.server.info.baseUrl, FRESHELL_TOKEN: options.server.info.token },
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
        if (run.code !== 0) throw new Error(`CLI new-tab failed (${run.code}): ${run.stderr || run.stdout}`)
        const payload = JSON.parse(extractJson(run.stdout)) as { data: { tabId: string; paneId: string; terminalId?: string } }
        tabId = payload.data.tabId
        paneId = payload.data.paneId
        terminalId = payload.data.terminalId
      } else {
        const { McpStdioClient, mcpServerBinPath } = await import('./mcp-stdio-client.js')
        const client = new McpStdioClient({
          command: process.execPath,
          args: [mcpServerBinPath()],
          env: {
            ...process.env,
            FRESHELL_URL: options.server.info.baseUrl,
            FRESHELL_TOKEN: options.server.info.token,
          },
        })
        await client.initialize()
        try {
          const created = await client.callFreshellAction('new-tab', body)
          if (created?.status !== 'ok') {
            throw new Error(`MCP new-tab failed: ${JSON.stringify(created)}`)
          }
          tabId = created.data.tabId
          paneId = created.data.paneId
          terminalId = created.data.terminalId
        } finally {
          await client.close()
        }
      }
      return {
        tabId,
        paneId,
        nameRef: await nameRefFromLayoutSnapshot(options.server, tabId, paneId),
        terminalId,
      }
    }
  }
}

function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error(`no JSON in CLI output: ${text}`)
  return text.slice(start, end + 1)
}

// ---------------------------------------------------------------------------
// The shared-name assertion
// ---------------------------------------------------------------------------

export interface ExpectSharedNameOptions {
  page: Page
  server: UnifiedNamesServer
  surfaces?: Array<'pane' | 'tab' | 'sidebar' | 'history' | 'http' | 'redux'>
  tabId?: string
  paneId?: string
  sessionId?: string
}

function refKey(ref: SessionNameRef): string {
  return ref.kind === 'pending'
    ? JSON.stringify(['pending', ref.id])
    : JSON.stringify(['session', ref.provider, ref.sessionId])
}

async function resolveDurableSessionId(
  handle: { sessionId?: string; nameRef: SessionNameRef },
  server: UnifiedNamesServer,
): Promise<string | null> {
  if (handle.nameRef.kind === 'session') return handle.nameRef.sessionId
  if (handle.sessionId) return handle.sessionId
  // A pending ref resolves through the store's redirect after materialize.
  const response = await fetch(`${server.info.baseUrl}/api/session-names/read`, {
    method: 'POST',
    headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ refs: [handle.nameRef] }),
  })
  if (!response.ok) return null
  const payload = await response.json() as { names: Array<{ record: { ref: SessionNameRef }; redirects: Array<{ to: SessionNameRef }> }> }
  const update = payload.names[0]
  if (!update) return null
  const recordRef = update.record.ref
  if (recordRef.kind === 'session') return recordRef.sessionId
  const redirect = update.redirects?.find((r) => r.to.kind === 'session')
  return redirect ? (redirect.to as { sessionId: string }).sessionId : null
}

/** The plan's `expectSharedName`: the ONE saved name is the real persisted
 * record (HTTP read + Redux cache) AND every visible surface — pane header,
 * tab label, sidebar row, and the history row (when the session is indexed). */
export async function expectSharedName(
  harness: TestHarness,
  nameRef: SessionNameRef,
  expected: string,
  options?: ExpectSharedNameOptions & { handle?: NamedAgentHandle },
): Promise<void> {
  if (!options?.page || !options?.server) {
    throw new Error('expectSharedName needs the page + server context (the surfaces it asserts are real)')
  }
  const { page, server } = options
  const surfaces = options.surfaces ?? ['http', 'redux', 'pane', 'tab', 'sidebar']

  // (1) The persisted authority: the canonical read route (poll — the
  // materialization bind and the generated name are server-async). The
  // intervals stay ≥500ms: the read route shares the API rate limiter
  // (300-token bucket, 5/sec refill) with the app's own traffic, and a
  // default-interval poll (100ms) drains it mid-journey. The 60s window is
  // the CLOUD container's observed slow tail for the materialization bind
  // (the auto-title sweep's hydration can index the transcript well before
  // the naming tick's verified bind merges the pending record — locally the
  // same convergence takes seconds, the container's cold fs showed >30s
  // once).
  if (surfaces.includes('http')) {
    await expect.poll(async () => {
      const response = await fetch(`${server.info.baseUrl}/api/session-names/read`, {
        method: 'POST',
        headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
        body: JSON.stringify({ refs: [nameRef] }),
      })
      if (!response.ok) return null
      const payload = await response.json() as { names: Array<{ record: { name: string } }> }
      return payload.names[0]?.record.name ?? null
    }, { timeout: 120_000, intervals: [500, 1_000, 2_000] }).toBe(expected)
  }

  // (2) The client's canonical cache (Redux). The entry is keyed by the
  // ref's RESOLVED key — the client folds pending→durable redirects, so a
  // pre-durable handle that materialized reads through the redirect chain
  // exactly like the real selectors (resolveRefKey's 8-hop walk).
  if (surfaces.includes('redux')) {
    await expect.poll(async () => {
      const state = await harness.getState()
      const cache = state?.sessionNames
      if (!cache?.records) return null
      let key = refKey(nameRef)
      for (let hops = 0; hops < 8; hops += 1) {
        const redirect = cache.redirects?.[key]
        if (!redirect) break
        key = redirect.toKey
      }
      return cache.records[key]?.name ?? null
    }, { timeout: 15_000, intervals: [500, 1_000, 2_000] }).toBe(expected)
  }

  // (3) The pane header.
  if (surfaces.includes('pane')) {
    await expect(
      page.locator('[data-context="pane-header"]:visible').first(),
    ).toContainText(expected, { timeout: 15_000 })
  }

  // (4) The tab label.
  if (surfaces.includes('tab') && options.tabId) {
    await expect(
      page.locator(`[data-context="tab"][data-tab-id="${options.tabId}"]`),
    ).toContainText(expected, { timeout: 15_000 })
  }

  // (5) The sidebar row (the session's directory entry).
  if (surfaces.includes('sidebar')) {
    const sessionId = await resolveDurableSessionId(
      { sessionId: options.sessionId, nameRef },
      server,
    )
    if (sessionId) {
      await expect(
        page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`),
      ).toContainText(expected, { timeout: 20_000 })
    }
  }

  // (6) The history (Projects) row — the unloaded-history-page convergence.
  // Project groups start collapsed (`expandedProjects: new Set()`), so the
  // project header is clicked first (the reveal title-sync-convergence
  // documents).
  if (surfaces.includes('history')) {
    const sessionId = await resolveDurableSessionId(
      { sessionId: options.sessionId, nameRef },
      server,
    )
    if (sessionId) {
      const row = page.locator(`[data-context="history-session"][data-session-id="${sessionId}"]`)
      if (!(await row.isVisible().catch(() => false))) {
        await page.getByTitle('Projects (Ctrl+B P)').click()
        const projectHeader = page.locator(`[data-context="history-project"][data-project-path="${server.projectDir}"]`)
        await expect(projectHeader).toBeVisible({ timeout: 15_000 })
        await projectHeader.click()
      }
      await expect(row).toContainText(expected, { timeout: 20_000 })
      await page.getByTitle('Coding Agents (Ctrl+B T)').click()
    }
  }
}

// ---------------------------------------------------------------------------
// Rename entries
// ---------------------------------------------------------------------------

/** Rename through the pane-header inline editor (dblclick + type + Enter). */
/** The resubmit backoffs shared by every UI rename verb: a 409 (stale
 * captured revision) or a transient 429 means the shared API rate bucket
 * is drained (the journey's own pollers + the app's traffic on the
 * container's 2 vCPU empty it faster than the 5/sec refill) — short
 * fixed backsteps lose the refilled tokens to the concurrent pollers, so
 * the resubmits are exponential and patient. */
const RENAME_RESUBMIT_BACKOFFS = [1_000, 2_000, 4_000, 8_000, 16_000, 16_000, 16_000]

/** Bound every rename-verb locator action explicitly: the e2e suite
 * configures NO actionTimeout (the restore-contract-wall precedent), so
 * a blocked action — a cold-container interceptor overlay, or a header
 * still churning through its identity-remount folds — retries FOREVER
 * and turns into a silent test-ceiling hang (the observed 600s cold
 * attempts). A 30s bound fails loudly with the real reason instead. */
const RENAME_ACTION_TIMEOUT = 30_000

/** The pane-header inline editor's commit discipline (shared by the
 * dblclick and the context-menu entries): a 409/429 keeps the editor
 * open — the conflict folds and REFRESHES the capture, and the user's
 * resubmit from the still-open editor is the documented path. Without it,
 * a materialize-time retarget (the freshcodex thread id resolves at
 * create — the revision bumps INSIDE the edit window under the
 * container's slower broadcast cadence) silently eats the rename and the
 * journey reads a fallback name 120s later. The conflict fold re-seeds
 * the editor with the accepted text, so refill OUR name each resubmit.
 * The editor closing is the product's success signal; the folded header
 * title is the honest commit gate (a lost rename fails HERE, not at a
 * downstream record read). */
async function commitPaneRenameEditor(page: Page, name: string): Promise<void> {
  const input = page.getByLabel('Rename pane')
  const header = page.locator('[data-context="pane-header"]:visible').first()
  // An open editor with NO shown error is an IN-FLIGHT commit (the
  // mirror-ready probe + the rename POST take seconds on the cold
  // container) — resubmitting mid-flight fights a healthy request
  // through the header's reconciliation churn. Resubmit ONLY on the
  // shown error state (the 409 conflict fold and the 429 refusal both
  // set aria-invalid), letting the in-flight window elapse first.
  for (const backoff of RENAME_RESUBMIT_BACKOFFS) {
    await page.waitForTimeout(backoff)
    if (!(await input.isVisible().catch(() => false))) break
    const errored = await input.getAttribute('aria-invalid').catch(() => null)
    if (errored !== 'true') continue
    try {
      await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
      await input.press('Enter', { timeout: RENAME_ACTION_TIMEOUT })
    } catch (error) {
      console.error(`[unified-agent-names] pane rename resubmit failed: ${String(error).slice(0, 200)}`)
    }
  }
  await expect(input).toBeHidden({ timeout: 30_000 })
  await expect(header).toContainText(name, { timeout: 10_000 })
}

export async function renameThroughPaneHeader(page: Page, name: string): Promise<void> {
  const header = page.locator('[data-context="pane-header"]:visible').first()
  // Open the editor: bounded, with retries — the cold container's
  // freshly mounted pane header churns through its identity-remount
  // folds, and a truly blocked action must fail loudly at the bound,
  // never hang the case to its ceiling (no actionTimeout is configured
  // suite-wide).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await header.dblclick({ timeout: RENAME_ACTION_TIMEOUT })
      break
    } catch (error) {
      if (attempt >= 2) throw error
      console.error(`[unified-agent-names] pane-header dblclick failed (attempt ${attempt + 1}): ${String(error).slice(0, 200)}`)
      await page.waitForTimeout(2_000)
    }
  }
  const input = page.getByLabel('Rename pane')
  // The first fill+Enter can stall through the cold container's
  // pre-durable reconciliation storm (the broadcast burst keeps the
  // header's DOM mid-reconciliation — every actionability window
  // detaches). Bounded retries: the storm settles within seconds and a
  // fresh resolution lands; an editor closed by a mid-storm remount is
  // reopened before the next attempt.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
      await input.press('Enter', { timeout: RENAME_ACTION_TIMEOUT })
      break
    } catch (error) {
      if (attempt >= 2) throw error
      console.error(`[unified-agent-names] pane rename submit failed (attempt ${attempt + 1}): ${String(error).slice(0, 200)}`)
      if (!(await input.isVisible().catch(() => false))) {
        try {
          await header.dblclick({ timeout: RENAME_ACTION_TIMEOUT })
        } catch {
          // The next loop round re-evaluates the editor state.
        }
      }
      await page.waitForTimeout(2_000)
    }
  }
  await commitPaneRenameEditor(page, name)
}

/** Rename through the tab's inline editor (dblclick + type + Enter). */
export async function renameThroughTabEdit(page: Page, tabId: string, name: string): Promise<void> {
  const tab = page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
  await tab.dblclick({ timeout: RENAME_ACTION_TIMEOUT })
  const input = tab.locator('input')
  await expect(input).toBeVisible({ timeout: 5_000 })
  await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
  await input.press('Enter', { timeout: RENAME_ACTION_TIMEOUT })
  // A 409 (stale captured revision — the naming broadcasts can land after
  // the editor opened) keeps the editor open with the conflict folded and
  // a REFRESHED capture, and a transient 429 drains the shared bucket:
  // the user's resubmit from the still-open editor is the documented
  // path (the shared pane-editor discipline).
  for (const backoff of RENAME_RESUBMIT_BACKOFFS) {
    await page.waitForTimeout(backoff)
    if (!(await input.isVisible().catch(() => false))) break
    await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
    await input.press('Enter', { timeout: RENAME_ACTION_TIMEOUT })
  }
  await expect(input).toBeHidden({ timeout: 10_000 })
  await expect(tab).toContainText(name, { timeout: 10_000 })
}

/** Rename through the sidebar context-menu Rename (window.prompt). */
export async function renameThroughSidebarMenu(page: Page, sessionId: string, name: string): Promise<void> {
  const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  const renameItem = page.getByRole('menuitem', { name: 'Rename', exact: true })
  const invoke = async (): Promise<void> => {
    page.once('dialog', (dialog) => { void dialog.accept(name) })
    await row.click({ button: 'right', timeout: RENAME_ACTION_TIMEOUT })
    await expect(renameItem).toBeVisible({ timeout: 5_000 })
    await renameItem.click({ timeout: RENAME_ACTION_TIMEOUT })
  }
  await invoke()
  // The prompt answers once; a transient 429 fails the POST silently
  // (the toast) — the user's retry re-invokes the menu. The row's title
  // is the commit gate (the sidebar row shows the canonical name).
  for (const backoff of RENAME_RESUBMIT_BACKOFFS) {
    await page.waitForTimeout(backoff)
    const text = await row.textContent().catch(() => '')
    if (text && text.includes(name)) break
    await invoke()
  }
  await expect(row).toContainText(name, { timeout: 10_000 })
}

/** Rename through the History (Projects) view's inline editor. Project
 * groups start collapsed (`expandedProjects: new Set()`), so the project
 * header is clicked first — the same reveal `title-sync-convergence`
 * documents. */
export async function renameThroughHistoryView(page: Page, sessionId: string, name: string, projectDir?: string): Promise<void> {
  await page.getByTitle('Projects (Ctrl+B P)').click()
  if (projectDir) {
    const projectHeader = page.locator(`[data-context="history-project"][data-project-path="${projectDir}"]`)
    await expect(projectHeader).toBeVisible({ timeout: 15_000 })
    await projectHeader.click()
  }
  const row = page.locator(`[data-context="history-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  const invoke = async (): Promise<void> => {
    await row.hover({ timeout: RENAME_ACTION_TIMEOUT })
    await row.getByLabel('Edit session').click({ timeout: RENAME_ACTION_TIMEOUT })
    const input = page.getByLabel('Session title')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
    await page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: RENAME_ACTION_TIMEOUT })
  }
  await invoke()
  // The history editor CLOSES on save regardless of the POST's outcome —
  // a transient 429 loses the rename with only the row's stale title to
  // show for it. The user's retry reopens the editor; the row's title is
  // the commit gate.
  for (const backoff of RENAME_RESUBMIT_BACKOFFS) {
    await page.waitForTimeout(backoff)
    const text = await row.textContent().catch(() => '')
    if (text && text.includes(name)) break
    await invoke()
  }
  await expect(row).toContainText(name, { timeout: 10_000 })
  await page.getByTitle('Coding Agents (Ctrl+B T)').click()
}

/** Rename through the pane context menu's 'Rename pane' (right-click the
 * pane header — the same captured-target inline editor the dblclick opens,
 * entered through the rendered accessible menu instead). */
export async function renameThroughPaneContextMenu(page: Page, name: string): Promise<void> {
  const header = page.locator('[data-context="pane-header"]:visible').first()
  await header.click({ button: 'right', timeout: RENAME_ACTION_TIMEOUT })
  const renameItem = page.getByRole('menuitem', { name: 'Rename pane', exact: true })
  await expect(renameItem).toBeVisible({ timeout: 5_000 })
  await renameItem.click({ timeout: RENAME_ACTION_TIMEOUT })
  const input = page.getByLabel('Rename pane')
  await expect(input).toBeVisible({ timeout: 5_000 })
  await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
  await input.press('Enter', { timeout: RENAME_ACTION_TIMEOUT })
  await commitPaneRenameEditor(page, name)
}

/** Rename through the mobile History session-details sheet. The caller
 * owns a mobile-viewport browser context (max-width: 767px, useMobile). */
export async function renameThroughMobileHistory(
  page: Page,
  sessionId: string,
  name: string,
  options?: { projectDir?: string },
): Promise<void> {
  // Mobile boots with the sidebar COLLAPSED (the MobileTabStrip's
  // "Show sidebar" toggle — mobile-viewport.spec's documented shape).
  const showSidebar = page.getByRole('button', { name: /show sidebar/i })
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click()
  }
  // Navigate to Projects via the keyboard chord — the same first-class
  // path a keyboard user has (the nav button's pointer click is not
  // reliably actionable under the mobile overlay layout).
  await page.keyboard.press('Control+b')
  await page.keyboard.press('p')
  // Project groups start collapsed (`expandedProjects: new Set()`): expand
  // the one holding the session.
  if (options?.projectDir) {
    const projectHeader = page.locator(`[data-context="history-project"][data-project-path="${options.projectDir}"]`)
    await expect(projectHeader).toBeVisible({ timeout: 15_000 })
    await projectHeader.click()
  }
  const row = page.locator(`[data-context="history-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  const sheet = page.locator('div.fixed.inset-x-0.bottom-0').last()
  await expect(sheet).toBeVisible({ timeout: 5_000 })
  const input = sheet.getByLabel('Session details title')
  await input.fill(name)
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet).toHaveCount(0, { timeout: 5_000 })
}

/** Rename through the Overview terminal card's inline editor. */
export async function renameThroughOverview(page: Page, terminalId: string, name: string): Promise<void> {
  await page.getByTitle('Panes (Ctrl+B O)').click()
  const card = page.locator(`[data-terminal-id="${terminalId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const invoke = async (): Promise<void> => {
    await card.hover({ timeout: RENAME_ACTION_TIMEOUT })
    await card.getByLabel('Edit terminal').click({ timeout: RENAME_ACTION_TIMEOUT })
    const input = page.getByLabel('Terminal title')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill(name, { timeout: RENAME_ACTION_TIMEOUT })
    await page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: RENAME_ACTION_TIMEOUT })
  }
  await invoke()
  // The overview editor closes on save regardless of the POST's outcome
  // (the history editor's shape) — a transient 429 loses the rename; the
  // user's retry reopens the editor. The card's title is the commit gate.
  for (const backoff of RENAME_RESUBMIT_BACKOFFS) {
    await page.waitForTimeout(backoff)
    const text = await card.textContent().catch(() => '')
    if (text && text.includes(name)) break
    await invoke()
  }
  await expect(card).toContainText(name, { timeout: 10_000 })
  await page.getByTitle('Coding Agents (Ctrl+B T)').click()
}

/** Rename through the canonical REST route (the automation surface). */
export async function renameThroughCanonicalApi(
  server: UnifiedNamesServer,
  target: SessionNameRef,
  name: string,
  nameIntent: 'user' | 'automatic' = 'user',
): Promise<void> {
  // The shared API rate-limit bucket can transiently 429 under parallel
  // workers — retry the bounded few times (the CLI/MCP/readUpdate
  // discipline).
  let response = await fetch(`${server.info.baseUrl}/api/session-names`, {
    method: 'PATCH',
    headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ target, name, nameIntent }),
  })
  for (let attempt = 0; attempt < 5 && response.status === 429; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    response = await fetch(`${server.info.baseUrl}/api/session-names`, {
      method: 'PATCH',
      headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ target, name, nameIntent }),
    })
  }
  expect(response.ok, `canonical rename: ${response.status} ${await response.text()}`).toBe(true)
}

/** PATCH one of the rename convenience routes with the bounded 429 retry
 * (the shared API rate-limit bucket can transiently deny under parallel
 * workers — the same discipline as readUpdate/CLI/MCP). */
async function patchRenameWith429Retry(url: string, body: unknown, token: string): Promise<Response> {
  let response = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-auth-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  for (let attempt = 0; attempt < 5 && response.status === 429; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    response = await fetch(url, {
      method: 'PATCH',
      headers: { 'x-auth-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  return response
}

/** Rename through the pane convenience route (PATCH /api/panes/:id). */
export async function renameThroughPaneRoute(
  server: UnifiedNamesServer,
  paneId: string,
  name: string,
  nameIntent: 'user' | 'automatic' = 'user',
): Promise<void> {
  const response = await patchRenameWith429Retry(`${server.info.baseUrl}/api/panes/${encodeURIComponent(paneId)}`, { name, nameIntent }, server.info.token)
  expect(response.ok).toBe(true)
  const payload = await response.json() as { data?: { tabId?: string } }
  expect(payload.data?.tabId, 'the pane rename actually applied').toBeTruthy()
}

/** Rename through the tab route (PATCH /api/tabs/:id {name}) — resolves the
 * tab's naming SOURCE session, never a tab-local label. */
export async function renameThroughTabRoute(
  server: UnifiedNamesServer,
  tabId: string,
  name: string,
  nameIntent: 'user' | 'automatic' = 'user',
): Promise<void> {
  const response = await patchRenameWith429Retry(`${server.info.baseUrl}/api/tabs/${encodeURIComponent(tabId)}`, { name, nameIntent }, server.info.token)
  expect(response.ok, await response.text()).toBe(true)
}

/** Rename through the legacy session-override route's scoped title path
 * (PATCH /api/sessions/:provider:sessionId {titleOverride}) — the old
 * ladder's entry point, routed to the ONE authority for scoped providers. */
export async function renameThroughSessionRoute(
  server: UnifiedNamesServer,
  provider: 'claude' | 'codex' | 'opencode',
  sessionId: string,
  name: string,
  nameIntent: 'user' | 'automatic' = 'user',
): Promise<void> {
  const response = await patchRenameWith429Retry(
    `${server.info.baseUrl}/api/sessions/${encodeURIComponent(`${provider}:${sessionId}`)}`,
    { titleOverride: name, nameIntent },
    server.info.token,
  )
  expect(response.ok, await response.text()).toBe(true)
}

/** Rename through the terminal route (PATCH /api/terminals/:id
 * {titleOverride}) — the terminal presentation's rename entry. */
export async function renameThroughTerminalRoute(
  server: UnifiedNamesServer,
  terminalId: string,
  name: string,
  nameIntent: 'user' | 'automatic' = 'user',
): Promise<void> {
  const response = await patchRenameWith429Retry(`${server.info.baseUrl}/api/terminals/${encodeURIComponent(terminalId)}`, { titleOverride: name, nameIntent }, server.info.token)
  expect(response.ok, await response.text()).toBe(true)
}

/** Rename through the standalone CLI verb (the automation surface's own
 * entry process). */
export async function renameThroughCli(
  server: UnifiedNamesServer,
  verb: 'rename-pane' | 'rename-tab',
  target: string,
  name: string,
): Promise<void> {
  const { spawn } = await import('node:child_process')
  const cliBin = path.join(REPO_ROOT, 'dist', 'tools', 'freshell-cli', 'index.js')
  const attempt = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, verb, '--target', target, '--name', name, '--name-intent', 'user'], {
      env: { ...process.env, FRESHELL_URL: server.info.baseUrl, FRESHELL_TOKEN: server.info.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI rename timed out')) }, 60_000)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  // The CLI verb shares the API rate-limit bucket with the journey's own
  // polls — under parallel workers a single-shot call can land 429. Retry
  // the transient denial a bounded few times (the readUpdate discipline).
  let run = await attempt()
  for (let tries = 0; tries < 5 && run.code !== 0 && /rate_limited/.test(run.stderr + run.stdout); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    run = await attempt()
  }
  expect(run.code, `CLI ${verb} failed: ${run.stderr || run.stdout}`).toBe(0)
}

/** Rename through the standalone MCP client's rename action. */
export async function renameThroughMcp(
  server: UnifiedNamesServer,
  action: 'rename-pane' | 'rename-tab',
  target: string,
  name: string,
): Promise<void> {
  const { McpStdioClient, mcpServerBinPath } = await import('./mcp-stdio-client.js')
  const attempt = async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [mcpServerBinPath()],
      env: { ...process.env, FRESHELL_URL: server.info.baseUrl, FRESHELL_TOKEN: server.info.token },
    })
    await client.initialize()
    try {
      return await client.callFreshellAction(action, { target, name, nameIntent: 'user' })
    } finally {
      await client.close()
    }
  }
  // The MCP action rides the same shared API rate-limit bucket as the
  // journey's own polls — under parallel workers a single-shot action can
  // land 429. Retry the transient denial a bounded few times (the CLI and
  // readUpdate discipline).
  let result = await attempt()
  for (let tries = 0; tries < 5 && result?.status !== 'ok' && /rate_limited/.test(JSON.stringify(result)); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 600))
    result = await attempt()
  }
  if (result?.status !== 'ok') {
    throw new Error(`MCP ${action} failed: ${JSON.stringify(result)}`)
  }
}

/** Assert the scoped context menu exposes Rename ONLY — no generate, no
 * reset-to-provider, no alias controls (rendered accessible menus). */
export async function expectRenameOnlyContextMenu(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('menuitem', { name: 'Reset to provider title' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Generate title' })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: /^Rename pane$/ })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: /rename terminal/i })).toHaveCount(0)
  await page.keyboard.press('Escape')
}
