import { Router } from 'express'

export interface ServerInfoRouterDeps {
  appVersion: string
  startedAt: number  // Date.now() captured at server start
}

export function createServerInfoRouter(deps: ServerInfoRouterDeps): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({
      version: deps.appVersion,
      uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    })
  })

  return router
}
