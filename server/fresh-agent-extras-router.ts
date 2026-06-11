import { Router, json, raw } from 'express'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { FreshAgentRuntimeProviderSchema, FreshAgentSessionTypeSchema } from '../shared/fresh-agent-contract.js'
import type { FreshAgentCreateRequest, FreshAgentSessionLocator } from './fresh-agent/runtime-adapter.js'

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const EXEC_TIMEOUT_MS = 30_000
const EXEC_MAX_OUTPUT = 200 * 1024
const DIFF_MAX_BYTES = 512 * 1024

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function attachmentsDir(): string {
  return path.join(os.homedir(), '.freshell', 'attachments')
}

type ExecResult = { output: string; exitCode: number | null; truncated: boolean }

function runCommand(command: string, cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', command], {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_OUTPUT,
      env: process.env,
    }, (error, stdout, stderr) => {
      const combined = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim()
      const truncated = combined.length >= EXEC_MAX_OUTPUT
      const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0
      resolve({
        output: truncated ? `${combined.slice(0, EXEC_MAX_OUTPUT)}\n[output truncated]` : combined,
        exitCode,
        truncated,
      })
    })
  })
}

function runGitDiff(cwd: string, filePath?: string): Promise<{ diff: string }> {
  return new Promise((resolve, reject) => {
    const args = ['diff', '--no-color']
    if (filePath) args.push('--', filePath)
    execFile('git', args, { cwd, maxBuffer: DIFF_MAX_BYTES, timeout: 15_000 }, (error, stdout) => {
      if (error && !stdout) {
        reject(new Error(`git diff failed: ${error.message}`))
        return
      }
      resolve({ diff: stdout })
    })
  })
}

/* ------------------------------------------------------------------------ *
 * Checkpoints: per-cwd shadow git repository under ~/.freshell/checkpoints.
 * The session cwd's own git state is never touched — snapshots live in a
 * separate --git-dir and use the cwd only as --work-tree. The work-tree's
 * .gitignore applies, so node_modules and friends stay out of snapshots.
 * Restore overwrites tracked files to the snapshot state; files created
 * after the snapshot are left in place (v1 semantics, documented in WORK.md).
 * ------------------------------------------------------------------------ */

const CHECKPOINT_GIT_TIMEOUT_MS = 60_000
const CHECKPOINT_LIST_LIMIT = 100
const CHECKPOINT_IDENTITY = ['-c', 'user.name=freshell', '-c', 'user.email=checkpoints@freshell.local']

function checkpointGitDir(cwd: string): string {
  const digest = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16)
  return path.join(os.homedir(), '.freshell', 'checkpoints', `${digest}.git`)
}

function runGit(args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: options.cwd ?? os.homedir(),
      timeout: CHECKPOINT_GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0] ?? ''} failed: ${stderr || error.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function ensureCheckpointRepo(cwd: string): Promise<string> {
  const gitDir = checkpointGitDir(cwd)
  try {
    await fsp.access(path.join(gitDir, 'HEAD'))
  } catch {
    await fsp.mkdir(gitDir, { recursive: true })
    await runGit(['init', '--bare', '-q', gitDir])
  }
  return gitDir
}

export type CheckpointEntry = { id: string; ts: number; label: string }

async function createCheckpoint(cwd: string, label: string): Promise<CheckpointEntry> {
  const gitDir = await ensureCheckpointRepo(cwd)
  const base = [`--git-dir=${gitDir}`, `--work-tree=${cwd}`]
  await runGit([...base, 'add', '-A'], { cwd })
  await runGit([...base, ...CHECKPOINT_IDENTITY, 'commit', '--allow-empty', '-q', '-m', label], { cwd })
  const sha = (await runGit([`--git-dir=${gitDir}`, 'rev-parse', 'HEAD'])).trim()
  return { id: sha, ts: Math.floor(Date.now() / 1000), label }
}

async function listCheckpoints(cwd: string): Promise<CheckpointEntry[]> {
  const gitDir = checkpointGitDir(cwd)
  try {
    await fsp.access(path.join(gitDir, 'HEAD'))
  } catch {
    return []
  }
  let raw: string
  try {
    raw = await runGit([
      `--git-dir=${gitDir}`,
      'log',
      `-n`, String(CHECKPOINT_LIST_LIMIT),
      '--pretty=format:%H%x09%ct%x09%s',
    ])
  } catch {
    // Empty repo (no commits yet).
    return []
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, ts, ...rest] = line.split('\t')
      return { id, ts: Number(ts), label: rest.join('\t') }
    })
}

async function restoreCheckpoint(cwd: string, id: string): Promise<void> {
  if (!/^[0-9a-f]{7,40}$/i.test(id)) {
    throw new Error('invalid checkpoint id')
  }
  const gitDir = await ensureCheckpointRepo(cwd)
  await runGit([`--git-dir=${gitDir}`, `--work-tree=${cwd}`, 'checkout', '-q', id, '--', '.'], { cwd })
}

/**
 * Pane-scoped helper endpoints for the fresh* clients. Auth is provided by the
 * global httpAuthMiddleware mounted ahead of all /api routes in server/index.ts.
 *
 * - POST /attachments?name=    (raw octet-stream)  -> {path}   (saved under ~/.freshell/attachments)
 * - POST /exec                 {command, cwd}      -> {output, exitCode, truncated}
 * - GET  /diff?cwd=&path=                          -> {diff}   (git diff for the session cwd)
 * - POST /checkpoints          {cwd, label}        -> {id, ts, label}
 * - GET  /checkpoints?cwd=                         -> {checkpoints: CheckpointEntry[]}
 * - POST /checkpoints/restore  {cwd, id}           -> {restored: true}
 *
 * Attachments are raw binary (Content-Type: application/octet-stream) rather
 * than base64-in-JSON: server/index.ts mounts a global express.json with a
 * 1mb limit ahead of all /api routes, which would reject larger JSON bodies
 * before this router's own parser ran. Raw bodies bypass JSON parsing by
 * content-type, avoid the 1.37x base64 inflation, and are size-capped here.
 */
