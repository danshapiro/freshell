import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import { makeSessionKey, parseSessionKey, sessionKeyRequiresCwdScope, type CodingCliProviderName } from './coding-cli/types.js'
import type { CodingCliProvider } from './coding-cli/provider.js'
import { CodingCliProviderSchema } from '../shared/ws-protocol.js'
import { logger } from './logger.js'
import { setResponsePerfContext } from './request-logger.js'
import { cascadeSessionRenameToTerminal } from './rename-cascade.js'
import { AI_CONFIG, PROMPTS } from './ai-prompts.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import type { SessionMetadataStore } from './session-metadata-store.js'
import { DEFAULT_CLI_PROVIDER_NAMES } from './platform.js'
import { SessionDirectoryQuerySchema } from '../shared/read-models.js'
import { querySessionDirectory } from './session-directory/service.js'
import { createRequestAbortSignal } from './read-models/request-abort.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from './read-models/work-scheduler.js'

const log = logger.child({ component: 'sessions-router' })

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

  function resolveCompositeSessionKey(
    rawId: string,
    providerQuery: CodingCliProviderName | undefined,
    cwdQuery: string | undefined,
  ): { compositeKey?: string; error?: string } {
    const parsedRaw = parseSessionKey(rawId)
    const rawProviderIsKnown = validCliProviders.has(parsedRaw.provider)
    const rawLooksScopedComposite = rawProviderIsKnown
      && sessionKeyRequiresCwdScope(parsedRaw.provider)
      && rawId.startsWith(`${parsedRaw.provider}:cwd=`)
      && rawId.includes(':sid=')
    const rawLooksLegacyComposite = rawProviderIsKnown
      && !sessionKeyRequiresCwdScope(parsedRaw.provider)
      && rawId.startsWith(`${parsedRaw.provider}:`)

    if (rawLooksScopedComposite || rawLooksLegacyComposite) {
      if (providerQuery && providerQuery !== parsedRaw.provider) {
        return { error: `Session key provider '${parsedRaw.provider}' does not match requested provider '${providerQuery}'` }
      }
      if (sessionKeyRequiresCwdScope(parsedRaw.provider) && !parsedRaw.cwd) {
        return { error: `Opaque cwd-scoped session key required for provider '${parsedRaw.provider}'` }
      }
      return { compositeKey: rawId }
    }

    const provider = providerQuery ?? 'claude'
    if (sessionKeyRequiresCwdScope(provider) && !cwdQuery) {
      return { error: `Opaque cwd-scoped session key required for provider '${provider}'` }
    }
    return { compositeKey: makeSessionKey(provider, rawId, cwdQuery) }
  }

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
    })

    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    const signal = createRequestAbortSignal(req, res)

    try {
      const page = await readModelScheduler.schedule({
        lane: parsed.data.priority,
        signal,
        run: (scheduledSignal) => querySessionDirectory({
          projects: codingCliIndexer.getProjects(),
          query: parsed.data,
          terminalMeta: deps.terminalMetadata?.list() ?? [],
          providers: codingCliProviders,
          signal: scheduledSignal,
        }),
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
      const status = /cursor/i.test(message) ? 400 : 500
      if (status === 500) {
        log.error({ err: error }, 'Session directory query failed')
      }
      res.status(status).json({ error: message })
    }
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = typeof req.query.provider === 'string' ? req.query.provider as CodingCliProviderName : undefined
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined
    const { compositeKey, error } = resolveCompositeSessionKey(rawId, provider, cwd)
    if (!compositeKey) {
      return res.status(400).json({ error })
    }
    const parsed = SessionPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
    const patch: Record<string, unknown> = {}
    if (titleOverride !== undefined) {
      patch.titleOverride = cleanString(titleOverride)
      if (cleanString(titleOverride)) patch.titleSource = 'user' as const
    }
    if (summaryOverride !== undefined) patch.summaryOverride = cleanString(summaryOverride)
    if (deleted !== undefined) patch.deleted = deleted
    if (archived !== undefined) patch.archived = archived
    if (createdAtOverride !== undefined) patch.createdAtOverride = createdAtOverride
    const next = await configStore.patchSessionOverride(compositeKey, patch)

    // Cascade: if this session is running in a terminal, also rename the terminal
    const cleanTitle = cleanString(titleOverride)
    let cascadedTerminalId: string | undefined
    if (cleanTitle && deps.terminalMetadata) {
      try {
        const parsedKey = parseSessionKey(compositeKey)
        cascadedTerminalId = await cascadeSessionRenameToTerminal(
          deps.terminalMetadata.list(),
          parsedKey.provider,
          parsedKey.sessionId,
          cleanTitle,
          parsedKey.cwd,
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
    const provider = typeof req.query.provider === 'string' ? req.query.provider as CodingCliProviderName : undefined
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined
    const { compositeKey, error } = resolveCompositeSessionKey(rawId, provider, cwd)
    if (!compositeKey) {
      return res.status(400).json({ error })
    }

    const firstMessage = typeof req.body?.firstMessage === 'string' ? req.body.firstMessage : ''
    if (!firstMessage.trim()) {
      return res.status(400).json({ error: 'firstMessage is required' })
    }

    if (!AI_CONFIG.enabled()) {
      return res.status(503).json({ error: 'AI not configured', source: 'none' })
    }

    try {
      const settings = await configStore.getSettings()
      const { generateText } = await import('ai')
      const { google } = await import('@ai-sdk/google')
      const promptConfig = PROMPTS.sessionTitle
      const model = google(promptConfig.model)
      const prompt = promptConfig.build(firstMessage, settings.ai?.titlePrompt)

      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: promptConfig.maxOutputTokens,
      })

      const title = (result.text || '').trim().slice(0, 80)
      if (!title) {
        return res.json({ title: null, source: 'none' })
      }

      await configStore.patchSessionOverride(compositeKey, {
        titleOverride: title,
        titleSource: 'ai',
      })
      await codingCliIndexer.refresh()
      res.json({ title, source: 'ai' })
    } catch (err: any) {
      log.warn({ err }, 'AI title generation failed')
      res.json({ title: null, source: 'none', error: err.message })
    }
  })

  router.delete('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = typeof req.query.provider === 'string' ? req.query.provider as CodingCliProviderName : undefined
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined
    const { compositeKey, error } = resolveCompositeSessionKey(rawId, provider, cwd)
    if (!compositeKey) {
      return res.status(400).json({ error })
    }
    await configStore.deleteSession(compositeKey)
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  const SessionMetadataPostSchema = z.object({
    provider: sessionMetadataProviderSchema,
    sessionId: z.string().min(1),
    sessionType: z.string().min(1),
  })

  router.post('/session-metadata', async (req, res) => {
    if (!deps.sessionMetadataStore) {
      return res.status(500).json({ error: 'Session metadata store not configured' })
    }
    const parsed = SessionMetadataPostSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing required fields: provider, sessionId, sessionType', details: parsed.error.issues })
    }
    const { provider, sessionId, sessionType } = parsed.data
    await deps.sessionMetadataStore.set(provider, sessionId, { sessionType })
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}
