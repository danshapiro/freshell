import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import pino from 'pino'
import { httpAuthMiddleware } from '../../../server/auth'
import { createClientLogsRouter } from '../../../server/client-logs'

const TEST_AUTH_TOKEN = 'test-auth-token-12345678'

describe('Client Logs API', () => {
  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  function setupApp() {
    const logs: Array<Record<string, unknown>> = []
    const stream = {
      write(chunk: string) {
        const line = chunk.toString().trim()
        if (!line) return
        logs.push(JSON.parse(line))
      },
    }

    const testLogger = pino({ level: 'debug' }, stream)

    const app = express()
    app.use(express.json())
    app.use('/api', httpAuthMiddleware)
    app.use('/api', createClientLogsRouter(testLogger))

    return { app, logs }
  }

  it('accepts client logs and writes entries', async () => {
    const { app, logs } = setupApp()

    const payload = {
      client: {
        id: 'client-1',
        userAgent: 'test-agent',
      },
      entries: [
        {
          timestamp: new Date().toISOString(),
          severity: 'warn',
          message: 'Something happened',
          consoleMethod: 'warn',
          args: ['Something happened'],
        },
      ],
    }

    const res = await request(app)
      .post('/api/logs/client')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send(payload)

    expect(res.status).toBe(204)
    expect(logs).toHaveLength(1)
    expect(logs[0].event).toBe('client_log')
    expect(logs[0].consoleMethod).toBe('warn')
    expect(logs[0].clientId).toBe('client-1')
  })

  it('rejects invalid payloads', async () => {
    const { app } = setupApp()

    const res = await request(app)
      .post('/api/logs/client')
      .set('x-auth-token', TEST_AUTH_TOKEN)
      .send({ entries: [] })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid request')
  })
})
