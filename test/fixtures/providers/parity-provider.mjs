#!/usr/bin/env node
// Records what a provider child can actually see on either terminal route.
// The wrapper basename supplies the provider, so no test-only environment has
// to cross the managed launch allowlist.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const provider = path.basename(process.argv[1]).replace(/^parity-/, '')
const argv = process.argv.slice(2)
const cwd = process.cwd()
const launchId = randomUUID()

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function existing(relative) {
  const file = path.join(cwd, relative)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

function append(row) {
  process.stdout.write(`FRESHELL_PROVIDER_PARITY_ROW:${Buffer.from(JSON.stringify({ provider, ...row })).toString('base64')}\n`)
}

function codexRecipe() {
  const values = argv.filter((_, index) => argv[index - 1] === '-c')
  const command = values.find(value => value.startsWith('mcp_servers.freshell.command='))
  const args = values.find(value => value.startsWith('mcp_servers.freshell.args='))
  if (!command || !args) return null
  try {
    return {
      command: JSON.parse(command.slice(command.indexOf('=') + 1)),
      args: JSON.parse(args.slice(args.indexOf('=') + 1)),
    }
  } catch { return null }
}

function mcpRecipe() {
  if (provider === 'codex') return codexRecipe()
  if (provider === 'opencode') {
    const config = readJson(path.join(cwd, '.opencode/opencode.json'))
    let inline = null
    try { inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '') } catch {}
    const entry = inline?.mcp?.freshell ?? config?.mcp?.freshell
    if (Array.isArray(entry?.command)) return { command: entry.command[0], args: entry.command.slice(1) }
    return null
  }
  const flag = provider === 'claude' ? '--mcp-config' : '--mcp-config-file'
  const at = argv.indexOf(flag)
  const selected = at >= 0 ? argv[at + 1] : process.env.AMPLIFIER_MCP_CONFIG
  const config = selected ? readJson(selected) : null
  return config?.mcpServers?.freshell ?? null
}

