import { Router } from 'express'
import fsp from 'fs/promises'
import path from 'path'
import cookieParser from 'cookie-parser'
import { timingSafeCompare } from './auth.js'

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
      res.sendFile(resolved)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' })
      }
      return res.status(500).json({ error: err.message })
    }
  })

  return router
}
