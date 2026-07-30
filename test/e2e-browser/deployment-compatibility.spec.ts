import { test, expect, type Page } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { TestHarness } from './helpers/test-harness.js'
import { TerminalHelper } from './helpers/terminal-helpers.js'
import { declarationDigest } from '../../scripts/deployment-compatibility.mjs'

if (process.env.FRESHELL_DESTRUCTIVE_SANDBOX !== '1') {
  throw new Error(
    'deployment compatibility browser proof requires FRESHELL_DESTRUCTIVE_SANDBOX=1',
  )
}

const execFileAsync = promisify(execFile)
const testFile = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(testFile), '../..')
const captureFixture = path.join(
  repository,
  'test/fixtures/launch-rust/real-capture-parent.sh',
)
const fakeCodexFixture = path.join(
  repository,
  'test/e2e-browser/fixtures/fake-codex-cli.mjs',
)
const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

type Rig = {
  root: string
  checkout: string
  home: string
  bootstrapTarget: string
  port: number
  token: string
  baseUrl: string
  portRoot: string
  environment: NodeJS.ProcessEnv
  knownPids: Set<number>
  sentinel: ChildProcess
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture port was not assigned')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return address.port
}

async function checked(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  } = {},
) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 900_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    })
  } catch (error: any) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${error.code ?? error.signal}):\n` +
        `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    )
  }
}

async function result(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeout?: number
  } = {},
): Promise<CommandResult> {
  try {
    const completed = await execFileAsync(command, args, {
      cwd: options.cwd ?? repository,
      env: options.env ?? process.env,
      timeout: options.timeout ?? 900_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { code: 0, stdout: completed.stdout, stderr: completed.stderr }
  } catch (error: any) {
    const diagnostic = [
      `code=${String(error.code)}`,
      `signal=${String(error.signal)}`,
      `killed=${String(error.killed)}`,
      `message=${String(error.message).split('\n')[0]}`,
    ].join(' ')
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: `${error.stderr ?? ''}\n[execFile failure: ${diagnostic}]`,
    }
  }
}

async function waitForHttp(port: number, expected: 'up' | 'down', timeout = 60_000) {
  await expect(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      expect(expected === 'up' && response.status === 200).toBe(true)
    } catch {
      expect(expected).toBe('down')
    }
  }).toPass({ timeout, intervals: [50, 100, 250, 500] })
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function isRecordedProcessRunning(identity: {
  pid: number
  kernelBootId: string
  startTimeTicks: string
}) {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (commandEnd < 0) return false
    const fieldsAfterCommand = stat.slice(commandEnd + 2).split(' ')
    const state = fieldsAfterCommand[0]
    const startTimeTicks = fieldsAfterCommand[19]
    return (
      bootId === identity.kernelBootId &&
      startTimeTicks === identity.startTimeTicks &&
      state !== 'Z'
    )
  } catch {
    return false
  }
}

function copyCheckout(source: string, destination: string) {
  const omitted = new Set([
    '.git',
    '.worktrees',
    '.freshell-deploy',
    'dist',
    'node_modules',
    'target',
    'playwright-report',
    'test-results',
  ])
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !omitted.has(path.basename(entry)),
  })
  writeFileSync(path.join(destination, '.git'), 'gitdir: /tmp/task7-browser-fixture.git\n')
  symlinkSync(path.join(source, 'node_modules'), path.join(destination, 'node_modules'))
}

