// Local fake Anthropic endpoint and isolated fixture for driving the REAL
// pinned Claude CLI in tests. Nothing here ever contacts the real API: the CLI
// gets ANTHROPIC_BASE_URL pointing at a loopback server, a random dummy key, a
// throwaway HOME/CLAUDE_CONFIG_DIR, and a dead proxy for any other egress.
//
// Used by:
//   - claude-checkpoint-uuid-replay.mjs (checkpoint UUID replay contract)
//   - claude-cli-scenarios.mjs (the T1-T19 contract suite and the simulator
//     conformance suite)
//   - claude-sidecar-shutdown.mjs (the real sidecar's shutdown contract; it
//     brings its own streaming provider)
//   - claude-capture-fixtures.mjs (resolvePinnedClaude only: the manual
//     transcript-fixture capture keeps its own `ws` workspace, which the
//     committed fixtures' paths depend on)
//
// The model's behavior is chosen by prompt markers (see
// test/fixtures/claude-cli-sim/prompt-markers.mjs), the same language the CLI
// simulator understands. Run directly (`node claude-local-provider.mjs
// --serve`) it prints one JSON line {"port","url"} and serves until stdin
// closes, for lanes that are not written in JavaScript.

import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parsePromptMarkers, SUBAGENT_MARKER, HANG_MCP_QUALIFIED_TOOL, PLAN_TEXT } from '../../fixtures/claude-cli-sim/prompt-markers.mjs'

export const PINNED_SDK_VERSION = '0.3.237'
export const PINNED_CLI_VERSION = '2.1.237'
export const FAKE_MODEL = 'claude-sonnet-4-5-20250929'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPO_ROOT = path.resolve(here, '../../..')
export const HANG_MCP_SERVER_SCRIPT = path.join(here, 'claude-hang-mcp-server.mjs')

/** Thrown when the pinned SDK or its bundled CLI is not installed. Never a skip. */
export class PinnedClaudeMissingError extends Error {
  constructor(message) {
    super(`${message}. The real-CLI contract suite requires @anthropic-ai/claude-agent-sdk ${PINNED_SDK_VERSION} with its bundled CLI ${PINNED_CLI_VERSION}; run \`pnpm install --frozen-lockfile\` at the repository root.`)
    this.name = 'PinnedClaudeMissingError'
    this.code = 'PINNED_CLAUDE_MISSING'
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * Locate the pinned SDK (the sidecar's vendored copy) and the native CLI binary
 * it bundles for this platform, and check both versions. Throws
 * PinnedClaudeMissingError instead of returning a "skip" signal.
 */
export async function resolvePinnedClaude(repoRoot = DEFAULT_REPO_ROOT) {
  const sdkLink = path.join(repoRoot, 'crates/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk')
  let sdkDir
  try {
    sdkDir = await fs.realpath(sdkLink)
  } catch {
    throw new PinnedClaudeMissingError(`The sidecar SDK is not installed at ${sdkLink}`)
  }
  const sdkPackage = await readJson(path.join(sdkDir, 'package.json'))
  if (sdkPackage.version !== PINNED_SDK_VERSION || sdkPackage.claudeCodeVersion !== PINNED_CLI_VERSION) {
    throw new PinnedClaudeMissingError(`Found SDK ${sdkPackage.version} bundling CLI ${sdkPackage.claudeCodeVersion}`)
  }
  const requireFromSdk = createRequire(path.join(sdkDir, 'package.json'))
  const candidates = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`]
  if (process.platform === 'linux') candidates.push(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`)
  let bundleDir
  for (const name of candidates) {
    try {
      bundleDir = path.dirname(requireFromSdk.resolve(`${name}/package.json`))
      break
    } catch { /* try the next candidate */ }
  }
  if (!bundleDir) throw new PinnedClaudeMissingError(`No bundled CLI package (${candidates.join(' or ')}) is installed`)
  const bundlePackage = await readJson(path.join(bundleDir, 'package.json'))
  if (bundlePackage.version !== PINNED_SDK_VERSION) {
    throw new PinnedClaudeMissingError(`The bundled CLI package is ${bundlePackage.version}`)
  }
  const executable = path.join(bundleDir, process.platform === 'win32' ? 'claude.exe' : 'claude')
  let nativeCli
  try {
    nativeCli = await fs.realpath(executable)
  } catch {
    throw new PinnedClaudeMissingError(`The bundled CLI binary is missing at ${executable}`)
  }
  let version
  try {
    const { stdout } = await promisify(execFile)(nativeCli, ['--version'], { timeout: 20_000, maxBuffer: 8192, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.tmpdir() } })
    version = stdout.trim()
  } catch (error) {
    throw new PinnedClaudeMissingError(`The bundled CLI did not run (${String(error?.message ?? error).slice(0, 200)})`)
  }
  if (!new RegExp(`^${PINNED_CLI_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`).test(version)) {
    throw new PinnedClaudeMissingError(`The bundled CLI reports version ${JSON.stringify(version)}`)
  }
  return {
    sdkDir,
    sdkEntry: path.join(sdkDir, 'sdk.mjs'),
    sdkVersion: sdkPackage.version,
    cliVersion: sdkPackage.claudeCodeVersion,
    nativeCli,
  }
}

/**
 * A throwaway HOME / CLAUDE_CONFIG_DIR / workspace. `env(baseUrl)` is the
 * complete environment for the CLI: nothing from the caller's environment
 * leaks in except PATH's node directory.
 */
export async function createClaudeFixture({ parent = os.tmpdir(), prefix = 'freshell-claude-contract-' } = {}) {
  const root = await fs.mkdtemp(path.join(parent, prefix))
  await fs.chmod(root, 0o700)
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'workspace')
  const tmp = path.join(root, 'tmp')
  for (const directory of [home, cwd, tmp]) await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const claudeConfigDir = path.join(home, '.claude')
  return {
    root,
    home,
    cwd,
    tmp,
    claudeConfigDir,
    env(baseUrl, extra = {}) {
      return {
        HOME: home,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: tmp,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_DATA_HOME: path.join(home, '.local/share'),
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        ANTHROPIC_API_KEY: `sk-local-${randomUUID()}`,
        ANTHROPIC_BASE_URL: baseUrl,
        // Any egress other than the loopback provider hits a closed port.
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_METRICS: '1',
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
        LANG: 'C.UTF-8',
        ...extra,
      }
    },
    /** Every transcript (.jsonl) under CLAUDE_CONFIG_DIR, as paths relative to it. */
    async transcripts() {
      const out = []
      const walk = async (directory) => {
        let entries
        try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          const target = path.join(directory, entry.name)
          if (entry.isDirectory()) await walk(target)
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.relative(claudeConfigDir, target))
        }
      }
      await walk(claudeConfigDir)
      return out.sort()
    },
    /**
     * The parsed lines of `<sessionId>.jsonl` under projects/, or null when
     * absent. The CLI appends while we read, so an unterminated last line is
     * not yet part of the transcript.
     */
    async readTranscript(sessionId) {
      const match = (await this.transcripts()).find((file) => file.startsWith('projects') && path.basename(file) === `${sessionId}.jsonl`)
      if (!match) return null
      const text = await fs.readFile(path.join(claudeConfigDir, match), 'utf8')
      const complete = text.slice(0, text.lastIndexOf('\n') + 1)
      return complete.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('\n')
}

