import { Router } from 'express'
import { migrateSettingsSortMode } from './settings-migrate.js'

export interface PerfRouterDeps {
  configStore: { patchSettings: (patch: any) => Promise<any> }
  registry: { setSettings: (s: any) => void }
  wsHandler: { broadcast: (msg: any) => void }
  applyDebugLogging: (enabled: boolean, source: string) => void
}

export function createPerfRouter(deps: PerfRouterDeps): Router {
  const { configStore, registry, wsHandler, applyDebugLogging } = deps
  const router = Router()

  router.post('/', async (req, res) => {
    const enabled = req.body?.enabled === true
    const updated = await configStore.patchSettings({ logging: { debug: enabled } })
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'api')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    res.json({ ok: true, enabled })
  })

  return router
}
