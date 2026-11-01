/**
 * Unified agent names (Task 5) — HTTP calls against the server's canonical
 * session-names routes: the batch bootstrap read (chunked at 100 refs) and
 * the captured-target rename. HTTP failures retain the server's error code
 * and the accepted record for the error UI.
 */
import { api, ApiError, with429Retry } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import {
  NamedProviderSchema,
  SessionNameRecordSchema,
  SessionNameUpdateSchema,
  sessionNameRefKey,
  type NameIntent,
  type RenameSessionNameRequest,
  type SessionNameRef,
  type SessionNameRecord,
  type SessionNameUpdate,
} from '@shared/session-names'

const log = createLogger('SessionNames')

/** Client batch reads are chunked to this many refs per request. */
export const SESSION_NAMES_READ_CHUNK = 100

export class SessionNameRenameError extends Error {
  /** The HTTP status, when the failure was an HTTP response. */
  status?: number
  /** The server's machine-readable error code (`error` field of the body). */
  serverCode?: string
  /** The accepted canonical record the server carried on a conflict — the
   * error UI folds this so the winner is visible everywhere. */
  acceptedRecord?: SessionNameRecord
}

/** The accepted record from either conflict-payload shape: the scoped
 * rename routes answer the CURRENT record as a bare `sessionName` (the
 * honest conflict semantics — an envelope would have to fabricate
 * documentGeneration/redirects the conflict path does not maintain), so
 * a conflict extractor must accept the bare record AND the full update
 * envelope (the success-path shape) for cross-version tolerance. */
export function parseSessionNameRecordOrUpdate(value: unknown): SessionNameRecord | undefined {
  const update = SessionNameUpdateSchema.safeParse(value)
  if (update.success) return update.data.record
  const record = SessionNameRecordSchema.safeParse(value)
  return record.success ? record.data : undefined
}

/** POST /api/session-names/read — batch bootstrap. Unknown refs are omitted
 * by the server; a chunked read still returns every resolvable update. */
export async function bootstrapSessionNames(
  refs: SessionNameRef[],
  options: { signal?: AbortSignal } = {},
): Promise<SessionNameUpdate[]> {
  const updates: SessionNameUpdate[] = []
  for (let index = 0; index < refs.length; index += SESSION_NAMES_READ_CHUNK) {
    const chunk = refs.slice(index, index + SESSION_NAMES_READ_CHUNK)
    const body = await with429Retry(
      () => api.post<{ names?: unknown }>('/api/session-names/read', { refs: chunk }, options),
      options,
    )
    for (const raw of Array.isArray(body?.names) ? body.names : []) {
      const parsed = SessionNameUpdateSchema.safeParse(raw)
      if (!parsed.success) {
        log.error('session name read returned an invalid update', { issues: parsed.error.issues })
        continue
      }
      updates.push(parsed.data)
    }
  }
  return updates
}

/** PATCH /api/session-names — the canonical rename. The caller captures
 * target + revision before opening the editor and passes them here. */
export async function renameSessionName(
  input: RenameSessionNameRequest,
  options: { signal?: AbortSignal } = {},
): Promise<SessionNameUpdate> {
  try {
    const body = await api.patch<unknown>('/api/session-names', input, options)
    const parsed = SessionNameUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw new SessionNameRenameError('the server returned an invalid session name update')
    }
    return parsed.data
  } catch (error) {
    // Aborts keep their native shape so callers' abort checks work.
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw toRenameError(error)
  }
}

/** Normalize any rename failure into the typed error carrying the server's
 * code and accepted record. */
export function toRenameError(error: unknown): SessionNameRenameError {
  if (error instanceof SessionNameRenameError) return error
  const renameError = new SessionNameRenameError(
    error instanceof Error ? error.message : 'Failed to rename session',
  )
  if (error instanceof ApiError) {
    renameError.status = error.status
    // The real ApiError carries the parsed response body in `details` (the
    // legacy unit mock's `data` twin masked this for the conflict lane —
    // a production 409 never populated serverCode/acceptedRecord), and
    // the scoped routes answer the accepted CURRENT record as a bare
    // `sessionName`.
    const body = (error as ApiError & { details?: unknown }).details
    if (body && typeof body === 'object') {
      const parsedBody = body as { error?: unknown; sessionName?: unknown }
      if (typeof parsedBody.error === 'string') renameError.serverCode = parsedBody.error
      renameError.acceptedRecord = parseSessionNameRecordOrUpdate(parsedBody.sessionName)
    }
  }
  return renameError
}

/** Collect every naming ref this client currently knows about — open panes,
 * directory rows, and background terminals — for the ready/reconnect batch
 * bootstrap (independent of the mounted composer/history page). */