function rpcProbe(recipe) {
  if (!recipe?.command || !Array.isArray(recipe.args)) {
    append({ kind: 'mcp', error: 'missing_recipe' })
    return
  }
  const child = spawn(recipe.command, recipe.args, { env: process.env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let buffer = ''
  let stderr = ''
  let nextId = 0
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const message = JSON.parse(line)
        if (pending.has(message.id)) {
          pending.get(message.id)(message)
          pending.delete(message.id)
        }
      } catch {}
    }
  })
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr.slice(-2000)}`)) }, 10_000)
    pending.set(id, response => { clearTimeout(timer); resolve(response) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  ;(async () => {
    try {
      const initialized = await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'provider-parity', version: '1' },
      })
      if (initialized.error) throw new Error(initialized.error.message)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const listed = await request('tools/list')
      const called = await request('tools/call', { name: 'freshell', arguments: { action: 'health', params: {} } })
      const authenticated = await request('tools/call', {
        name: 'freshell',
        arguments: { action: 'search-sessions', params: { query: '__provider_parity_no_match__' } },
      })
      const authenticatedBody = authenticated.result?.content?.[0]?.text
        ? JSON.parse(authenticated.result.content[0].text) : null
      append({
        kind: 'mcp',
        tools: listed.result?.tools?.map(tool => tool.name).sort(),
        call: called.result?.content?.[0]?.text ? JSON.parse(called.result.content[0].text) : null,
        isError: called.result?.isError ?? false,
        authenticatedCall: {
          rpcError: authenticated.error?.message,
          isError: authenticated.result?.isError ?? false,
          count: authenticatedBody?.count,
          truncated: authenticatedBody?.truncated,
          body: authenticatedBody,
        },
      })
    } catch (error) {
      append({ kind: 'mcp', error: String(error) })
    } finally {
      child.kill()
    }
  })()
}

const home = process.env.HOME ?? ''
const providerHome = {
  claude: process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
  codex: process.env.CODEX_HOME ?? path.join(home, '.codex'),
  opencode: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode'),
  amplifier: process.env.AMPLIFIER_HOME ?? path.join(home, '.amplifier'),
}[provider]
const pluginRelativePath = {
  claude: 'plugins/parity-plugin.txt',
  codex: 'skills/parity/SKILL.md',
  opencode: 'plugins/parity-plugin.js',
  amplifier: 'bundles/parity-bundle.yaml',
}[provider]
const pluginPath = providerHome && pluginRelativePath ? path.join(providerHome, pluginRelativePath) : null
const nativeIdArgIndex = provider === 'claude'
  ? Math.max(argv.indexOf('--session-id'), argv.indexOf('--resume'))
  : provider === 'amplifier' && argv.includes('resume') ? argv.length - 2 : -1
const nativeId = nativeIdArgIndex >= 0 ? argv[nativeIdArgIndex + 1] : null
const onecliKey = {
  claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY',
  opencode: 'OPENROUTER_API_KEY', amplifier: 'OPENAI_API_KEY',
}[provider]
append({
  kind: 'launch',
  launchId,
  onecliChildDigest: process.env[onecliKey]
    ? createHash('sha256').update(process.env[onecliKey]).digest('hex') : null,
  onecliControlPresent: Boolean(process.env.ONECLI_URL),
  argv,
  cwd,
  env: {
    FRESHELL: process.env.FRESHELL,
    FRESHELL_URL: process.env.FRESHELL_URL,
    FRESHELL_TOKEN_PRESENT: Boolean(process.env.FRESHELL_TOKEN),
    FRESHELL_TERMINAL_ID: process.env.FRESHELL_TERMINAL_ID,
    FRESHELL_TAB_ID: process.env.FRESHELL_TAB_ID,
    FRESHELL_PANE_ID: process.env.FRESHELL_PANE_ID,
    OPENCODE_TUI_CONFIG: process.env.OPENCODE_TUI_CONFIG,
  },
  tuiConfig: provider === 'opencode' && process.env.OPENCODE_TUI_CONFIG
    ? fs.readFileSync(process.env.OPENCODE_TUI_CONFIG, 'utf8') : null,
  inlineConfig: provider === 'opencode'
    ? (() => {
      try {
        const vendor = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '')?.mcp?.vendor
        return vendor ? createHash('sha256').update(JSON.stringify(vendor)).digest('hex') : null
      } catch { return null }
    })()
    : null,
  providerConfig: providerHome ? Object.fromEntries(
    ['settings.json', 'config.toml', 'opencode.json', 'opencode.jsonc', 'config.yaml', 'new-provider.jsonc']
      .map(name => [name, readJson(path.join(providerHome, name)) ?? (fs.existsSync(path.join(providerHome, name)) ? fs.readFileSync(path.join(providerHome, name), 'utf8') : null)])
      .filter(([, value]) => value !== null),
  ) : {},
  providerPlugin: pluginPath && fs.existsSync(pluginPath) ? fs.readFileSync(pluginPath, 'utf8') : null,
  providerOwned: providerHome && fs.existsSync(path.join(providerHome, 'plugins/provider-owned.txt'))
    ? fs.readFileSync(path.join(providerHome, 'plugins/provider-owned.txt'), 'utf8') : null,
  projectPlugin: existing('parity-plugin.js'),
  projectedProjectConfig: provider === 'opencode' && providerHome
    ? (fs.existsSync(path.join(providerHome, 'project/.opencode/opencode.json'))
      ? fs.readFileSync(path.join(providerHome, 'project/.opencode/opencode.json'), 'utf8') : null)
    : null,
  nativeSession: nativeIdArgIndex >= 0 && argv[nativeIdArgIndex + 1]
    ? { source: 'argv', value: argv[nativeIdArgIndex + 1] }
    : { source: 'provider-store', value: null },
  projectConfig: {
    opencodeJson: existing('opencode.json'),
    opencodeJsonc: existing('opencode.jsonc'),
    dotOpencodeJson: existing('.opencode/opencode.json'),
    dotOpencodeJsonc: existing('.opencode/opencode.jsonc'),
  },
  mcpRecipePresent: Boolean(mcpRecipe()),
})
rpcProbe(mcpRecipe())
// This controlled terminal fixture runs the configured native commands. It
// never writes identity receipts itself, and startup emits no user transcript.
async function configuredClaudeStartup() {
  if (!nativeId) return
  const settings = {
    ...(readJson(path.join(providerHome, 'settings.json')) ?? {}),
    ...(readJson(path.join(cwd, '.claude/settings.json')) ?? {}),
    ...(readJson(path.join(cwd, '.claude/settings.local.json')) ?? {}),
  }
  for (let index = 0; index < argv.length - 1; index++) {
    if (argv[index] !== '--settings') continue
    let selected
    try { selected = JSON.parse(argv[index + 1]) } catch { selected = readJson(argv[index + 1]) }
    if (selected) Object.assign(settings, selected)
  }
  const source = argv.includes('--resume') ? 'resume' : 'startup'
  const transcript = path.join(providerHome, 'projects/provider-parity', `${nativeId}.jsonl`)
  const command = (selected, input) => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', selected], { env: process.env, cwd, stdio: ['pipe', 'inherit', 'inherit'] })
    const timer = setTimeout(() => { child.kill(); reject(new Error('configured native command timeout')) }, 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('configured native command refused')) })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
  if (settings.disableAllHooks !== true) {
    for (const group of settings.hooks?.SessionStart ?? []) {
      if (group.matcher && !new RegExp(group.matcher).test(source)) continue
      for (const hook of group.hooks ?? []) {
        if (hook.type === 'command' && typeof hook.command === 'string') {
          await command(hook.command, { hook_event_name: 'SessionStart', session_id: nativeId, source, cwd, transcript_path: transcript })
        }
      }
    }
  }
  if (settings.statusLine?.type === 'command' && typeof settings.statusLine.command === 'string') {
    const model = argv.indexOf('--model')
    await command(settings.statusLine.command, { session_id: nativeId, transcript_path: transcript,
      version: '2.1.263', model: { id: model >= 0 ? argv[model + 1] : settings.model ?? 'controlled-fixture-model' },
      workspace: { current_dir: cwd }, context_window: { context_window_size: 200000, current_usage: null } })
  }
}
if (provider === 'claude') {
  try { await configuredClaudeStartup() }
  catch (error) { append({ kind: 'native-startup', result: 'refused', errorKind: error?.name ?? 'Error' }); process.exitCode = 1 }
}
async function configuredAmplifierStartup() {
  if (!nativeId || !process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH) return
  // Load the actual installed CLI store and restore the controlled context.
  // Its unchanged producer captures the native files and publishes the ACK.
  const code = `
