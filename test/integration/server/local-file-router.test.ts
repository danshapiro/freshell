// @vitest-environment node
import express, { type Express } from 'express'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalFileRouter } from '../../../server/local-file-router.js'

const TEST_AUTH_TOKEN = 'local-file-router-test-token'

describe('local-file router', () => {
  let app: Express
  let tempDir: string
  let readableFile: string

  beforeEach(async () => {
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-local-file-'))
    readableFile = path.join(tempDir, 'readable.txt')
    await fsp.writeFile(readableFile, 'hello from freshell', 'utf-8')

    app = express()
    app.use('/local-file', createLocalFileRouter())
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.AUTH_TOKEN
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('rejects missing auth before any filesystem work', async () => {
    const statSpy = vi.spyOn(fsp, 'stat')

    const res = await request(app).get(`/local-file?path=${encodeURIComponent(readableFile)}`)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(statSpy).not.toHaveBeenCalled()
  })

  it('returns 400 when path query is missing', async () => {
    const res = await request(app)
      .get('/local-file')
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'path query parameter required' })
  })

  it('returns 404 when the requested file does not exist', async () => {
    const res = await request(app)
      .get(`/local-file?path=${encodeURIComponent(path.join(tempDir, 'missing.txt'))}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'File not found' })
  })

  it('returns 400 when the requested path is a directory', async () => {
    const res = await request(app)
      .get(`/local-file?path=${encodeURIComponent(tempDir)}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Cannot serve directories' })
  })

  it('returns the readable file body with 200', async () => {
    const res = await request(app)
      .get(`/local-file?path=${encodeURIComponent(readableFile)}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(200)
    expect(res.text).toBe('hello from freshell')
  })

  it('returns 500 when async stat fails unexpectedly', async () => {
    vi.spyOn(fsp, 'stat').mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EACCES' }))

    const res = await request(app)
      .get(`/local-file?path=${encodeURIComponent(readableFile)}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to read file metadata' })
  })

  it('returns 500 when sendFile fails unexpectedly', async () => {
    vi.spyOn(express.response, 'sendFile').mockImplementationOnce(function (_path: any, callback?: any) {
      callback?.(Object.assign(new Error('send failed'), { code: 'EPIPE' }))
      return this as any
    })

    const res = await request(app)
      .get(`/local-file?path=${encodeURIComponent(readableFile)}`)
      .set('x-auth-token', TEST_AUTH_TOKEN)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Failed to send file' })
  })
})