async function setupRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'freshell-deploy-browser-'))
  const checkout = path.join(root, 'checkout')
  const home = path.join(root, 'home')
  const bootstrapTarget = path.join(root, 'bootstrap-target')
  const legacyClient = path.join(root, 'legacy-client')
  const runtime = path.join(root, 'legacy-runtime')
  const distServer = path.join(runtime, 'dist-server')
  const sidecar = path.join(runtime, 'sidecar')
  const nodeModules = path.join(runtime, 'node_modules')
  const bin = path.join(root, 'bin')
  const pidFile = path.join(root, 'legacy.pid')
  const logFile = path.join(root, 'legacy.log')
  const token = `task7-browser-${Date.now()}-token`
  const clientMarker = `task7-browser-client-${Date.now()}`
  let port = await unusedPort()
  while (port === 3002) port = await unusedPort()

  copyCheckout(repository, checkout)
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(path.join(distServer, 'mcp'), { recursive: true })
  mkdirSync(path.join(checkout, 'dist/server/mcp'), { recursive: true })
  mkdirSync(sidecar)
  mkdirSync(nodeModules)
  copyFileSync(fakeCodexFixture, path.join(bin, 'codex'))
  chmodSync(path.join(bin, 'codex'), 0o755)
  const indexPath = path.join(checkout, 'index.html')
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8').replace(
      '</head>',
      `<meta name="task7-browser-client" content="${clientMarker}"></head>`,
    ),
  )

  const packageManifest = JSON.stringify({
    name: 'freshell-task7-browser-runtime',
    version: '1.0.0',
    type: 'module',
  })
  const packageLock = JSON.stringify({
    name: 'freshell-task7-browser-runtime',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'freshell-task7-browser-runtime',
        version: '1.0.0',
      },
    },
  })
  const hiddenPackageLock = JSON.stringify({
    name: 'freshell-task7-browser-runtime',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {},
  })
  const checkoutPackage = readFileSync(path.join(repository, 'package.json'))
  const checkoutPackageLock = readFileSync(path.join(repository, 'package-lock.json'))
  writeFileSync(path.join(checkout, 'package.json'), checkoutPackage)
  writeFileSync(path.join(checkout, 'package-lock.json'), checkoutPackageLock)
  writeFileSync(path.join(runtime, 'package.json'), packageManifest)
  writeFileSync(path.join(runtime, 'package-lock.json'), packageLock)
  writeFileSync(path.join(nodeModules, '.package-lock.json'), hiddenPackageLock)
  writeFileSync(path.join(distServer, 'mcp/server.js'), 'export const task7BrowserFixture = true\n')
  writeFileSync(
    path.join(checkout, 'dist/server/mcp/server.js'),
    'export const task7BrowserFixture = true\n',
  )
  writeFileSync(path.join(sidecar, 'package.json'), packageManifest)
  writeFileSync(path.join(sidecar, 'package-lock.json'), packageLock)
  writeFileSync(
    path.join(sidecar, 'index.mjs'),
    "import readline from 'node:readline'\n" +
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {\n" +
      "  if (JSON.parse(line).type === 'shutdown') process.exit(0)\n" +
      "})\n",
  )

  const settings = JSON.stringify({
    version: 1,
    settings: {
      network: { configured: true, host: '127.0.0.1' },
      codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
    },
  }, null, 2)
  writeFileSync(path.join(home, 'config.json'), settings)
  mkdirSync(path.join(home, '.freshell'), { recursive: true })
  writeFileSync(path.join(home, '.freshell/config.json'), settings)
  const codexSessions = path.join(home, '.codex/sessions')
  mkdirSync(codexSessions, { recursive: true })
  writeFileSync(
    path.join(codexSessions, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-07-29T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: root },
      }),
      JSON.stringify({
        timestamp: '2026-07-29T08:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'task7 browser deployment seed' }],
        },
      }),
    ].join('\n') + '\n',
  )

  writeFileSync(
    path.join(checkout, '.env'),
    `AUTH_TOKEN=${token}\nFRESHELL_HOME=${home}\nCODEX_CMD=${path.join(bin, 'codex')}\n`,
    { mode: 0o600 },
  )
  const environment = {
    ...process.env,
    AUTH_TOKEN: token,
    FRESHELL_HOME: home,
    HOME: home,
    CARGO_BUILD_JOBS: '2',
    CMAKE_BUILD_PARALLEL_LEVEL: '2',
    FRESHELL_DEPLOY_BUILD_PARENT: path.join(root, 'builds'),
  }

  await checked('cargo', ['build', '--quiet', '--release', '-p', 'freshell-server', '-p', 'freshell-deploy'], {
    cwd: checkout,
    env: { ...environment, CARGO_TARGET_DIR: bootstrapTarget },
  })
  await checked('npm', ['run', 'build:client'], {
    cwd: checkout,
    env: { ...environment, FRESHELL_CLIENT_OUT_DIR: legacyClient },
  })
  const managedServerRoot = path.join(root, 'managed-server-build')
  const managedRuntime = path.join(root, 'managed-runtime')
  mkdirSync(managedRuntime)
  await checked('npm', [
    'run',
    'build:server',
    '--',
    '--outDir',
    managedServerRoot,
    '--tsBuildInfoFile',
    path.join(root, 'managed-server.tsbuildinfo'),
  ], { cwd: checkout, env: environment })
  copyFileSync(path.join(checkout, 'package.json'), path.join(managedRuntime, 'package.json'))
  copyFileSync(path.join(checkout, 'package-lock.json'), path.join(managedRuntime, 'package-lock.json'))
  await checked('npm', ['ci', '--omit=dev', '--prefix', managedRuntime], {
    cwd: checkout,
    env: environment,
  })

  rmSync(path.join(checkout, 'node_modules'))
  symlinkSync(nodeModules, path.join(checkout, 'node_modules'))
  writeFileSync(path.join(checkout, 'package.json'), packageManifest)
  writeFileSync(path.join(checkout, 'package-lock.json'), packageLock)
  const node = realpathSync(process.execPath)
  const server = path.join(bootstrapTarget, 'release/freshell-server')
  const controller = path.join(bootstrapTarget, 'release/freshell-deploy')
  await checked(captureFixture, [], {
    cwd: checkout,
    env: {
      ...environment,
      NODE_ENV: 'production',
      PORT: String(port),
      FRESHELL_BIND_HOST: '127.0.0.1',
      FRESHELL_CLIENT_DIR: legacyClient,
      FRESHELL_EXTENSIONS_DIR: path.join(checkout, 'extensions'),
      FRESHELL_CLAUDE_SIDECAR: path.join(sidecar, 'index.mjs'),
      FRESHELL_CLAUDE_NODE: node,
      FRESHELL_MCP_SERVER_ENTRY: path.join(checkout, 'dist/server/mcp/server.js'),
      FRESHELL_REAL_SERVER: server,
      FRESHELL_REAL_CONTROLLER: controller,
      FRESHELL_REAL_CHECKOUT: checkout,
      FRESHELL_REAL_PID_FILE: pidFile,
      FRESHELL_REAL_LOG_FILE: logFile,
      FRESHELL_REAL_PORT: String(port),
      FRESHELL_REAL_CLIENT_DIR: legacyClient,
      FRESHELL_REAL_EXTENSIONS_DIR: path.join(checkout, 'extensions'),
      FRESHELL_REAL_DIST_SERVER_DIR: path.join(checkout, 'dist/server'),
      FRESHELL_REAL_SIDECAR_DIR: sidecar,
      FRESHELL_REAL_PACKAGE_JSON: path.join(checkout, 'package.json'),
      FRESHELL_REAL_PACKAGE_LOCK: path.join(checkout, 'package-lock.json'),
      FRESHELL_REAL_NODE_MODULES: nodeModules,
      FRESHELL_REAL_NODE: node,
      FRESHELL_REAL_NODE_VERSION: process.version,
    },
  })
  console.log('task7 deploy sandbox: captured real legacy listener')

  const knownPids = new Set<number>([Number(readFileSync(pidFile, 'utf8').trim())])
  await checked(controller, [
    'deploy',
    '--checkout',
    checkout,
    '--port',
    String(port),
    '--mode',
    'full',
    '--client-dir',
    legacyClient,
    '--server-executable',
    server,
    '--controller-executable',
    controller,
    '--extensions-dir',
    path.join(checkout, 'extensions'),
    '--dist-server-dir',
    path.join(managedServerRoot, 'server'),
    '--mcp-entry-relative',
    'mcp/server.js',
    '--claude-sidecar-dir',
    path.join(checkout, 'crates/freshell-claude-sidecar'),
    '--claude-sidecar-entry-relative',
    'index.mjs',
    '--package-json',
    path.join(managedRuntime, 'package.json'),
    '--package-lock',
    path.join(managedRuntime, 'package-lock.json'),
    '--node-modules',
    path.join(managedRuntime, 'node_modules'),
    '--node-executable',
    node,
    '--node-version',
    process.version,
  ], { cwd: checkout, env: environment })
  console.log('task7 deploy sandbox: adopted managed full generation')
  rmSync(path.join(checkout, 'node_modules'))
  symlinkSync(path.join(repository, 'node_modules'), path.join(checkout, 'node_modules'))
  writeFileSync(path.join(checkout, 'package.json'), checkoutPackage)
  writeFileSync(path.join(checkout, 'package-lock.json'), checkoutPackageLock)
  await waitForHttp(port, 'up')
  const portRoot = path.join(checkout, '.freshell-deploy/ports', String(port))
  const live = JSON.parse(readFileSync(path.join(portRoot, 'live.json'), 'utf8'))
  knownPids.add(live.processIdentity.pid)

  const sentinel = spawn(
    node,
    ['--eval', 'setInterval(() => {}, 1000)'],
    { stdio: 'ignore' },
  )
  if (!sentinel.pid) throw new Error('unrelated sentinel did not start')

  return {
    root,
    checkout,
    home,
    bootstrapTarget,
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    portRoot,
    environment,
    knownPids,
    sentinel,
  }
}

