import { Router } from 'express'

export interface DebugRouterDeps {
  appVersion: string
  configStore: { snapshot: () => Promise<any> }
  wsHandler: { connectionCount: () => number }
  codingCliIndexer: { getProjects: () => any[] }
  tabsRegistryStore: { count: () => number; listDevices: () => any[] }
  registry: { list: () => any[] }
}

export function createDebugRouter(deps: DebugRouterDeps): Router {
  const { appVersion, configStore, wsHandler, codingCliIndexer, tabsRegistryStore, registry } = deps
  const router = Router()

  router.get('/', async (_req, res) => {
    const cfg = await configStore.snapshot()
    res.json({
      version: 1,
      appVersion,
      wsConnections: wsHandler.connectionCount(),
      settings: cfg.settings,
      sessionsProjects: codingCliIndexer.getProjects(),
      tabsRegistry: {
        recordCount: tabsRegistryStore.count(),
        deviceCount: tabsRegistryStore.listDevices().length,
      },
      terminals: registry.list(),
      time: new Date().toISOString(),
    })
  })

  return router
}
