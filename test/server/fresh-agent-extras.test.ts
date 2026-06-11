import { afterAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createFreshAgentExtrasRouter } from '../../server/fresh-agent-extras-router.js'

function makeApp() {
  const app = express()
  app.use('/api/fresh-agent', createFreshAgentExtrasRouter())
  return app
}

const createdPaths: string[] = []
afterAll(async () => {
  await Promise.all(createdPaths.map((p) => fsp.rm(p, { force: true, recursive: true })))
})

describe('fresh-agent extras router', () => {
  describe('POST /attachments', () => {
    it('saves a raw binary attachment and returns its path', async () => {
      const res = await request(makeApp())
        .post('/api/fresh-agent/attachments')
        .query({ name: 'note.txt' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('hello attachment'))
        .expect(200)

      expect(res.body.path).toContain('note.txt')
      expect(res.body.bytes).toBe('hello attachment'.length)
      createdPaths.push(res.body.path)
      const saved = await fsp.readFile(res.body.path, 'utf8')
      expect(saved).toBe('hello attachment')
    })

    it('sanitizes hostile filenames', async () => {
      const res = await request(makeApp())
        .post('/api/fresh-agent/attachments')
        .query({ name: '../../etc/passwd' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('x'))
        .expect(200)

      createdPaths.push(res.body.path)
      expect(path.dirname(res.body.path)).toBe(path.join(os.homedir(), '.freshell', 'attachments'))
      expect(path.basename(res.body.path)).not.toContain('..')
    })

    it('rejects a missing name and an empty body', async () => {
      await request(makeApp())
        .post('/api/fresh-agent/attachments')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0))
        .expect(400)
      await request(makeApp())
        .post('/api/fresh-agent/attachments')
        .query({ name: 'x.txt' })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0))
        .expect(400)
    })

    it('accepts multi-megabyte uploads through a production-shaped app (global 1mb JSON parser)', async () => {
      // Regression guard: server/index.ts mounts express.json({limit:'1mb'})
      // globally before this router. Raw octet-stream bodies must bypass it.
      const app = express()
      app.use(express.json({ limit: '1mb' }))
      app.use('/api/fresh-agent', createFreshAgentExtrasRouter())

      const big = Buffer.alloc(2 * 1024 * 1024, 7)
      const res = await request(app)
        .post('/api/fresh-agent/attachments')
        .query({ name: 'big.bin' })
        .set('Content-Type', 'application/octet-stream')
        .send(big)
        .expect(200)

      createdPaths.push(res.body.path)
      expect(res.body.bytes).toBe(big.byteLength)
    })
  })

  describe('POST /exec', () => {
    it('runs a command in the given cwd and returns output', async () => {
      const res = await request(makeApp())
        .post('/api/fresh-agent/exec')
        .send({ command: 'echo hello-exec && pwd', cwd: os.tmpdir() })
        .expect(200)

      expect(res.body.output).toContain('hello-exec')
      expect(res.body.exitCode).toBe(0)
    })

    it('reports non-zero exit codes with output', async () => {
      const res = await request(makeApp())
        .post('/api/fresh-agent/exec')
        .send({ command: 'echo to-stderr >&2; exit 3', cwd: os.tmpdir() })
        .expect(200)

      expect(res.body.output).toContain('to-stderr')
      expect(res.body.exitCode).toBe(3)
    })

    it('rejects a missing command and a bad cwd', async () => {
      await request(makeApp())
        .post('/api/fresh-agent/exec')
        .send({ cwd: os.tmpdir() })
        .expect(400)
      await request(makeApp())
        .post('/api/fresh-agent/exec')
        .send({ command: 'true', cwd: '/definitely/not/a/real/dir' })
        .expect(400)
    })
  })

  describe('GET /diff', () => {
    it('requires cwd and validates it exists', async () => {
      await request(makeApp()).get('/api/fresh-agent/diff').expect(400)
      await request(makeApp())
        .get('/api/fresh-agent/diff')
        .query({ cwd: '/definitely/not/a/real/dir' })
        .expect(400)
    })

    it('returns a diff payload for a git repo cwd', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fresh-extras-'))
      createdPaths.push(dir)
      const app = makeApp()
      // Initialize a repo with one dirty file.
      const { execFile } = await import('node:child_process')
      const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
        execFile(cmd, args, { cwd: dir }, (err) => err ? reject(err) : resolve())
      })
      await run('git', ['init', '-q'])
      await fsp.writeFile(path.join(dir, 'a.txt'), 'one\n')
      await run('git', ['add', '.'])
      await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
      await fsp.writeFile(path.join(dir, 'a.txt'), 'two\n')

      const res = await request(app)
        .get('/api/fresh-agent/diff')
        .query({ cwd: dir, path: 'a.txt' })
        .expect(200)

      expect(res.body.diff).toContain('-one')
      expect(res.body.diff).toContain('+two')
    })
  })

  describe('POST /send', () => {
    it('forwards to the injected runtime manager', async () => {
      const send = vi.fn().mockResolvedValue(undefined)
      const app = express()
      app.use('/api/fresh-agent', createFreshAgentExtrasRouter({ freshAgentRuntimeManager: { send } }))

      await request(app)
        .post('/api/fresh-agent/send')
        .send({ sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', text: 'ls the cwd' })
        .expect(200)

      expect(send).toHaveBeenCalledWith(
        { sessionId: 's1', sessionType: 'freshclaude', provider: 'claude' },
        { text: 'ls the cwd' },
      )
    })

    it('503s without a runtime manager and 400s on missing fields', async () => {
      await request(makeApp())
        .post('/api/fresh-agent/send')
        .send({ sessionId: 's1', sessionType: 'freshclaude', provider: 'claude', text: 'x' })
        .expect(503)

      const app = express()
      app.use('/api/fresh-agent', createFreshAgentExtrasRouter({
        freshAgentRuntimeManager: { send: vi.fn() },
      }))
      await request(app)
        .post('/api/fresh-agent/send')
        .send({ sessionId: 's1', sessionType: 'freshclaude', provider: 'claude' })
        .expect(400)
      await request(app)
        .post('/api/fresh-agent/send')
        .send({ sessionId: 's1', sessionType: 'freshclaude', provider: 'not-real', text: 'x' })
        .expect(400)
    })

    it('surfaces manager failures as 500 with the message', async () => {
      const app = express()
      app.use('/api/fresh-agent', createFreshAgentExtrasRouter({
        freshAgentRuntimeManager: { send: vi.fn().mockRejectedValue(new Error('no such session')) },
      }))
      const res = await request(app)
        .post('/api/fresh-agent/send')
        .send({ sessionId: 'nope', sessionType: 'freshclaude', provider: 'claude', text: 'x' })
        .expect(500)
      expect(res.body.error).toContain('no such session')
    })
  })

  describe('checkpoints', () => {
    it('creates, lists, and restores checkpoints without touching the cwd git state', async () => {
      const { createHash } = await import('node:crypto')
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fresh-ckpt-'))
      createdPaths.push(dir)
      const shadow = path.join(
        os.homedir(), '.freshell', 'checkpoints',
        `${createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16)}.git`,
      )
      createdPaths.push(shadow)
      const app = makeApp()
      const file = path.join(dir, 'main.ts')

      await fsp.writeFile(file, 'version one\n')
      const first = await request(app)
        .post('/api/fresh-agent/checkpoints')
        .send({ cwd: dir, label: 'before refactor' })
        .expect(200)
      expect(first.body.id).toMatch(/^[0-9a-f]{40}$/)
      expect(first.body.label).toBe('before refactor')

      await fsp.writeFile(file, 'version two\n')
      await request(app)
        .post('/api/fresh-agent/checkpoints')
        .send({ cwd: dir, label: 'after refactor' })
        .expect(200)

      const list = await request(app)
        .get('/api/fresh-agent/checkpoints')
        .query({ cwd: dir })
        .expect(200)
      expect(list.body.checkpoints).toHaveLength(2)
      // Newest first, git log order.
      expect(list.body.checkpoints[0].label).toBe('after refactor')
      expect(list.body.checkpoints[1].label).toBe('before refactor')

      await request(app)
        .post('/api/fresh-agent/checkpoints/restore')
        .send({ cwd: dir, id: first.body.id })
        .expect(200)
      expect(await fsp.readFile(file, 'utf8')).toBe('version one\n')
      // The cwd itself never became a git repo.
      await expect(fsp.access(path.join(dir, '.git'))).rejects.toThrow()
    })

    it('lists empty for a cwd with no checkpoints and validates restore ids', async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fresh-ckpt-empty-'))
      createdPaths.push(dir)
      const app = makeApp()

      const list = await request(app)
        .get('/api/fresh-agent/checkpoints')
        .query({ cwd: dir })
        .expect(200)
      expect(list.body.checkpoints).toEqual([])

      await request(app)
        .post('/api/fresh-agent/checkpoints/restore')
        .send({ cwd: dir, id: 'not-a-sha!' })
        .expect(400)
    })
  })
})
