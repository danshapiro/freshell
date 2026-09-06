import os from 'os'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'
import type { CodingCliProvider } from './coding-cli/provider.js'
import { CodingCliProviderSchema } from '../shared/ws-protocol.js'
import { DEFAULT_ENABLED_CLI_PROVIDERS } from '../shared/coding-cli-defaults.js'
import { logger } from './logger.js'
import { setResponsePerfContext } from './request-logger.js'
import { cascadeSessionRenameToTerminal } from './rename-cascade.js'
import { AI_CONFIG } from './ai-prompts.js'
import { generateAiSessionTitle } from './ai-title.js'
import { extractTitleFromMessage } from '../shared/title-utils.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import type { SessionMetadataStore } from './session-metadata-store.js'
import { DEFAULT_CLI_PROVIDER_NAMES } from './platform.js'
import { SessionDirectoryQuerySchema } from '../shared/read-models.js'
import {
  KnownSessionMetadataTypeSchema,
  SessionTypeMetadataSourceSchema,
} from '../shared/session-flavor.js'
import {
  querySessionDirectory,
  SessionDirectoryCursorError,
} from './session-directory/service.js'
import {
  ResumeResolveRequestSchema,
  type ResumeResolveProviderError,
  type ResumeResolveResponse,
} from '../shared/resume-resolve-contract.js'
import { resolveResumeInput } from './coding-cli/resolve-session.js'
import type { ResolveFallbacks } from './coding-cli/resolve-fallbacks.js'
import { createRequestAbortSignal } from './read-models/request-abort.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from './read-models/work-scheduler.js'

const log = logger.child({ component: 'sessions-router' })

// STATUS-STRIP: monotonic per-process counter for session-directory pages,
// assigned at query invocation (inside the scheduler's run() closure, right
// before `codingCliIndexer.getProjects()` captures the index state). Clock-seeded
// so a restarted process never restamps lower than a page it already served — and
// paired with a per-boot nonce: ordering by snapshotSeq is only trusted within
// the same (serverInstance, bootId) namespace.
let directorySnapshotSeq = Date.now()
const directoryBootId = randomUUID()

export const SessionPatchSchema = z.object({
  titleOverride: z.string().optional().nullable(),
  summaryOverride: z.string().optional().nullable(),
  deleted: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  createdAtOverride: z.coerce.number().optional(),
})

