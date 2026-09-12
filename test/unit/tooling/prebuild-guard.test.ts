import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkProdRunning,
  isLinkedWorktreeCheckout,
  parseEnv,
} from '../../../scripts/prebuild-guard.js'

describe('prebuild-guard', () => {
  describe('parseEnv', () => {
    it('parses simple key=value pairs', () => {
      expect(parseEnv('PORT=3001\nHOST=localhost')).toEqual({
        PORT: '3001',
        HOST: 'localhost',
      })
    })

    it('strips double quotes from values', () => {
      expect(parseEnv('PORT="3001"')).toEqual({ PORT: '3001' })
    })

    it('strips single quotes from values', () => {
      expect(parseEnv("PORT='3001'")).toEqual({ PORT: '3001' })
    })

    it('does not strip mismatched quotes', () => {
      expect(parseEnv('PORT="3001\'')).toEqual({ PORT: '"3001\'' })
    })

    it('skips blank lines and comments', () => {
      const content = '# This is a comment\n\nPORT=3001\n  # Another comment\nHOST=localhost'
      expect(parseEnv(content)).toEqual({ PORT: '3001', HOST: 'localhost' })
    })

    it('handles empty string', () => {
      expect(parseEnv('')).toEqual({})
    })

    it('preserves unquoted values with internal quotes', () => {
      expect(parseEnv('MSG=hello "world"')).toEqual({ MSG: 'hello "world"' })
    })

    it('strips export prefix from keys', () => {
      expect(parseEnv('export PORT=4000')).toEqual({ PORT: '4000' })
    })

    it('handles spaces around equals sign', () => {
      expect(parseEnv('PORT = 4000')).toEqual({ PORT: '4000' })
    })

    it('handles export prefix with spaces and quotes', () => {
      expect(parseEnv('export PORT = "4000"')).toEqual({ PORT: '4000' })
    })

    it('strips inline comments after quoted values', () => {
      expect(parseEnv('PORT="3001" # prod')).toEqual({ PORT: '3001' })
    })

    it('strips inline comments after single-quoted values', () => {
      expect(parseEnv("PORT='3001' # prod")).toEqual({ PORT: '3001' })
    })

    it('strips inline comments after unquoted values', () => {
      expect(parseEnv('PORT=3001 # prod')).toEqual({ PORT: '3001' })
    })
  })

  describe('checkProdRunning', () => {
    let server: http.Server | undefined
    let port: number

    afterEach(async () => {
      vi.unstubAllGlobals()
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        server = undefined
      }
    })

    it('retries transient probe failures before reporting not-running', async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ app: 'freshell', ok: true, version: '0.5.0', ready: true }),
        } as Response)
      vi.stubGlobal('fetch', fetchMock)

      const result = await checkProdRunning(3001)

      expect(result).toEqual({ status: 'running', version: '0.5.0' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('honors custom retry settings', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'))
      vi.stubGlobal('fetch', fetchMock)

      const result = await checkProdRunning(3001, { attempts: 2, retryDelayMs: 0, timeoutMs: 1 })

      expect(result).toEqual({ status: 'not-running' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('returns running with version when freshell is on the port', async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ app: 'freshell', ok: true, version: '0.5.0', ready: true }))
      })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      port = (server.address() as { port: number }).port

      const result = await checkProdRunning(port)
      expect(result).toEqual({ status: 'running', version: '0.5.0' })
    })

    it('returns not-running when port is free', async () => {
      // Use a port that nothing is listening on
      const result = await checkProdRunning(0)
      expect(result).toEqual({ status: 'not-running' })
    })

    it('returns not-running when non-freshell app is on the port', async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ app: 'something-else' }))
      })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      port = (server.address() as { port: number }).port

      const result = await checkProdRunning(port)
      expect(result).toEqual({ status: 'not-running' })
    })

    it('returns not-running when health endpoint returns non-200', async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(500)
        res.end()
      })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      port = (server.address() as { port: number }).port

      const result = await checkProdRunning(port)
      expect(result).toEqual({ status: 'not-running' })
    })

    it('returns not-running on timeout', async () => {
      // Server that never responds
      server = http.createServer(() => {
        // intentionally hang
      })
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve())
      })
      port = (server.address() as { port: number }).port

      const result = await checkProdRunning(port, { attempts: 1, retryDelayMs: 0, timeoutMs: 25 })
      expect(result).toEqual({ status: 'not-running' })
    })
  })

  describe('isLinkedWorktreeCheckout', () => {
    it('returns true when .git points at git worktree metadata', () => {
      const root = mkdtempSync(join(tmpdir(), 'prebuild-guard-worktree-'))
      try {
        writeFileSync(join(root, '.git'), 'gitdir: /repo/.git/worktrees/visible-first\n')
        expect(isLinkedWorktreeCheckout(root)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('returns true when .git uses Windows-style git worktree metadata', () => {
      const root = mkdtempSync(join(tmpdir(), 'prebuild-guard-worktree-win-'))
      try {
        writeFileSync(join(root, '.git'), 'gitdir: C:\\repo\\.git\\worktrees\\visible-first\r\n')
        expect(isLinkedWorktreeCheckout(root)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('returns false for a normal checkout with a .git directory', () => {
      const root = mkdtempSync(join(tmpdir(), 'prebuild-guard-main-'))
      try {
        mkdirSync(join(root, '.git'))
        expect(isLinkedWorktreeCheckout(root)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