/**
 * The text the model should "read" in the last user message: everything after
 * its last tool_result block. A send absorbed into a tool call (or typed after
 * an interrupted one) rides in the same message as the tool_result, after it.
 */
function promptTextAfterTools(message) {
  const content = message?.content
  if (!Array.isArray(content)) return { text: textOfContent(content), afterTool: false }
  let lastTool = -1
  content.forEach((block, i) => { if (block?.type === 'tool_result') lastTool = i })
  return { text: textOfContent(content.slice(lastTool + 1)), afterTool: lastTool >= 0 }
}

function sseWriter(response) {
  return (type, data) => {
    if (response.destroyed || response.writableEnded) return false
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    return true
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start the loopback endpoint. Returns { url, port, requests, close }.
 * `requests` records one summary row per model request (no bodies).
 */
export async function startLocalProvider({ replyText = 'ok' } = {}) {
  const requests = []
  const hung = new Set()
  let toolSeq = 0

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    let body = {}
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        response.writeHead(400).end()
        return
      }
    }
    if (url.pathname === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }))
      return
    }
    if (url.pathname !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }

    const messages = Array.isArray(body.messages) ? body.messages : []
    // The last USER message: the CLI can append a system-role message after it
    // (its agent-type listing), which carries no prompt.
    const last = [...messages].reverse().find((m) => m?.role === 'user')
    const firstUserText = textOfContent(messages.find((m) => m?.role === 'user')?.content)
    const { text: promptText, afterTool } = promptTextAfterTools(last)
    const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : []
    const isSubagent = firstUserText.includes(SUBAGENT_MARKER)
    const marker = parsePromptMarkers(promptText)
    requests.push({ n: requests.length + 1, marker: marker.kind, afterTool, isSubagent, tools: tools.length })

    if (marker.kind === 'api_error') {
      response.writeHead(marker.status, { 'content-type': 'application/json', 'request-id': randomUUID() })
        .end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'local provider error' } }))
      return
    }

    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': randomUUID() })
    const send = sseWriter(response)
    send('message_start', {
      message: {
        id: `msg_${randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: FAKE_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 0 },
      },
    })

    if (marker.kind === 'hang') {
      hung.add(response)
      response.once('close', () => hung.delete(response))
      return
    }

    const toolUse = (name, input) => {
      toolSeq += 1
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_local_${toolSeq}`, name, input: {} } })
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } })
    }

    if (marker.kind === 'tool') {
      toolUse('Bash', { command: marker.command, description: 'local provider command', ...(marker.timeoutMs ? { timeout: marker.timeoutMs } : {}) })
    } else if (marker.kind === 'mcp_hang') {
      toolUse(HANG_MCP_QUALIFIED_TOOL, {})
    } else if (marker.kind === 'exit_plan') {
      toolUse('ExitPlanMode', { plan: PLAN_TEXT })
    } else if (marker.kind === 'agent_async') {
      const agentTool = tools.find((name) => name === 'Agent' || name === 'Task') ?? 'Agent'
      toolUse(agentTool, {
        description: 'local provider background agent',
        // The subagent streams slowly so that it finishes after the main turn
        // (its completion then starts a CLI-initiated turn from idle).
        prompt: `${SUBAGENT_MARKER} SLOW`,
        subagent_type: 'general-purpose',
        run_in_background: true,
      })
    } else {
      const pieces = marker.kind === 'slow'
        ? Array.from({ length: marker.chunks }, (_, i) => `chunk${i} `)
        : [afterTool ? 'done' : replyText]
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const piece of pieces) {
        if (!send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } })) return
        if (marker.kind === 'slow') await sleep(marker.delayMs)
      }
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    }
    send('message_stop', {})
    response.end()
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const response of hung) response.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    },
    get listening() { return server.listening },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--serve')) {
  const provider = await startLocalProvider()
  process.stdout.write(`${JSON.stringify({ port: provider.port, url: provider.url })}\n`)
  const stop = async () => { await provider.close(); process.exit(0) }
  process.stdin.on('end', stop)
  process.stdin.resume()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
