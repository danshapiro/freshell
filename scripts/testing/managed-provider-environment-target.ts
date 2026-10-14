import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION, type ClientMessage } from '../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../../test/e2e-browser/helpers/managed-runtime.js'
import { authorizeProviderParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes } from '../../test/helpers/provider-parity-broker.js'
import { managedEnvironmentOpencodeSelection, providerParityFailureDiagnostics } from '../../test/helpers/provider-parity-environment.js'
import { fakeOnecliGrants } from '../../test/helpers/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from './runtime-test-broker.js'
import { resolvePairedExternalFixture } from './e2e-external-target.js'
import { assertManagedTerminalCreated, observeManagedEnvironmentNativeIdentity, readManagedEnvironmentDaemonId,
  serviceManagedEnvironmentCases, summarizeRustServerLogEvents, waitForManagedEnvironmentReadyOrBrowserFailure,
  writeManagedEnvironmentBrowserFailureIncident } from './managed-environment-create.js'
import { waitForCloudExecutionDispatch } from './cloud-execution-dispatch.js'
import { ManagedEnvironmentBrowserSummaryCapture, type ManagedEnvironmentBrowserSummary } from './managed-environment-browser-summary.js'

const cloudflaredVersion = '2026.10.0'
const cloudflaredSha = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'
const scenarios = ['healthy', 'missing-reference', 'startup-before-identity'] as const
const ordinaryFixtureMode = 'managed-fixture-ordinary'
const managedEnvironmentFixtureModel = 'opencode/big-pickle'
const checkpointImage = 'freshell-sandbox:latest'
const checkpointContainerPort = 3477
const checkpointForwarderPort = 3478
const checkpointFixtureRoot = '/tmp/freshell-checkpoint-fixture'
const checkpointControlRequest = `${checkpointFixtureRoot}/control/request.json`
const checkpointControlAck = (id: string) => `${checkpointFixtureRoot}/control/ack-${id}.json`
const checkpointControlPollIntervalMs = 1_000
const targetReadRateLimitRetries = 3
export type ManagedProviderEnvironmentTargetMode = 'managed-environment' | 'code-checkpoint'
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

export const checkpointTcpForwarderSource = String.raw`
const net = require('node:net')
const listenHost = process.env.FRESHELL_CHECKPOINT_FORWARDER_HOST
const listenPort = Number(process.env.FRESHELL_CHECKPOINT_FORWARDER_PORT)
const upstreamHost = process.env.FRESHELL_CHECKPOINT_UPSTREAM_HOST
const upstreamPort = Number(process.env.FRESHELL_CHECKPOINT_UPSTREAM_PORT)
if (!listenHost || !Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535 ||
    !upstreamHost || !Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
  console.error(JSON.stringify({ severity: 'error', event: 'code_checkpoint.forwarder_config_invalid' }))
  process.exit(2)
}
const server = net.createServer(client => {
  const upstream = net.createConnection({ host: upstreamHost, port: upstreamPort })
  client.pipe(upstream)
  upstream.pipe(client)
  client.once('error', () => upstream.destroy())
  upstream.once('error', error => {
    console.error(JSON.stringify({ severity: 'warn', event: 'code_checkpoint.forwarder_upstream_failed', code: error.code ?? 'unknown' }))
    client.destroy()
  })
  client.once('close', () => upstream.destroy())
})
server.once('error', error => {
  console.error(JSON.stringify({ severity: 'error', event: 'code_checkpoint.forwarder_listen_failed', code: error.code ?? 'unknown' }))
  process.exitCode = 1
})
server.listen(listenPort, listenHost, () => {
  console.log(JSON.stringify({ severity: 'info', event: 'code_checkpoint.forwarder_listening', listenHost, listenPort, upstreamHost, upstreamPort }))
})
`

const managedMcpServerSource = String.raw`import { writeFileSync } from 'node:fs'
import dependency from 'managed-fixture-mcp-dependency'

const [receiptPath, expectedNonce] = process.argv.slice(2)
if (!receiptPath || !expectedNonce) process.exit(12)
writeFileSync(receiptPath, JSON.stringify({
  expectedNonce,
  dependency,
  bun: typeof Bun === 'object',
  bunVersion: Bun.version,
  launchCwd: process.cwd(),
  bunCommandCwd: process.env.npm_config_local_prefix,
  configuredCwd: process.env.FRESHELL_EXPECTED_MCP_CWD,
  executable: process.execPath,
  scriptPath: new URL(import.meta.url).pathname,
}))

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  while (true) {
    const boundary = buffered.indexOf('\n')
    if (boundary < 0) break
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (!request || !Object.hasOwn(request, 'id')) continue
    let result
    if (request.method === 'initialize') {
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'freshell-managed-bun-fixture', version: '1.0.0' },
      }
    } else if (request.method === 'tools/list') {
      result = { tools: [{ name: 'fixture_probe', description: 'Managed Bun launch proof', inputSchema: { type: 'object', properties: {} } }] }
    } else if (request.method === 'ping') {
      result = {}
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'Method not found' } }) + '\n')
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
})
`

const directMcpServerSource = String.raw`import fs from 'node:fs'
import sibling from './helper.mjs'
import dependency from 'managed-direct-fixture-dependency'
const schema = JSON.parse(fs.readFileSync(new URL('./schema.json', import.meta.url), 'utf8'))
const [receiptPath, expectedNonce] = process.argv.slice(2)
if (!receiptPath || !expectedNonce) process.exit(12)
const envFileOperandRewritten = process.execArgv.some(value =>
  /^--env-file=\/home\/freshell\/provider\/\.freshell\/references\/\d+$/.test(value))
const envValueLoaded = process.env.FRESHELL_MANAGED_SHARED_ENV === expectedNonce
fs.writeFileSync(receiptPath, JSON.stringify({ expectedNonce, helper: process.env.MANAGED_DIRECT_MCP_HELPER,
  sibling, dependency, schemaNonce: schema.nonce, cwd: process.cwd(), scriptPath: process.argv[1],
  envFileOperandRewritten, envValueLoaded }))
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  while (true) {
    const boundary = buffered.indexOf('\n')
    if (boundary < 0) break
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (!request || !Object.hasOwn(request, 'id')) continue
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'freshell-direct-script-fixture', version: '1.0.0' } }
    else if (request.method === 'tools/list') result = { tools: [] }
    else if (request.method === 'ping') result = {}
    else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'Method not found' } }) + '\n')
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
})
`

const workspaceCwdAliasMcpServerSource = String.raw`import fs from 'node:fs'
import helper from './helper.mjs'
const [receiptPath, expectedNonce] = process.argv.slice(2)
if (!receiptPath || !expectedNonce) process.exit(12)
fs.writeFileSync(receiptPath, JSON.stringify({ expectedNonce, helper,
  envValueLoaded: process.env.FRESHELL_MANAGED_CWD_ALIAS_ENV === expectedNonce,
  envFileTarget: fs.realpathSync('.env'),
  envFileOperand: process.execArgv.find(value => value.startsWith('--env-file=')),
  cwd: process.cwd(), scriptPath: process.argv[1] }))
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  while (true) {
    const boundary = buffered.indexOf('\n')
    if (boundary < 0) break
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (!request || !Object.hasOwn(request, 'id')) continue
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'freshell-workspace-cwd-alias-fixture', version: '1.0.0' } }
    else if (request.method === 'tools/list') result = { tools: [] }
    else if (request.method === 'ping') result = {}
    else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'Method not found' } }) + '\n')
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
})
`

export function workspaceCwdAliasMcpWrapperSource(): string {
  const receiptVariable = '${receipt}'
  return `#!/bin/sh
set +e
receipt=$1
started="${receiptVariable}.started"
printf '%s' wrapper-started > "$started"
diagnostic=$(mktemp)
node --env-file=.env server.mjs "$@" 2>"$diagnostic"
status=$?
if [ "$status" -ne 0 ]; then
  has_enoent=false
  has_eacces=false
  has_env_file_error=false
  has_syntax_error=false
  has_module_error=false
  grep -q 'ENOENT' "$diagnostic" && has_enoent=true
  grep -q 'EACCES' "$diagnostic" && has_eacces=true
  grep -qi 'env file' "$diagnostic" && has_env_file_error=true
  grep -q 'SyntaxError' "$diagnostic" && has_syntax_error=true
  if grep -q 'ERR_MODULE_NOT_FOUND' "$diagnostic" || grep -qi 'Cannot find module' "$diagnostic"; then has_module_error=true; fi
  printf '{"wrapperStarted":true,"nodeExitCode":%s,"stderrHasENOENT":%s,"stderrHasEACCES":%s,"stderrHasEnvFileError":%s,"stderrHasSyntaxError":%s,"stderrHasModuleError":%s}' \
    "$status" "$has_enoent" "$has_eacces" "$has_env_file_error" "$has_syntax_error" "$has_module_error" > "$receipt"
fi
rm -f "$diagnostic"
exit "$status"
`
}

export function directHomeAppendMcpServerSource(outputName: string): string {
  const outputUrl = `new URL(${JSON.stringify(`./${outputName}`)}, import.meta.url)`
  return `import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
const [receiptPath, expectedNonce] = process.argv.slice(2)
if (!receiptPath || !expectedNonce) process.exit(12)
let appendError
try { fs.appendFileSync(${outputUrl}, '|' + expectedNonce) }
catch (error) { appendError = error.code ?? error.message ?? String(error) }
let output, readError
try { output = fs.readFileSync(${outputUrl}, 'utf8') }
catch (error) { readError = error.code ?? error.message ?? String(error) }
const outputPath = fileURLToPath(${outputUrl})
const outputExists = fs.existsSync(outputPath)
const siblingMountPresent = (() => { try { return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').some(line => line.includes(outputPath)) } catch { return false } })()
const envFileOperandRewritten = process.execArgv.some(value =>
  /^--env-file=\\/home\\/freshell\\/provider\\/\\.freshell\\/references\\/\\d+$/.test(value))
const envValueLoaded = process.env.FRESHELL_MANAGED_SHARED_ENV === expectedNonce
fs.writeFileSync(receiptPath, JSON.stringify({ expectedNonce, appendError, readError, output, outputExists,
  siblingMountPresent, scriptPath: process.argv[1], envFileOperandRewritten, envValueLoaded }))
let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffered += chunk
  while (true) {
    const boundary = buffered.indexOf('\\n')
    if (boundary < 0) break
    const line = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 1)
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (!request || !Object.hasOwn(request, 'id')) continue
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'freshell-home-append-fixture', version: '1.0.0' } }
    else if (request.method === 'tools/list') result = { tools: [] }
    else if (request.method === 'ping') result = {}
    else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { code: -32601, message: 'Method not found' } }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`
}

export function resolveManagedProviderEnvironmentTargetMode(args: string[]): ManagedProviderEnvironmentTargetMode {
  if (args.length === 0) return 'managed-environment'
  if (args.length === 1 && args[0] === '--checkpoint') return 'code-checkpoint'
  throw new Error('Usage: managed-provider-environment-target.ts [--checkpoint]')
}

async function poll<T>(description: string, operation: () => Promise<T | undefined>, timeout = 180_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await operation()
    if (value !== undefined) return value
    await delay(250)
  }
  throw new Error(`Managed environment timed out: ${description}`)
}

async function writeJson(selected: string, value: unknown) {
  await fs.writeFile(selected, JSON.stringify(value, null, 2), { mode: 0o600 })
}