import asyncio, sys
from types import SimpleNamespace
from amplifier_app_cli.session_store import SessionStore
from amplifier_app_cli.freshell_native_resume import publish_initialized

class ControlledContext:
    async def set_messages(self, messages):
        self.messages = list(messages)
    async def get_messages(self):
        return self.messages

async def main():
    loaded, metadata = SessionStore().load(sys.argv[1])
    context = ControlledContext()
    await context.set_messages(loaded)
    async def cleanup():
        pass
    session = SimpleNamespace(session_id=sys.argv[1], parent_id=metadata.get('parent_id'),
                              coordinator={'context': context}, cleanup=cleanup)
    config = SimpleNamespace(is_resume=True, initial_transcript=loaded)
    await publish_initialized(session, config)

asyncio.run(main())
`
  await new Promise((resolve, reject) => {
    const child = spawn('/opt/amplifier-src/.venv/bin/python', ['-c', code, nativeId],
      { env: process.env, cwd, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('installed Amplifier startup producer refused')))
  })
}

async function controlledOpenCodeTui() {
  // This function runs in a child with Node's TypeScript transform enabled:
  // the installed TUI plugin contains parameter properties. All native and
  // hydrated reads below come from the same real controlled SQLite store.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { DatabaseSync } = await import('node:sqlite')
  const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_TUI_CONFIG, 'utf8'))
  const pluginPath = config.plugin.find(value => value.endsWith('/freshell-rebind-plugin.ts'))
  if (!pluginPath) throw new Error('configured native TUI plugin missing')
  const plugin = (await import(pluginPath)).default
  const dataHome = path.join(process.env.HOME, '.local/share/opencode')
  fs.mkdirSync(dataHome, { recursive: true })
  const db = new DatabaseSync(path.join(dataHome, 'opencode.db'))
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS project (id text PRIMARY KEY, worktree text);
    CREATE TABLE IF NOT EXISTS session (
      id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
      slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
      version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer,
      summary_files integer, summary_diffs text, metadata text, cost real NOT NULL DEFAULT 0,
      tokens_input integer NOT NULL DEFAULT 0, tokens_output integer NOT NULL DEFAULT 0,
      tokens_reasoning integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0,
      tokens_cache_write integer NOT NULL DEFAULT 0, revert text, permission text, agent text,
      model text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
      time_compacting integer, time_archived integer);
    CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL,
      session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS message_seq (session_id text PRIMARY KEY, next integer NOT NULL);
  `)
  const get = id => {
    const row = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
    if (!row) throw new Error('native root not found')
    return { id: row.id, parentID: row.parent_id, revert: row.revert ? JSON.parse(row.revert) : undefined }
  }
  const parts = id => db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY time_created, id')
    .all(id).map(row => ({ ...JSON.parse(row.data), id: row.id, messageID: row.message_id, sessionID: row.session_id }))
  const messages = id => db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id')
    .all(id).map(row => ({ info: { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id }, parts: parts(row.id) }))
  const resume = argv.indexOf('--session')
  const selected = resume >= 0 ? argv[resume + 1] : null
  const route = { current: selected ? { name: 'session', params: { sessionID: selected } } : { name: 'home' },
    navigate(name, params) { this.current = { name, params } } }
  const lifecycle = new AbortController()
  const api = {
    route, lifecycle: { signal: lifecycle.signal },
    state: { ready: true, part: parts, session: { get, messages: id => messages(id).map(row => row.info) } },
    client: { session: {
      async create() {
        const id = 'ses_' + randomUUID().replaceAll('-', '')
        const now = Date.now()
        db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run(id, process.cwd())
        db.prepare(`INSERT INTO session
          (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated)
          VALUES (?, ?, NULL, ?, ?, ?, 'controlled-parity', 'controlled-model', ?, ?)`)
          .run(id, id, id, process.cwd(), id, now, now)
        return { data: get(id) }
      },
      async get({ sessionID }) { return { data: get(sessionID) } },
      async messages({ sessionID }) { get(sessionID); return { data: messages(sessionID) } },
    } },
  }
  plugin.tui(api)
  // The native plugin creates/navigates the fresh root asynchronously. This
  // marker observes its selected row; it never constructs an identity ACK.
  let announced = false
  const observation = setInterval(() => {
    const id = route.current.params?.sessionID
    if (!id || announced) return
    get(id)
    announced = true
    process.stdout.write(`opencode: session ${id} started\n`)
    process.stdout.write('FRESHELL_PROVIDER_PARITY_ROW:' + Buffer.from(JSON.stringify({
      provider: 'opencode', kind: 'identity', terminalId: process.env.FRESHELL_TERMINAL_ID,
      nativeSession: { source: 'provider-store', value: id },
    })).toString('base64') + '\n')
  }, 25)
  process.stdin.on('data', chunk => {
    const id = route.current.params?.sessionID
    const prompt = String(chunk).trim()
    if (prompt.startsWith('SELECT_SESSION ')) {
      const selected = prompt.slice('SELECT_SESSION '.length)
      get(selected)
      route.navigate('session', { sessionID: selected })
      return
    }
    if (!id || !prompt || messages(id).length) return
    const now = Date.now()
    const message = 'msg_' + randomUUID().replaceAll('-', '')
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
      .run(message, id, now, now, JSON.stringify({ role: 'user' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
      .run('prt_' + randomUUID().replaceAll('-', ''), message, id, now, now, JSON.stringify({ type: 'text', text: prompt }))
  })
  process.stdin.resume()
  const dispose = () => { lifecycle.abort(); clearInterval(observation); db.close() }
  process.once('exit', dispose)
}

if (provider === 'amplifier') await configuredAmplifierStartup()
if (provider === 'opencode' && process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH) {
  const terminal = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e',
    `const argv = process.argv.slice(1); await (${controlledOpenCodeTui.toString()})()`, '--', ...argv],
  { env: process.env, cwd, stdio: 'inherit' })
  terminal.once('exit', code => { process.exitCode = code ?? 1 })
} else if (provider === 'codex' || provider === 'opencode') {
  // Keep ordinary fake transcripts Enter-bound. Only this managed Codex
  // parity wrapper requests the current proxy handshake before input.
  const fake = path.join(import.meta.dirname,
    provider === 'codex' ? 'fake-codex-terminal.mjs' : 'fake-opencode-terminal.mjs')
  const terminal = spawn(process.execPath, [fake, ...argv], {
    env: provider === 'codex' ? { ...process.env, FAKE_CODEX_TERMINAL_PARITY_STARTUP: '1' } : process.env,
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  let output = ''
  terminal.stdout.on('data', chunk => {
    output += String(chunk)
    process.stdout.write(chunk)
    const match = output.match(provider === 'codex'
      ? /codex: session ([^\s]+) started/
      : /opencode: session ([^\s]+) started/)
    if (match) {
      append({ kind: 'identity', terminalId: process.env.FRESHELL_TERMINAL_ID,
        nativeSession: { source: 'provider-store', value: match[1] } })
      output = ''
    }
  })
  terminal.on('exit', code => { process.exitCode = code ?? 1 })
} else {
  process.stdin.on('data', () => {
    if (!nativeId) return
    if (provider === 'claude') {
      const sessionDir = path.join(providerHome, 'projects', 'provider-parity')
      fs.mkdirSync(sessionDir, { recursive: true })
      fs.appendFileSync(path.join(sessionDir, `${nativeId}.jsonl`),
        `${JSON.stringify({ type: 'user', sessionId: nativeId, cwd, message: { role: 'user', content: 'fixture prompt' } })}\n`)
    } else if (provider === 'amplifier') {
      const projects = path.join(providerHome, 'projects')
      for (const project of fs.readdirSync(projects)) {
        const events = path.join(projects, project, 'sessions', nativeId, 'events.jsonl')
        if (fs.existsSync(events)) {
          fs.appendFileSync(events, `${JSON.stringify({ event: 'prompt:submit', text: 'fixture prompt' })}\n`)
          break
        }
      }
    }
  })
  process.stdin.resume()
}
