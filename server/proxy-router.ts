import http from 'node:http'
import { Router } from 'express'
import { logger } from './logger.js'
import type { PortForwardManager } from './port-forward.js'
import { getRequesterIdentity } from './request-ip.js'

const log = logger.child({ component: 'proxy-router' })

export interface ProxyRouterDeps {
  portForwardManager: PortForwardManager
}

export function createProxyRouter(deps: ProxyRouterDeps): Router {
  const { portForwardManager } = deps
  const router = Router()

  router.post('/forward', async (req, res) => {
    const { port: targetPort } = req.body || {}

    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }

    try {
      const requester = getRequesterIdentity(req)
      const result = await portForwardManager.forward(targetPort, requester)
      res.json({ forwardedPort: result.port })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward failed')
      res.status(500).json({ error: `Failed to create port forward: ${msg}` })
    }
  })

  router.delete('/forward/:port', async (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }
    try {
      const requester = getRequesterIdentity(req)
      await portForwardManager.close(targetPort, requester.key)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward close failed')
      res.status(500).json({ error: `Failed to close port forward: ${msg}` })
    }
  })

  // HTTP reverse proxy for localhost URLs.
  // Routes requests through Freshell's own port, avoiding WSL2/Docker
  // networking issues where the browser can't reach localhost ports directly.
  // Uses router.use so Express strips the matched prefix — req.url becomes
  // the target path+query (e.g. /index.html?v=1).
  router.use('/http/:port', (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    headers.host = `127.0.0.1:${targetPort}`
    delete headers['transfer-encoding']
    delete headers['connection']

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url || '/',
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )

    proxyReq.on('error', (err) => {
      log.warn({ err, targetPort, path: req.url }, 'HTTP proxy connection failed')
      if (!res.headersSent) {
        res.status(502).json({ error: `Failed to connect to localhost:${targetPort}` })
      }
    })

    // If Express body-parsing middleware already consumed the stream,
    // re-serialize and write manually. Otherwise pipe the raw stream.
    if (req.readable) {
      req.pipe(proxyReq)
    } else if (req.body != null && Object.keys(req.body).length > 0) {
      const bodyStr = JSON.stringify(req.body)
      proxyReq.setHeader('content-type', 'application/json')
      proxyReq.setHeader('content-length', Buffer.byteLength(bodyStr))
      proxyReq.end(bodyStr)
    } else {
      proxyReq.end()
    }
  })

  return router
}
