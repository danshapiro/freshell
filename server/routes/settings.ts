import { Router } from 'express'
import { detectLanIps } from '../bootstrap.js'
import { configStore } from '../config-store.js'
import { migrateSettingsSortMode } from '../settings-migrate.js'
import { detectPlatform, detectAvailableClis } from '../platform.js'
import { collectCandidateDirectories } from '../candidate-dirs.js'
import { getPerfConfig, withPerfSpan } from '../perf-logger.js'
import type { TerminalRegistry } from '../terminal-registry.js'
import type { WsHandler } from '../ws-handler.js'
import type { CodingCliSessionIndexer } from '../coding-cli/session-indexer.js'
import type { claudeIndexer as ClaudeIndexerType } from '../claude-indexer.js'

const perfConfig = getPerfConfig()

function normalizeSettingsPatch(patch: Record<string, any>) {
  if (Object.prototype.hasOwnProperty.call(patch, 'defaultCwd')) {
    const raw = patch.defaultCwd
    if (raw === null) {
      patch.defaultCwd = undefined
    } else if (typeof raw === 'string' && raw.trim() === '') {
      patch.defaultCwd = undefined
    }
  }
  return patch
}

type SettingsRouterDeps = {
  registry: TerminalRegistry
  wsHandler: WsHandler
  codingCliIndexer: CodingCliSessionIndexer
  claudeIndexer: typeof ClaudeIndexerType
  applyDebugLogging: (enabled: boolean, source: string) => void
}

export function createSettingsRouter(deps: SettingsRouterDeps) {
  const { registry, wsHandler, codingCliIndexer, claudeIndexer, applyDebugLogging } = deps
  const router = Router()

  router.post('/perf', async (req, res) => {
    const enabled = req.body?.enabled === true
    const updated = await configStore.patchSettings({ logging: { debug: enabled } })
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'api')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    res.json({ ok: true, enabled })
  })

  // --- API: settings ---
  //
  // SECURITY NOTE (XSS Prevention):
  // User-provided strings (tab titles, descriptions, settings values) are stored
  // as-is without server-side sanitization. This is intentional because:
  //
  // 1. The frontend uses React, which automatically escapes all interpolated
  //    values in JSX (e.g., {title}, {description}), preventing XSS attacks.
  //
  // 2. CRITICAL: `dangerouslySetInnerHTML` must NEVER be used with any user
  //    data from these APIs. If rich text rendering is ever needed, use a
  //    sanitization library like DOMPurify on the frontend.
  //
  // 3. The same applies to session overrides, terminal overrides, and project
  //    colors - all user input flows through React's automatic escaping.
  //
  // Verified: No dangerouslySetInnerHTML or innerHTML usage exists in src/components/.
  //
  router.get('/settings', async (_req, res) => {
    const s = await configStore.getSettings()
    res.json(migrateSettingsSortMode(s))
  })

  router.get('/lan-info', (_req, res) => {
    res.json({ ips: detectLanIps() })
  })

  router.get('/platform', async (_req, res) => {
    const [platform, availableClis] = await Promise.all([
      detectPlatform(),
      detectAvailableClis(),
    ])
    res.json({ platform, availableClis })
  })

  router.get('/files/candidate-dirs', async (_req, res) => {
    const cfg = await configStore.snapshot()
    const providerCwds = Object.values(cfg.settings?.codingCli?.providers || {}).map((provider) => provider?.cwd)
    const directories = collectCandidateDirectories({
      projects: codingCliIndexer.getProjects(),
      terminals: registry.list(),
      recentDirectories: cfg.recentDirectories || [],
      providerCwds,
      defaultCwd: cfg.settings?.defaultCwd,
    })
    res.json({ directories })
  })

  router.patch('/settings', async (req, res) => {
    const patch = normalizeSettingsPatch(migrateSettingsSortMode(req.body || {}) as any)
    const updated = await configStore.patchSettings(patch)
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'settings')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    await withPerfSpan(
      'coding_cli_refresh',
      () => codingCliIndexer.refresh(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    await withPerfSpan(
      'claude_refresh',
      () => claudeIndexer.refresh(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    res.json(migrated)
  })

  // Alias (matches implementation plan)
  router.put('/settings', async (req, res) => {
    const patch = normalizeSettingsPatch(migrateSettingsSortMode(req.body || {}) as any)
    const updated = await configStore.patchSettings(patch)
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'settings')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    await withPerfSpan(
      'coding_cli_refresh',
      () => codingCliIndexer.refresh(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    await withPerfSpan(
      'claude_refresh',
      () => claudeIndexer.refresh(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    res.json(migrated)
  })

  return router
}