export interface SessionsRouterDeps {
  configStore: {
    getSettings: () => Promise<any>
    patchSessionOverride: (key: string, data: any) => Promise<any>
    deleteSession: (key: string) => Promise<void>
  }
  codingCliIndexer: {
    getProjects: () => any[]
    refresh: () => Promise<void>
    /** True once at least one index refresh completed (resolve readiness signal). */
    isReady?: () => boolean
    /** Providers whose MOST RECENT listing attempt failed (unsearchable, not empty). */
    getScanFailures?: () => string[]
    /** Fire-and-forget refresh so a degraded response's Retry can converge. */
    requestRefresh?: () => void
  }
  codingCliProviders: CodingCliProvider[]
  perfConfig: { slowSessionRefreshMs: number }
  terminalMetadata?: { list: () => TerminalMeta[] }
  registry?: { updateTitle: (id: string, title: string) => void }
  wsHandler?: { broadcastTerminalsChanged?: () => void }
  sessionMetadataStore?: SessionMetadataStore
  serverInstanceId?: string
  validCliProviders?: string[]
  readModelScheduler?: ReadModelWorkScheduler
  /** Global index readiness (startup-state codingCliIndexer task). Defaults to ready. */
  getIndexReadiness?: () => boolean
  /** Exact-id resolve fallbacks (buildResolveFallbacks); budget applied per request. */
  resolveFallbacks?: ResolveFallbacks
  /** Server home directory returned to the resolve client for cwd prefill. Defaults to os.homedir(). */
  homeDir?: string
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const { configStore, codingCliIndexer, codingCliProviders, perfConfig } = deps
  const router = Router()
  const readModelScheduler = deps.readModelScheduler ?? defaultReadModelScheduler
  const validCliProviders = new Set(deps.validCliProviders ?? DEFAULT_CLI_PROVIDER_NAMES)
  const sessionMetadataProviderSchema = z.string().min(1).superRefine((value, ctx) => {
    if (validCliProviders.has(value)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown CLI provider: '${value}'`,
    })
  })

  router.get('/session-directory', async (req, res) => {
    const parsed = SessionDirectoryQuerySchema.safeParse({
      query: typeof req.query.query === 'string' ? req.query.query : undefined,
      tier: typeof req.query.tier === 'string' ? req.query.tier : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      priority: req.query.priority,
      revision: typeof req.query.revision === 'string' ? Number(req.query.revision) : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      includeSubagents: req.query.includeSubagents,
      includeNonInteractive: req.query.includeNonInteractive,
      includeEmpty: req.query.includeEmpty,
      // STATUS-STRIP: comma-separated `provider:sessionId` keys the client
      // needs usage for regardless of the sidebar window (context meter).
      includeKeys: typeof req.query.includeKeys === 'string' && req.query.includeKeys.length > 0
        ? req.query.includeKeys.split(',').filter(Boolean)
        : undefined,
    })

    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    const signal = createRequestAbortSignal(req, res)

    try {
      const page = await readModelScheduler.schedule({
        lane: parsed.data.priority,
        signal,
        run: (scheduledSignal) => {
          // Assign immediately before capturing the indexer snapshot: the
          // sequence order matches the getProjects() capture order, so a later
          // query is never stamped lower than an earlier one.
          const snapshotSeq = ++directorySnapshotSeq
          return querySessionDirectory({
            projects: codingCliIndexer.getProjects(),
            query: parsed.data,
            terminalMeta: deps.terminalMetadata?.list() ?? [],
            providers: codingCliProviders,
            signal: scheduledSignal,
            snapshotSeq,
            bootId: directoryBootId,
            serverInstance: deps.serverInstanceId,
          })
        },
      })
      setResponsePerfContext(res, {
        readModelLane: parsed.data.priority,
        responsePayloadBytes: Buffer.byteLength(JSON.stringify(page), 'utf8'),
      })
      res.json(page)
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      const message = error instanceof Error ? error.message : 'Session directory query failed'
      const status = error instanceof SessionDirectoryCursorError ? 400 : 500
      if (status === 500) {
        log.error({ err: error }, 'Session directory query failed')
      }
      res.status(status).json({ error: message })
    }
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    const parsed = SessionPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
    // b5fb scope contract: EVERY override field is written only when its KEY is
    // present in the request body (same rule as the Rust route in
    // crates/freshell-server/src/sessions.rs). An absent key leaves the stored
    // value untouched — ConfigStore merges {...existing, ...patch} and the JSON
    // save drops keys spread as undefined, so unconditionally spreading an
    // absent field would erase a stored archived/deleted/summary/createdAt
    // value. Touching the title additionally writes/clears titleSource: an
    // explicit null/blank clear removes the source rung too, so the ladder is
    // unblocked afterwards (a leftover titleSource:'user' was a permanent
    // freeze).
    const touched = (key: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, key)
    const cleanTitle = cleanString(titleOverride)
    const next = await configStore.patchSessionOverride(compositeKey, {
      ...(touched('titleOverride')
        ? { titleOverride: cleanTitle, titleSource: cleanTitle ? ('user' as const) : undefined }
        : {}),
      ...(touched('summaryOverride') ? { summaryOverride: cleanString(summaryOverride) } : {}),
      ...(touched('deleted') ? { deleted } : {}),
      ...(touched('archived') ? { archived } : {}),
      ...(touched('createdAtOverride') ? { createdAtOverride } : {}),
    })

    // Cascade: if this session is running in a terminal, also rename the terminal
    let cascadedTerminalId: string | undefined
    if (cleanTitle && deps.terminalMetadata) {
      try {
        const parts = compositeKey.split(':')
        const sessionProvider = (parts.length >= 2 ? parts[0] : provider) as CodingCliProviderName
        const sessionId = parts.length >= 2 ? parts.slice(1).join(':') : rawId
        cascadedTerminalId = await cascadeSessionRenameToTerminal(
          deps.terminalMetadata.list(),
          sessionProvider,
          sessionId,
          cleanTitle,
        )
        if (cascadedTerminalId) {
          deps.registry?.updateTitle(cascadedTerminalId, cleanTitle)
          deps.wsHandler?.broadcastTerminalsChanged?.()
        }
      } catch (err) {
        log.warn({ err, compositeKey }, 'Cascade rename to terminal failed (non-fatal)')
      }
    }

    await codingCliIndexer.refresh()
    res.json({ ...next, cascadedTerminalId })
  })

  router.post('/sessions/:sessionId/generate-title', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)

    const firstMessage = typeof req.body?.firstMessage === 'string' ? req.body.firstMessage : ''
    if (!firstMessage.trim()) {
      return res.status(400).json({ error: 'firstMessage is required' })
    }

    // An authoritative provider-generated title (e.g. Amplifier's own AI-generated
    // name) is already the canonical name. Short-circuit before any 'ai' override
    // write so freshell never shadows it.
    const parsed = deps.codingCliIndexer
      .getProjects()
      .flatMap((p) => p.sessions)
      .find((s) => makeSessionKey(s.provider, s.sessionId) === compositeKey)
    if (parsed?.titleSource === 'provider-generated') {
      return res.json({ title: parsed.title ?? null, source: 'provider-generated' })
    }

    // No Gemini key: finalize from the first user message instead of failing.
    // Uses the same (default) length as the client first-message title so the
    // persisted name matches and there is no visible flip.
    if (!AI_CONFIG.enabled()) {
      const fallback = extractTitleFromMessage(firstMessage)
      if (!fallback) {
        return res.json({ title: null, source: 'none' })
      }
      const result = await configStore.patchSessionOverride(compositeKey, {
        titleOverride: fallback,
        titleSource: 'first-message',
      })
      await codingCliIndexer.refresh()
      return res.json({ title: result.titleOverride, source: result.titleSource })
    }

    try {
      const settings = await configStore.getSettings()
      const title = await generateAiSessionTitle(firstMessage, settings.ai?.titlePrompt)
      if (!title) {
        return res.json({ title: null, source: 'none' })
      }

      const stored = await configStore.patchSessionOverride(compositeKey, {
        titleOverride: title,
        titleSource: 'ai',
      })
      await codingCliIndexer.refresh()
      res.json({ title: stored.titleOverride, source: stored.titleSource })
    } catch (err: any) {
      log.warn({ err }, 'AI title generation failed')
      res.json({ title: null, source: 'none', error: err.message })
    }
  })

  router.delete('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    await configStore.deleteSession(compositeKey)
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  // The indexer scans ONLY settings-enabled providers, so a disabled
  // provider's sessions can never be found. Report those as UNSEARCHED so
  // "not found" never overclaims. Order matches the canonical provider list.
  const KNOWN_RESUME_PROVIDERS = DEFAULT_ENABLED_CLI_PROVIDERS

  router.post('/sessions/resolve', async (req, res) => {
    const parsed = ResumeResolveRequestSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid resolve request', details: parsed.error.issues })
    }
    // Readiness = startupState (getIndexReadiness) OR'd with the indexer's own
    // isReady() signal: startup readiness can stick false forever (its
    // markReady only runs in the start chain's success path), so once the
    // indexer has completed a refresh the endpoint must stop reporting
    // warming. When NEITHER signal is wired, default to ready.
    const readinessSignals: Array<() => boolean> = []
    if (deps.getIndexReadiness) readinessSignals.push(deps.getIndexReadiness)
    const indexerIsReady = deps.codingCliIndexer.isReady
    if (indexerIsReady) readinessSignals.push(() => indexerIsReady.call(deps.codingCliIndexer))
    const result = await resolveResumeInput(parsed.data.input, {
      getProjects: () => deps.codingCliIndexer.getProjects(),
      isIndexReady: () => readinessSignals.length === 0 || readinessSignals.some((fn) => fn()),
      fallbacks: deps.resolveFallbacks,
    })
    const settings = await configStore.getSettings().catch(() => ({}))
    const enabled = new Set<string>(
      settings?.codingCli?.enabledProviders ?? KNOWN_RESUME_PROVIDERS,
    )
    const unsearchedProviders = KNOWN_RESUME_PROVIDERS.filter((name) => !enabled.has(name))
    // A provider whose last index SCAN failed was not searched either — the
    // indexer swallows listing failures into empty lists. A DISABLED provider
    // is unsearched (reported above), never a provider error: otherwise a
    // failed-then-disabled provider would keep responses degraded forever (no
    // successful scan could ever clear it). Fallback errors win the dedupe —
    // they carry the more specific message/code.
    const errorsByProvider = new Map<string, ResumeResolveProviderError>(
      result.providerErrors.map((entry) => [entry.provider, entry]),
    )
    for (const name of deps.codingCliIndexer.getScanFailures?.() ?? []) {
      if (!enabled.has(name) || errorsByProvider.has(name)) continue
      errorsByProvider.set(name, { provider: name, message: 'session scan failed' })
    }
    const providerErrors = [...errorsByProvider.values()]
    // degraded = something FAILED — even when matches exist: a failed provider
    // means a HIGHER-priority exact match may have been missed, so the client
    // must never auto-resume a surviving lower-priority match.
    const status: 'ready' | 'warming' | 'degraded' =
      result.status === 'warming' ? 'warming' : providerErrors.length > 0 ? 'degraded' : 'ready'
    // Fire-and-forget: give the user's Retry a chance to converge once a
    // failed provider recovers (scan failures only clear on a new scan).
    if (status === 'degraded') deps.codingCliIndexer.requestRefresh?.()
    const response: ResumeResolveResponse = {
      status,
      matches: result.matches,
      hint: result.hint,
      providerErrors,
      unsearchedProviders,
      // Lets the client prefill a CONCRETE cwd instead of the '~' sentinel.
      homeDir: deps.homeDir ?? os.homedir(),
    }
    res.json(response)
  })

  const SessionMetadataPostSchema = z.object({
    provider: sessionMetadataProviderSchema,
    sessionId: z.string().min(1),
    sessionType: KnownSessionMetadataTypeSchema,
    sessionTypeSource: SessionTypeMetadataSourceSchema.optional(),
  })

  router.post('/session-metadata', async (req, res) => {
    if (!deps.sessionMetadataStore) {
      return res.status(500).json({ error: 'Session metadata store not configured' })
    }
    const parsed = SessionMetadataPostSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing required fields: provider, sessionId, sessionType', details: parsed.error.issues })
    }
    const { provider, sessionId, sessionType, sessionTypeSource } = parsed.data
    const changed = await deps.sessionMetadataStore.set(provider, sessionId, {
      sessionType,
      ...(sessionTypeSource ? { sessionTypeSource } : {}),
    })
    if (changed) {
      await codingCliIndexer.refresh()
    }
    res.json({ ok: true, changed })
  })

  return router
}