async function readJson(selected: string): Promise<any | undefined> {
  try { return JSON.parse(await fs.readFile(selected, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}

export async function processIdentity(child: { pid?: number }) {
  assert(child.pid)
  const raw = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8')
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  return { pid: child.pid, parentPid: Number(fields[1]), processGroupId: Number(fields[2]), sessionId: Number(fields[3]),
    birthTicks: fields[19], cwd: await fs.readlink(`/proc/${child.pid}/cwd`) }
}

type NativeExit = { code: number | null; signal: NodeJS.Signals | null }

function joined(child: ChildProcess): Promise<NativeExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function joinedAfterOutput(child: ChildProcess): Promise<NativeExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function bounded<T>(completion: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([completion, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Managed environment timed out: ${description}`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

function processIsGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ESRCH'
}

export async function stopExact(child: ChildProcess | undefined, identity: Awaited<ReturnType<typeof processIdentity>> | undefined,
  completion: Promise<NativeExit> | undefined, ownedProcessGroup = false) {
  if (!child || !completion) return
  if (child.exitCode === null && child.signalCode === null) {
    assert(identity, 'Live owned child has no captured identity; retain its fixture')
    let current: Awaited<ReturnType<typeof processIdentity>> | undefined
    try { current = await processIdentity(child) }
    catch (error) { if (!processIsGone(error)) throw error }
    if (current) assert.deepEqual(current, identity, 'Owned child identity changed; retain it')
    if (ownedProcessGroup) signalOwnedProcessGroup(identity, 'SIGTERM')
    else if (current) child.kill('SIGTERM')
  }
  try { return await bounded(completion, 15_000, 'owned child graceful join') }
  catch (error) {
    if (ownedProcessGroup) {
      assert(identity, 'Detached owned child group has no captured identity; retain its fixture')
      if (identity.processGroupId !== identity.pid || identity.sessionId !== identity.pid) {
        throw new Error('Detached child no longer identifies its unique owned process group; retain its fixture', { cause: error })
      }
      if (child.exitCode === null && child.signalCode === null) {
        let current: Awaited<ReturnType<typeof processIdentity>> | undefined
        try { current = await processIdentity(child) }
        catch (identityError) { if (!processIsGone(identityError)) throw identityError }
        if (current) assert.deepEqual(current, identity, 'Owned child identity changed before group escalation; retain it')
      }
      signalOwnedProcessGroup(identity, 'SIGKILL')
    } else {
      if (child.exitCode !== null || child.signalCode !== null) throw error
      let current: Awaited<ReturnType<typeof processIdentity>> | undefined
      try { current = await processIdentity(child) }
      catch (identityError) { if (!processIsGone(identityError)) throw identityError }
      if (current) {
        assert.deepEqual(current, identity, 'Owned child identity changed before escalation; retain it')
        child.kill('SIGKILL')
      }
    }
  }
  return bounded(completion, 15_000, 'owned child final join')
}

function signalOwnedProcessGroup(identity: Awaited<ReturnType<typeof processIdentity>>, signal: NodeJS.Signals): boolean {
  assert.equal(identity.processGroupId, identity.pid, 'Owned detached process group must match its captured leader')
  assert.equal(identity.sessionId, identity.pid, 'Owned detached session must match its captured leader')
  try { process.kill(-identity.processGroupId, signal); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function terminalDirectory(rig: ManagedRuntimeBrowserRig): Promise<any[]> {
  const response = await fetch(`${rig.info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': rig.info.token }, signal: AbortSignal.timeout(30_000) })
  assert(response.ok, 'Owned terminal directory request failed')
  const rows = await response.json()
  assert(Array.isArray(rows), 'Owned terminal directory must return its real rows')
  return rows
}

async function webChildren(rig: ManagedRuntimeBrowserRig): Promise<number[]> {
  const { pid } = rig.web.processEvidence()
  const children = new Set<number>()
  for (const thread of await fs.readdir(`/proc/${pid}/task`)) {
    try {
      const selected = await fs.readFile(`/proc/${pid}/task/${thread}/children`, 'utf8')
      for (const child of selected.trim().split(/\s+/).filter(Boolean)) children.add(Number(child))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  assert.equal(rig.web.processEvidence().pid, pid, 'Owned scratch web server changed during child observation')
  return [...children].sort((left, right) => left - right)
}

export function managedEnvironmentFixtureLayout(root: string) {
  const workspace = path.join(root, 'workspace')
  const resources = path.join(root, 'selected-resources')
  const plugin = path.join(resources, 'fixture-plugin')
  const mcpPackage = path.join(resources, 'fixture-mcp')
  const directMcp = path.join(resources, 'direct-mcp')
  const cwdAliasProject = path.join(resources, 'cwd-alias-project')
  const mcpNested = path.join(mcpPackage, 'nested')
  const mcpParentDependency = path.join(resources, 'node_modules/managed-fixture-mcp-dependency')
  return { workspace, resources, plugin, mcpPackage, directMcp, cwdAliasProject, mcpNested, mcpParentDependency }
}

export function managedHomeAppendFixturePaths(home: string, cwd: string, scenario: string) {
  const script = path.join(home, `direct-home-${scenario}.mjs`)
  const receipt = path.join(cwd, '.managed-fixture/direct-home-mcp-receipt.json')
  return {
    script,
    wrapper: path.join(home, `direct-home-${scenario}-start`),
    envFile: path.join(home, `direct-home-${scenario}.env`),
    output: path.join(path.dirname(script), `direct-home-${scenario}.txt`),
    receipt,
    started: `${receipt}.started`,
  }
}

async function configure(root: string, nonce: string, candidateSha: string, runId: string) {
  const home = path.join(root, 'home'), xdg = path.join(home, 'fixture-xdg')
  const { workspace, resources, plugin, mcpPackage, directMcp, cwdAliasProject, mcpNested, mcpParentDependency } = managedEnvironmentFixtureLayout(root)
  await fs.mkdir(path.join(plugin, 'node_modules/managed-fixture-dependency'), { recursive: true, mode: 0o755 })
  await fs.mkdir(mcpNested, { recursive: true, mode: 0o755 })
  await fs.mkdir(directMcp, { recursive: true, mode: 0o755 })
  await fs.mkdir(cwdAliasProject, { recursive: true, mode: 0o755 })
  await fs.symlink(workspace, path.join(cwdAliasProject, 'workspace'))
  await fs.mkdir(mcpParentDependency, { recursive: true, mode: 0o755 })
  const sharedEnvFile = path.join(directMcp, '.env')
  await fs.writeFile(sharedEnvFile, `FRESHELL_MANAGED_SHARED_ENV=${nonce}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(cwdAliasProject, '.env'), `FRESHELL_MANAGED_CWD_ALIAS_ENV=${nonce}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(cwdAliasProject, 'helper.mjs'), `export default ${JSON.stringify(nonce)};\n`)
  await fs.writeFile(path.join(cwdAliasProject, 'server.mjs'), workspaceCwdAliasMcpServerSource)
  const directMcpDependency = path.join(directMcp, 'node_modules/managed-direct-fixture-dependency')
  await fs.mkdir(directMcpDependency, { recursive: true, mode: 0o755 })
  await fs.mkdir(path.join(xdg, 'opencode'), { recursive: true, mode: 0o755 })
  await fs.mkdir(path.join(xdg, 'opencode/mcp-servers'), { recursive: true, mode: 0o755 })
  await fs.chmod(home, 0o700)
  await fs.chmod(root, 0o751)
  // Register a known CLI without a managed adapter through the normal HOME
  // extension scan. Shell uses the managed facade when a controller is present;
  // this mode reaches the ordinary registry.create refusal instead.
  const ordinaryExtension = path.join(home, '.freshell/extensions', ordinaryFixtureMode)
  await fs.mkdir(ordinaryExtension, { recursive: true, mode: 0o700 })
  await writeJson(path.join(ordinaryExtension, 'freshell.json'), {
    name: ordinaryFixtureMode, version: '1.0.0', label: 'Ordinary terminal fixture',
    description: 'Owned ordinary terminal refusal fixture', category: 'cli', cli: { command: '/bin/false' },
  })
  await fs.writeFile(path.join(plugin, 'node_modules/managed-fixture-dependency/package.json'), '{"type":"module","exports":"./index.mjs"}')
  await fs.writeFile(path.join(plugin, 'node_modules/managed-fixture-dependency/index.mjs'), `export default ${JSON.stringify(nonce)};`)
  await fs.writeFile(path.join(plugin, 'selected-resource'), nonce, { mode: 0o600 })
  const command = path.join(plugin, 'command')
  await fs.writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ resource: nonce })}'\n`, { mode: 0o751 })
  await fs.chmod(command, 0o751)
  await fs.writeFile(path.join(plugin, 'package.json'), '{"type":"module","exports":{"./server":"./server.mjs","./tui":"./tui.mjs"}}')
  await fs.writeFile(path.join(plugin, 'server.mjs'), `export default {id:'managed-environment-server',async server(){return {}}};`)
  // Exact pinned API: OpenCode v1.18.21 packages/plugin/src/tui.ts and specs/tui-plugins.md.
  // The SDK creates only an empty local session; no prompt or model call is made.
  // Fail from the TUI initializer: OpenCode logs and ignores server config-hook errors.
  await fs.writeFile(path.join(plugin, 'tui.mjs'), `import fs from 'node:fs';import path from 'node:path';import dependency from 'managed-fixture-dependency';
export default {id:'managed-environment-tui',async tui(api,options){
 const cwd=process.cwd();if(cwd.endsWith('/startup-before-identity')){await new Promise(resolve=>process.stderr.write('startup-fixture failed before native identity\\n',resolve));process.exit(23)}
 const command=new URL('./command',import.meta.url), resource=fs.readFileSync(new URL('./selected-resource',import.meta.url),'utf8');
 const child=Bun.spawn([command.pathname],{stdout:'pipe',stderr:'pipe'});const output=JSON.parse(await new Response(child.stdout).text());if(await child.exited!==0)throw new Error('selected executable failed');
 const configuration=await api.client.config.get({directory:cwd});if(!configuration.data?.agent)throw new Error('resolved provider configuration was not available');const sessionFlag=process.argv.findIndex(value=>value==='--session'||value==='-s');const resumed=sessionFlag>=0?process.argv[sessionFlag+1]:undefined;const result=resumed?await api.client.session.get({directory:cwd,sessionID:resumed}):await api.client.session.create({directory:cwd,title:'Managed fixture'});if(!result.data?.id||(resumed&&result.data.id!==resumed))throw new Error('native session creation or resume failed');api.route.navigate('session',{sessionID:result.data.id});
 const receipt={...options,terminalId:process.env.FRESHELL_TERMINAL_ID,nativeSessionId:result.data.id,bun:typeof Bun==='object',bunVersion:Bun.version,bunExecutable:process.execPath,opencodeVersion:api.app.version,model:configuration.data.model,dependency,resource,absoluteReference:configuration.data.agent.fixtureAbsolute.prompt,relativeReference:configuration.data.agent.fixtureRelative.prompt,executableMode:(fs.statSync(command).mode&511).toString(8).padStart(4,'0'),pid:process.pid,createdAt:new Date().toISOString()};
 fs.writeFileSync(path.join(cwd,'.managed-fixture/child-receipt.json'),JSON.stringify(receipt));const marker='MANAGED_ENV_OUTPUT '+output.resource;process.stdout.write('\\n'+marker+'\\n');api.ui.toast.show({message:marker,duration:180000});
}};`)
  await writeJson(path.join(mcpPackage, 'package.json'), {
    type: 'module',
    scripts: { 'mcp.js': 'bun ./server.mjs' },
  })
  await fs.writeFile(path.join(mcpPackage, 'server.mjs'), managedMcpServerSource)
  const directCommand = path.join(directMcp, 'start')
  await fs.writeFile(directCommand,
    '#!/bin/sh\ncd "$(dirname "$0")"\nSCRIPT_DIR=$(dirname "$0")\n. "$SCRIPT_DIR/helper.sh"\nexec node --env-file=.env "$SCRIPT_DIR/server.mjs" "$@"\n',
    { mode: 0o751 })
  await fs.chmod(directCommand, 0o751)
  await fs.writeFile(path.join(directMcp, 'helper.sh'),
    `export MANAGED_DIRECT_MCP_HELPER='${nonce}'\n`)
  await fs.writeFile(path.join(directMcp, 'helper.mjs'), `export default ${JSON.stringify(nonce)};\n`)
  await fs.writeFile(path.join(directMcp, 'schema.json'), JSON.stringify({ nonce }))
  await writeJson(path.join(directMcpDependency, 'package.json'), {
    name: 'managed-direct-fixture-dependency',
    type: 'module',
    exports: './index.mjs',
  })
  await fs.writeFile(path.join(directMcpDependency, 'index.mjs'), `export default ${JSON.stringify(nonce)};\n`)
  await fs.writeFile(path.join(directMcp, 'server.mjs'), directMcpServerSource)
  await writeJson(path.join(mcpParentDependency, 'package.json'), {
    name: 'managed-fixture-mcp-dependency',
    type: 'module',
    exports: './index.mjs',
  })
  await fs.writeFile(path.join(mcpParentDependency, 'index.mjs'), `export default ${JSON.stringify(nonce)};`)
  const absoluteRule = path.join(resources, 'absolute-rule.txt')
  await fs.writeFile(absoluteRule, nonce, { mode: 0o600 })
  const options = { expectedNonce: nonce, candidateSha, runId }
  await writeJson(path.join(xdg, 'opencode/opencode.json'), { model: managedEnvironmentFixtureModel,
    plugin: [[plugin, options]], agent: { fixtureAbsolute: { prompt: `{file:${absoluteRule}}` } } })
  await writeJson(path.join(xdg, 'opencode/tui.json'), { plugin: [[plugin, options]] })
  for (const scenario of [...scenarios, 'preflight']) {
    const cwd = path.join(workspace, scenario)
    await fs.mkdir(path.join(cwd, '.managed-fixture'), { recursive: true, mode: 0o777 })
    await fs.chmod(cwd, 0o777)
    await fs.chmod(path.join(cwd, '.managed-fixture'), 0o777)
    await fs.writeFile(path.join(cwd, 'rules.txt'), nonce, { mode: 0o600 })
    const mcpReceipt = path.join(cwd, '.managed-fixture/mcp-receipt.json')
    const cwdAliasWrapper = path.join(cwd, '.managed-fixture/mcp-cwd-alias/start')
    const cwdAliasReceipt = path.join(cwd, '.managed-fixture/mcp-cwd-alias-receipt.json')
    await fs.mkdir(path.dirname(cwdAliasWrapper), { recursive: true, mode: 0o755 })
    await fs.writeFile(cwdAliasWrapper, workspaceCwdAliasMcpWrapperSource(), { mode: 0o751 })
    await fs.chmod(cwdAliasWrapper, 0o751)
    const homeAppend = managedHomeAppendFixturePaths(home, cwd, scenario)
    await fs.writeFile(homeAppend.script, directHomeAppendMcpServerSource(path.basename(homeAppend.output)))
    await fs.writeFile(homeAppend.output, `initial-${nonce}`)
    await fs.writeFile(homeAppend.envFile, `FRESHELL_MANAGED_SHARED_ENV=${nonce}\n`, { mode: 0o600 })
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await fs.writeFile(homeAppend.wrapper, `#!/bin/sh
set +e
SCRIPT_DIR=$(dirname "$0")
receipt=$1
expected=$2
started="${'${receipt}'}.started"
printf '%s' wrapper-started > "$started"
diagnostic=$(mktemp)
node --env-file=${shellQuote(homeAppend.envFile)} "$SCRIPT_DIR/${path.basename(homeAppend.script)}" "$receipt" "$expected" 2>"$diagnostic"
status=$?
if [ "$status" -ne 0 ]; then
  has_enoent=false
  has_eacces=false
  has_env_file_error=false
  has_syntax_error=false
  grep -q 'ENOENT' "$diagnostic" && has_enoent=true
  grep -q 'EACCES' "$diagnostic" && has_eacces=true
  grep -qi 'env file' "$diagnostic" && has_env_file_error=true
  grep -q 'SyntaxError' "$diagnostic" && has_syntax_error=true
  printf '{"wrapperStarted":true,"nodeExitCode":%s,"stderrHasENOENT":%s,"stderrHasEACCES":%s,"stderrHasEnvFileError":%s,"stderrHasSyntaxError":%s}' "$status" "$has_enoent" "$has_eacces" "$has_env_file_error" "$has_syntax_error" > "$receipt"
fi
rm -f "$diagnostic"
exit "$status"
`, { mode: 0o751 })
    await fs.chmod(homeAppend.wrapper, 0o751)
    await writeJson(path.join(cwd, 'opencode.json'), { model: managedEnvironmentFixtureModel, agent: { fixtureRelative: {
      prompt: `{file:./${scenario === 'missing-reference' ? 'missing-selected.txt' : 'rules.txt'}}` } },
      mcp: {
        managed_fixture: {
          type: 'local',
          command: ['bun', 'run', 'mcp.js', mcpReceipt, nonce],
          cwd: mcpNested,
          enabled: true,
          environment: { FRESHELL_EXPECTED_MCP_CWD: mcpNested },
        },
        direct_script_fixture: {
          type: 'local',
          command: [directCommand, path.join(cwd, '.managed-fixture/direct-mcp-receipt.json'), nonce],
          enabled: true,
        },
        workspace_cwd_alias_fixture: {
          type: 'local',
          command: [cwdAliasWrapper, cwdAliasReceipt, nonce],
          cwd: cwdAliasProject,
          enabled: true,
        },
        direct_home_append_fixture: {
          type: 'local',
          command: [homeAppend.wrapper, homeAppend.receipt, nonce],
          enabled: true,
        },
      },
    })
  }
  return { home, xdg, workspace, command, mcpPackage, mcpNested, cwdAliasProject }
}

async function socketCreate(rig: ManagedRuntimeBrowserRig, requestId: string, mode: 'shell' | 'opencode', cwd: string,
  capabilities?: Record<string, true>) {
  const ws = new WebSocket(rig.info.wsUrl)
  const messages: any[] = []
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
  ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())))
  try {
    await bounded(new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) }),
      30_000, 'owned WebSocket open')
    const hello = { type: 'hello', token: rig.info.token, protocolVersion: WS_PROTOCOL_VERSION,
      ...(capabilities ? { capabilities } : {}) } satisfies ClientMessage
    ws.send(JSON.stringify(hello))
    const ready = await poll('authenticated ready', async () => messages.find(message => message.type === 'ready'), 30_000)
    if (capabilities?.managedRuntimeV1) assert.equal(ready.capabilities?.managedRuntimeV1, true)
    const create = { type: 'terminal.create', requestId, mode, shell: 'system', cwd } satisfies ClientMessage
    ws.send(JSON.stringify(create))
    return await poll('terminal create response', async () => messages.find(message =>
      message.requestId === requestId && (message.type === 'terminal.created' || message.type === 'error')), 120_000)
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) ws.close()
    try { await bounded(closed, 5_000, 'owned WebSocket close') }
    catch { ws.terminate(); await bounded(closed, 5_000, 'owned WebSocket terminate join') }
  }
}

