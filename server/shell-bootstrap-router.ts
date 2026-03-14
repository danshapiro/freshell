import { Router } from 'express'
import { MAX_BOOTSTRAP_PAYLOAD_BYTES, type BootstrapPayload } from '../shared/read-models.js'
import { setResponsePerfContext } from './request-logger.js'
import { createRequestAbortSignal } from './read-models/request-abort.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from './read-models/work-scheduler.js'

export interface ShellBootstrapRouterDeps {
  getSettings: () => Promise<BootstrapPayload['settings']>
  getLegacyLocalSettingsSeed?: () => Promise<BootstrapPayload['legacyLocalSettingsSeed']>
  getPlatform: () => Promise<unknown>
  getShellState?: () => Promise<BootstrapPayload['shell']>
  getShellTaskStatus?: () => Promise<Record<string, boolean>>
  getPerfState?: () => Promise<BootstrapPayload['perf'] | undefined>
  getPerfLogging?: () => boolean | Promise<boolean>
  getConfigFallback?: () => Promise<BootstrapPayload['configFallback'] | undefined>
  readModelScheduler?: ReadModelWorkScheduler
}

export { MAX_BOOTSTRAP_PAYLOAD_BYTES }

export function createShellBootstrapRouter(deps: ShellBootstrapRouterDeps): Router {
  const router = Router()
  const readModelScheduler = deps.readModelScheduler ?? defaultReadModelScheduler

  router.get('/bootstrap', async (req, res) => {
    const signal = createRequestAbortSignal(req, res)
    try {
      const payload = await readModelScheduler.schedule({
        lane: 'critical',
        signal,
        run: async (scheduledSignal) => {
          const settings = await deps.getSettings()
          const legacyLocalSettingsSeed = deps.getLegacyLocalSettingsSeed
            ? await deps.getLegacyLocalSettingsSeed()
            : undefined

          const [platform, shell, perf, configFallback] = await Promise.all([
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

          if (scheduledSignal.aborted) {
            throw scheduledSignal.reason
          }

          return {
            settings,
            ...(legacyLocalSettingsSeed ? { legacyLocalSettingsSeed } : {}),
            platform,
            shell,
            ...(perf ? { perf } : {}),
            ...(configFallback ? { configFallback } : {}),
          } satisfies BootstrapPayload
        },
      })

      const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
      if (payloadBytes > MAX_BOOTSTRAP_PAYLOAD_BYTES) {
        res.status(500).json({ error: 'Bootstrap payload exceeds budget' })
        return
      }

      setResponsePerfContext(res, {
        readModelLane: 'critical',
        responsePayloadBytes: payloadBytes,
      })
      res.json(payload)
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      res.status(500).json({ error: 'Bootstrap failed' })
    }
  })

  return router
}