/** Structural slice of FreshAgentRuntimeManager — keeps this router
 * standalone-testable with a fake and avoids a hard import cycle. */
export type FreshAgentSendCapable = {
  send?: (locator: FreshAgentSessionLocator, payload: { text: string; settings?: FreshAgentCreateRequest }) => Promise<unknown>
}

function parseSendLocator(body: unknown): FreshAgentSessionLocator | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const input = body as Record<string, unknown>
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
  const sessionType = FreshAgentSessionTypeSchema.safeParse(input.sessionType)
  const provider = FreshAgentRuntimeProviderSchema.safeParse(input.provider)
  if (!sessionId || !sessionType.success || !provider.success) {
    return null
  }
  return { sessionId, sessionType: sessionType.data, provider: provider.data }
}

export function createFreshAgentExtrasRouter(
  deps: { freshAgentRuntimeManager?: FreshAgentSendCapable } = {},
): Router {
  const router = Router()
  // Small JSON bodies only (exec/checkpoints); mirrors the global 1mb cap so
  // the standalone test app exercises the same constraint as production.
  router.use(json({ limit: '1mb' }))

  router.post(
    '/attachments',
    raw({ type: 'application/octet-stream', limit: ATTACHMENT_MAX_BYTES }),
    async (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : ''
      if (!name) {
        return res.status(400).json({ error: 'name query parameter required' })
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : null
      if (!buffer || buffer.byteLength === 0) {
        return res.status(400).json({ error: 'attachment body must be a non-empty application/octet-stream' })
      }
      const dir = attachmentsDir()
      await fsp.mkdir(dir, { recursive: true })
      const filename = `${randomUUID().slice(0, 8)}-${sanitizeFilename(name)}`
      const target = path.join(dir, filename)
      await fsp.writeFile(target, buffer)
      res.json({ path: target, bytes: buffer.byteLength })
    },
  )

  router.post('/exec', async (req, res) => {
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : ''
    const cwd = typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd : os.homedir()
    if (!command) {
      return res.status(400).json({ error: 'command is required' })
    }
    try {
      await fsp.access(cwd)
    } catch {
      return res.status(400).json({ error: `cwd does not exist: ${cwd}` })
    }
    const result = await runCommand(command, cwd)
    res.json(result)
  })

  router.get('/diff', async (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : ''
    const filePath = typeof req.query.path === 'string' && req.query.path ? req.query.path : undefined
    if (!cwd) {
      return res.status(400).json({ error: 'cwd query parameter required' })
    }
    try {
      await fsp.access(cwd)
    } catch {
      return res.status(400).json({ error: `cwd does not exist: ${cwd}` })
    }
    try {
      const result = await runGitDiff(cwd, filePath)
      res.json(result)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'diff failed' })
    }
  })

  // Programmatic prompt injection for automation/testing (MCP `fresh-send`
  // routes here). Same entrypoint the WS handler uses: runtimeManager.send.
  router.post('/send', async (req, res) => {
    const manager = deps.freshAgentRuntimeManager
    if (!manager?.send) {
      return res.status(503).json({ error: 'fresh-agent runtime not available on this server' })
    }
    const locator = parseSendLocator(req.body)
    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!locator || !text) {
      return res.status(400).json({ error: 'sessionId, sessionType, provider, and text are required' })
    }
    const settings = req.body?.settings && typeof req.body.settings === 'object' && !Array.isArray(req.body.settings)
      ? req.body.settings as FreshAgentCreateRequest
      : undefined
    try {
      await manager.send(locator, { text, ...(settings ? { settings } : {}) })
      res.json({ sent: true })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'send failed' })
    }
  })

  router.post('/checkpoints', async (req, res) => {
    const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd : ''
    const label = typeof req.body?.label === 'string' && req.body.label.trim()
      ? req.body.label.trim().slice(0, 120)
      : 'checkpoint'
    if (!cwd) {
      return res.status(400).json({ error: 'cwd is required' })
    }
    try {
      await fsp.access(cwd)
    } catch {
      return res.status(400).json({ error: `cwd does not exist: ${cwd}` })
    }
    try {
      const entry = await createCheckpoint(cwd, label)
      res.json(entry)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'checkpoint failed' })
    }
  })

  router.get('/checkpoints', async (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : ''
    if (!cwd) {
      return res.status(400).json({ error: 'cwd query parameter required' })
    }
    try {
      res.json({ checkpoints: await listCheckpoints(cwd) })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'list failed' })
    }
  })

  router.post('/checkpoints/restore', async (req, res) => {
    const cwd = typeof req.body?.cwd === 'string' ? req.body.cwd : ''
    const id = typeof req.body?.id === 'string' ? req.body.id : ''
    if (!cwd || !id) {
      return res.status(400).json({ error: 'cwd and id are required' })
    }
    try {
      await fsp.access(cwd)
    } catch {
      return res.status(400).json({ error: `cwd does not exist: ${cwd}` })
    }
    try {
      await restoreCheckpoint(cwd, id)
      res.json({ restored: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'restore failed'
      res.status(message.includes('invalid checkpoint id') ? 400 : 500).json({ error: message })
    }
  })

  return router
}
