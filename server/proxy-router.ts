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

  router.delete('/forward/:port', (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }
    try {
      const requester = getRequesterIdentity(req)
      portForwardManager.close(targetPort, requester.key)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward close failed')
      res.status(500).json({ error: `Failed to close port forward: ${msg}` })
    }
  })

  return router
}
