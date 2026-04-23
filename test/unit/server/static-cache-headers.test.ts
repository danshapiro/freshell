import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { registerStaticClientRoutes } from '../../../server/static-client-routes.js'

describe('production static file cache headers', () => {
  let app: express.Express
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-static-client-'))
    const clientDir = path.join(tempDir, 'client')
    fs.mkdirSync(path.join(clientDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(clientDir, 'index.html'), '<html>test</html>')
    fs.writeFileSync(path.join(clientDir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
    fs.writeFileSync(path.join(clientDir, 'manifest.webmanifest'), '{}')
    fs.writeFileSync(path.join(clientDir, 'favicon.ico'), '')
    fs.writeFileSync(path.join(clientDir, 'assets', 'index-abc123.js'), 'console.log("hello")')
    fs.writeFileSync(path.join(clientDir, 'assets', 'EditorPane-xyz789.js'), 'export {}')
    fs.writeFileSync(path.join(clientDir, 'assets', 'styles-def456.css'), 'body{}')

    app = express()
    registerStaticClientRoutes(app, clientDir)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('serves index.html directly with no-cache/no-store headers', async () => {
    const res = await request(app).get('/index.html')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['expires']).toBe('0')
  })

  it('serves SPA fallback routes with no-cache/no-store headers', async () => {
    const res = await request(app).get('/some/deep/route')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['expires']).toBe('0')
  })

  it('serves hashed assets with immutable one-year cache', async () => {
    const res = await request(app).get('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves hashed editor chunks with immutable one-year cache', async () => {
    const res = await request(app).get('/assets/EditorPane-xyz789.js')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves hashed CSS assets with immutable one-year cache', async () => {
    const res = await request(app).get('/assets/styles-def456.css')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves unhashed root assets with no-cache', async () => {
    const sw = await request(app).get('/sw.js')
    expect(sw.status).toBe(200)
    expect(sw.headers['cache-control']).toBe('no-cache')

    const manifest = await request(app).get('/manifest.webmanifest')
    expect(manifest.status).toBe(200)
    expect(manifest.headers['cache-control']).toBe('no-cache')

    const favicon = await request(app).get('/favicon.ico')
    expect(favicon.status).toBe(200)
    expect(favicon.headers['cache-control']).toBe('no-cache')
  })

  it('returns 404 for missing assets under /assets', async () => {
    const res = await request(app).get('/assets/missing-abc123.js')
    expect(res.status).toBe(404)
  })

  it('falls through to SPA HTML for missing non-asset routes', async () => {
    const res = await request(app).get('/missing/non-asset/path')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(res.text).toContain('<html')
  })
})