async function cleanupRig(rig: Rig) {
  const liveFile = path.join(rig.portRoot, 'live.json')
  if (existsSync(liveFile)) {
    try {
      const live = JSON.parse(readFileSync(liveFile, 'utf8'))
      if (live.processIdentity?.pid) rig.knownPids.add(live.processIdentity.pid)
      const controller = path.join(rig.portRoot, 'current/controller/freshell-deploy')
      if (existsSync(controller)) {
        await result(controller, [
          'stop-current',
          '--checkout',
          rig.checkout,
          '--port',
          String(rig.port),
        ], { cwd: rig.checkout, env: rig.environment, timeout: 60_000 })
      }
    } catch {
      // Exact PIDs already observed remain available for sandbox cleanup.
    }
  }
  for (const pid of rig.knownPids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already stopped by the controller.
    }
  }
  rig.sentinel.kill('SIGTERM')
  await waitForHttp(rig.port, 'down', 20_000).catch(() => {})
  await result('chmod', ['-R', 'u+rwX', rig.root], { timeout: 60_000 })
  rmSync(rig.root, { recursive: true, force: true })
}

async function connect(page: Page, rig: Rig) {
  await page.goto(`${rig.baseUrl}/?token=${rig.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

async function postTab(rig: Rig, payload: Record<string, unknown>) {
  const response = await fetch(`${rig.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: {
      'x-auth-token': rig.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(200)
  return body.data
}

function terminalLeaves(node: any, output: any[] = []): any[] {
  if (!node) return output
  if (node.type === 'leaf' && node.content?.kind === 'terminal') {
    output.push({
      paneId: node.id,
      mode: node.content.mode,
      createRequestId: node.content.createRequestId,
      terminalId: node.content.terminalId,
      sessionRef: node.content.sessionRef ?? null,
    })
  }
  for (const child of node.children ?? []) terminalLeaves(child, output)
  return output
}

async function browserIdentity(harness: TestHarness) {
  const state = await harness.getState()
  const restartScopedPaneFields = new Set([
    'terminalId',
    'status',
    'error',
    'lastOutputAt',
    'streamId',
    'serverInstanceId',
    'initialCwd',
    'reconcileEpoch',
    'pendingReconcile',
  ])
  return {
    tabs: state.tabs.tabs.map((tab: any) => ({
      id: tab.id,
      title: tab.title,
      name: tab.name,
      mode: tab.mode,
    })),
    layouts: Object.fromEntries(
      state.tabs.tabs.map((tab: any) => {
        const layout = state.panes.layouts[tab.id]
        return [
          tab.id,
          {
            structure: JSON.stringify(layout, (key, value) => (
              restartScopedPaneFields.has(key)
                ? undefined
                : value
            )),
            terminals: terminalLeaves(layout),
          },
        ]
      }),
    ),
  }
}

async function deploymentIdentity(rig: Rig) {
  const liveBytes = readFileSync(path.join(rig.portRoot, 'live.json'), 'utf8')
  const live = JSON.parse(liveBytes)
  rig.knownPids.add(live.processIdentity.pid)
  const health = await (await fetch(`${rig.baseUrl}/api/health`)).json()
  const compatibility = await (
    await fetch(`${rig.baseUrl}/api/deployment-compatibility`, {
      headers: { 'x-auth-token': rig.token },
    })
  ).json()
  return {
    liveBytes,
    live,
    health,
    compatibility,
    current: readlinkSync(path.join(rig.portRoot, 'current')),
    transaction: readFileSync(path.join(rig.portRoot, 'transaction.json'), 'utf8'),
  }
}

async function tabDiff(rig: Rig, args: string[]) {
  return result(path.join(rig.checkout, 'scripts/deploy-tab-diff.sh'), args, {
    cwd: rig.checkout,
    env: rig.environment,
  })
}

async function waitForPersistedCoverage(rig: Rig, minimumRecords: number) {
  await expect(async () => {
    const response = await fetch(`${rig.baseUrl}/api/tabs-sync/snapshots`, {
      headers: { 'x-auth-token': rig.token },
    })
    const body = await response.json()
    expect(body.devices.some((device: any) => device.recordCount >= minimumRecords)).toBe(true)
  }).toPass({ timeout: 60_000 })
}

async function waitForSnapshotAfter(rig: Rig, capturedAt: number) {
  await expect(async () => {
    const response = await fetch(`${rig.baseUrl}/api/tabs-sync/snapshots`, {
      headers: { 'x-auth-token': rig.token },
    })
    const body = await response.json()
    expect(
      body.devices.some((device: any) => (
        device.generations.some((generation: any) => generation.capturedAt > capturedAt)
      )),
    ).toBe(true)
  }).toPass({ timeout: 60_000 })
}

async function assertTerminalMarker(
  page: Page,
  harness: TestHarness,
  tabId: string,
  terminalId: string,
  marker: string,
) {
  await page.locator(`[data-tab-id="${tabId}"]`).first().click()
  const terminal = new TerminalHelper(page)
  await terminal.waitForTerminal()
  await terminal.executeCommand(`printf '${marker}\\n'`)
  await terminal.waitForOutput(marker, { terminalId, timeout: 30_000 })
}

async function assertLazyEditorChunk(page: Page) {
  const loaded = new Set(
    await page.evaluate(() => performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\.js(?:\?|$)/.test(name))),
  )
  const newScripts: string[] = []
  const listener = (request: any) => {
    if (
      (request.resourceType() === 'script' || /\.js(?:\?|$)/.test(request.url()))
      && !loaded.has(request.url())
    ) {
      newScripts.push(request.url())
    }
  }
  page.on('request', listener)
  try {
    await page.locator('.xterm').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()
    await page.getByRole('button', { name: /^Editor$/i }).click()
    await expect(page.locator('[data-testid="editor-pane"]')).toBeVisible()
    await expect(page.locator('[data-testid="editor-pane-loading"]')).toBeHidden()
    expect(newScripts.length).toBeGreaterThan(0)
  } finally {
    page.off('request', listener)
  }
}

test('compatibility-checked deployment preserves one connected browser and rejects both incompatible directions', async ({ page }) => {
  test.setTimeout(3_600_000)
  const rig = await setupRig()
  const beforeFile = path.join(rig.root, 'before.json')
  try {
    const harness = await connect(page, rig)
    console.log('task7 deploy sandbox: browser connected')
    const initial = await deploymentIdentity(rig)
    expect(initial.compatibility.serverDeclaration.version).toBe('0.7.0')
    expect(initial.compatibility.serverDeclaration.supports.client).toEqual({
      minInclusive: '0.7.5',
      maxExclusive: '0.7.6',
    })
    const selectedRoot = path.join(
      rig.portRoot,
      'generations',
      initial.live.selectedGenerationId,
    )
    const clientDeclaration = JSON.parse(
      readFileSync(
        path.join(selectedRoot, 'client/deployment-compatibility.json'),
        'utf8',
      ),
    ).declaration
    expect(clientDeclaration.version).toBe('0.7.5')
    expect(clientDeclaration.supports.server).toEqual({
      minInclusive: '0.7.0',
      maxExclusive: '0.7.1',
    })
    expect(initial.compatibility.serverProcessGenerationId)
      .toBe(initial.live.runningServerGenerationId)
    expect(await page.locator('meta[name="task7-browser-client"]').getAttribute('content'))
      .toMatch(/^task7-browser-client-/)
    console.log('task7 deploy sandbox: unequal compatible pair loaded')

    const shell = await postTab(rig, { mode: 'shell', name: 'Task 7 shell' })
    const codex = await postTab(rig, {
      mode: 'codex',
      name: 'Task 7 codex',
      sessionRef: { provider: 'codex', sessionId },
    })
    expect(shell.terminalId).toBeTruthy()
    expect(codex.terminalId).toBeTruthy()
    await waitForPersistedCoverage(rig, 2)
    const capture = await tabDiff(rig, [
      'capture',
      '--url',
      rig.baseUrl,
      '--token',
      rig.token,
      '--out',
      beforeFile,
    ])
    expect(capture.code, `${capture.stdout}\n${capture.stderr}`).toBe(0)
    console.log('task7 deploy sandbox: tab-diff coverage capture passed')
    const capturedAt = JSON.parse(readFileSync(beforeFile, 'utf8')).capturedAt

    const beforeBrowser = await browserIdentity(harness)
    const shellBefore = Object.values(beforeBrowser.layouts)
      .flatMap((layout: any) => layout.terminals)
      .find((leaf: any) => leaf.paneId === shell.paneId)
    const codexBefore = Object.values(beforeBrowser.layouts)
      .flatMap((layout: any) => layout.terminals)
      .find((leaf: any) => leaf.paneId === codex.paneId)
    expect(shellBefore?.terminalId).toBeTruthy()
    expect(codexBefore?.sessionRef?.sessionId).toBe(sessionId)
    await assertTerminalMarker(
      page,
      harness,
      shell.tabId,
      shellBefore.terminalId,
      'task7-before-restart',
    )

    writeFileSync(
      path.join(rig.checkout, 'server/task7-deploy-generation-marker.ts'),
      'export const task7DeployGenerationMarker = true\n',
    )
    const restart = await result(
      path.join(rig.checkout, 'scripts/launch-rust.sh'),
      ['--port', String(rig.port), '--server-only', '--restart'],
      { cwd: rig.checkout, env: rig.environment, timeout: 1_800_000 },
    )
    expect(restart.code, `${restart.stdout}\n${restart.stderr}`).toBe(0)
    console.log('task7 deploy sandbox: canonical server-only restart completed')
    await harness.waitForConnection(60_000)
    const after = await deploymentIdentity(rig)
    expect(after.live.processIdentity.pid).not.toBe(initial.live.processIdentity.pid)
    expect(after.health.instanceId).toBe(initial.health.instanceId)
    expect(after.compatibility.bootId).not.toBe(initial.compatibility.bootId)
    expect(after.live.selectedGenerationId).not.toBe(initial.live.selectedGenerationId)
    expect(after.live.runningServerGenerationId).toBe(after.live.selectedGenerationId)
    expect(realpathSync(`/proc/${after.live.processIdentity.pid}/exe`))
      .toBe(realpathSync(path.join(rig.portRoot, 'current/server/freshell-server')))
    await expect(() => {
      expect(isRecordedProcessRunning(initial.live.processIdentity)).toBe(false)
    }).toPass({ timeout: 10_000, intervals: [50, 100, 250, 500] })
    expect(isProcessAlive(rig.sentinel.pid!)).toBe(true)

    await expect(async () => {
      const afterBrowser = await browserIdentity(harness)
      expect(afterBrowser.tabs).toEqual(beforeBrowser.tabs)
      for (const [tabId, beforeLayout] of Object.entries(beforeBrowser.layouts) as any) {
        expect(afterBrowser.layouts[tabId].structure).toBe(beforeLayout.structure)
      }
      const terminals = Object.values(afterBrowser.layouts)
        .flatMap((layout: any) => layout.terminals)
      const shellAfter = terminals.find((leaf: any) => leaf.paneId === shell.paneId)
      const codexAfter = terminals.find((leaf: any) => leaf.paneId === codex.paneId)
      expect(shellAfter.createRequestId).toBe(shellBefore.createRequestId)
      expect(shellAfter.terminalId).not.toBe(shellBefore.terminalId)
      expect(codexAfter.createRequestId).toBe(codexBefore.createRequestId)
      expect(codexAfter.terminalId).not.toBe(codexBefore.terminalId)
      expect(codexAfter.sessionRef?.sessionId).toBe(sessionId)
    }).toPass({ timeout: 60_000 })
    const afterBrowser = await browserIdentity(harness)
    const shellAfter = Object.values(afterBrowser.layouts)
      .flatMap((layout: any) => layout.terminals)
      .find((leaf: any) => leaf.paneId === shell.paneId)
    await assertTerminalMarker(
      page,
      harness,
      shell.tabId,
      shellAfter.terminalId,
      'task7-after-restart',
    )
    await waitForSnapshotAfter(rig, capturedAt)
    const verify = await tabDiff(rig, [
      'verify',
      '--url',
      rig.baseUrl,
      '--token',
      rig.token,
      '--before',
      beforeFile,
    ])
    expect(verify.code, `${verify.stdout}\n${verify.stderr}`).toBe(0)
    expect(verify.stdout).toContain('OK: every previously-live pane came back')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText(/auto-resuming/i)).toHaveCount(0)
    await expect(page.locator('[data-testid="crash-trace"]')).toHaveCount(0)
    await assertLazyEditorChunk(page)

    const assertRejectedWithoutMutation = async (
      attempt: () => Promise<CommandResult>,
    ) => {
      const beforeDeploy = await deploymentIdentity(rig)
      const beforeUi = await browserIdentity(harness)
      const rejected = await attempt()
      expect(rejected.code).not.toBe(0)
      await harness.waitForConnection()
      const afterDeploy = await deploymentIdentity(rig)
      expect(afterDeploy.liveBytes).toBe(beforeDeploy.liveBytes)
      expect(afterDeploy.current).toBe(beforeDeploy.current)
      expect(afterDeploy.live.processIdentity.pid).toBe(beforeDeploy.live.processIdentity.pid)
      expect(afterDeploy.health.instanceId).toBe(beforeDeploy.health.instanceId)
      expect(await browserIdentity(harness)).toEqual(beforeUi)
      expect(isRecordedProcessRunning(beforeDeploy.live.processIdentity)).toBe(true)
      expect(isProcessAlive(rig.sentinel.pid!)).toBe(true)
      await assertTerminalMarker(
        page,
        harness,
        shell.tabId,
        shellAfter.terminalId,
        `task7-rejected-${Date.now()}`,
      )
      return rejected
    }

    const contractPath = path.join(rig.checkout, 'config/deployment-compatibility.json')
    const compatibleContract = readFileSync(contractPath, 'utf8')
    const incompatibleClient = path.join(rig.root, 'incompatible-client')
    await checked('npm', ['run', 'build:client'], {
      cwd: rig.checkout,
      env: { ...rig.environment, FRESHELL_CLIENT_OUT_DIR: incompatibleClient },
    })
    const clientArtifactPath = path.join(
      incompatibleClient,
      'deployment-compatibility.json',
    )
    const clientArtifact = JSON.parse(readFileSync(clientArtifactPath, 'utf8'))
    clientArtifact.declaration.supports.server = {
      minInclusive: '0.8.0',
      maxExclusive: '0.8.1',
    }
    clientArtifact.declarationSha256 = declarationDigest(clientArtifact.declaration)
    writeFileSync(clientArtifactPath, `${JSON.stringify(clientArtifact, null, 2)}\n`)
    const storedController = path.join(rig.portRoot, 'current/controller/freshell-deploy')
    const node = realpathSync(process.execPath)
    const clientRejected = await assertRejectedWithoutMutation(() => result(
      storedController,
      [
        'deploy',
        '--checkout',
        rig.checkout,
        '--port',
        String(rig.port),
        '--mode',
        'client-only',
        '--client-dir',
        incompatibleClient,
        '--node-executable',
        node,
        '--node-version',
        process.version,
      ],
      { cwd: rig.checkout, env: rig.environment },
    ))
    expect(`${clientRejected.stdout}\n${clientRejected.stderr}`).toMatch(
      /client.*server|compatib/i,
    )
    console.log('task7 deploy sandbox: candidate-client rejection proved')

    const serverRejects = JSON.parse(compatibleContract)
    // Keep the source contract internally valid so Cargo can build a genuine
    // candidate ELF; only that candidate server is deployed against the
    // already-selected 0.7.5 client.
    serverRejects.client.version = '0.8.0'
    serverRejects.server.supportsClient = {
      minInclusive: '0.8.0',
      maxExclusive: '0.8.1',
    }
    writeFileSync(contractPath, `${JSON.stringify(serverRejects, null, 2)}\n`)
    await checked('cargo', ['build', '--quiet', '--release', '-p', 'freshell-server'], {
      cwd: rig.checkout,
      env: { ...rig.environment, CARGO_TARGET_DIR: rig.bootstrapTarget },
    })
    writeFileSync(contractPath, compatibleContract)
    const candidateRuntime = path.join(rig.root, 'managed-runtime')
    const candidateServerRoot = path.join(rig.root, 'managed-server-build/server')
    const serverRejected = await assertRejectedWithoutMutation(() => result(
      storedController,
      [
        'deploy',
        '--checkout',
        rig.checkout,
        '--port',
        String(rig.port),
        '--mode',
        'server',
        '--server-executable',
        path.join(rig.bootstrapTarget, 'release/freshell-server'),
        '--controller-executable',
        path.join(rig.bootstrapTarget, 'release/freshell-deploy'),
        '--extensions-dir',
        path.join(rig.checkout, 'extensions'),
        '--dist-server-dir',
        candidateServerRoot,
        '--mcp-entry-relative',
        'mcp/server.js',
        '--claude-sidecar-dir',
        path.join(rig.checkout, 'crates/freshell-claude-sidecar'),
        '--claude-sidecar-entry-relative',
        'index.mjs',
        '--package-json',
        path.join(candidateRuntime, 'package.json'),
        '--package-lock',
        path.join(candidateRuntime, 'package-lock.json'),
        '--node-modules',
        path.join(candidateRuntime, 'node_modules'),
        '--node-executable',
        node,
        '--node-version',
        process.version,
      ],
      { cwd: rig.checkout, env: rig.environment },
    ))
    expect(`${serverRejected.stdout}\n${serverRejected.stderr}`).toMatch(
      /server.*client|compatib/i,
    )
    console.log('task7 deploy sandbox: candidate-server rejection proved')
  } finally {
    await cleanupRig(rig)
  }
})
