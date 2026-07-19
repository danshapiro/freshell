import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Raw MCP stdio JSON-RPC client + build helper for the "MCP bridge" QA-lever
 * pin (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a76/\u00a78.3).
 *
 * `McpStdioClient` speaks the EXACT wire format the SDK's `StdioServerTransport`
 * implements (`@modelcontextprotocol/sdk`'s `dist/esm/shared/stdio.js`
 * `ReadBuffer`/`serializeMessage`): newline-delimited JSON-RPC 2.0 messages
 * over stdin/stdout, no `Content-Length` framing (unlike LSP). Deliberately
 * NOT built on the SDK's own `Client`/`StdioClientTransport` -- this hand-rolls
 * the raw wire contract so a regression in the SERVER's framing (e.g. an
 * accidental `console.log` corrupting the stdio channel, which `server/mcp/server.ts`'s
 * own doc comment calls out as the one hard rule) is caught even if the SDK's
 * client-side transport were ever to compensate for malformed output.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function findRepoRootFrom(startDir: string): string {
  let dir = path.resolve(startDir)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('Could not find project root (no package.json found)')
}

/** Absolute path to this worktree's repo root (ported pattern from `rust-server.ts`). */
export const REPO_ROOT = findRepoRootFrom(__dirname)

/** Absolute path of the built (frozen-source) MCP stdio binary. */
export function mcpServerBinPath(root: string = REPO_ROOT): string {
  return path.join(root, 'dist', 'server', 'mcp', 'server.js')
}

/**
 * Ensure `dist/server/mcp/server.js` (built from the FROZEN `server/mcp/`
 * source -- consumed here, never edited) exists and is current, by running
 * `npm run build:server` (`tsc -p tsconfig.server.json`). That project has
 * `incremental: true` with a committed `tsBuildInfo` cache
 * (`node_modules/.cache/tsconfig.server.tsbuildinfo`), so it is safe and fast
 * to run UNCONDITIONALLY on every call rather than hand-rolling mtime-staleness
 * detection across the whole frozen `server/` + `shared/` tree: an unchanged
 * tree is a near-instant no-op, and a changed one gets a real (still
 * incremental) rebuild. Returns the elapsed build time in ms so callers can
 * log it.
 */
export function ensureMcpServerBuilt(root: string = REPO_ROOT): { path: string; buildMs: number } {
  const bin = mcpServerBinPath(root)
  const start = Date.now()
  const result = spawnSync('npm', ['run', 'build:server'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  })
  const buildMs = Date.now() - start
  if (result.status !== 0) {
    throw new Error(
      `npm run build:server failed (exit ${result.status ?? 'signal ' + result.signal}); ` +
      `cannot boot the MCP bridge fixture without a current dist/server/mcp/server.js.\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  if (!fs.existsSync(bin)) {
    throw new Error(`npm run build:server completed but ${bin} is still missing.`)
  }
  return { path: bin, buildMs }
}

export interface McpStdioClientOptions {
  command: string
  args?: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  /** Per-request timeout in ms (default: 30_000). */
  requestTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/** A single JSON-RPC response/notification line as parsed off stdout. */
interface JsonRpcLine {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  result?: unknown
  error?: { code: number; message: string }
}

export class McpStdioClient {
  private readonly proc: ChildProcessWithoutNullStreams
  private buffer = ''
  private stderrBuffer = ''
  private nextId = 1
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly requestTimeoutMs: number
  private exited = false

  constructor(options: McpStdioClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.proc = spawn(options.command, options.args ?? [], {
      env: options.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8')
    })
    this.proc.on('exit', (code, signal) => {
      this.exited = true
      const err = new Error(
        `MCP server process exited (code=${code}, signal=${signal}) before all requests resolved.\n` +
        `stderr:\n${this.stderrBuffer}`,
      )
      for (const [id, pending] of this.pending) {
        pending.reject(err)
        this.pending.delete(id)
      }
    })
  }

  /** Everything the child process has written to stderr so far (diagnostics). */
  get stderr(): string {
    return this.stderrBuffer
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    let idx: number
    // eslint-disable-next-line no-cond-assign
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcLine
    try {
      message = JSON.parse(line)
    } catch (error) {
      // A non-JSON line on stdout is itself a protocol violation -- the
      // "no console.log" rule in `server/mcp/server.ts` exists precisely to
      // prevent this. Surface it loudly instead of silently dropping it.
      throw new Error(
        `MCP server wrote a non-JSON line to stdout (stdio channel corruption): ${JSON.stringify(line)}\n` +
        `parse error: ${error}\nstderr so far:\n${this.stderrBuffer}`,
      )
    }
    if (message.id === undefined || message.id === null) return // notification; ignored
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`))
    } else {
      pending.resolve(message.result)
    }
  }

  request(method: string, params?: unknown): Promise<any> {
    if (this.exited) {
      return Promise.reject(new Error(`MCP server process already exited; cannot send '${method}'.`))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(
          `MCP request '${method}' (id=${id}) timed out after ${this.requestTimeoutMs}ms.\n` +
          `stderr so far:\n${this.stderrBuffer}`,
        ))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      this.proc.stdin.write(payload)
    })
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n')
  }

  /** MCP initialize handshake: `initialize` request, then `notifications/initialized`. */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'freshell-mcp-bridge-test', version: '0.0.0' },
    })
    this.notify('notifications/initialized')
  }

  async listTools(): Promise<Array<{ name: string; [key: string]: unknown }>> {
    const result = await this.request('tools/list', {})
    return (result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
  }

  /**
   * Call the single `freshell` tool with `{action, params}` and unwrap the
   * `content[0].text` payload. `server/mcp/server.ts`'s tool handler always
   * `JSON.stringify()`s the raw action result -- even when that result is
   * itself a plain string (e.g. `capture-pane`'s scrollback text) -- so
   * `JSON.parse`ing it back here recovers the original value in both cases.
   */
  async callFreshellAction(action: string, params?: Record<string, unknown>): Promise<any> {
    const result = await this.request('tools/call', {
      name: 'freshell',
      arguments: { action, params: params ?? {} },
    })
    const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
    if (r?.isError) {
      throw new Error(`freshell tool action '${action}' returned an error result: ${JSON.stringify(r)}`)
    }
    const text = r?.content?.[0]?.text
    if (typeof text !== 'string') return result
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /** Graceful stdin-close, escalating to SIGTERM/SIGKILL if it doesn't exit. */
  async close(): Promise<void> {
    if (this.exited || this.proc.exitCode !== null) return
    try {
      this.proc.stdin.end()
    } catch {
      // already gone
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { this.proc.kill('SIGTERM') } catch { /* already gone */ }
      }, 2000)
      const hardTimer = setTimeout(() => {
        try { this.proc.kill('SIGKILL') } catch { /* already gone */ }
        resolve()
      }, 5000)
      this.proc.once('exit', () => {
        clearTimeout(killTimer)
        clearTimeout(hardTimer)
        resolve()
      })
    })
  }
}
