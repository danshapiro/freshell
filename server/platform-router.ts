import { Router } from 'express'
import { AI_CONFIG } from './ai-prompts.js'
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

export function detectFeatureFlags(platform: NodeJS.Platform = process.platform): Record<string, boolean> {
  return {
    kilroy: isTruthy(process.env.KILROY_ENABLED),
    aiEnabled: AI_CONFIG.enabled(),
    // Resume-by-id UI (SYNC-06): BOTH servers implement POST
    // /api/sessions/resolve and declare this flag — the Rust side in
    // build_platform_payload (crates/freshell-server/src/main.rs).
    sessionResolve: true,
    // Host-stats collection reads /proc + /sys (unavailable on Windows).
    // Boot-static platform check (no /proc probe): readers degrade to
    // `available: false` on failure. Rust mirrors with
    // cfg!(not(target_os = "windows")).
    hostStatsAvailable: platform !== 'win32',
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