async function stageProof(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView, nonce: string) {
  const base = path.join(rig.runtime.scenarioPath(rig.supervisor.scenarioId), 'control')
  for (const generation of await fs.readdir(path.join(base, 'provider-roots'))) {
    const capability = await readJson(path.join(base, 'mcp-capabilities', `${generation}.json`))
    if (capability?.soulId !== view.soulId || (capability.incarnationId && capability.incarnationId !== view.incarnationId)) continue
    const stageRoot = path.join(base, 'provider-roots', generation)
    const context = await readJson(path.join(stageRoot, '.freshell/prepared-context.json'))
    if (context?.preparedInputs?.generationId !== generation) continue
    const manifest = await fs.readFile(path.join(stageRoot, '.freshell/input-manifest.json'))
    assert.equal(digest(manifest), context.preparedInputs.manifest.sha256)
    const selected: string[] = []
    let entries = 0
    async function walk(directory: string, depth = 0) {
      assert(depth <= 64, 'Owned controller-stage observation exceeded its depth bound')
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        assert(++entries <= 100_000, 'Owned controller-stage observation exceeded its entry bound')
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(file, depth + 1)
        else if (entry.isFile() && entry.name === 'command') {
          assert((await fs.stat(file)).size <= 4096, 'Synthetic selected command changed beyond its finite fixture size')
          if ((await fs.readFile(file, 'utf8')).includes(nonce)) selected.push(file)
        }
      }
    }
    await walk(stageRoot)
    if (!selected.length) continue
    for (const file of selected) assert.equal(requireMode(await fs.stat(file)), '0751')
    return { observed: true, generation, manifestSha256: digest(manifest), executableMode: '0751', terminalId: view.terminalId,
      soulId: view.soulId, incarnationId: view.incarnationId }
  }
  throw new Error('No current owned controller stage contains the selected executable')
}

const requireMode = (metadata: { mode: number }) => (metadata.mode & 0o777).toString(8).padStart(4, '0')

const checkpointTargetLauncher = String.raw`import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const root = '/tmp/freshell-checkpoint-fixture'
const uid = Number(process.env.FRESHELL_CHECKPOINT_FIXTURE_UID)
assert.equal(process.env.FRESHELL_CHECKPOINT_FIXTURE_ROOT, root)
assert(Number.isSafeInteger(uid) && uid > 0)
assert.equal(process.getuid(), uid, 'fixture setup must run as restricted UID B')
// The sandbox entrypoint's gosu handoff resets HOME to /home/sandbox. Restore
// the explicitly staged synthetic account home so validate-dir exercises the
// same account-home exclusion that this fixture advertises to the browser.
process.env.HOME = path.join(root, 'home')
const status = fs.readFileSync('/proc/self/status', 'utf8')
const capabilities = status.match(/^CapEff:\s+([0-9a-f]+)$/m)?.[1]
assert.equal(capabilities, '0000000000000000', 'fixture UID B must have no effective capabilities')

const project = path.join(root, 'project')
const linkedWorktree = path.join(root, 'linked-worktree')
const home = path.join(root, 'home')
const storage = path.join(root, 'storage')
const control = path.join(root, 'control')
const deniedFile = path.join(project, 'private-file.ignored')
const deniedDirectory = path.join(project, 'private-dir.ignored')
const mode = (selected) => fs.lstatSync(selected).mode & 0o777
function assertDeniedFile(selected) {
  assert.throws(() => fs.readFileSync(selected), { code: 'EACCES' })
}
function assertDeniedDirectory(selected) {
  assert.throws(() => fs.readdirSync(selected), { code: 'EACCES' })
}
const fileStat = fs.lstatSync(deniedFile)
const directoryStat = fs.lstatSync(deniedDirectory)
assert.equal(fileStat.uid, 0)
assert.equal(mode(deniedFile), 0o600)
assert.equal(directoryStat.uid, 0)
assert.equal(mode(deniedDirectory), 0o700)
assertDeniedFile(deniedFile)
assertDeniedDirectory(deniedDirectory)
const eligibleFile = path.join(project, 'private-file')
const eligibleDirectory = path.join(project, 'private-dir')
fs.renameSync(deniedFile, eligibleFile)
assertDeniedFile(eligibleFile)
fs.renameSync(eligibleFile, deniedFile)
fs.renameSync(deniedDirectory, eligibleDirectory)
assertDeniedDirectory(eligibleDirectory)
fs.renameSync(eligibleDirectory, deniedDirectory)
assert.deepEqual([fs.lstatSync(deniedFile).uid, mode(deniedFile)], [0, 0o600])
assert.deepEqual([fs.lstatSync(deniedDirectory).uid, mode(deniedDirectory)], [0, 0o700])

fs.mkdirSync(control, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(project, '.freshell-checkpoint-fixture'), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(project, 'nested'), { recursive: true, mode: 0o755 })
fs.writeFileSync(path.join(project, 'main.rs'), 'main before checkpoint\n')
fs.writeFileSync(path.join(project, 'notes.txt'), 'notes before checkpoint\n')
fs.writeFileSync(path.join(project, 'nested/rewind.txt'), 'nested before checkpoint\n')
fs.writeFileSync(path.join(project, 'run.sh'), '#!/bin/sh\necho before\n', { mode: 0o755 })
fs.symlinkSync('main.rs', path.join(project, 'main-link'))
execFileSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['config', 'user.name', 'Freshell checkpoint fixture'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['add', '--', '.gitignore', 'main.rs', 'notes.txt', 'run.sh', 'main-link', 'nested/rewind.txt'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['commit', '-q', '-m', 'synthetic checkpoint fixture'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['worktree', 'add', '-q', '-b', 'checkpoint-e2e-linked-worktree', linkedWorktree, 'HEAD'], {
  cwd: project,
  stdio: 'ignore',
})

const nonGit = path.join(root, 'non-git')
fs.mkdirSync(nonGit, { mode: 0o755 })
fs.writeFileSync(path.join(nonGit, 'one.txt'), 'one before checkpoint\n')
fs.writeFileSync(path.join(nonGit, 'two.txt'), 'two before checkpoint\n')
fs.mkdirSync(path.join(home, '.freshell'), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(home, '.codex'), { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(storage, 'logs'), { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(home, '.freshell', 'config.json'), JSON.stringify({ version: 1, settings: {
  network: { configured: true, host: '127.0.0.1' },
  freshAgent: { enabled: true, initialSetupDone: true, defaultPlugins: [], providers: {} },
  codingCli: { enabledProviders: ['codex'], providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } } },
} }))
fs.writeFileSync(path.join(control, 'initialization.json'), JSON.stringify({ restrictedUid: uid,
  effectiveCapabilities: capabilities, privateFileDenied: true, privateDirectoryDenied: true,
  privateFileUid: fileStat.uid, privateFileMode: '0600', privateDirectoryUid: directoryStat.uid,
  privateDirectoryMode: '0700', sameParentRenameVerified: true, nonGitWorkspace: nonGit }))
console.log(JSON.stringify({ severity: 'info', event: 'code_checkpoint.target_fixture_initialized',
  restrictedUid: uid, effectiveCapabilities: capabilities, privateFileDenied: true,
  privateDirectoryDenied: true, sameParentRenameVerified: true }))

const child = spawn('/checkpoint-target/freshell-server', [], { stdio: 'inherit', env: process.env })
child.once('error', (error) => { console.error(error.message); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
const exit = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal }))
})
if (exit.signal) process.exitCode = 1
else process.exitCode = exit.code ?? 1
`

const checkpointTargetControl = String.raw`import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const [action, requestId, expectedUidText] = process.argv.slice(2)
const expectedUid = Number(expectedUidText)
assert(['eligible', 'ignored'].includes(action))
assert(/^[a-zA-Z0-9-]{1,96}$/.test(requestId ?? ''))
assert(Number.isSafeInteger(expectedUid) && expectedUid > 0)
assert.equal(process.getuid(), expectedUid, 'control must run as restricted UID B')
const capabilities = fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s+([0-9a-f]+)$/m)?.[1]
assert.equal(capabilities, '0000000000000000', 'control must not receive capabilities')
const project = '/tmp/freshell-checkpoint-fixture/project'
const from = path.join(project, action === 'eligible' ? 'private-file.ignored' : 'private-file')
const to = path.join(project, action === 'eligible' ? 'private-file' : 'private-file.ignored')
if (fs.existsSync(from)) fs.renameSync(from, to)
const privatePath = action === 'eligible' ? to : path.join(project, 'private-file.ignored')
const privateStat = fs.lstatSync(privatePath)
assert.equal(privateStat.uid, 0)
assert.equal(privateStat.mode & 0o777, 0o600)
assert.throws(() => fs.readFileSync(privatePath), { code: 'EACCES' })
const root = '/tmp/freshell-checkpoint-fixture/control'
const ack = path.join(root, 'ack-' + requestId + '.json')
fs.writeFileSync(ack, JSON.stringify({ requestId, action, restrictedUid: expectedUid,
  privateFileUid: privateStat.uid, privateFileMode: '0600', privateFileDenied: true,
  effectiveCapabilities: capabilities }), { flag: 'wx', mode: 0o600 })
`

function docker(args: string[], timeout = 30_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim()
}

function dockerMaybe(args: string[], timeout = 10_000): string | undefined {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout })
  if (result.error) throw result.error
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

