import { Router, type Request, type Response, type NextFunction } from 'express'
import fsp from 'fs/promises'
import path from 'path'
import {
  getPathModuleForFlavor,
  isPathAllowed,
  isReachableDirectory,
  normalizeUserPath,
  toFilesystemPath,
} from './path-utils.js'
import { detectPlatform } from './platform.js'
import { resolveOpenCommand, spawnAndMonitor } from './file-opener.js'
import { collectCandidateDirectories } from './candidate-dirs.js'

export interface FilesRouterDeps {
  configStore: {
    getSettings: () => Promise<any>
    snapshot: () => Promise<any>
  }
  codingCliIndexer: {
    getProjects: () => any[]
  }
  registry: {
    list: () => any[]
  }
}

async function resolveUserFilesystemPath(input: string): Promise<string> {
  const { normalizedPath, flavor } = normalizeUserPath(input)
  return toFilesystemPath(normalizedPath, flavor)
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const { configStore, codingCliIndexer, registry } = deps
  const router = Router()

  /**
   * Middleware that validates file paths against the configured allowedFilePaths sandbox.
   * Returns 403 if the path is outside all allowed roots.
   * When allowedFilePaths is empty/undefined, all paths are allowed (backward compatible).
   */
  async function validatePath(req: Request, res: Response, next: NextFunction) {
    const filePath = (req.query.path as string) || (req.query.prefix as string) || req.body?.path
    if (!filePath) {
      return next()
    }

    const resolved = await resolveUserFilesystemPath(filePath)
    const settings = await configStore.getSettings()

    if (!isPathAllowed(resolved, settings.allowedFilePaths)) {
      return res.status(403).json({ error: 'Path not allowed' })
    }

    next()
  }

  router.get('/read', validatePath, async (req, res) => {
    const filePath = req.query.path as string
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' })
    }

    const resolved = await resolveUserFilesystemPath(filePath)

    try {
      const stat = await fsp.stat(resolved)
      if (stat.isDirectory()) {
        return res.status(400).json({ error: 'Cannot read directory' })
      }

      const content = await fsp.readFile(resolved, 'utf-8')
      res.json({
        content,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      })
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' })
      }
      return res.status(500).json({ error: err.message })
    }
  })

  router.post('/write', validatePath, async (req, res) => {
    const { path: filePath, content } = req.body

    if (!filePath) {
      return res.status(400).json({ error: 'path is required' })
    }
    if (content === undefined) {
      return res.status(400).json({ error: 'content is required' })
    }

    const resolved = await resolveUserFilesystemPath(filePath)

    try {
      // Create parent directories if needed
      await fsp.mkdir(path.dirname(resolved), { recursive: true })

      await fsp.writeFile(resolved, content, 'utf-8')
      const stat = await fsp.stat(resolved)

      res.json({
        success: true,
        modifiedAt: stat.mtime.toISOString(),
      })
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  router.get('/complete', validatePath, async (req, res) => {
    const prefix = req.query.prefix as string
    const dirsOnly = req.query.dirs === 'true' || req.query.dirs === '1'
    if (!prefix) {
      return res.status(400).json({ error: 'prefix query parameter required' })
    }

    const { normalizedPath, flavor } = normalizeUserPath(prefix)
    const pathModule = getPathModuleForFlavor(flavor)
    const resolvedFsPath = await toFilesystemPath(normalizedPath, flavor)

    try {
      // Check if prefix is a directory - if so, list all files in it
      let dirDisplayPath: string
      let dirFsPath: string
      let basename: string

      try {
        const stat = await fsp.stat(resolvedFsPath)
        if (stat.isDirectory()) {
          dirDisplayPath = normalizedPath
          dirFsPath = resolvedFsPath
          basename = ''
        } else {
          dirDisplayPath = pathModule.dirname(normalizedPath)
          dirFsPath = await toFilesystemPath(dirDisplayPath, flavor)
          basename = pathModule.basename(normalizedPath)
        }
      } catch {
        // Path doesn't exist, treat as partial path
        dirDisplayPath = pathModule.dirname(normalizedPath)
        dirFsPath = await toFilesystemPath(dirDisplayPath, flavor)
        basename = pathModule.basename(normalizedPath)
      }

      const entries = await fsp.readdir(dirFsPath, { withFileTypes: true })

      const matches = entries
        .filter((entry) => entry.name.startsWith(basename))
        .filter((entry) => !dirsOnly || entry.isDirectory())
        .map((entry) => ({
          path: pathModule.join(dirDisplayPath, entry.name),
          isDirectory: entry.isDirectory(),
        }))
        // Sort: directories first, then alphabetically
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1
          }
          return a.path.localeCompare(b.path)
        })
        .slice(0, 20)

      res.json({ suggestions: matches })
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.json({ suggestions: [] })
      }
      return res.status(500).json({ error: err.message })
    }
  })

  router.post('/validate-dir', validatePath, async (req, res) => {
    const pathInput = req.body?.path
    if (!pathInput || typeof pathInput !== 'string') {
      return res.status(400).json({ error: 'path is required' })
    }

    const trimmed = pathInput.trim()
    if (!trimmed) {
      return res.status(400).json({ error: 'path is required' })
    }

    const { ok, resolvedPath } = await isReachableDirectory(trimmed)
    return res.json({ valid: ok, resolvedPath })
  })

  router.post('/open', validatePath, async (req, res) => {
    const { path: filePath, reveal, line, column } = req.body || {}
    if (!filePath) {
      return res.status(400).json({ error: 'path is required' })
    }

    const resolved = await resolveUserFilesystemPath(filePath)

    try {
      await fsp.stat(resolved)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' })
      }
      return res.status(500).json({ error: err.message })
    }

    const settings = await configStore.getSettings()
    const platform = await detectPlatform()

    const cmd = await resolveOpenCommand({
      filePath: resolved,
      reveal,
      line: typeof line === 'number' ? line : undefined,
      column: typeof column === 'number' ? column : undefined,
      editorSetting: settings.editor?.externalEditor,
      customEditorCommand: settings.editor?.customEditorCommand,
      platform,
    })

    const result = await spawnAndMonitor(cmd)
    if (!result.ok) {
      return res.status(502).json({ error: result.error })
    }
    return res.json({ ok: true })
  })

  router.get('/candidate-dirs', async (_req, res) => {
    const cfg = await configStore.snapshot()
    const providerCwds = Object.values(cfg.settings?.codingCli?.providers || {}).map((provider: any) => provider?.cwd)
    const directories = collectCandidateDirectories({
      projects: codingCliIndexer.getProjects(),
      terminals: registry.list(),
      recentDirectories: cfg.recentDirectories || [],
      providerCwds,
      defaultCwd: cfg.settings?.defaultCwd,
    })
    res.json({ directories })
  })

  return router
}
