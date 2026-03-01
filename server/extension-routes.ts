/**
 * Extension API routes — CRUD + lifecycle for extensions.
 *
 * Mounted at /api/extensions by the server entry point.
 */
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import type { ExtensionManager } from './extension-manager.js'

export function createExtensionRouter(extensionManager: ExtensionManager): Router {
  const router = Router()

  /** GET / — List all extensions (client registry format). */
  router.get('/', (_req, res) => {
    res.json(extensionManager.toClientRegistry())
  })

  /** GET /:name — Single extension details + server status. */
  router.get('/:name', (req, res) => {
    const { name } = req.params
    const entry = extensionManager.get(name)
    if (!entry) {
      return res.status(404).json({ error: `Extension not found: '${name}'` })
    }

    // Find this extension's client entry from the full registry
    const clientEntries = extensionManager.toClientRegistry()
    const clientEntry = clientEntries.find((e) => e.name === name)
    res.json(clientEntry)
  })

  /** POST /:name/start — Start a server extension. */
  router.post('/:name/start', async (req, res) => {
    const { name } = req.params
    const entry = extensionManager.get(name)
    if (!entry) {
      return res.status(404).json({ error: `Extension not found: '${name}'` })
    }
    if (entry.manifest.category !== 'server') {
      return res.status(400).json({ error: `Extension '${name}' is not a server extension` })
    }

    try {
      const port = await extensionManager.startServer(name)
      res.json({ port })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  /** POST /:name/stop — Stop a server extension. */
  router.post('/:name/stop', async (req, res) => {
    const { name } = req.params
    const entry = extensionManager.get(name)
    if (!entry) {
      return res.status(404).json({ error: `Extension not found: '${name}'` })
    }

    await extensionManager.stopServer(name)
    res.json({ ok: true })
  })

  /** GET /:name/client/* — Serve client extension static files. */
  router.get('/:name/client/*', (req, res) => {
    const { name } = req.params
    const entry = extensionManager.get(name)
    if (!entry) {
      return res.status(404).json({ error: `Extension not found: '${name}'` })
    }
    if (entry.manifest.category !== 'client') {
      return res.status(400).json({ error: `Extension '${name}' is not a client extension` })
    }

    // Scope file serving to the directory of the client entry file.
    // e.g. if client.entry is "./dist/index.html", publicRoot is "<extDir>/dist"
    const clientEntry = entry.manifest.client!.entry
    const publicRoot = path.resolve(entry.path, path.dirname(clientEntry))

    // Validate publicRoot is within the extension directory (blocks absolute entry
    // paths and symlink escapes). Resolve both sides through realpath so symlinks
    // in publicRoot or entry.path are handled consistently.
    let realExtDir: string
    let realPublicRoot: string
    try {
      realExtDir = fs.realpathSync(entry.path)
      realPublicRoot = fs.realpathSync(publicRoot)
    } catch {
      // publicRoot doesn't exist on disk — reject early
      return res.status(400).json({ error: 'Invalid client entry path' })
    }

    if (!realPublicRoot.startsWith(realExtDir + path.sep) && realPublicRoot !== realExtDir) {
      return res.status(400).json({ error: 'Invalid client entry path' })
    }

    // The wildcard captures everything after /client/
    const filePath = req.params[0] || path.basename(clientEntry)
    const resolved = path.resolve(realPublicRoot, filePath)

    // Path traversal protection: resolved path must stay within publicRoot.
    // Use realpathSync to resolve any symlinks in the requested file path.
    let realResolved: string
    try {
      realResolved = fs.realpathSync(resolved)
    } catch {
      // File doesn't exist — fall through to sendFile which will 404
      realResolved = resolved
    }

    if (!realResolved.startsWith(realPublicRoot + path.sep) && realResolved !== realPublicRoot) {
      return res.status(400).json({ error: 'Invalid file path' })
    }

    res.sendFile(resolved, (err) => {
      if (err) {
        if ((err as any).code === 'ENOENT') {
          return res.status(404).json({ error: 'File not found' })
        }
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve file' })
        }
      }
    })
  })

  /** GET /:name/icon — Serve extension icon SVG. */
  router.get('/:name/icon', (req, res) => {
    const { name } = req.params
    const entry = extensionManager.get(name)
    if (!entry) {
      return res.status(404).json({ error: `Extension not found: '${name}'` })
    }

    const icon = entry.manifest.icon
    if (!icon) {
      return res.status(404).json({ error: 'No icon defined for this extension' })
    }

    // Path traversal protection: resolve relative to the extension dir
    // and verify the result stays within it
    const iconPath = path.resolve(entry.path, icon)
    if (!iconPath.startsWith(entry.path + path.sep) && iconPath !== entry.path) {
      return res.status(400).json({ error: 'Invalid icon path' })
    }

    try {
      const content = fs.readFileSync(iconPath, 'utf-8')
      res.setHeader('Content-Type', 'image/svg+xml')
      res.send(content)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Icon file not found' })
      }
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
