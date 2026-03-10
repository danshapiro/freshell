import { Router } from 'express'

export const MAX_BOOTSTRAP_PAYLOAD_BYTES = 12 * 1024

export type ShellTasks = Record<string, boolean>

export interface ShellBootstrapRouterDeps {
  getSettings: () => Promise<any>
  getPlatform: () => Promise<any>
  getShellTaskStatus: () => Promise<ShellTasks>
  getPerfLogging: () => boolean
  getConfigFallback: () => Promise<{ reason: string; backupExists: boolean } | undefined>
}

type BootstrapPayload = {
  settings: unknown
  platform: unknown
  shell: { authenticated: boolean; ready?: boolean; tasks?: Record<string, boolean> }
  perf?: { logging: boolean }
  configFallback?: { reason: string; backupExists: boolean }
}

export function createShellBootstrapRouter(deps: ShellBootstrapRouterDeps): Router {
  const { getSettings, getPlatform, getShellTaskStatus, getPerfLogging, getConfigFallback } = deps
  const router = Router()

  router.get('/bootstrap', async (_req, res) => {
    const [settings, platform, tasks, configFallback] = await Promise.all([
      getSettings(),
      getPlatform(),
      getShellTaskStatus(),
      getConfigFallback(),
    ])

    const payload: BootstrapPayload = {
      settings,
      platform,
      shell: {
        authenticated: true,
        ready: Object.values(tasks).every(Boolean),
        tasks,
      },
      perf: { logging: !!getPerfLogging() },
      ...(configFallback ? { configFallback } : {}),
    }

    // Enforce payload budget defensively by truncating large fields if ever added in future
    // Current payload is small, so this is a soft guard.
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body, 'utf8') > MAX_BOOTSTRAP_PAYLOAD_BYTES) {
      // If over budget, drop task details but preserve minimal shape
      const trimmed: BootstrapPayload = {
        ...payload,
        shell: { authenticated: true, ready: payload.shell.ready },
      }
      return res.json(trimmed)
    }

    res.json(payload)
  })

  return router
}

