// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLocalFileRouter } from '../../../server/local-file-router.js'

const TEST_AUTH_TOKEN = 'test-auth-token-abcd1234'

describe('local-file-router', () => {
  let app: ReturnType<typeof express>
  let tmpDir: string
  let testFilePath: string

  beforeAll(() => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-localfile-test-'))
    testFilePath = path.join(tmpDir, 'test-file.txt')
    fs.writeFileSync(testFilePath, 'hello world')
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    app = express()
    app.use('/local-file', createLocalFileRouter())
  })

  it('returns 400 when path query parameter is missing', async () => {
    const res = await request(app)
      .get('/local-file')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('path query parameter required')
  })

  it('returns 404 for nonexistent files', async () => {
    const res = await request(app)
      .get('/local-file')
      .query({ path: '/nonexistent/file.txt' })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('File not found')
  })

  it('returns 400 for directories', async () => {
    const res = await request(app)
      .get('/local-file')
      .query({ path: tmpDir })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Cannot serve directories')
  })

  it('serves a valid file', async () => {
    const res = await request(app)
      .get('/local-file')
      .query({ path: testFilePath })
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.text).toBe('hello world')
  })

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .get('/local-file')
      .query({ path: testFilePath })

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })
})
