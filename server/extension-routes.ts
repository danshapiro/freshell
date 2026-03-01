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
