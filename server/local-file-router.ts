import { Router, type Response } from 'express'
import cookieParser from 'cookie-parser'
import fsp from 'node:fs/promises'
import path from 'path'
import { timingSafeCompare } from './auth.js'

function mapStatError(error: NodeJS.ErrnoException): { status: number; body: { error: string } } {
  if (error.code === 'ENOENT') {
    return { status: 404, body: { error: 'File not found' } }
  }

  if (error.code === 'EISDIR') {
    return { status: 400, body: { error: 'Cannot serve directories' } }
  }

  return { status: 500, body: { error: 'Failed to read file metadata' } }
}

function sendResolvedFile(res: Response, resolved: string): Promise<void> {
  return new Promise((resolve) => {
    res.sendFile(resolved, (error?: NodeJS.ErrnoException) => {
      if (!error) {
        resolve()
        return
      }

      if (!res.headersSent) {
        if (error.code === 'ENOENT') {
          res.status(404).json({ error: 'File not found' })
        } else if (error.code === 'EISDIR') {
          res.status(400).json({ error: 'Cannot serve directories' })
        } else {
          res.status(500).json({ error: 'Failed to send file' })
        }
      }

      resolve()
    })
  })
}

export function createLocalFileRouter(): Router {
  const router = Router()

  router.get('/', cookieParser(), (req, res, next) => {
    const headerToken = typeof req.headers['x-auth-token'] === 'string'
      ? req.headers['x-auth-token']
      : undefined
    const cookieToken = typeof req.cookies?.['freshell-auth'] === 'string'
      ? req.cookies['freshell-auth']
      : undefined
    const token = headerToken || cookieToken
    const expectedToken = process.env.AUTH_TOKEN
    if (!expectedToken || !token || !timingSafeCompare(token, expectedToken)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  }, async (req, res) => {
    const filePath = req.query.path as string
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' })
    }

    const resolved = path.resolve(filePath)

    try {
      const stat = await fsp.stat(resolved)
      if (stat.isDirectory()) {
        return res.status(400).json({ error: 'Cannot serve directories' })
      }
    } catch (error) {
      const mapped = mapStatError(error as NodeJS.ErrnoException)
      return res.status(mapped.status).json(mapped.body)
    }

    await sendResolvedFile(res, resolved)
  })

  return router
}
