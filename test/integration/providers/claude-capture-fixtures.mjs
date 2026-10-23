// Manual capture tool for the real-CLI claude transcript fixtures under
// test/fixtures/fresh-agent/claude/real-cli-2.1.237/ (transcript-live plan,
// Phase A1). It drives the PINNED Claude CLI (SDK 0.3.237 / CLI 2.1.237)
// through scripted scenarios against a LOCAL fake Anthropic endpoint (never the
// real API), then copies the transcript the CLI itself wrote (main JSONL plus
// the `<session>/subagents/` directory) into the fixture tree, with the
// temporary fixture root rewritten to the stable placeholder `/fixture`.
//
// Usage (from the repo root; not part of any test suite):
//   node test/integration/providers/claude-capture-fixtures.mjs <repoRoot> <outDir> [scenario...]
//
// Each scenario writes:
//   <outDir>/<scenario>/session.jsonl              the main transcript
//   <outDir>/<scenario>/session/subagents/*        subagent transcripts + meta.json
//   <outDir>/<scenario>/sdk.jsonl                  the SDK message sequence ({t, msg})
// Structured progress is written to stderr as JSONL with a severity field.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { FAKE_MODEL, resolvePinnedClaude } from './claude-local-provider.mjs'

const SCENARIOS = ['tools-sync', 'agent-async', 'agent-failed', 'compact-ok', 'compact-fail', 'api-error', 'image']

const [repoRoot, outDir, ...requested] = process.argv.slice(2)
if (!repoRoot || !outDir) {
  throw new Error('usage: claude-capture-fixtures.mjs <repoRoot> <outDir> [scenario...]')
}
const scenarios = requested.length > 0 ? requested : SCENARIOS
for (const name of scenarios) {
  if (!SCENARIOS.includes(name)) throw new Error(`unknown scenario ${name}`)
}

