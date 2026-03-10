import { Router } from 'express'
import { MAX_BOOTSTRAP_PAYLOAD_BYTES, type BootstrapPayload } from '../shared/read-models.js'

export interface ShellBootstrapRouterDeps {
  getSettings: () => Promise<unknown>
  getPlatform: () => Promise<unknown>
  getShellState?: () => Promise<BootstrapPayload['shell']>
  getShellTaskStatus?: () => Promise<Record<string, boolean>>
  getPerfState?: () => Promise<BootstrapPayload['perf'] | undefined>
  getPerfLogging?: () => boolean | Promise<boolean>
  getConfigFallback?: () => Promise<BootstrapPayload['configFallback'] | undefined>
}

export { MAX_BOOTSTRAP_PAYLOAD_BYTES }

export function createShellBootstrapRouter(deps: ShellBootstrapRouterDeps): Router {
  const router = Router()

  router.get('/bootstrap', async (_req, res) => {
    try {
      const [settings, platform, shell, perf, configFallback] = await Promise.all([
        deps.getSettings(),
        deps.getPlatform(),
        (async () => {
          if (deps.getShellState) {
            return deps.getShellState()
          }
          const tasks = await deps.getShellTaskStatus?.()
          return {
            authenticated: true,
            ...(tasks
              ? {
                  ready: Object.values(tasks).every(Boolean),
                  tasks,
                }
              : {}),
          }
        })(),
        (async () => {
          if (deps.getPerfState) {
            return deps.getPerfState()
          }
          if (deps.getPerfLogging === undefined) {
            return undefined
          }
          return {
            logging: await deps.getPerfLogging(),
          }
        })(),
        deps.getConfigFallback?.() ?? Promise.resolve(undefined),
      ])

      const payload: BootstrapPayload = {
        settings,
        platform,
        shell,
        ...(perf ? { perf } : {}),
        ...(configFallback ? { configFallback } : {}),
      }

      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
      if (payloadBytes > MAX_BOOTSTRAP_PAYLOAD_BYTES) {
        res.status(500).json({ error: 'Bootstrap payload exceeds budget' })
        return
      }

      res.json(payload)
    } catch {
      res.status(500).json({ error: 'Bootstrap failed' })
    }
  })

  return router
}
