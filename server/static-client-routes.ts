import express, { type Express, type Response } from 'express'
import path from 'path'

const HASHED_ASSET_RE = /[.-][A-Za-z0-9_-]{6,}\.(js|css|svg|png|jpg|jpeg|gif|woff2?)$/

function setNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

function applyStaticClientCacheHeaders(res: Response, filePath: string): void {
  const normalizedPath = path.normalize(filePath)
  const isIndexHtml = normalizedPath.endsWith(`${path.sep}index.html`)
  const isHashedAsset = normalizedPath.includes(`${path.sep}assets${path.sep}`)
    && HASHED_ASSET_RE.test(path.basename(normalizedPath))

  if (isIndexHtml) {
    setNoStoreHeaders(res)
    return
  }

  if (isHashedAsset) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    return
  }

  res.setHeader('Cache-Control', 'no-cache')
}

export function registerStaticClientRoutes(app: Express, clientDir: string): void {
  const indexHtml = path.join(clientDir, 'index.html')

  app.use(express.static(clientDir, {
    index: false,
    setHeaders: (res, filePath) => applyStaticClientCacheHeaders(res, filePath),
  }))

  app.get('/assets/*', (_req, res) => {
    res.status(404).send('Not found')
  })

  app.get('*', (_req, res) => {
    setNoStoreHeaders(res)
    res.sendFile(indexHtml)
  })
}