export function collectSessionNameRefs(state: {
  panes?: { layouts?: Record<string, import('@/store/paneTypes').PaneNode> }
  sessions?: { windows?: Record<string, { projects?: Array<{ sessions?: Array<{ nameRef?: unknown }> }> }> }
  terminalDirectory?: { windows?: Record<string, { items?: Array<{ nameRef?: unknown }> }> }
}): SessionNameRef[] {
  const keys = new Set<string>()
  const refs: SessionNameRef[] = []

  const push = (ref: unknown) => {
    const parsed = parseSessionNameRef(ref)
    if (!parsed) return
    const key = sessionNameRefKey(parsed)
    if (keys.has(key)) return
    keys.add(key)
    refs.push(parsed)
  }

  for (const layout of Object.values(state.panes?.layouts ?? {})) {
    if (!layout) continue
    collectPaneRefs(layout, push)
  }
  for (const window of Object.values(state.sessions?.windows ?? {})) {
    for (const project of window?.projects ?? []) {
      for (const session of project?.sessions ?? []) {
        push(session?.nameRef)
      }
    }
  }
  for (const window of Object.values(state.terminalDirectory?.windows ?? {})) {
    for (const item of window?.items ?? []) {
      push(item?.nameRef)
    }
  }
  return refs
}

/** A fresh page's ready-time bootstrap races its own state hydration: the
 * layout restore, the sessions fetch, and the terminal inventory land AFTER
 * ready, so refs they carry were not collectible when the batch read ran.
 * This filter selects the refs that STILL lack a cached record once they
 * become collectible — following the cache's pending→durable redirects —
 * and marks each attempted ref in `attempted` so a ref the bootstrap has
 * already read (or the server has no record for) never re-reads. */
export function uncachedSessionNameRefs(
  state: Parameters<typeof collectSessionNameRefs>[0] & {
    sessionNames?: {
      records?: Record<string, { name?: unknown }>
      redirects?: Record<string, { toKey?: unknown }>
    }
  },
  attempted: Set<string>,
): SessionNameRef[] {
  const records = state.sessionNames?.records ?? {}
  const redirects = state.sessionNames?.redirects ?? {}
  const resolvesToCachedRecord = (ref: SessionNameRef): boolean => {
    let key = sessionNameRefKey(ref)
    for (let hops = 0; hops < 8; hops += 1) {
      if (records[key]) return true
      const redirect = redirects[key]
      const toKey = typeof redirect?.toKey === 'string' ? redirect.toKey : null
      if (!toKey || toKey === key) return false
      key = toKey
    }
    return false
  }
  const out: SessionNameRef[] = []
  for (const ref of collectSessionNameRefs(state)) {
    const key = sessionNameRefKey(ref)
    if (attempted.has(key)) continue
    attempted.add(key)
    if (resolvesToCachedRecord(ref)) continue
    out.push(ref)
  }
  return out
}

function collectPaneRefs(
  node: import('@/store/paneTypes').PaneNode,
  push: (ref: unknown) => void,
): void {
  if (node.type === 'leaf') {
    const content = node.content as Record<string, unknown>
    if (content.kind === 'terminal' || content.kind === 'fresh-agent') {
      push(content.nameRef)
      if (typeof content.namingHandle === 'string' && content.namingHandle.length > 0) {
        push({ kind: 'pending', id: content.namingHandle })
      }
      const sessionRef = content.sessionRef as { provider?: unknown; sessionId?: unknown } | undefined
      if (
        typeof sessionRef?.provider === 'string'
        && typeof sessionRef?.sessionId === 'string'
        && sessionRef.sessionId.length > 0
      ) {
        push({ kind: 'session', provider: sessionRef.provider, sessionId: sessionRef.sessionId })
      }
    }
    return
  }
  collectPaneRefs(node.children[0], push)
  collectPaneRefs(node.children[1], push)
}

/** Parse an unknown naming-ref-shaped value; undefined for anything else.
 * The session variant's provider is validated against the scoped-provider
 * whitelist (`NamedProviderSchema`: claude/codex/opencode/antigravity) — never an
 * unsound cast. This is the collector's single ingestion point, so an
 * out-of-scope coding CLI's pane (gemini/kimi/amplifier — `SessionLocator`
 * providers are arbitrary strings) can never produce a ref the server's
 * strict wholesale-400 scope gate would reject the whole batched read for. */
export function parseSessionNameRef(value: unknown): SessionNameRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ref = value as { kind?: unknown; id?: unknown; provider?: unknown; sessionId?: unknown }
  if (ref.kind === 'pending' && typeof ref.id === 'string' && ref.id.length > 0) {
    return { kind: 'pending', id: ref.id }
  }
  if (
    ref.kind === 'session'
    && typeof ref.sessionId === 'string'
    && ref.sessionId.length > 0
  ) {
    const provider = NamedProviderSchema.safeParse(ref.provider)
    if (!provider.success) return undefined
    return { kind: 'session', provider: provider.data, sessionId: ref.sessionId }
  }
  return undefined
}

/** Parse a name-intent CLI/MCP argument: only `user` and `automatic` are
 * accepted; anything else is a loud error (never a silent default). The
 * error names the argument the caller actually received — pass
 * `'--name-intent'` (the default) for the CLI flag or `'nameIntent'` for
 * the MCP parameter, so the message never points an MCP caller at a CLI
 * flag they cannot type. */
export function parseNameIntent(value: unknown, argument = '--name-intent'): NameIntent {
  if (value === 'user' || value === 'automatic') return value
  throw new Error(`${argument} must be "user" or "automatic"`)
}

/** Schema-parse a canonical update riding on any response body
 * (`sessionName`) or error body. Returns undefined for absent/invalid — a
 * malformed projection never enters the cache. */
export function parseSessionNameUpdate(value: unknown): SessionNameUpdate | undefined {
  const parsed = SessionNameUpdateSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
