import { Router } from 'express'
import { ok } from './response.js'

export function createAgentApiRouter({ layoutStore, registry, wsHandler }: { layoutStore: any; registry: any; wsHandler?: any }) {
  const router = Router()

  router.get('/tabs', (_req, res) => {
    const tabs = layoutStore.listTabs?.() || []
    res.json(ok({ tabs }))
  })

  router.get('/panes', (req, res) => {
    const tabId = req.query.tabId as string | undefined
    const panes = layoutStore.listPanes?.(tabId) || []
    res.json(ok({ panes }))
  })

  return router
}
