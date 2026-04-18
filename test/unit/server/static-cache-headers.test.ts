import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'
import os from 'os'
import fs from 'fs'

describe('production static file cache headers', () => {
  const originalEnv = process.env
  let app: express.Express
  let tempDir: string

  beforeEach(() => {
    process.env = { ...originalEnv }
    app = express()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-test-static-'))

    const clientDir = path.join(tempDir, 'client')
    fs.mkdirSync(clientDir)
    fs.mkdirSync(path.join(clientDir, 'assets'))

    fs.writeFileSync(path.join(clientDir, 'index.html'), '<html>test</html>')
    fs.writeFileSync(path.join(clientDir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
    fs.writeFileSync(path.join(clientDir, 'manifest.webmanifest'), '{}')
    fs.writeFileSync(path.join(clientDir, 'favicon.ico'), '')
    fs.writeFileSync(path.join(clientDir, 'assets', 'index-abc123.js'), 'console.log("hello")')
    fs.writeFileSync(path.join(clientDir, 'assets', 'EditorPane-xyz789.js'), 'export {}')
    fs.writeFileSync(path.join(clientDir, 'assets', 'styles-def456.css'), 'body{}')

    const indexHtml = path.join(clientDir, 'index.html')

    app.use(express.static(clientDir, {
      index: false,
      setHeaders: (res, filePath) => {
        const isIndexHtml = filePath.endsWith('/index.html') || filePath.endsWith('\\index.html')
        const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`)
          && /[.-][A-Za-z0-9_-]{6,}\.(js|css|svg|png|jpg|jpeg|gif|woff2?)$/.test(filePath)
        if (isIndexHtml) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
          res.setHeader('Pragma', 'no-cache')
          res.setHeader('Expires', '0')
        } else if (isHashedAsset) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else {
          res.setHeader('Cache-Control', 'no-cache')
        }
      },
    }))
    app.get('/assets/*', (_req, res) => {
      res.status(404).send('Not found')
    })
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
      res.sendFile(indexHtml)
    })
  })

  afterEach(() => {
    process.env = originalEnv
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('serves index.html with no-cache headers via SPA fallback', async () => {
    const res = await request(app).get('/some/spa/route')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['expires']).toBe('0')
  })

  it('serves index.html directly with no-cache headers', async () => {
    const res = await request(app).get('/index.html')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['expires']).toBe('0')
  })

  it('serves hashed JS assets with long-lived immutable cache', async () => {
    const res = await request(app).get('/assets/index-abc123.js')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves hashed editor chunk with long-lived immutable cache', async () => {
    const res = await request(app).get('/assets/EditorPane-xyz789.js')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves hashed CSS assets with long-lived immutable cache', async () => {
    const res = await request(app).get('/assets/styles-def456.css')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('serves unhashed root assets (sw.js) with no-cache', async () => {
    const res = await request(app).get('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('serves unhashed root assets (manifest) with no-cache', async () => {
    const res = await request(app).get('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('serves unhashed root assets (favicon) with no-cache', async () => {
    const res = await request(app).get('/favicon.ico')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('returns 404 for missing /assets/ paths', async () => {
    const res = await request(app).get('/assets/Nonexistent-abc123.js')
    expect(res.status).toBe(404)
  })
})