const log = (severity, event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, component: 'claude-capture-fixtures', event, ...fields })}\n`)
}

// The same pinned SDK and bundled CLI the contract suite checks, for this platform.
const pinned = await resolvePinnedClaude(repoRoot)
const nativeCli = pinned.nativeCli
const { query } = await import(pathToFileURL(pinned.sdkEntry).href)

const MODEL = FAKE_MODEL
// 1x1 PNG, used for the image attachment and the image Read result.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

let messageSeq = 0
function sse(res, blocks, { inputTokens = 100, outputTokens = 20 } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  const id = `msg_fixture${String(++messageSeq).padStart(4, '0')}`
  ev('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const piece of block.text.match(/[\s\S]{1,8}/g)) ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
    } else if (block.type === 'thinking') {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } })
    } else {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    }
    ev('content_block_stop', { type: 'content_block_stop', index })
  })
  const stop = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } })
  ev('message_stop', { type: 'message_stop' })
  res.end()
}

function apiError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

const lastToolResult = (messages) => {
  const last = messages[messages.length - 1]
  const content = Array.isArray(last?.content) ? last.content : []
  return content.find((block) => block.type === 'tool_result')
}
const lastUserText = (messages) => {
  const last = messages[messages.length - 1]
  if (typeof last?.content === 'string') return last.content
  return (Array.isArray(last?.content) ? last.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}
// The pinned CLI's compaction request ends with its summary instructions.
const isCompactionRequest = (body) => /creating the above summary|<analysis> block followed by a <summary> block/
  .test(JSON.stringify(body.messages?.at(-1)?.content ?? ''))
const isSubagent = (body) => JSON.stringify(body.messages?.[0]?.content ?? '').includes('SUBAGENT-PROMPT')

// Per-scenario fake model: (body, ctx) => void (writes the response).
function makeResponder(scenario, ctx) {
  const file = path.join(ctx.cwd, 'a.txt')
  return (body, res) => {
    const messages = body.messages ?? []
    const toolResult = lastToolResult(messages)
    if (isSubagent(body)) {
      if (!toolResult) return sse(res, [{ type: 'text', text: 'subagent reading' }, { type: 'tool_use', id: `toolu_sub${++ctx.toolSeq}`, name: 'Read', input: { file_path: file } }])
      return sse(res, [{ type: 'text', text: 'SUBAGENT-DONE: file has two' }])
    }
    switch (scenario) {
      case 'tools-sync': {
        if (!toolResult) {
          if (lastUserText(messages).includes('GO')) {
            return sse(res, [{ type: 'thinking', thinking: 'plan the write' }, { type: 'text', text: 'Writing the file now.' }, { type: 'tool_use', id: 'toolu_write1', name: 'Write', input: { file_path: file, content: 'one\n' } }])
          }
          return sse(res, [{ type: 'text', text: 'ok' }])
        }
        if (toolResult.tool_use_id === 'toolu_write1') return sse(res, [{ type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: { file_path: file, old_string: 'one', new_string: 'two' } }])
        if (toolResult.tool_use_id === 'toolu_edit1') return sse(res, [{ type: 'tool_use', id: 'toolu_edit2', name: 'Edit', input: { file_path: file, old_string: 'not-present', new_string: 'x' } }])
        // b.txt exists before the session: the CLI requires a Read before an Edit.
        if (toolResult.tool_use_id === 'toolu_edit2') return sse(res, [{ type: 'tool_use', id: 'toolu_read2', name: 'Read', input: { file_path: path.join(ctx.cwd, 'b.txt') } }])
        if (toolResult.tool_use_id === 'toolu_read2') return sse(res, [{ type: 'tool_use', id: 'toolu_edit3', name: 'Edit', input: { file_path: path.join(ctx.cwd, 'b.txt'), old_string: 'beta', new_string: 'beta\ngamma' } }])
        if (toolResult.tool_use_id === 'toolu_edit3') return sse(res, [{ type: 'tool_use', id: 'toolu_agent1', name: 'Agent', input: { description: 'check file', prompt: 'SUBAGENT-PROMPT read a.txt', subagent_type: 'general-purpose', run_in_background: false } }])
        if (toolResult.tool_use_id === 'toolu_agent1') return sse(res, [{ type: 'text', text: 'All done.' }])
        return sse(res, [{ type: 'text', text: 'unexpected' }])
      }
      case 'agent-async': {
        const text = lastUserText(messages)
        if (text.includes('<task-notification>')) return sse(res, [{ type: 'text', text: 'The background check finished.' }])
        if (!toolResult) {
          if (text.includes('GO')) {
            // Seed the file the subagent reads, then delegate in the background.
            return sse(res, [{ type: 'tool_use', id: 'toolu_write1', name: 'Write', input: { file_path: file, content: 'two\n' } }])
          }
          return sse(res, [{ type: 'text', text: 'ok' }])
        }
        if (toolResult.tool_use_id === 'toolu_write1') return sse(res, [{ type: 'tool_use', id: 'toolu_agent1', name: 'Agent', input: { description: 'check file', prompt: 'SUBAGENT-PROMPT read a.txt', subagent_type: 'general-purpose' } }])
        if (toolResult.tool_use_id === 'toolu_agent1') return sse(res, [{ type: 'text', text: 'Launched the check in the background.' }])
        return sse(res, [{ type: 'text', text: 'unexpected' }])
      }
      case 'agent-failed': {
        if (!toolResult) return sse(res, [{ type: 'tool_use', id: 'toolu_agent1', name: 'Agent', input: { description: 'unknown helper', prompt: 'SUBAGENT-PROMPT never runs', subagent_type: 'no-such-agent-type', run_in_background: false } }])
        return sse(res, [{ type: 'text', text: 'The delegation failed.' }])
      }
      case 'compact-ok':
      case 'compact-fail': {
        if (isCompactionRequest(body)) {
          if (scenario === 'compact-fail') return apiError(res, 400, 'invalid_request_error', 'compaction refused by fake')
          return sse(res, [{ type: 'text', text: '<summary>The user said hi three times.</summary>' }], { inputTokens: 5000, outputTokens: 30 })
        }
        return sse(res, [{ type: 'text', text: `reply ${++ctx.replySeq}` }], { inputTokens: 5000, outputTokens: 30 })
      }
      case 'api-error':
        return apiError(res, 400, 'invalid_request_error', 'fixture bad request')
      case 'image': {
        if (!toolResult) return sse(res, [{ type: 'tool_use', id: 'toolu_read1', name: 'Read', input: { file_path: path.join(ctx.cwd, 'pic.png') } }])
        return sse(res, [{ type: 'text', text: 'a red pixel' }])
      }
      default:
        throw new Error(`no responder for ${scenario}`)
    }
  }
}

// Prompt scripts: each entry is sent after the previous result.
const PROMPTS = {
  'tools-sync': ['GO write then edit then delegate'],
  'agent-async': ['GO delegate in the background'],
  'agent-failed': ['delegate to a missing agent'],
  'compact-ok': ['hi there', 'second msg', 'third msg', '/compact keep it short', 'after compact', '/cost', '/context'],
  'compact-fail': ['hi there', 'second msg', 'third msg', '/compact'],
  'api-error': ['hi'],
  image: [[{ type: 'text', text: 'what is this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]],
}
// Results to wait for beyond the scripted prompts (unsolicited turns).
const EXTRA_RESULTS = { 'agent-async': 1 }

async function walkFiles(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walkFiles(full))
    else out.push(full)
  }
  return out
}

async function capture(scenario) {
  messageSeq = 0
  // Outside the repo so the CLI's CLAUDE.md walk-up never sees project files.
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-capture-'))
  const home = path.join(fixtureRoot, 'home')
  const cwd = path.join(fixtureRoot, 'ws')
  for (const dir of [home, cwd, path.join(fixtureRoot, 'tmp')]) await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(cwd, 'pic.png'), Buffer.from(PNG, 'base64'))
  await fs.writeFile(path.join(cwd, 'b.txt'), 'alpha\nbeta\n')
  const ctx = { cwd, toolSeq: 0, replySeq: 0 }
  const respond = makeResponder(scenario, ctx)
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!req.url.includes('/v1/messages')) { res.writeHead(404).end(); return }
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 42 })); return }
    if (process.env.CAPTURE_DEBUG) {
      const body = JSON.parse(raw)
      log('debug', 'fake_request', { scenario, system: JSON.stringify(body.system ?? '').slice(0, 300), last: JSON.stringify(body.messages?.at(-1)?.content ?? '').slice(-600), tools: (body.tools ?? []).length })
    }
    try { respond(JSON.parse(raw), res) } catch (error) {
      log('error', 'fake_endpoint_failed', { scenario, message: String(error?.message ?? error) })
      res.writeHead(500).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = {
    HOME: home,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: path.join(fixtureRoot, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_API_KEY: 'sk-fixture-not-a-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    // Any egress other than the loopback endpoint hits a closed port (as in createClaudeFixture).
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    LANG: 'C.UTF-8',
  }
  const script = [...PROMPTS[scenario]]
  const queue = []
  let wake
  let closed = false
  async function* prompt() {
    while (!closed) {
      while (queue.length) yield queue.shift()
      await new Promise((resolve) => { wake = resolve })
    }
  }
  const push = (content) => {
    queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: 'default' })
    wake?.()
  }
  const t0 = Date.now()
  const sdkMessages = []
  const abort = new AbortController()
  const q = query({
    prompt: prompt(),
    options: {
      cwd,
      env,
      model: MODEL,
      pathToClaudeCodeExecutable: nativeCli,
      abortController: abort,
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      extraArgs: { 'replay-user-messages': null },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      stderr: () => {},
    },
  })
  const timer = setTimeout(() => {
    log('warn', 'scenario_timeout', { scenario })
    abort.abort()
    try { q.close() } catch {}
  }, 90_000)
  let pendingResults = script.length + (EXTRA_RESULTS[scenario] ?? 0)
  push(script.shift())
  try {
    for await (const msg of q) {
      sdkMessages.push({ t: Date.now() - t0, msg })
      if (msg.type !== 'result') continue
      pendingResults -= 1
      if (script.length > 0) push(script.shift())
      else if (pendingResults <= 0) break
    }
  } catch (error) {
    log('error', 'scenario_stream_failed', { scenario, message: String(error?.message ?? error) })
  }
  clearTimeout(timer)
  // Let the CLI flush its last JSONL lines (writes lag emission by ~100 ms).
  await new Promise((resolve) => setTimeout(resolve, 1500))
  closed = true
  wake?.()
  try { q.close() } catch {}
  server.closeAllConnections()
  server.close()

  // Both the literal root and the CLI's slug encoding of it (`-tmp-...-ws`).
  const slugRoot = fixtureRoot.replace(/[^a-zA-Z0-9]/g, '-')
  const normalize = (text) => text.split(fixtureRoot).join('/fixture').split(slugRoot).join('-fixture')
  const projects = path.join(home, '.claude', 'projects')
  const files = await walkFiles(projects)
  const main = files.find((file) => file.endsWith('.jsonl') && !file.includes(`${path.sep}subagents${path.sep}`))
  if (!main) throw new Error(`scenario ${scenario} produced no transcript`)
  const sessionDir = main.slice(0, -'.jsonl'.length)
  const target = path.join(outDir, scenario)
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, 'session.jsonl'), normalize(await fs.readFile(main, 'utf8')))
  for (const file of files.filter((f) => f.startsWith(`${sessionDir}${path.sep}subagents${path.sep}`))) {
    const relative = path.relative(sessionDir, file)
    await fs.mkdir(path.join(target, 'session', path.dirname(relative)), { recursive: true })
    await fs.writeFile(path.join(target, 'session', relative), normalize(await fs.readFile(file, 'utf8')))
  }
  await fs.writeFile(
    path.join(target, 'sdk.jsonl'),
    sdkMessages.map((row) => normalize(JSON.stringify(row))).join('\n') + '\n',
  )
  await fs.rm(fixtureRoot, { recursive: true, force: true })
  log('info', 'scenario_captured', { scenario, sdkMessages: sdkMessages.length, transcriptFiles: files.length })
}

for (const scenario of scenarios) await capture(scenario)
process.exit(0)
