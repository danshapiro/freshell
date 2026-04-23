import { beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'fs'
import path from 'path'
import request from 'supertest'
import { registerStaticClientRoutes } from '../../../server/static-client-routes.js'

const distClientDir = path.resolve(__dirname, '../../../dist/client')
const hasBuild = fs.existsSync(path.join(distClientDir, 'index.html'))

describe.skipIf(!hasBuild)('production build integrity', () => {
  let indexHtml: string
  let mainJsUrl: string | null = null
  let mainJsContent = ''
  let app: express.Express

  beforeAll(() => {
    indexHtml = fs.readFileSync(path.join(distClientDir, 'index.html'), 'utf8')
    const scriptMatch = indexHtml.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)
    if (scriptMatch) mainJsUrl = scriptMatch[1]
    if (mainJsUrl) {
      const mainJsPath = path.join(distClientDir, ...mainJsUrl.split('/').filter(Boolean))
      mainJsContent = fs.readFileSync(mainJsPath, 'utf8')
    }

    app = express()
    registerStaticClientRoutes(app, distClientDir)
  })

  it('every <script src> asset in index.html exists on disk', () => {
    const scripts = [...indexHtml.matchAll(/src="(\/assets\/[^"]+)"/g)].map((match) => match[1])
    expect(scripts.length).toBeGreaterThanOrEqual(1)

    for (const href of scripts) {
      const filePath = path.join(distClientDir, ...href.split('/').filter(Boolean))
      expect(fs.existsSync(filePath), `missing: ${href}`).toBe(true)
    }
  })

  it('every <link href> asset in index.html exists on disk', () => {
    const links = [...indexHtml.matchAll(/href="(\/assets\/[^"]+)"/g)].map((match) => match[1])

    for (const href of links) {
      const filePath = path.join(distClientDir, ...href.split('/').filter(Boolean))
      expect(fs.existsSync(filePath), `missing: ${href}`).toBe(true)
    }
  })

  it('every dynamic import in the main bundle exists on disk', () => {
    expect(mainJsUrl).not.toBeNull()
    const chunks = [...mainJsContent.matchAll(/import\(\s*"\.\/([^"]+)"/g)].map((match) => match[1])
    expect(chunks.length).toBeGreaterThanOrEqual(1)

    for (const chunk of chunks) {
      const chunkPath = path.join(distClientDir, 'assets', chunk)
      expect(fs.existsSync(chunkPath), `missing chunk: ${chunk}`).toBe(true)
    }
  })

  it('serves index.html with no-cache headers', async () => {
    const res = await request(app).get('/index.html')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
  })

  it('serves hashed emitted assets with immutable one-year cache', async () => {
    const scripts = [...indexHtml.matchAll(/src="(\/assets\/[^"]+)"/g)].map((match) => match[1])
    expect(scripts.length).toBeGreaterThanOrEqual(1)

    for (const href of scripts) {
      const res = await request(app).get(href)
      expect(res.status, `failed to fetch ${href}`).toBe(200)
      expect(res.headers['cache-control'], `${href} cache-control`).toBe('public, max-age=31536000, immutable')
    }
  })

  it('serves dynamically imported chunks with immutable one-year cache', async () => {
    expect(mainJsUrl).not.toBeNull()
    const chunks = [...mainJsContent.matchAll(/import\(\s*"\.\/([^"]+)"/g)].map((match) => match[1])
    expect(chunks.length).toBeGreaterThanOrEqual(1)

    for (const chunk of chunks) {
      const res = await request(app).get(`/assets/${chunk}`)
      expect(res.status, `failed to fetch chunk ${chunk}`).toBe(200)
      expect(res.headers['cache-control'], `chunk ${chunk} cache-control`).toBe('public, max-age=31536000, immutable')
    }
  })

  it('returns 404 for missing /assets paths', async () => {
    const res = await request(app).get('/assets/SettingsView-DOESNOTEXIST.js')
    expect(res.status).toBe(404)
  })

  it('falls through to SPA HTML for missing non-asset paths', async () => {
    const res = await request(app).get('/some/deep/spa/route')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    expect(res.text).toContain('<html')
  })

  it('serves unhashed root assets with no-cache', async () => {
    const res = await request(app).get('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('serves manifest.webmanifest with no-cache', async () => {
    const res = await request(app).get('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })
})
