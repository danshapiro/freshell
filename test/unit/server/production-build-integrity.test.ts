import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'path'
import fs from 'fs'

const distClientDir = path.resolve(__dirname, '../../../dist/client')
const hasBuild = fs.existsSync(path.join(distClientDir, 'index.html'))

describe.skipIf(!hasBuild)('production build integrity', () => {
  let indexHtml: string
  let mainJsUrl: string | null = null
  let mainJsContent: string

  beforeAll(() => {
    indexHtml = fs.readFileSync(path.join(distClientDir, 'index.html'), 'utf8')
    const scriptMatch = indexHtml.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)
    if (scriptMatch) mainJsUrl = scriptMatch[1]
    if (mainJsUrl) {
      const mainJsPath = path.join(distClientDir, ...mainJsUrl.split('/').filter(Boolean))
      mainJsContent = fs.readFileSync(mainJsPath, 'utf8')
    }
  })

  describe('static asset references resolve', () => {
    it('every <script src> in index.html exists on disk', () => {
      const scripts = [...indexHtml.matchAll(/src="(\/assets\/[^"]+)"/g)].map(m => m[1])
      expect(scripts.length).toBeGreaterThanOrEqual(1)

      for (const href of scripts) {
        const filePath = path.join(distClientDir, ...href.split('/').filter(Boolean))
        expect(fs.existsSync(filePath), `missing: ${href}`).toBe(true)
      }
    })

    it('every <link href> in index.html exists on disk', () => {
      const links = [...indexHtml.matchAll(/href="(\/assets\/[^"]+)"/g)].map(m => m[1])

      for (const href of links) {
        const filePath = path.join(distClientDir, ...href.split('/').filter(Boolean))
        expect(fs.existsSync(filePath), `missing: ${href}`).toBe(true)
      }
    })

    it('every dynamic import() in the main bundle exists on disk', () => {
      expect(mainJsUrl).not.toBeNull()
      const chunks = [...mainJsContent.matchAll(/import\(\s*"\.\/([^"]+)"/g)].map(m => m[1])

      expect(chunks.length).toBeGreaterThanOrEqual(1)

      for (const chunk of chunks) {
        const chunkPath = path.join(distClientDir, 'assets', chunk)
        expect(fs.existsSync(chunkPath), `missing chunk: ${chunk}`).toBe(true)
      }
    })
  })

  describe('cache headers', () => {
    let app: express.Express

    beforeAll(() => {
      app = express()
      const indexHtmlPath = path.join(distClientDir, 'index.html')

      app.use(express.static(distClientDir, {
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
      app.get('*', (_req, res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')
        res.sendFile(indexHtmlPath)
      })
    })

    it('index.html is served with no-cache via direct request', async () => {
      const res = await request(app).get('/index.html')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
    })

    it('SPA fallback route returns index.html with no-cache', async () => {
      const res = await request(app).get('/some/deep/spa/route')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
      expect(res.text).toContain('<html')
    })

    it('hashed JS assets have long-lived immutable cache', async () => {
      const scripts = [...indexHtml.matchAll(/src="(\/assets\/[^"]+)"/g)].map(m => m[1])
      expect(scripts.length).toBeGreaterThanOrEqual(1)

      for (const href of scripts) {
        const res = await request(app).get(href)
        expect(res.status, `failed to fetch ${href}`).toBe(200)
        expect(res.headers['cache-control'], `${href} cache-control`).toBe('public, max-age=31536000, immutable')
      }
    })

    it('dynamically imported chunks have long-lived immutable cache', async () => {
      expect(mainJsUrl).not.toBeNull()
      const chunks = [...mainJsContent.matchAll(/import\(\s*"\.\/([^"]+)"/g)].map(m => m[1])
      expect(chunks.length).toBeGreaterThanOrEqual(1)

      for (const chunk of chunks) {
        const res = await request(app).get(`/assets/${chunk}`)
        expect(res.status, `failed to fetch chunk ${chunk}`).toBe(200)
        expect(res.headers['cache-control'], `chunk ${chunk} cache-control`).toBe('public, max-age=31536000, immutable')
      }
    })

    it('nonexistent path falls through to SPA fallback (no 404 leak)', async () => {
      const res = await request(app).get('/assets/SettingsView-DOESNOTEXIST.js')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate')
      expect(res.text).toContain('<html')
    })

    it('unhashed root assets (sw.js) get no-cache', async () => {
      const res = await request(app).get('/sw.js')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache')
    })

    it('unhashed root assets (manifest.webmanifest) get no-cache', async () => {
      const res = await request(app).get('/manifest.webmanifest')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-cache')
    })
  })
})