function cancelOwnedCloudExecution(executionName: string, candidateSha: string): Record<string, unknown> {
  assert.match(executionName, new RegExp(`^freshell-e2e-${candidateSha.slice(0, 12)}-[a-z0-9-]+$`),
    'Refusing to cancel a Cloud execution not created for this checkpoint candidate')
  const account = process.env.FRESHELL_GCP_ACCOUNT ?? process.env.GCLOUD_IDENT
  const args = ['run', 'jobs', 'executions', 'cancel', executionName, '--quiet',
    `--project=${process.env.FRESHELL_GCP_PROJECT ?? 'misc-puttering-project'}`,
    `--region=${process.env.FRESHELL_GCP_REGION ?? 'us-west1'}`]
  if (account) args.push(`--account=${account}`)
  const result = spawnSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Owned Cloud checkpoint execution cancellation failed: ${(result.stderr ?? '').trim().slice(-1500)}`)
  return { executionName, cancelled: true }
}

function assertDirectEgressBlocked(containerId: string, subject: string): Record<string, unknown> {
  const probe = String.raw`
const net = require('node:net')
let settled = false
const socket = net.createConnection({ host: '1.1.1.1', port: 443 })
const blocked = reason => {
  if (settled) return
  settled = true
  console.log(JSON.stringify({ blocked: true, reason }))
  socket.destroy()
}
socket.setTimeout(1500)
socket.once('connect', () => {
  settled = true
  console.error(JSON.stringify({ blocked: false }))
  socket.destroy()
  process.exitCode = 1
})
socket.once('error', error => blocked(error.code ?? 'connection-failed'))
socket.once('timeout', () => blocked('timeout'))
`
  const result = docker(['exec', containerId, '/usr/local/bin/node', '-e', probe], 5_000)
  const evidence = JSON.parse(result) as Record<string, unknown>
  assert.equal(evidence.blocked, true, `${subject} unexpectedly reached the external egress probe`)
  return evidence
}

async function makeStageTreeReadable(directory: string): Promise<void> {
  await fs.chmod(directory, 0o755)
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const selected = path.join(directory, entry.name)
    if (entry.isDirectory()) await makeStageTreeReadable(selected)
    else if (entry.isFile()) await fs.chmod(selected, 0o444)
    else throw new Error(`Unexpected non-file in staged checkpoint input: ${selected}`)
  }
}

async function stageCheckpointTarget(stage: string, repoRoot: string): Promise<void> {
  await fs.mkdir(stage, { recursive: true, mode: 0o700 })
  const binary = path.join(repoRoot, 'target/debug/freshell-server')
  const client = path.join(repoRoot, 'dist/client')
  assert((await fs.stat(binary)).isFile(), 'Feature-enabled checkpoint server binary is missing')
  assert((await fs.stat(client)).isDirectory(), 'Built client assets are missing')
  await fs.copyFile(binary, path.join(stage, 'freshell-server'))
  await fs.chmod(path.join(stage, 'freshell-server'), 0o555)
  await fs.cp(client, path.join(stage, 'client'), { recursive: true, dereference: true, preserveTimestamps: false })
  await makeStageTreeReadable(path.join(stage, 'client'))
  // The restricted server runs outside the repository cwd, so stage the real
  // Codex CLI manifest that makes the provider visible to the pane picker.
  const codexExtension = path.join(stage, 'extensions', 'codex-cli')
  await fs.mkdir(path.dirname(codexExtension), { recursive: true, mode: 0o755 })
  await fs.cp(path.join(repoRoot, 'extensions', 'codex-cli'), codexExtension,
    { recursive: true, dereference: true, preserveTimestamps: false })
  await makeStageTreeReadable(path.join(stage, 'extensions'))
  await fs.copyFile(path.resolve(repoRoot, 'docker/sandbox/entrypoint.sh'), path.join(stage, 'sandbox-entrypoint.sh'))
  await fs.chmod(path.join(stage, 'sandbox-entrypoint.sh'), 0o555)
  const launcher = path.join(stage, 'launch.mjs')
  await fs.writeFile(launcher, checkpointTargetLauncher, { mode: 0o444 })
  await fs.chmod(launcher, 0o444)
  const control = path.join(stage, 'control.mjs')
  await fs.writeFile(control, checkpointTargetControl, { mode: 0o444 })
  await fs.chmod(control, 0o444)
  const fake = path.resolve(repoRoot, 'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs')
  await fs.copyFile(fake, path.join(stage, 'fake-app-server.mjs'))
  await fs.chmod(path.join(stage, 'fake-app-server.mjs'), 0o444)
  // CLI discovery runs `which` on CODEX_CMD, so expose the multi-argument fake
  // app-server command through a discoverable single-word executable.
  const fakeCodex = path.join(stage, 'fake-codex')
  await fs.writeFile(fakeCodex,
    '#!/bin/sh\nexec /usr/local/bin/node /checkpoint-target/fake-app-server.mjs "$@"\n', { mode: 0o555 })
  await fs.chmod(fakeCodex, 0o555)
  const require = createRequire(import.meta.url)
  const wsRoot = path.dirname(require.resolve('ws'))
  const nodeModules = path.join(stage, 'node_modules')
  await fs.mkdir(nodeModules, { mode: 0o700 })
  const stagedWebSocket = path.join(nodeModules, 'ws')
  await fs.cp(wsRoot, stagedWebSocket, { recursive: true, dereference: true, preserveTimestamps: false })
  await makeStageTreeReadable(stagedWebSocket)
  // Rootless Docker maps container UIDs into a private host range, so the
  // numerically matching sandbox UID still cannot traverse a host-owned 0700
  // bind-mount root. The mount itself is read-only; grant traversal at the
  // root and keep copied package contents readable so the restricted process
  // can load its entrypoint and dependencies.
  await fs.chmod(nodeModules, 0o755)
  await fs.chmod(stage, 0o711)
}

function restrictedIdentity(): { uid: number; gid: number } {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  if (!dockerMaybe(['image', 'inspect', '--format', '{{.Id}}', checkpointImage])) {
    execFileSync(path.join(repoRoot, 'scripts/sandbox-build.sh'), { cwd: repoRoot, stdio: 'inherit' })
  }
  const readIdentity = () => ({
    uid: Number(docker(['run', '--rm', '--read-only', '--network', 'none', '--entrypoint', '/usr/bin/id',
      checkpointImage, '-u', 'sandbox'])),
    gid: Number(docker(['run', '--rm', '--read-only', '--network', 'none', '--entrypoint', '/usr/bin/id',
      checkpointImage, '-g', 'sandbox'])),
  })
  let { uid, gid } = readIdentity()
  if (uid !== process.getuid() || gid !== process.getgid()) {
    execFileSync(path.join(repoRoot, 'scripts/sandbox-build.sh'), { cwd: repoRoot, stdio: 'inherit' })
    const rebuiltIdentity = readIdentity()
    uid = rebuiltIdentity.uid
    gid = rebuiltIdentity.gid
  }
  assert(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0,
    'Sandbox image must provide its fixed non-root restricted identity')
  return { uid, gid }
}

export async function externalTargetRead(
  baseUrl: string,
  token: string,
  selected: string,
  dependencies: { fetcher?: typeof fetch; wait?: (milliseconds: number) => Promise<void> } = {},
): Promise<any | undefined> {
  const fetchTarget = dependencies.fetcher ?? fetch
  const wait = dependencies.wait ?? delay
  let retries = 0
  while (true) {
    const response = await fetchTarget(`${baseUrl}/api/files/read?path=${encodeURIComponent(selected)}`, {
      headers: { 'x-auth-token': token }, signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 429 && retries < targetReadRateLimitRetries) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'))
      await response.body?.cancel()
      await wait(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 1_000)
      retries += 1
      continue
    }
    if (response.status === 404) return undefined
    assert(response.ok, `Owned checkpoint target control read failed with HTTP ${response.status}`)
    const body = await response.json() as { content?: unknown }
    assert(typeof body.content === 'string')
    return JSON.parse(body.content)
  }
}

async function externalTargetWrite(baseUrl: string, token: string, selected: string, content: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/files/write`, {
    method: 'POST',
    headers: { 'x-auth-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ path: selected, content }),
    signal: AbortSignal.timeout(15_000),
  })
  assert(response.ok, `Owned checkpoint target control write failed with HTTP ${response.status}`)
}

function runCheckpointControl(containerId: string, identity: { uid: number; gid: number }, action: 'eligible' | 'ignored', requestId: string): void {
  try {
    execFileSync('docker', ['exec', '--user', `${identity.uid}:${identity.gid}`, containerId,
      '/usr/local/bin/node', '/checkpoint-target/control.mjs', action, requestId, String(identity.uid)],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      status?: number | null; signal?: NodeJS.Signals | null; stderr?: Buffer | string; stdout?: Buffer | string
    }
    const stderr = Buffer.isBuffer(commandError.stderr) ? commandError.stderr.toString('utf8') : commandError.stderr
    const stdout = Buffer.isBuffer(commandError.stdout) ? commandError.stdout.toString('utf8') : commandError.stdout
    const details = [
      commandError.status === null || commandError.status === undefined ? undefined : `exit=${commandError.status}`,
      commandError.signal ? `signal=${commandError.signal}` : undefined,
      stderr?.trim() ? `stderr=${stderr.trim().slice(-2048)}` : undefined,
      stdout?.trim() ? `stdout=${stdout.trim().slice(-1024)}` : undefined,
      !stderr?.trim() && !stdout?.trim() ? commandError.message : undefined,
    ].filter(Boolean).join('; ')
    throw new Error(`Restricted checkpoint control ${requestId} (${action}) failed${details ? `: ${details}` : ''}`, { cause: error })
  }
}

async function verifyCheckpointControl(
  baseUrl: string,
  token: string,
  containerId: string,
  identity: { uid: number; gid: number },
  fixture: { expectedNonce: string },
  action: 'eligible' | 'ignored',
): Promise<Record<string, unknown>> {
  const requestId = randomUUID()
  await externalTargetWrite(baseUrl, token, checkpointControlRequest, JSON.stringify({ action, expectedNonce: fixture.expectedNonce, requestId }))
  runCheckpointControl(containerId, identity, action, requestId)
  const ack = await poll(`restricted fixture control acknowledgement ${requestId}`, async () =>
    externalTargetRead(baseUrl, token, checkpointControlAck(requestId)), 15_000)
  assert.deepEqual(ack, { requestId, action, restrictedUid: identity.uid, privateFileUid: 0,
    privateFileMode: '0600', privateFileDenied: true, effectiveCapabilities: '0000000000000000' })
  return { requestId, action, restrictedUid: identity.uid, privateFileDenied: true,
    effectiveCapabilities: ack.effectiveCapabilities }
}

async function serveCheckpointControls(
  baseUrl: string,
  token: string,
  containerId: string,
  identity: { uid: number; gid: number },
  fixture: { expectedNonce: string },
  browser: ChildProcess,
  proof: Record<string, unknown>,
): Promise<void> {
  const processed = new Set<string>()
  while (browser.exitCode === null && browser.signalCode === null) {
    const request = await externalTargetRead(baseUrl, token, checkpointControlRequest)
    if (request && typeof request.requestId === 'string' && !processed.has(request.requestId)) {
      assert.deepEqual(Object.keys(request).sort(), ['action', 'expectedNonce', 'requestId'])
      assert.equal(request.expectedNonce, fixture.expectedNonce, 'Fixture control nonce did not match this owned run')
      assert(['eligible', 'ignored'].includes(request.action), 'Fixture requested an unsupported private-path state')
      assert.match(request.requestId, /^[a-zA-Z0-9-]{1,96}$/)
      processed.add(request.requestId)
      runCheckpointControl(containerId, identity, request.action, request.requestId)
      const ack = await poll(`restricted fixture control acknowledgement ${request.requestId}`, async () => {
        return externalTargetRead(baseUrl, token, checkpointControlAck(request.requestId))
      }, 15_000)
      assert.deepEqual(ack, { requestId: request.requestId, action: request.action, restrictedUid: identity.uid,
        privateFileUid: 0, privateFileMode: '0600', privateFileDenied: true, effectiveCapabilities: '0000000000000000' })
      const controls = (proof.controls ??= []) as unknown[]
      controls.push({ requestId: request.requestId, action: request.action, restrictedUid: identity.uid,
        privateFileDenied: true, effectiveCapabilities: ack.effectiveCapabilities })
    }
    // Each read consumes the target's authenticated API budget shared with
    // browser traffic. Keep fixture-control polling below that request rate.
    await delay(checkpointControlPollIntervalMs)
  }
}

export function buildManagedEnvironmentClient(repoRoot: string, candidateSha: string): void {
  assert.match(candidateSha, /^[a-f0-9]{40}$/, 'Managed acceptance requires a known worktree commit')
  execFileSync('pnpm', ['run', 'build:client'], {
    cwd: repoRoot,
    env: { ...process.env, FRESHELL_BUILD_COMMIT: candidateSha },
    stdio: 'inherit',
  })
}

