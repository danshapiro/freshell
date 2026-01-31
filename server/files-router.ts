import express from 'express'
import fsp from 'fs/promises'
import path from 'path'

export const filesRouter = express.Router()

filesRouter.get('/read', async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    return res.status(400).json({ error: 'path query parameter required' })
  }

  const resolved = path.resolve(filePath)

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

filesRouter.post('/write', async (req, res) => {
  const { path: filePath, content } = req.body

  if (!filePath) {
    return res.status(400).json({ error: 'path is required' })
  }
  if (content === undefined) {
    return res.status(400).json({ error: 'content is required' })
  }

  const resolved = path.resolve(filePath)

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

filesRouter.get('/complete', async (req, res) => {
  const prefix = req.query.prefix as string
  if (!prefix) {
    return res.status(400).json({ error: 'prefix query parameter required' })
  }

  const resolved = path.resolve(prefix)

  try {
    // Check if prefix is a directory - if so, list all files in it
    let dir: string
    let basename: string

    try {
      const stat = await fsp.stat(resolved)
      if (stat.isDirectory()) {
        dir = resolved
        basename = ''
      } else {
        dir = path.dirname(resolved)
        basename = path.basename(resolved)
      }
    } catch {
      // Path doesn't exist, treat as partial path
      dir = path.dirname(resolved)
      basename = path.basename(resolved)
    }

    const entries = await fsp.readdir(dir, { withFileTypes: true })

    const matches = entries
      .filter((entry) => entry.name.startsWith(basename))
      .map((entry) => ({
        path: path.join(dir, entry.name),
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
