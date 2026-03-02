import { Router } from 'express'
import { logger } from './logger.js'

const log = logger.child({ component: 'platform-router' })

export interface PlatformRouterDeps {
  detectPlatform: () => Promise<string>
  detectAvailableClis: () => Promise<Record<string, boolean>>
  detectHostName: () => Promise<string>
  checkForUpdate: (currentVersion: string) => Promise<any>
  appVersion: string
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true'
}

function detectFeatureFlags(): Record<string, boolean> {
  return {
    kilroy: isTruthy(process.env.KILROY_ENABLED),
  }
}

export function createPlatformRouter(deps: PlatformRouterDeps): Router {
  const { detectPlatform, detectAvailableClis, detectHostName, checkForUpdate, appVersion } = deps
  const router = Router()

  router.get('/platform', async (_req, res) => {
    const [platform, availableClis, hostName] = await Promise.all([
      detectPlatform(),
      detectAvailableClis(),
      detectHostName(),
    ])
    const featureFlags = detectFeatureFlags()
    res.json({ platform, availableClis, hostName, featureFlags })
  })

  router.get('/version', async (_req, res) => {
    try {
      const updateCheck = await checkForUpdate(appVersion)
      res.json({ currentVersion: appVersion, updateCheck })
    } catch (err) {
      log.warn({ err }, 'Version check failed')
      res.json({ currentVersion: appVersion, updateCheck: null })
    }
  })

  return router
}