export async function runCodeCheckpointTarget() {
  assert.equal(process.env.FRESHELL_E2E_BACKEND, 'cloud', 'Checkpoint acceptance requires configured Cloud')
  assert.equal(process.env.GCLOUD_ROBOT_REQUIRE, '1', 'Checkpoint acceptance requires the robot identity')
  assert.equal(process.env.GCLOUD_ROBOT_ACCOUNT, 'gcloud-robot@misc-puttering-project.iam.gserviceaccount.com')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }).trim()
  assert.match(candidateSha, /^[a-f0-9]{40}$/)
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }).trim()
  assert.equal(dirty, '', 'Checkpoint Cloud acceptance must build an exact committed candidate')
  execFileSync('mise', ['exec', 'rust@1.96', '--', 'cargo', 'build', '-p', 'freshell-server',
    '--features', 'managed-runtime-v1', '--locked'], {
    cwd: repoRoot, env: { ...process.env, FRESHELL_BUILD_COMMIT: candidateSha }, stdio: 'inherit',
  })
  buildManagedEnvironmentClient(repoRoot, candidateSha)

  const runId = randomUUID()
  const expectedNonce = randomUUID()
  const identity = restrictedIdentity()
  assert.equal(identity.uid, process.getuid(), 'Sandbox image UID must match the invoking test owner for read-only fixture mounts')
  assert.equal(identity.gid, process.getgid(), 'Sandbox image GID must match the invoking test owner for read-only fixture mounts')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-code-checkpoint-'))
  const stage = path.join(root, 'artifacts')
  const token = randomUUID()
  const fixture = {
    candidateSha,
    runId,
    syntheticWorkspacePath: path.join(checkpointFixtureRoot, 'project'),
    linkedWorktreePath: path.join(checkpointFixtureRoot, 'linked-worktree'),
    syntheticHomePath: path.join(checkpointFixtureRoot, 'home'),
    nonGitWorkspacePath: path.join(checkpointFixtureRoot, 'non-git'),
    restrictedUid: identity.uid,
    expectedNonce,
  }
  const proof: Record<string, unknown> = { candidateSha, runId, fixture, image: checkpointImage }
  const networkName = `freshell-checkpoint-${runId.slice(0, 8)}`
  const forwarderNetworkName = `freshell-checkpoint-forwarder-${runId.slice(0, 8)}`
  const containerName = `freshell-checkpoint-${runId.slice(0, 8)}`
  const forwarderContainerName = `freshell-checkpoint-forwarder-${runId.slice(0, 8)}`
  const containerIdPath = path.join(root, 'container.id')
  const dockerEnvPath = path.join(root, 'target.env')
  const cloudDispatchReceiptPath = path.join(root, 'cloud-execution-dispatch.json')
  const evidenceDir = path.join(repoRoot, '.runtime-evidence', candidateSha, runId)
  const receiptPath = path.join(evidenceDir, 'code-checkpoint-acceptance.json')
  let networkId: string | undefined
  let forwarderNetworkId: string | undefined
  let containerId: string | undefined
  let forwarderContainerId: string | undefined
  let dockerRun: ChildProcess | undefined, dockerRunIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined,
    dockerRunJoin: Promise<NativeExit> | undefined
  let tunnel: ChildProcess | undefined, tunnelIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined,
    tunnelJoin: Promise<NativeExit> | undefined
  let browser: ChildProcess | undefined, browserIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined,
    browserJoin: Promise<NativeExit> | undefined
  let dockerStdout = '', dockerStderr = ''
  let primaryFailure: unknown
  const browserSummaryCapture = new ManagedEnvironmentBrowserSummaryCapture()
  try {
    await stageCheckpointTarget(stage, repoRoot)
    await fs.writeFile(dockerEnvPath, [
      `AUTH_TOKEN=${token}`,
      `PORT=${checkpointContainerPort}`,
      'NODE_ENV=production',
      'FRESHELL_BIND_HOST=0.0.0.0',
      'FRESHELL_DISABLE_WSL_PORT_FORWARD=1',
      'HIDE_STARTUP_TOKEN=true',
      'FRESHELL_EXTENSIONS_DIR=/checkpoint-target/extensions',
      `FRESHELL_HOME=${fixture.syntheticHomePath}`,
      `HOME=${fixture.syntheticHomePath}`,
      `CODEX_HOME=${fixture.syntheticHomePath}/.codex`,
      `FRESHELL_LOG_DIR=${checkpointFixtureRoot}/storage/logs`,
      'FRESHELL_CLIENT_DIR=/checkpoint-target/client',
      'CODEX_CMD=/checkpoint-target/fake-codex',
      'FAKE_CODEX_APP_SERVER_BEHAVIOR={"recordTurns":true,"uniqueThreadIds":true,"persistRolloutUserMessages":true}',
      'FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES=1',
      `FRESHELL_CHECKPOINT_FIXTURE_ROOT=${checkpointFixtureRoot}`,
      `FRESHELL_CHECKPOINT_FIXTURE_UID=${identity.uid}`,
      'FRESHELL_SANDBOX_MODE=runtime-suite',
      'FRESHELL_SANDBOX_CHECKPOINT_FIXTURE=1',
      '',
    ].join('\n'), { mode: 0o600 })

    networkId = docker(['network', 'create', '--driver', 'bridge', '--internal', '--label', 'freshell.owner=checkpoint-acceptance',
      '--label', `freshell.run-id=${runId}`, networkName])
    assert.match(networkId, /^[a-f0-9]{64}$/)
    const networkDetails = docker(['network', 'inspect', '--format', '{{.Id}} {{index .Labels "freshell.run-id"}} {{.Internal}}', networkId])
    assert.equal(networkDetails, `${networkId} ${runId} true`, 'Checkpoint network must be internally isolated and owned by this run')
    forwarderNetworkId = docker(['network', 'create', '--driver', 'bridge',
      '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
      '--label', 'freshell.owner=checkpoint-acceptance', '--label', `freshell.run-id=${runId}`, forwarderNetworkName])
    assert.match(forwarderNetworkId, /^[a-f0-9]{64}$/)
    const forwarderNetworkDetails = docker(['network', 'inspect', '--format',
      '{{.Id}} {{index .Labels "freshell.run-id"}} {{.Internal}} {{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}', forwarderNetworkId])
    assert.equal(forwarderNetworkDetails, `${forwarderNetworkId} ${runId} false false`,
      'Loopback forwarder network must disable outbound masquerading and be owned by this run')

    const dockerArgs = [
      'run', '--rm', '--init', '--name', containerName, '--cidfile', containerIdPath,
      '--label', 'freshell.owner=checkpoint-acceptance', '--label', `freshell.run-id=${runId}`,
      '--network', networkId,
      '--pids-limit', '512', '--memory', '4g', '--read-only', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--tmpfs', '/workspace:rw,nosuid,nodev,size=64m',
      '--tmpfs', '/usr/local/cargo:rw,nosuid,nodev,size=256m',
      '--tmpfs', '/home/sandbox/.cache:rw,nosuid,nodev,size=256m',
      '--mount', `type=bind,source=${stage},target=/checkpoint-target,readonly`,
      '--env-file', dockerEnvPath, '--entrypoint', '/checkpoint-target/sandbox-entrypoint.sh',
      checkpointImage, '/usr/local/bin/node', '/checkpoint-target/launch.mjs',
    ]
    dockerRun = spawn('docker', dockerArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    dockerRunJoin = joinedAfterOutput(dockerRun); dockerRunJoin.catch(() => {})
    dockerRun.stdout!.on('data', (chunk: Buffer) => {
      dockerStdout = (dockerStdout + chunk.toString()).slice(-262_144)
    })
    dockerRun.stderr!.on('data', (chunk: Buffer) => {
      dockerStderr = (dockerStderr + chunk.toString()).slice(-262_144)
    })
    dockerRunIdentity = await processIdentity(dockerRun)
    containerId = await poll('owned checkpoint container identity', async () => {
      const contents = await fs.readFile(containerIdPath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (contents) return contents.trim()
      assert.equal(dockerRun!.exitCode, null, 'Owned checkpoint container exited before publishing its ID')
      return undefined
    }, 60_000)
    assert.match(containerId, /^[a-f0-9]{64}$/)
    const containerDetails = docker(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "freshell.run-id"}}', containerId])
    assert.equal(containerDetails, `${containerId} ${runId}`, 'Checkpoint container ownership labels did not match this run')
    const targetAddress = docker(['container', 'inspect', '--format', `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`, containerId])
    assert.match(targetAddress, /^(?:\d{1,3}\.){3}\d{1,3}$/, 'Restricted checkpoint target did not receive an IPv4 address')
    const targetEgress = assertDirectEgressBlocked(containerId, 'Restricted checkpoint target')

    const forwarderArgs = [
      'run', '--detach', '--rm', '--init', '--name', forwarderContainerName,
      '--label', 'freshell.owner=checkpoint-acceptance', '--label', `freshell.run-id=${runId}`,
      '--network', forwarderNetworkId, '--publish', `127.0.0.1::${checkpointForwarderPort}/tcp`,
      '--pids-limit', '128', '--memory', '128m', '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
      '--env', 'FRESHELL_CHECKPOINT_FORWARDER_HOST=0.0.0.0',
      '--env', `FRESHELL_CHECKPOINT_FORWARDER_PORT=${checkpointForwarderPort}`,
      '--env', `FRESHELL_CHECKPOINT_UPSTREAM_HOST=${targetAddress}`,
      '--env', `FRESHELL_CHECKPOINT_UPSTREAM_PORT=${checkpointContainerPort}`,
      '--entrypoint', '/usr/local/bin/node', checkpointImage, '-e', checkpointTcpForwarderSource,
    ]
    forwarderContainerId = docker(forwarderArgs)
    assert.match(forwarderContainerId, /^[a-f0-9]{64}$/, 'Loopback forwarder did not publish its owned container identity')
    const forwarderDetails = docker(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "freshell.run-id"}}', forwarderContainerId])
    assert.equal(forwarderDetails, `${forwarderContainerId} ${runId}`, 'Loopback forwarder ownership labels did not match this run')
    docker(['network', 'connect', networkId, forwarderContainerId])
    const forwarderEgress = assertDirectEgressBlocked(forwarderContainerId, 'Loopback forwarder')

    const mapping = await poll('loopback-only ephemeral checkpoint target port', async () => {
      const value = dockerMaybe(['port', forwarderContainerId!, `${checkpointForwarderPort}/tcp`])
      if (!value) return undefined
      const match = value.match(/^127\.0\.0\.1:(\d+)$/m)
      if (!match) throw new Error('Checkpoint target forwarder port was not published on host loopback only')
      return Number(match[1])
    }, 60_000)
    assert(Number.isSafeInteger(mapping) && mapping > 0 && mapping <= 65535)
    const baseUrl = `http://127.0.0.1:${mapping}`
    await poll('restricted checkpoint target health', async () => {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
      return response?.ok ? true : undefined
    }, 120_000)
    const initialization = await poll('fixed restricted-UID initializer proof', () =>
      externalTargetRead(baseUrl, token, `${checkpointFixtureRoot}/control/initialization.json`), 30_000)
    proof.initialization = initialization
    assert.deepEqual(initialization, { restrictedUid: identity.uid, effectiveCapabilities: '0000000000000000',
      privateFileDenied: true, privateDirectoryDenied: true, privateFileUid: 0, privateFileMode: '0600',
      privateDirectoryUid: 0, privateDirectoryMode: '0700', sameParentRenameVerified: true,
      nonGitWorkspace: fixture.nonGitWorkspacePath })
    const serverInfoResponse = await fetch(`${baseUrl}/api/server-info`, { headers: { 'x-auth-token': token }, signal: AbortSignal.timeout(15_000) })
    proof.serverInfoStatus = serverInfoResponse.status
    assert(serverInfoResponse.ok)
    const serverInfo = await serverInfoResponse.json() as { commit?: unknown; buildDirty?: unknown; runtime?: unknown }
    proof.serverInfo = serverInfo
    assert.equal(serverInfo.runtime, 'rust')
    assert.equal(serverInfo.commit, candidateSha)
    assert.equal(serverInfo.buildDirty, false)
    proof.target = { containerId, containerName, networkId, networkName, networkInternal: true, restrictedIdentity: identity,
      targetAddress, targetEgress, forwarderContainerId, forwarderContainerName, forwarderNetworkId, forwarderNetworkName,
      forwarderNetworkMasquerade: false, forwarderEgress, hostLoopbackPort: mapping, serverInfo, initialization }
    proof.localControlPreflight = []
    for (const action of ['ignored', 'eligible', 'ignored'] as const) {
      (proof.localControlPreflight as unknown[]).push(await verifyCheckpointControl(baseUrl, token, containerId, identity, fixture, action))
    }
    await externalTargetWrite(baseUrl, token, checkpointControlRequest, '{}')
    proof.localControlPreflightRequestCleared = true
    if (process.env.FRESHELL_CODE_CHECKPOINT_PREFLIGHT_ONLY === '1') {
      proof.localPreflightOnly = true
      await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 })
      const preflightReceipt = path.join(evidenceDir, 'code-checkpoint-preflight.json')
      await writeJson(preflightReceipt, proof)
      console.log(JSON.stringify({ severity: 'info', event: 'code_checkpoint.local_preflight_passed', candidateSha, runId,
        controlActions: ['ignored', 'eligible', 'ignored'], receipt: preflightReceipt }))
      return
    }

    const toolHome = path.join(root, 'cloudflared-home')
    await fs.mkdir(toolHome, { mode: 0o700 })
    const tool = path.join(root, 'cloudflared')
    const download = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-amd64`,
      { signal: AbortSignal.timeout(120_000) })
    assert(download.ok)
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal(digest(bytes), cloudflaredSha, 'Pinned cloudflared checksum mismatch')
    await fs.writeFile(tool, bytes, { mode: 0o700 })
    const versionText = execFileSync(tool, ['--version'], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: toolHome },
      encoding: 'utf8', timeout: 30_000 })
    assert.match(versionText, /^cloudflared version 2026\.10\.0(?:\s|$)/)
    tunnel = spawn(tool, ['tunnel', '--url', baseUrl], {
      cwd: root, env: { PATH: process.env.PATH ?? '', HOME: toolHome, XDG_CONFIG_HOME: toolHome },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    tunnelJoin = joined(tunnel); tunnelJoin.catch(() => {})
    tunnelIdentity = await processIdentity(tunnel)
    let tunnelLog = ''
    const tunnelOutput = (chunk: Buffer) => { tunnelLog = (tunnelLog + chunk.toString()).slice(-65_536) }
    tunnel.stdout!.on('data', tunnelOutput); tunnel.stderr!.on('data', tunnelOutput)
    const origin = await poll('pinned checkpoint Quick Tunnel hostname', async () => {
      assert.equal(tunnel!.exitCode, null, 'Owned checkpoint tunnel exited before publication')
      return tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
    }, 120_000)
    await poll('checkpoint tunnel health', async () => {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
      return response?.ok ? true : undefined
    }, 120_000)

    const cloudEnvironment: NodeJS.ProcessEnv = { ...process.env,
      FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'code-checkpoint',
      FRESHELL_CODE_CHECKPOINT_FIXTURE: JSON.stringify(fixture),
      FRESHELL_E2E_TARGET_URL: origin,
      FRESHELL_E2E_TARGET_WS_URL: origin.replace('https:', 'wss:') + '/ws',
      FRESHELL_E2E_TARGET_TOKEN: token,
    }
    delete cloudEnvironment.FRESHELL_MANAGED_ENVIRONMENT_FIXTURE
    delete cloudEnvironment.FRESHELL_E2E_TARGET_HOME
    const paired = resolvePairedExternalFixture(cloudEnvironment, true)
    assert.equal(paired?.kind, 'code-checkpoint')
    const browserSpec = 'test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts'
    cloudEnvironment.FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT = cloudDispatchReceiptPath
    browser = spawn('pnpm', ['run', 'test:e2e', '--shards=1', '--workers=1', '--project=chromium-external-target', browserSpec], {
      cwd: repoRoot, env: cloudEnvironment, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    browser.stdout!.on('data', chunk => browserSummaryCapture.write(chunk))
    browser.stdout!.pipe(process.stdout); browser.stderr!.pipe(process.stderr)
    browserJoin = joinedAfterOutput(browser); browserJoin.catch(() => {})
    browserIdentity = await processIdentity(browser)
    const cloudDispatch = await waitForCloudExecutionDispatch(cloudDispatchReceiptPath,
      () => browser?.exitCode === null && browser.signalCode === null)
    proof.cloudExecution = cloudDispatch
    console.log(JSON.stringify({ severity: 'info', event: 'code_checkpoint.cloud_execution_dispatched', ...cloudDispatch }))
    await serveCheckpointControls(baseUrl, token, containerId, identity, fixture, browser, proof)
    const browserExit = await bounded(browserJoin, 120_000, 'configured Cloud checkpoint browser final join')
    assert.equal(browserExit.code, 0, 'Configured Cloud checkpoint browser acceptance failed')
    const browserSummary = browserSummaryCapture.finish()
    assert.equal(browserSummary.executedCases, 5, 'Configured Cloud must execute all five checkpoint browser cases')
    assert.equal(browserSummary.passedCases, 5, 'Every configured checkpoint browser case must pass')
    assert.equal(browserSummary.failedCases, 0)
    assert.equal(browserSummary.skippedCases, 0)
    assert.equal(browserSummary.interruptedCases, 0)
    proof.cloudBrowser = { actualNativeExit: browserExit, identity: browserIdentity, ...browserSummary }
    await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    await writeJson(receiptPath, proof)
    console.log(JSON.stringify({ severity: 'info', event: 'code_checkpoint.acceptance_passed', candidateSha, runId,
      executedBrowserCases: browserSummary.executedCases, passedBrowserCases: browserSummary.passedCases, receipt: receiptPath }))
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    const errors: Error[] = []
    const cleanup: Record<string, unknown> = {}
    const attempt = async (operation: string, action: () => unknown | Promise<unknown>) => {
      try { cleanup[operation] = await action() }
      catch (error) {
        errors.push(new Error(`Owned checkpoint target cleanup failed: ${operation}`, { cause: error }))
        const message = error instanceof Error ? error.message : String(error)
        cleanup[operation] = { settled: false, error: message.replaceAll(token, '[redacted]').slice(-2048) }
      }
    }
    const cloudExecution = proof.cloudExecution as { executionName?: unknown } | undefined
    if (primaryFailure !== undefined && browser?.exitCode === null && browser.signalCode === null
        && typeof cloudExecution?.executionName === 'string') {
      await attempt('cloudExecution', () => cancelOwnedCloudExecution(cloudExecution.executionName as string, candidateSha))
    }
    await attempt('browserJoin', () => stopExact(browser, browserIdentity, browserJoin, true))
    await attempt('tunnelJoin', () => stopExact(tunnel, tunnelIdentity, tunnelJoin, true))
    if (forwarderContainerId) await attempt('forwarderContainer', async () => {
      const matching = docker(['ps', '-aq', '--no-trunc', '--filter', `id=${forwarderContainerId}`]).split('\n').filter(Boolean)
      if (matching.length) {
        assert.deepEqual(matching, [forwarderContainerId], 'Only the exact owned checkpoint forwarder may be stopped')
        const details = docker(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "freshell.run-id"}}', forwarderContainerId])
        assert.equal(details, `${forwarderContainerId} ${runId}`, 'Refusing to clean up an unowned checkpoint forwarder')
        docker(['container', 'stop', '--timeout', '10', forwarderContainerId], 20_000)
      }
      const remaining = docker(['ps', '-aq', '--no-trunc', '--filter', `id=${forwarderContainerId}`]).split('\n').filter(Boolean)
      if (remaining.length) docker(['container', 'rm', '--force', forwarderContainerId], 20_000)
      assert.deepEqual(docker(['ps', '-aq', '--no-trunc', '--filter', `id=${forwarderContainerId}`]).split('\n').filter(Boolean), [])
      return { containerId: forwarderContainerId, settled: true }
    })
    if (containerId) await attempt('container', async () => {
      const matching = docker(['ps', '-aq', '--no-trunc', '--filter', `id=${containerId}`]).split('\n').filter(Boolean)
      if (matching.length) {
        assert.deepEqual(matching, [containerId], 'Only the exact owned checkpoint container may be stopped')
        const details = docker(['container', 'inspect', '--format', '{{.Id}} {{index .Config.Labels "freshell.run-id"}}', containerId])
        assert.equal(details, `${containerId} ${runId}`, 'Refusing to clean up an unowned checkpoint container')
        docker(['container', 'stop', '--time', '10', containerId], 20_000)
      }
      const remaining = docker(['ps', '-aq', '--no-trunc', '--filter', `id=${containerId}`]).split('\n').filter(Boolean)
      if (remaining.length) docker(['container', 'rm', '--force', containerId], 20_000)
      assert.deepEqual(docker(['ps', '-aq', '--no-trunc', '--filter', `id=${containerId}`]).split('\n').filter(Boolean), [])
      return { containerId, settled: true }
    })
    else if (dockerRun && dockerRunIdentity && dockerRunJoin) await attempt('containerIdentity', async () => {
      const named = docker(['ps', '-aq', '--no-trunc', '--filter', `name=^/${containerName}$`]).split('\n').filter(Boolean)
      assert.deepEqual(named, [], 'Container without a published owned ID remains unknown; retain its fixture')
    })
    await attempt('dockerRunJoin', () => stopExact(dockerRun, dockerRunIdentity, dockerRunJoin, true))
    if (networkId) await attempt('network', async () => {
      const matching = docker(['network', 'ls', '-q', '--no-trunc', '--filter', `id=${networkId}`]).split('\n').filter(Boolean)
      if (matching.length) {
        assert.deepEqual(matching, [networkId], 'Only the exact owned checkpoint network may be removed')
        const details = docker(['network', 'inspect', '--format', '{{.Id}} {{index .Labels "freshell.run-id"}}', networkId])
        assert.equal(details, `${networkId} ${runId}`, 'Refusing to remove an unowned checkpoint network')
        docker(['network', 'rm', networkId])
      }
      assert.deepEqual(docker(['network', 'ls', '-q', '--no-trunc', '--filter', `id=${networkId}`]).split('\n').filter(Boolean), [])
      return { networkId, settled: true }
    })
    if (forwarderNetworkId) await attempt('forwarderNetwork', async () => {
      const matching = docker(['network', 'ls', '-q', '--no-trunc', '--filter', `id=${forwarderNetworkId}`]).split('\n').filter(Boolean)
      if (matching.length) {
        assert.deepEqual(matching, [forwarderNetworkId], 'Only the exact owned checkpoint forwarder network may be removed')
        const details = docker(['network', 'inspect', '--format', '{{.Id}} {{index .Labels "freshell.run-id"}}', forwarderNetworkId])
        assert.equal(details, `${forwarderNetworkId} ${runId}`, 'Refusing to remove an unowned checkpoint forwarder network')
        docker(['network', 'rm', forwarderNetworkId])
      }
      assert.deepEqual(docker(['network', 'ls', '-q', '--no-trunc', '--filter', `id=${forwarderNetworkId}`]).split('\n').filter(Boolean), [])
      return { networkId: forwarderNetworkId, settled: true }
    })
    if (errors.length === 0) await attempt('fixtureDirectory', () => fs.rm(root, { recursive: true, force: true }))
    proof.cleanup = cleanup
    proof.knownOwnedSettled = errors.length === 0
    if (errors.length) proof.retainedFixture = root
    if (primaryFailure !== undefined) {
      const message = primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure)
      proof.primaryFailure = {
        name: primaryFailure instanceof Error ? primaryFailure.name : 'UnknownError',
        message: message.replaceAll(token, '[redacted]'),
      }
    }
    await attempt('cleanupReceipt', async () => {
      proof.targetOutput = {
        stdoutTail: dockerStdout.replaceAll(token, '[redacted]').slice(-8192),
        stderrTail: dockerStderr.replaceAll(token, '[redacted]').slice(-8192),
      }
      await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 })
      await writeJson(path.join(evidenceDir, 'code-checkpoint-cleanup.json'), proof)
    })
    if (errors.length) {
      const primaryMessage = primaryFailure === undefined
        ? ''
        : `: ${primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure)}`
      const failures = primaryFailure === undefined ? errors : [primaryFailure, ...errors]
      throw new AggregateError(failures, `Checkpoint target failed${primaryMessage}; cleanup remains unsettled`)
    }
  }
}

export async function runManagedEnvironmentTarget() {
  assert.equal(process.env.FRESHELL_E2E_BACKEND, 'cloud', 'Managed acceptance requires configured Cloud')
  assert.equal(process.env.GCLOUD_ROBOT_REQUIRE, '1', 'Managed acceptance requires the robot identity')
  assert.equal(process.env.GCLOUD_ROBOT_ACCOUNT, 'gcloud-robot@misc-puttering-project.iam.gserviceaccount.com')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 5_000,
  }).trim()
  buildManagedEnvironmentClient(repoRoot, candidateSha)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-managed-environment-'))
  const grants = fakeOnecliGrants(['opencode'])
  const nonce = randomUUID()
  let rig: ManagedRuntimeBrowserRig | undefined
  let webIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined
  let version: ChildProcess | undefined, versionIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined,
    versionJoin: Promise<NativeExit> | undefined
  let tunnel: ChildProcess | undefined, tunnelIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined, tunnelJoin: Promise<NativeExit> | undefined
  let browser: ChildProcess | undefined, browserIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined, browserJoin: Promise<NativeExit> | undefined
  const browserSummaryCapture = new ManagedEnvironmentBrowserSummaryCapture()
  const owners: InitialProviderVolumeAuthorization[] = []
  let capturedVolumes: ReturnType<typeof captureProviderParityVolumes> = []
  const proof: Record<string, unknown> = { expectedNonce: nonce }
  try {
    const home = path.join(root, 'home'), xdg = path.join(home, 'fixture-xdg'), workspace = path.join(root, 'workspace')
    // The synthetic grant is the only selected OneCLI input. RustServer merges
    // ambient env, so explicitly close optional host auth/CA references too.
    const environment = { ...grants.serverEnv, ...managedEnvironmentOpencodeSelection(), HOME: home, XDG_CONFIG_HOME: xdg,
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: '', FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: '' }
    rig = new ManagedRuntimeBrowserRig(repoRoot, 2, { ...environment, FRESHELL_MANAGED_ENVIRONMENT_FIXTURE_ONLY: '1' },
      environment, 'release', {
        enabledProviders: ['opencode'],
        providerSettings: { opencode: { model: managedEnvironmentFixtureModel } },
      }, home,
      { workspaceRoots: [workspace], providerInputRoots: [managedEnvironmentFixtureLayout(root).resources, home],
        bootstrapFiles: [grants.grants.opencode], defaultCwd: workspace })
    const selected = await configure(root, nonce, rig.runtime.candidateSha, rig.runtime.runId)
    await rig.start()
    webIdentity = await processIdentity(rig.web.processEvidence())
    proof.scratchWeb = webIdentity
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    const source = { installationId: health.data.installation_id, imageRef: rig.runtime.imageRef,
      hostBinaryPath: rig.runtime.releaseHostBinary, binarySha256: digest(await fs.readFile(rig.runtime.releaseHostBinary)),
      daemonId: await readManagedEnvironmentDaemonId() }
    const authorize = (requestId: string) => owners.push(authorizeProviderParityRequest(rig!.runtime.broker, source, requestId))
    const before = await rig.inventory()
    assert.deepEqual(before, [])
    assert.deepEqual(await terminalDirectory(rig), [])
    for (const capabilities of [undefined, { paneReconcileV1: true }] as (Record<string, true> | undefined)[]) {
      const refused = await socketCreate(rig, randomUUID(), 'shell', selected.workspace, capabilities)
      assert.equal(refused.type, 'error')
      assert(JSON.stringify(refused).includes('managed environment fixture denies host PTY'))
    }
    const fallback = await fetch(`${rig.info.baseUrl}/api/tabs`, { method: 'POST', headers: { 'x-auth-token': rig.info.token,
      'content-type': 'application/json' }, body: JSON.stringify({ mode: ordinaryFixtureMode, cwd: selected.workspace }), signal: AbortSignal.timeout(30_000) })
    assert.equal(fallback.status, 400)
    assert((await fallback.text()).includes('managed environment fixture denies host PTY'))
    assert.deepEqual(await rig.inventory(), before)
    const ordinaryRows = await terminalDirectory(rig)
    assert.deepEqual(ordinaryRows, [])
    const childPids = await poll('absence of owned ordinary PTY child PIDs', async () => {
      const children = await webChildren(rig!)
      return children.length === 0 ? children : undefined
    }, 15_000)
    proof.hostPtyDenials = { legacy: true, nonNegotiated: true, httpCliMcpFallback: true, httpMode: ordinaryFixtureMode,
      observedRegistryRows: ordinaryRows, observedChildPids: childPids, scratchWeb: rig.web.processEvidence() }
    const preflightRequest = `managed-preflight-${randomUUID()}`
    authorize(preflightRequest)
    const created = await socketCreate(rig, preflightRequest, 'opencode', path.join(selected.workspace, 'preflight'),
      { paneReconcileV1: true, managedRuntimeV1: true })
    assertManagedTerminalCreated(rig, created)
    const preflightChild = await poll('genuine managed preflight configuration', async () => readJson(path.join(selected.workspace, 'preflight/.managed-fixture/child-receipt.json')))
    assert.equal(preflightChild.terminalId, created.terminalId)
    assert.equal(preflightChild.candidateSha, rig.runtime.candidateSha)
    assert.equal(preflightChild.runId, rig.runtime.runId)
    assert.equal(preflightChild.model, managedEnvironmentFixtureModel)
    assert.equal(preflightChild.expectedNonce, nonce)
    assert.equal(preflightChild.bun, true)
    const preflightMcp = await poll('OpenCode starts the nested Bun package-script MCP', async () =>
      readJson(path.join(selected.workspace, 'preflight/.managed-fixture/mcp-receipt.json')))
    assert.equal(preflightMcp.expectedNonce, nonce)
    assert.equal(preflightMcp.dependency, nonce, 'MCP must load its dependency from the staged parent node_modules')
    assert.equal(preflightMcp.bun, true, 'OpenCode must run the local MCP package script under Bun')
    assert.equal(preflightMcp.bunVersion, '1.4.3', 'Managed OpenCode MCP must use the pinned Bun runtime')
    assert.equal(preflightMcp.launchCwd, selected.mcpPackage, 'Bun runs a package script from its package root')
    assert.equal(preflightMcp.bunCommandCwd, selected.mcpNested, 'OpenCode must launch Bun from the configured nested MCP cwd')
    assert.equal(preflightMcp.configuredCwd, selected.mcpNested)
    assert(preflightMcp.scriptPath.endsWith('/fixture-mcp/server.mjs'))
    const preflightDirectMcp = await poll('OpenCode starts the direct extensionless MCP through its sibling helper', async () =>
      readJson(path.join(selected.workspace, 'preflight/.managed-fixture/direct-mcp-receipt.json')))
    assert.equal(preflightDirectMcp.expectedNonce, nonce)
    assert.equal(preflightDirectMcp.helper, nonce)
    assert.equal(preflightDirectMcp.sibling, nonce)
    assert.equal(preflightDirectMcp.dependency, nonce)
    assert.equal(preflightDirectMcp.schemaNonce, nonce)
    assert.equal(preflightDirectMcp.envFileOperandRewritten, true)
    assert.equal(preflightDirectMcp.envValueLoaded, true)
    assert(preflightDirectMcp.scriptPath.endsWith('/direct-mcp/server.mjs'))
    const preflightHomeAppendPaths = managedHomeAppendFixturePaths(
      selected.home, path.join(selected.workspace, 'preflight'), 'preflight')
    const preflightHomeAppend = await poll('OpenCode starts the direct HOME MCP and it appends its sibling output', async () => {
      const receipt = await readJson(preflightHomeAppendPaths.receipt)
      if (receipt) return receipt
      try {
        const [started, metadata] = await Promise.all([
          fs.readFile(preflightHomeAppendPaths.started, 'utf8'), fs.stat(preflightHomeAppendPaths.started),
        ])
        if (started === 'wrapper-started' && Date.now() - metadata.mtimeMs > 15_000) {
          return { wrapperStarted: true, nodeStartupTimedOut: true }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      return undefined
    })
    assert.equal(preflightHomeAppend.expectedNonce, nonce,
      `direct HOME MCP did not complete its receipt: ${JSON.stringify(preflightHomeAppend)}`)
    assert.equal(preflightHomeAppend.appendError, undefined, 'the staged HOME-level append target must be writable')
    assert.equal(preflightHomeAppend.readError, undefined, 'the staged HOME-level append target must be readable')
    assert.equal(preflightHomeAppend.outputExists, true, 'the sibling file must exist inside the provider container')
    assert.equal(preflightHomeAppend.siblingMountPresent, true, 'the sibling file must have its own provider-volume mount')
    assert.equal(preflightHomeAppend.output, `initial-${nonce}|${nonce}`)
    assert.equal(preflightHomeAppend.envFileOperandRewritten, true)
    assert.equal(preflightHomeAppend.envValueLoaded, true)
    assert(preflightHomeAppend.scriptPath.endsWith('/direct-home-preflight.mjs'))
    const preflightCwdAliasReceipt = path.join(selected.workspace, 'preflight/.managed-fixture/mcp-cwd-alias-receipt.json')
    const aliasWaitStartedAt = Date.now()
    const preflightCwdAliasMcp = await poll('OpenCode starts a workspace wrapper with its external MCP cwd env file', async () => {
      const receipt = await readJson(preflightCwdAliasReceipt)
      if (receipt) return receipt
      try {
        const [started, metadata] = await Promise.all([
          fs.readFile(`${preflightCwdAliasReceipt}.started`, 'utf8'), fs.stat(`${preflightCwdAliasReceipt}.started`),
        ])
        if (started === 'wrapper-started' && Date.now() - metadata.mtimeMs > 15_000) {
          return { wrapperStarted: true, nodeStartupTimedOut: true }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (Date.now() - aliasWaitStartedAt > 30_000) return { wrapperStarted: false, nodeStartupTimedOut: true }
      return undefined
    }, 45_000)
    assert.equal(preflightCwdAliasMcp.expectedNonce, nonce)
    assert.equal(preflightCwdAliasMcp.helper, nonce)
    assert.equal(preflightCwdAliasMcp.envValueLoaded, true)
    assert.match(preflightCwdAliasMcp.envFileTarget, /^\/home\/freshell\/provider\/\.freshell\/references\/\d+$/)
    assert.equal(preflightCwdAliasMcp.envFileOperand, '--env-file=.env', 'the workspace wrapper must retain its relative operand')
    assert.equal(preflightCwdAliasMcp.cwd, selected.cwdAliasProject)
    assert(preflightCwdAliasMcp.scriptPath.endsWith('/cwd-alias-project/server.mjs'))
    const preflightView = await poll('genuine managed preflight native identity', () =>
      observeManagedEnvironmentNativeIdentity(rig!, created.terminalId, preflightChild.nativeSessionId))
    assert((await terminalDirectory(rig)).some(row => row.terminalId === created.terminalId))
    assert.deepEqual(await webChildren(rig), [], 'Managed child must belong to the disposable session host, not the host web process')
    proof.preflight = { terminalId: created.terminalId, soulId: preflightView.soulId, incarnationId: preflightView.incarnationId,
      stage: await stageProof(rig, preflightView, nonce), child: preflightChild, mcpServer: preflightMcp,
      workspaceCwdAliasMcp: preflightCwdAliasMcp,
      directMcpServer: preflightDirectMcp, directHomeAppendMcp: preflightHomeAppend }
    const toolHome = path.join(root, 'tools')
    await fs.mkdir(toolHome, { mode: 0o700 })
    const tool = path.join(toolHome, 'cloudflared')
    const download = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-amd64`, { signal: AbortSignal.timeout(120_000) })
    assert(download.ok)
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal(digest(bytes), cloudflaredSha, 'Pinned cloudflared checksum mismatch')
    await fs.writeFile(tool, bytes, { mode: 0o700 })
    version = spawn(tool, ['--version'], { cwd: root, env: { ...process.env, HOME: toolHome } })
    versionJoin = joined(version); versionJoin.catch(() => {})
    versionIdentity = await processIdentity(version).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    })
    let versionText = ''; version.stdout!.on('data', bytes => { versionText += bytes })
    const versionExit = await bounded(versionJoin, 30_000, 'pinned cloudflared version join')
    assert.equal(versionExit.code, 0)
    assert.match(versionText, /^cloudflared version 2026\.10\.0(?:\s|$)/)
    proof.cloudflared = { version: cloudflaredVersion, sha256: cloudflaredSha, versionIdentity: versionIdentity ?? 'UNKNOWN', versionExit }
    tunnel = spawn(tool, ['tunnel', '--url', `http://127.0.0.1:${rig.info.port}`],
      { cwd: root, env: { ...process.env, HOME: toolHome, XDG_CONFIG_HOME: toolHome }, stdio: ['ignore', 'pipe', 'pipe'] })
    tunnelJoin = joined(tunnel); tunnelJoin.catch(() => {})
    tunnelIdentity = await processIdentity(tunnel)
    let tunnelLog = ''; const tunnelOutput = (bytes: Buffer) => { tunnelLog += bytes.toString(); if (tunnelLog.length > 65536) tunnelLog = tunnelLog.slice(-65536) }
    tunnel.stdout!.on('data', tunnelOutput); tunnel.stderr!.on('data', tunnelOutput)
    const origin = await poll('pinned Quick Tunnel hostname', async () => {
      assert.equal(tunnel!.exitCode, null, 'Owned tunnel exited before publication')
      return tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
    }, 120_000)
    await poll('tunnel health', async () => {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
      return response?.ok ? true : undefined
    }, 120_000)
    const fixture = { candidateSha: rig.runtime.candidateSha, runId: rig.runtime.runId,
      remoteWorkspacePath: selected.workspace, expectedNonce: nonce }
    const cloudEnvironment: NodeJS.ProcessEnv = { ...process.env, FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'managed-environment',
      FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: JSON.stringify(fixture), FRESHELL_E2E_TARGET_URL: origin,
      FRESHELL_E2E_TARGET_WS_URL: origin.replace('https:', 'wss:') + '/ws', FRESHELL_E2E_TARGET_TOKEN: rig.info.token }
    delete cloudEnvironment.FRESHELL_CODE_CHECKPOINT_FIXTURE
    delete cloudEnvironment.FRESHELL_E2E_TARGET_HOME
    resolvePairedExternalFixture(cloudEnvironment, true)
    await writeJson(path.join(root, 'handoff.json'), { fixture, origin, token: rig.info.token, tunnelIdentity })
    const cloudDispatchReceiptPath = path.join(root, 'cloud-execution-dispatch.json')
    cloudEnvironment.FRESHELL_E2E_CLOUD_DISPATCH_RECEIPT = cloudDispatchReceiptPath
    browser = spawn('pnpm', ['run', 'test:e2e', '--shards=1', '--project=chromium-external-target',
      'test/e2e-browser/specs/managed-provider-environment-external.spec.ts'], { cwd: repoRoot, env: cloudEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
    browser.stdout!.on('data', chunk => browserSummaryCapture.write(chunk))
    browser.stdout!.pipe(process.stdout)
    browser.stderr!.pipe(process.stderr)
    browserJoin = joinedAfterOutput(browser); browserJoin.catch(() => {})
    browserIdentity = await processIdentity(browser)
    const cloudDispatch = await waitForCloudExecutionDispatch(cloudDispatchReceiptPath,
      () => browser?.exitCode === null && browser.signalCode === null)
    proof.cloudExecution = cloudDispatch
    console.log(JSON.stringify({ severity: 'info', event: 'managed_environment.cloud_execution_dispatched', ...cloudDispatch }))
    await serviceManagedEnvironmentCases(fixture, scenario => {
      const cwd = path.join(selected.workspace, scenario)
      return {
        nextAttempt: attempt => poll(`Cloud ${scenario} attempt ${attempt} picker or completion`, async () => {
          const request = await readJson(path.join(cwd, '.managed-fixture/request.json'))
          if (request?.attempt === attempt) return { request }
          const completion = await readJson(path.join(cwd, '.managed-fixture/completion.json'))
          if (completion?.attempt === attempt) return { completion }
          assert.equal(browser!.exitCode, null, 'Cloud browser exited before completing its three cases')
          assert.equal(browser!.signalCode, null, 'Cloud browser was signaled before completing its three cases')
          return undefined
        }, attempt === 0 ? 600_000 : scenario === 'healthy' ? 360_000 : 300_000),
        authorize,
        publishAuthorization: request => writeJson(path.join(cwd, '.managed-fixture/authorized.json'), request),
        waitForCompletion: request => poll(`Cloud ${scenario} attempt ${request.attempt} completion`, async () => {
          const completion = await readJson(path.join(cwd, '.managed-fixture/completion.json'))
          if (completion?.attempt === request.attempt) return completion
          assert.equal(browser!.exitCode, null, 'Cloud browser exited without its attempt completion')
          return undefined
        }, scenario === 'healthy' ? 360_000 : 300_000),
        onAuthorized: async request => {
          if (scenario !== 'healthy') return
          const completionPath = path.join(cwd, '.managed-fixture/completion.json')
          const outcome = await waitForManagedEnvironmentReadyOrBrowserFailure(request, async () => {
            const child = await readJson(path.join(cwd, '.managed-fixture/child-receipt.json'))
            if (!child) return undefined
            const view = (await rig!.inventory()).find(row => row.terminalId === child.terminalId
              && row.terminalCreateRequestId === request.createRequestId && row.nativeSessionId === child.nativeSessionId
              && row.launchState === 'running')
            return view ? { child, view } : undefined
          }, () => readJson(completionPath))
          if (outcome.kind === 'browser_attempt_failed') {
            const completion = await readJson(completionPath)
            let rows: ManagedRuntimeView[] = []
            try { rows = (await rig!.inventory()).filter(row => row.terminalCreateRequestId === request.createRequestId) }
            catch { /* Keep browser failure evidence even when a fresh inventory cannot be read. */ }
            const view = rows[0]
            const summarizeOwnedLogs = (containerId: string) => {
              try { return providerParityFailureDiagnostics(rig!.runtime.containerLogs(containerId).slice(-512 * 1024)) }
              catch { return 'UNKNOWN' }
            }
            const supervisorLogs = summarizeOwnedLogs(rig!.supervisor.containerId)
            const sessionHostLogs = view?.containerId ? summarizeOwnedLogs(view.containerId) : undefined
            let serverLogEvents: ReturnType<typeof summarizeRustServerLogEvents> = []
            try { serverLogEvents = summarizeRustServerLogEvents(Object.values(rig!.web.capturedOutput()).join('\n')) }
            catch { /* Keep browser and runtime evidence if the scratch server log is unavailable. */ }
            const captured = writeManagedEnvironmentBrowserFailureIncident(request, {
              browser: completion?.failureEvidence ?? 'UNKNOWN',
              managedTerminal: view ? {
                launchState: view.launchState, desiredState: view.desiredState, recoveryState: view.recoveryState,
                durabilityState: view.durabilityState, allocationState: view.allocationState,
                provider: view.provider, terminalMode: view.terminalMode,
                nativeIdentityPresent: Boolean(view.nativeSessionId), sessionHostPresent: Boolean(view.containerId),
              } : { matchingTerminalCount: rows.length },
              ...(sessionHostLogs ? { sessionHostLogs } : {}), supervisorLogs, serverLogEvents,
            }, (name, value) => rig!.runtime.writeIncident(name, value))
            if (!captured) {
              console.error(JSON.stringify({ severity: 'error', event: 'managed_environment.browser_runtime_capture_persist_failed', scenario, attempt: request.attempt }))
            }
            return
          }
          const { child, view } = outcome.value
          assert.equal(child.expectedNonce, nonce)
          assert.equal(child.candidateSha, fixture.candidateSha)
          assert.equal(child.runId, fixture.runId)
          assert.equal(child.bun, true)
          assert.equal(child.opencodeVersion, '1.18.21')
          assert.equal(child.model, managedEnvironmentFixtureModel)
          assert.match(child.bunExecutable, /opencode/)
          assert.equal(child.executableMode, '0711')
          const mcpServer = await poll('Cloud OpenCode starts the nested Bun package-script MCP', async () =>
            readJson(path.join(cwd, '.managed-fixture/mcp-receipt.json')))
          assert.equal(mcpServer.expectedNonce, nonce)
          assert.equal(mcpServer.dependency, nonce, 'OpenCode MCP must load the staged parent dependency')
          assert.equal(mcpServer.bun, true, 'OpenCode must run the local MCP package script under Bun')
          assert.equal(mcpServer.bunVersion, '1.4.3', 'Managed OpenCode MCP must use the pinned Bun runtime')
          assert.equal(mcpServer.launchCwd, selected.mcpPackage, 'Bun runs a package script from its package root')
          assert.equal(mcpServer.bunCommandCwd, selected.mcpNested, 'OpenCode must launch Bun from the configured nested MCP cwd')
          assert.equal(mcpServer.configuredCwd, selected.mcpNested)
          assert(mcpServer.scriptPath.endsWith('/fixture-mcp/server.mjs'))
          const directMcpServer = await poll('Cloud OpenCode starts the direct extensionless MCP through its sibling helper', async () =>
            readJson(path.join(cwd, '.managed-fixture/direct-mcp-receipt.json')))
          assert.equal(directMcpServer.expectedNonce, nonce)
          assert.equal(directMcpServer.helper, nonce)
          assert.equal(directMcpServer.sibling, nonce)
          assert.equal(directMcpServer.dependency, nonce)
          assert.equal(directMcpServer.schemaNonce, nonce)
          assert.equal(directMcpServer.envFileOperandRewritten, true)
          assert.equal(directMcpServer.envValueLoaded, true)
          assert(directMcpServer.scriptPath.endsWith('/direct-mcp/server.mjs'))
          const directHomeAppendMcp = await poll('Cloud OpenCode appends through its direct HOME MCP', async () =>
            readJson(path.join(cwd, '.managed-fixture/direct-home-mcp-receipt.json')))
          assert.equal(directHomeAppendMcp.expectedNonce, nonce)
          assert.equal(directHomeAppendMcp.appendError, undefined, 'the managed HOME sibling mount must permit append')
          assert.equal(directHomeAppendMcp.output, `initial-${nonce}|${nonce}`)
          assert.equal(directHomeAppendMcp.envFileOperandRewritten, true)
          assert.equal(directHomeAppendMcp.envValueLoaded, true)
          assert(directHomeAppendMcp.scriptPath.endsWith('/direct-home-healthy.mjs'))
          const workspaceCwdAliasMcp = await poll('Cloud OpenCode starts a workspace wrapper with its external MCP cwd env file', async () =>
            readJson(path.join(cwd, '.managed-fixture/mcp-cwd-alias-receipt.json')))
          assert.equal(workspaceCwdAliasMcp.expectedNonce, nonce)
          assert.equal(workspaceCwdAliasMcp.helper, nonce)
          assert.equal(workspaceCwdAliasMcp.envValueLoaded, true)
          assert.match(workspaceCwdAliasMcp.envFileTarget, /^\/home\/freshell\/provider\/\.freshell\/references\/\d+$/)
          assert.equal(workspaceCwdAliasMcp.envFileOperand, '--env-file=.env', 'the workspace wrapper must retain its relative operand')
          assert.equal(workspaceCwdAliasMcp.cwd, selected.cwdAliasProject)
          assert(workspaceCwdAliasMcp.scriptPath.endsWith('/cwd-alias-project/server.mjs'))
          const stage = await stageProof(rig!, view, nonce)
          const receipt = { ...fixture, terminalId: view.terminalId, soulId: view.soulId, incarnationId: view.incarnationId,
            nativeSessionId: view.nativeSessionId, stage, child, mcpServer, directMcpServer, directHomeAppendMcp,
            workspaceCwdAliasMcp }
          await writeJson(path.join(cwd, '.managed-fixture/target-receipt.json'), receipt)
          proof.healthy = receipt
        },
      }
    }, async () => {
      const browserExit = await bounded(browserJoin!, 120_000, 'configured Cloud browser final join')
      assert.equal(browserExit.code, 0, 'Configured Cloud browser acceptance failed')
      const browserSummary: ManagedEnvironmentBrowserSummary = browserSummaryCapture.finish()
      assert.equal(browserSummary.executedCases, scenarios.length, 'Configured Cloud ran an unexpected number of browser cases')
      assert.equal(browserSummary.passedCases, scenarios.length, 'Every configured managed-environment browser case must pass')
      assert.equal(browserSummary.failedCases, 0, 'Configured managed-environment browser cases failed')
      assert.equal(browserSummary.skippedCases, 0, 'Configured managed-environment browser cases were skipped')
      assert.equal(browserSummary.interruptedCases, 0, 'Configured managed-environment browser cases were interrupted')
      proof.cloudBrowser = { actualNativeExit: browserExit, identity: browserIdentity, selectedScenarios: [...scenarios], ...browserSummary }
    })
    const healthy = proof.healthy as any
    const original = (await rig.inventory()).find(row => row.soulId === healthy.soulId)
    assert(original?.containerId)
    await fs.rename(path.join(selected.workspace, 'healthy/.managed-fixture/child-receipt.json'), path.join(root, 'initial-child-receipt.json'))
    rig.runtime.stopOwnedRuntimeExact(original.containerId)
    const replacement = await poll('current-owner replacement incarnation', async () => (await rig!.inventory()).find(row =>
      row.soulId === original.soulId && row.incarnationId !== original.incarnationId && row.launchState === 'running'), 300_000)
    const replacementChild = await poll('replacement Bun child', async () => readJson(path.join(selected.workspace, 'healthy/.managed-fixture/child-receipt.json')))
    const replacementStage = await stageProof(rig, replacement, nonce)
    assert.equal(replacement.nativeSessionId, original.nativeSessionId)
    assert.equal(replacementChild.bun, true)
    assert.equal(replacementChild.terminalId, replacement.terminalId)
    assert.equal(replacementChild.nativeSessionId, replacement.nativeSessionId)
    assert.equal(replacementChild.candidateSha, rig.runtime.candidateSha)
    assert.equal(replacementChild.runId, rig.runtime.runId)
    assert.equal(replacementChild.expectedNonce, nonce)
    assert.equal(replacementChild.executableMode, '0711')
    proof.nativeReplacement = { priorIncarnationId: original.incarnationId, incarnationId: replacement.incarnationId,
      soulId: replacement.soulId, nativeSessionId: replacement.nativeSessionId, stage: replacementStage, child: replacementChild }
    await writeJson(path.join(rig.runtime.evidenceDir, 'managed-environment-acceptance.json'), proof)
    const browserSummary = proof.cloudBrowser as ManagedEnvironmentBrowserSummary
    console.log(JSON.stringify({ severity: 'info', event: 'managed_environment.acceptance_passed', candidateSha: fixture.candidateSha,
      runId: fixture.runId, executedBrowserCases: browserSummary.executedCases, passedBrowserCases: browserSummary.passedCases,
      receipt: path.join(rig.runtime.evidenceDir, 'managed-environment-acceptance.json') }))
  } finally {
    const errors: Error[] = []
    const cleanup: Record<string, unknown> = {}
    const attempt = async (operation: string, action: () => unknown | Promise<unknown>) => {
      try { cleanup[operation] = await action() }
      catch (error) { errors.push(new Error(`Owned fixture cleanup failed: ${operation}`, { cause: error })); cleanup[operation] = 'FAILED; retain owned fixture' }
    }
    await attempt('browserJoin', () => stopExact(browser, browserIdentity, browserJoin))
    await attempt('tunnelJoin', () => stopExact(tunnel, tunnelIdentity, tunnelJoin))
    await attempt('versionJoin', () => stopExact(version, versionIdentity, versionJoin))
    if (rig) {
      if (!webIdentity && rig.web) await attempt('scratchWebIdentity', async () => {
        try { webIdentity = await processIdentity(rig!.web.processEvidence()) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
            && (!(error instanceof Error) || error.message !== 'RustServer has no live owned process evidence')) throw error
          return 'Already absent according to the owning helper'
        }
      })
      for (const owner of owners) await attempt(`capture:${owner.providerVolumeName}`, () => {
        capturedVolumes.push(...captureProviderParityVolumes([owner]))
      })
      let rigSettled = false
      await attempt('rigStop', async () => {
        const result = await rig!.stop()
        assert(result.ok, 'Owned rig cleanup did not settle all workloads')
        if (webIdentity) {
          try {
            const current = await processIdentity({ pid: webIdentity.pid })
            assert.notEqual(current.birthTicks, webIdentity.birthTicks, 'Owned scratch web process remains live')
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        rigSettled = true
        return result
      })
      if (rigSettled) for (const volume of capturedVolumes) await attempt(`remove:${volume.owner.providerVolumeName}`,
        () => cleanupProviderParityVolumes([volume]))
    }
    if (errors.length === 0) {
      await attempt('grantDirectory', () => fs.rm(grants.directory, { recursive: true, force: true }))
      await attempt('fixtureDirectory', () => fs.rm(root, { recursive: true, force: true }))
    }
    if (rig) await attempt('cleanupReceipt', () => writeJson(path.join(rig!.runtime.evidenceDir, 'managed-environment-cleanup.json'),
      { cleanup, knownOwnedSettled: errors.length === 0, retainedFixture: errors.length ? root : undefined }))
    if (errors.length) throw new AggregateError(errors, 'Managed environment owned cleanup remains unsettled')
  }
}

export async function runManagedProviderEnvironmentTarget(args = process.argv.slice(2)) {
  const mode = resolveManagedProviderEnvironmentTargetMode(args)
  if (mode === 'code-checkpoint') return runCodeCheckpointTarget()
  return runManagedEnvironmentTarget()
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runManagedProviderEnvironmentTarget().catch(error => {
    const mode = process.argv.slice(2).includes('--checkpoint') ? 'code_checkpoint' : 'managed_environment'
    console.error(JSON.stringify({ severity: 'error', event: `${mode}.acceptance_failed`, error: error instanceof Error ? error.message : 'Unknown fixture failure' }))
    process.exitCode = 1
  })
}
