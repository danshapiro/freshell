import { Router } from 'express'
import { withPerfSpan } from './perf-logger.js'
import { DEFAULT_CLI_PROVIDER_NAMES } from './platform.js'
import { buildServerSettingsPatchSchema, type ServerSettingsPatch } from '../shared/settings.js'
import { AI_CONFIG } from './ai-prompts.js'

// --- SettingsPatchSchema (moved from settings-schema.ts) ---

export function buildSettingsPatchSchema(validCliProviders: readonly string[] = DEFAULT_CLI_PROVIDER_NAMES) {
  return buildServerSettingsPatchSchema(validCliProviders)
}

export const SettingsPatchSchema = buildServerSettingsPatchSchema()

export type SettingsPatch = ServerSettingsPatch

// --- normalizeSettingsPatch (moved from server/index.ts) ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stripDeprecatedSettingsPatchAliases(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {}
  }

  const patch = { ...value }
  if (isRecord(patch.sidebar)) {
    const sidebar = { ...patch.sidebar }
    delete sidebar.ignoreCodexSubagentSessions
    patch.sidebar = sidebar
  }

  return patch
}

export const normalizeSettingsPatch = (patch: Record<string, any>) => {
  if (Object.prototype.hasOwnProperty.call(patch, 'defaultCwd')) {
    const raw = patch.defaultCwd
    if (raw === null) {
      patch.defaultCwd = undefined
    } else if (typeof raw === 'string' && raw.trim() === '') {
      patch.defaultCwd = undefined
    }
  }

  if (patch.codingCli?.providers && typeof patch.codingCli.providers === 'object') {
    for (const providerPatch of Object.values(patch.codingCli.providers)) {
      if (!providerPatch || typeof providerPatch !== 'object' || Array.isArray(providerPatch)) {
        continue
      }
      const providerPatchRecord = providerPatch as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(providerPatchRecord, 'cwd')) {
        const raw = providerPatchRecord.cwd
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          providerPatchRecord.cwd = undefined
        }
      }
      if (Object.prototype.hasOwnProperty.call(providerPatchRecord, 'model')) {
        const raw = providerPatchRecord.model
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          providerPatchRecord.model = undefined
        }
      }
      if (Object.prototype.hasOwnProperty.call(providerPatchRecord, 'sandbox') && providerPatchRecord.sandbox === null) {
        providerPatchRecord.sandbox = undefined
      }
    }
  }

  if (patch.agentChat?.providers && typeof patch.agentChat.providers === 'object') {
    for (const providerPatch of Object.values(patch.agentChat.providers)) {
      if (!providerPatch || typeof providerPatch !== 'object' || Array.isArray(providerPatch)) {
        continue
      }
      const providerPatchRecord = providerPatch as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(providerPatchRecord, 'modelSelection') && providerPatchRecord.modelSelection === null) {
        providerPatchRecord.modelSelection = undefined
      }
      if (Object.prototype.hasOwnProperty.call(providerPatchRecord, 'effort')) {
        const raw = providerPatchRecord.effort
        if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
          providerPatchRecord.effort = undefined
        }
      }
    }
  }

  return patch
}

// --- Router ---

export interface SettingsRouterDeps {
  configStore: {
    getSettings: () => Promise<any>
    patchSettings: (patch: any) => Promise<any>
  }
  registry: { setSettings: (s: any) => void }
  wsHandler: { broadcast: (msg: any) => void }
  codingCliIndexer: { refresh: () => Promise<void> }
  perfConfig: { slowSessionRefreshMs: number }
  applyDebugLogging: (enabled: boolean, source: string) => void
  validCliProviders?: string[]
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const {
    configStore,
    registry,
    wsHandler,
    codingCliIndexer,
    perfConfig,
    applyDebugLogging,
    validCliProviders = DEFAULT_CLI_PROVIDER_NAMES,
  } = deps
  const settingsPatchSchema = buildSettingsPatchSchema(validCliProviders)
  const router = Router()

  router.get('/', async (_req, res) => {
    const s = await configStore.getSettings()
    res.json(s)
  })

  const handleSettingsPatch = async (req: any, res: any) => {
    const parsed = settingsPatchSchema.safeParse(stripDeprecatedSettingsPatchAliases(req.body || {}))
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const patch = normalizeSettingsPatch(parsed.data as Record<string, any>) as SettingsPatch
    const updated = await configStore.patchSettings(patch)
    registry.setSettings(updated)
    AI_CONFIG.applySettingsKey(updated.ai?.geminiApiKey, { force: true })
    applyDebugLogging(!!updated.logging?.debug, 'settings')
    wsHandler.broadcast({ type: 'settings.updated', settings: updated })
    await withPerfSpan(
      'coding_cli_refresh',
      () => codingCliIndexer.refresh(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    res.json(updated)
  }

  router.patch('/', handleSettingsPatch)
  router.put('/', handleSettingsPatch)

  return router
}
