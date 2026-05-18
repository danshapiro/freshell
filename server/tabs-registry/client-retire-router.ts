import { Router } from 'express'
import { z } from 'zod'

import type { TabsRegistryStore } from './store.js'

const TabsSyncClientRetireBodySchema = z.object({
  deviceId: z.string().min(1),
  clientInstanceId: z.string().min(1),
  snapshotRevision: z.number().int().nonnegative(),
}).strict()

export function createTabsSyncRouter(deps: {
  tabsRegistryStore: Pick<TabsRegistryStore, 'retireClientSnapshot'>
}): Router {
  const router = Router()

  router.post('/client-retire', async (req, res) => {
    const parsed = TabsSyncClientRetireBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid tabs registry retire payload',
        details: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
          message: issue.message,
        })),
      })
      return
    }

    try {
      const result = await deps.tabsRegistryStore.retireClientSnapshot(parsed.data)
      res.json({ ok: true, accepted: result.accepted })
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return router
}
