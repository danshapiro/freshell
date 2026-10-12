import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')

const sdkDir = path.join(repoRoot, 'crates/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk')
const sdkPackage = JSON.parse(await fs.readFile(path.join(sdkDir, 'package.json'), 'utf8'))
if (sdkPackage.version !== '0.3.237' || sdkPackage.claudeCodeVersion !== '2.1.237') {
  throw new Error('the Claude checkpoint contract requires SDK 0.3.237 and CLI 2.1.237')
}

const storeRoot = path.join(repoRoot, 'node_modules/.pnpm')
const optionalStore = (await fs.readdir(storeRoot)).find(name =>
  name.startsWith('@anthropic-ai+claude-agent-sdk-linux-x64@0.3.237'))
if (!optionalStore) throw new Error('the pinned Linux x64 Claude CLI package is not installed')
const bundleDir = path.join(storeRoot, optionalStore, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64')
const bundlePackage = JSON.parse(await fs.readFile(path.join(bundleDir, 'package.json'), 'utf8'))
if (bundlePackage.version !== '0.3.237') throw new Error('the bundled Claude CLI package version is not pinned')
const nativeCli = await fs.realpath(path.join(bundleDir, 'claude'))

const fixture = await fs.mkdtemp(path.join(repoRoot, '.tmp-claude-checkpoint-contract-'))
await fs.chmod(fixture, 0o700)
const home = path.join(fixture, 'home')
const cwd = path.join(fixture, 'workspace')
for (const directory of [home, cwd, path.join(fixture, 'tmp')]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
}

const inputUuid = randomUUID()
const promptText = randomUUID()
const responseText = randomUUID()
const apiKey = randomUUID()
const childEnv = {
  HOME: home,
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  TMPDIR: path.join(fixture, 'tmp'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local/share'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  ANTHROPIC_API_KEY: apiKey,
  FRESHELL_CLAUDE_ONECLI_API_KEY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_METRICS: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  LANG: 'C.UTF-8',
}

let server
let query
let nativeChild
let releasePrompt
let timer
let resultMessage
let replayedUserUuid
let persistedUserUuid
let replayFlagObservedByNativeCli = false
let localProviderClosed = false
let nativeCliExited = false
let verdict = 'FAIL'
let failureStage = 'initialization'

const closeProvider = async () => {
  releasePrompt?.()
  try { query?.close?.() } catch {}
  if (nativeChild && !nativeCliExited) {
    nativeChild.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => nativeChild.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
    if (!nativeCliExited) nativeChild.kill('SIGKILL')
    await Promise.race([
      new Promise(resolve => nativeChild.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
  }
  nativeCliExited = !nativeChild || nativeCliExited
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  localProviderClosed = !server || !server.listening
}

try {
  const { stdout: nativeVersion } = await promisify(execFile)(nativeCli, ['--version'], {
    cwd,
    env: childEnv,
    timeout: 10_000,
    maxBuffer: 8192,
  })
  if (!/^2\.1\.237(?:\s|$)/.test(nativeVersion.trim())) {
    throw new Error('native CLI did not report version 2.1.237')
  }
  const { stdout: nativeHelp } = await promisify(execFile)(nativeCli, ['--help'], {
    cwd,
    env: childEnv,
    timeout: 10_000,
    maxBuffer: 100_000,
  })
  if (!nativeHelp.includes('--replay-user-messages')) throw new Error('native CLI does not advertise replay-user-messages')

  failureStage = 'local provider'
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    if (chunks.length) {
      try { JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        response.writeHead(400).end()
        return
      }
    }
    if (url.pathname === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ input_tokens: 1 }))
      return
    }
    if (url.pathname !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }

    const message = {
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: responseText }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'request-id': randomUUID(),
    })
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } })
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: responseText } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    send('message_stop', {})
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const providerUrl = `http://127.0.0.1:${server.address().port}`
  childEnv.ANTHROPIC_BASE_URL = providerUrl

  // Match the production sidecar's clean child environment and SDK dependency.
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, childEnv)
  const { query: sdkQuery } = await import(path.join(sdkDir, 'sdk.mjs'))
  const abortController = new AbortController()
  timer = setTimeout(() => {
    abortController.abort()
    query?.close?.()
  }, 45_000)

  async function* prompt() {
    yield {
      type: 'user',
      uuid: inputUuid,
      message: { role: 'user', content: promptText },
      parent_tool_use_id: null,
    }
    await new Promise(resolve => { releasePrompt = resolve })
  }

  failureStage = 'SDK query and replay'
  query = sdkQuery({
    prompt: prompt(),
    options: {
      cwd,
      env: childEnv,
      settingSources: ['user', 'project', 'local'],
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 1,
      systemPrompt: '',
      pathToClaudeCodeExecutable: nativeCli,
      extraArgs: { 'replay-user-messages': null },
      abortController,
      spawnClaudeCodeProcess(options) {
        if (options.command !== nativeCli || options.cwd !== cwd
          || options.env.HOME !== home || options.env.ANTHROPIC_BASE_URL !== providerUrl) {
          throw new Error('SDK spawned the native CLI outside the isolated local-provider fixture')
        }
        replayFlagObservedByNativeCli = options.args.includes('--replay-user-messages')
        nativeChild = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        nativeChild.stderr.on('data', () => {})
        nativeChild.once('exit', () => { nativeCliExited = true })
        return nativeChild
      },
      stderr() {},
    },
  })

  for await (const message of query) {
    if (message.type === 'user' && message.isReplay === true && message.message?.role === 'user') {
      replayedUserUuid = message.uuid
    }
    if (message.type === 'result') {
      resultMessage = message
      releasePrompt?.()
      break
    }
  }
  clearTimeout(timer)
  timer = undefined
  query.close()
  await closeProvider()

  failureStage = 'persisted transcript'
  async function walk(directory) {
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        for (const line of (await fs.readFile(target, 'utf8')).split('\n').filter(Boolean)) {
          let row
          try { row = JSON.parse(line) } catch { continue }
          if (row.type === 'user' && row.message?.role === 'user' && row.uuid === inputUuid) {
            persistedUserUuid = row.uuid
          }
        }
      }
    }
  }
  await walk(home)
  if (replayedUserUuid === inputUuid && persistedUserUuid === inputUuid
    && resultMessage?.subtype === 'success' && resultMessage?.is_error === false
    && replayFlagObservedByNativeCli && nativeCliExited && localProviderClosed) {
    verdict = 'PASS'
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    component: 'claude-checkpoint-contract',
    stage: failureStage,
    code: error?.code ?? 'CONTRACT_FAILURE',
    name: error?.name ?? 'Error',
    message: String(error?.message ?? 'unknown error').slice(0, 500),
  })}\n`)
} finally {
  if (timer) clearTimeout(timer)
  await closeProvider()
  await fs.rm(fixture, { recursive: true, force: true })
}

const fixtureRemoved = !(await fs.stat(fixture).catch(() => null))
process.stdout.write(`${JSON.stringify({
  verdict,
  sdkVersion: sdkPackage.version,
  bundledCliVersion: sdkPackage.claudeCodeVersion,
  replayFlagObservedByNativeCli,
  replayedUserUuid,
  persistedUserUuid,
  resultSubtype: resultMessage?.subtype,
  nativeCliExited,
  localProviderClosed,
  fixtureRemoved,
})}\n`)
if (verdict !== 'PASS' || !fixtureRemoved) process.exitCode = 1
