import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import { checkProdRunning, parseEnv } from '../../../scripts/prebuild-guard.js'

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
    let server: http.Server
    let port: number

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
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

      const result = await checkProdRunning(port)
      expect(result).toEqual({ status: 'not-running' })
    })
  })
})
