import WebSocket from 'ws'
import {
  CodexFsChangedNotificationSchema,
  CodexFsUnwatchParamsSchema,
  CodexFsWatchParamsSchema,
  CodexFsWatchResultSchema,
  CodexInitializeParamsSchema,
  CodexInitializeResultSchema,
  CodexLoadedThreadListResultSchema,
  CodexRpcErrorEnvelopeSchema,
  CodexRpcNotificationEnvelopeSchema,
  CodexRpcSuccessEnvelopeSchema,
  CodexThreadLifecycleNotificationSchema,
  CodexThreadStartedNotificationSchema,
  CodexThreadOperationResultSchema,
  CodexThreadPageParamsSchema,
  CodexThreadForkParamsSchema,
  CodexThreadReadParamsSchema,
  CodexThreadReadResultSchema,
  CodexThreadResumeParamsSchema,
  CodexThreadSchema,
  CodexThreadStartParamsSchema,
  CodexThreadTurnReadResultSchema,
  CodexThreadTurnsListResultSchema,
  CodexTurnInterruptParamsSchema,
  CodexTurnInterruptResultSchema,
  CodexTurnStartParamsSchema,
  CodexTurnStartResultSchema,
  CodexTurnCompletedNotificationSchema,
  CodexTurnStartedNotificationSchema,
  type CodexInitializeResult,
  type CodexRequestId,
  type CodexRpcError,
  type CodexThreadHandle,
  type CodexThreadOperationResult,
  type CodexThreadPageParams,
  type CodexThreadReadParams,
  type CodexThreadReadResult,
  type CodexThreadForkParams,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexThreadTurnReadParams,
  type CodexThreadTurnReadResult,
  type CodexThreadTurnsListParams,
  type CodexThreadTurnsListResult,
  type CodexTurnInterruptParams,
  type CodexTurnStartParams,
} from './protocol.js'

type CodexAppServerClientOptions = {
  requestTimeoutMs?: number
}

type CodexAppServerEndpoint = {
  wsUrl: string
}

type PendingRequest = {
  method: string
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timeout: NodeJS.Timeout
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const LOSS_STATUSES = new Set(['notLoaded', 'systemError'])

class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Codex app-server ${method} failed: ${message}`)
    this.name = 'CodexAppServerRpcError'
  }
}

type CodexThreadStartInput =
  Omit<CodexThreadStartParams, 'experimentalRawEvents' | 'persistExtendedHistory'> & {
    richClient?: boolean
  }

type CodexThreadResumeInput = Omit<CodexThreadResumeParams, 'persistExtendedHistory'>

type CodexThreadOperationClientResult = CodexThreadOperationResult & {
  threadId: string
}

export type CodexThreadLifecycleLossEvent =
  | { method: 'thread/closed'; threadId?: string }
  | { method: 'thread/status/changed'; threadId?: string; status: 'notLoaded' | 'systemError' }

export type CodexThreadLifecycleEvent = {
  kind: 'thread_started'
  thread: CodexThreadHandle
} | {
  kind: 'thread_closed'
  threadId: string
} | {
  kind: 'thread_status_changed'
  threadId: string
  status: { type: string } & Record<string, unknown>
}

export type CodexAppServerDisconnectEvent = {
  reason: 'close' | 'error'
  error?: Error
}

export type CodexTurnEvent = {
  threadId: string
  turnId?: string
  params: Record<string, unknown>
}

function normalizeThread(thread: CodexThreadHandle): CodexThreadOperationResult['thread'] {
  return CodexThreadSchema.parse(thread)
}

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number
  private socket: WebSocket | null = null
  private connectPromise: Promise<WebSocket> | null = null
  private initializePromise: Promise<CodexInitializeResult> | null = null
  private nextRequestId = 1
  private pendingRequests = new Map<CodexRequestId, PendingRequest>()
  private readonly threadStartedHandlers = new Set<(thread: CodexThreadHandle) => void>()
  private readonly threadLifecycleHandlers = new Set<(event: CodexThreadLifecycleEvent) => void>()
  private readonly disconnectHandlers = new Set<(event: CodexAppServerDisconnectEvent) => void>()
  private readonly fsChangedHandlers = new Set<(event: { watchId: string; changedPaths: string[] }) => void>()
  private readonly turnStartedHandlers = new Set<(event: CodexTurnEvent) => void>()
  private readonly turnCompletedHandlers = new Set<(event: CodexTurnEvent) => void>()
  private lifecycleLossHandlers = new Set<(event: CodexThreadLifecycleLossEvent) => void>()

  constructor(
    private readonly endpoint: CodexAppServerEndpoint,
    options: CodexAppServerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async initialize(): Promise<CodexInitializeResult> {
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = this.request('initialize', CodexInitializeParamsSchema.parse({
      clientInfo: { name: 'freshell', version: '1.0.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ['thread/started'],
      },
    })).then(async (result) => {
      const parsed = CodexInitializeResultSchema.safeParse(result)
      if (!parsed.success) {
        throw new Error('Codex app-server returned an invalid initialize payload.')
      }
      await this.notify('initialized')
      return parsed.data
    }).catch((error) => {
      this.initializePromise = null
      throw error
    })

    return this.initializePromise
  }

  async startThread(params: CodexThreadStartInput): Promise<CodexThreadOperationClientResult> {
    const { richClient, ...appServerParams } = params
    const result = await this.request('thread/start', CodexThreadStartParamsSchema.parse({
      ...appServerParams,
      experimentalRawEvents: richClient === true,
      persistExtendedHistory: true,
    }))
    const parsed = CodexThreadOperationResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/start payload.')
    }
    const thread = normalizeThread(parsed.data.thread)
    this.emitThreadStartedEvidence(thread)
    return {
      ...parsed.data,
      thread,
      threadId: thread.id,
    }
  }

  async resumeThread(params: CodexThreadResumeInput): Promise<CodexThreadOperationClientResult> {
    // Intentionally preserve Codex's default raw-event behavior for resume calls.
    const result = await this.request('thread/resume', CodexThreadResumeParamsSchema.parse({
      ...params,
      persistExtendedHistory: true,
    }))
    const parsed = CodexThreadOperationResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/resume payload.')
    }
    const thread = normalizeThread(parsed.data.thread)
    this.emitThreadStartedEvidence(thread)
    return {
      ...parsed.data,
      thread,
      threadId: thread.id,
    }
  }

  async watchPath(targetPath: string, watchId: string): Promise<{ path: string }> {
    const result = await this.request('fs/watch', CodexFsWatchParamsSchema.parse({
      path: targetPath,
      watchId,
    }))
    const parsed = CodexFsWatchResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid fs/watch payload.')
    }
    return parsed.data
  }

  async unwatchPath(watchId: string): Promise<void> {
    await this.request('fs/unwatch', CodexFsUnwatchParamsSchema.parse({
      watchId,
    }))
  }

  async listLoadedThreads(): Promise<string[]> {
    const result = await this.request('thread/loaded/list', {})
    const parsed = CodexLoadedThreadListResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/loaded/list payload.')
    }
    return parsed.data.data
  }

  async forkThread(params: CodexThreadForkParams): Promise<{ threadId: string }> {
    const result = await this.request('thread/fork', CodexThreadForkParamsSchema.parse(params))
    const parsed = CodexThreadOperationResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/fork payload.')
    }
    return { threadId: parsed.data.thread.id }
  }

  async readThread(params: CodexThreadReadParams): Promise<CodexThreadReadResult> {
    const result = await this.request('thread/read', CodexThreadReadParamsSchema.parse(params))
    const parsed = CodexThreadReadResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/read payload.')
    }
    return parsed.data
  }

  async listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResult> {
    const parsedParams = CodexThreadPageParamsSchema.parse(params)
    if (this.isThreadReadFallbackCursor(parsedParams.cursor)) {
      return await this.listThreadTurnsViaThreadRead(parsedParams, new Error('thread/read fallback cursor'))
    }
    try {
      return await this.requestThreadTurnsList(parsedParams)
    } catch (error) {
      if (!this.canFallbackToThreadRead(parsedParams, error)) {
        throw error
      }
      return await this.listThreadTurnsViaThreadRead(parsedParams, error)
    }
  }

  async readThreadTurn(params: CodexThreadTurnReadParams): Promise<CodexThreadTurnReadResult> {
    let cursor: string | undefined
    let observedListRevision: number | undefined
    try {
      for (;;) {
        const page = await this.requestThreadTurnsList({
          threadId: params.threadId,
          limit: 50,
          sortDirection: 'desc',
          itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        })
        if (page.revision !== undefined && observedListRevision === undefined) {
          observedListRevision = page.revision
        } else if (page.revision !== undefined && page.revision !== observedListRevision) {
          throw new Error('Codex app-server thread turn list revision changed while paging thread turns.')
        }
        if (params.revision !== undefined && page.revision !== params.revision) {
          throw new Error('Codex app-server thread turn list revision does not match requested revision.')
        }
        const turn = page.turns.find((candidate) => candidate.id === params.turnId)
        if (turn) {
          const revision = params.revision ?? observedListRevision
          const parsedTurn = CodexThreadTurnReadResultSchema.safeParse({
            ...turn,
            turnId: turn.id,
            revision,
          })
          if (!parsedTurn.success) {
            throw new Error('Codex app-server returned an invalid synthesized thread turn body.')
          }
          return parsedTurn.data
        }
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
    } catch (error) {
      if (!this.isThreadTurnsListUnavailableError(error)) throw error
      return await this.readThreadTurnViaThreadRead(params)
    }
    throw new Error(`Codex app-server thread ${params.threadId} does not contain turn ${params.turnId}.`)
  }

  private async requestThreadTurnsList(params: CodexThreadPageParams): Promise<CodexThreadTurnsListResult> {
    const result = await this.request('thread/turns/list', params)
    const parsed = CodexThreadTurnsListResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/turns/list payload.')
    }
    return parsed.data
  }

  private async readThreadTurnViaThreadRead(params: CodexThreadTurnReadParams): Promise<CodexThreadTurnReadResult> {
    const snapshot = await this.readThread({ threadId: params.threadId, includeTurns: true })
    const snapshotRevision = Number.isFinite(snapshot.thread.updatedAt)
      ? Math.max(0, Math.trunc(snapshot.thread.updatedAt))
      : undefined
    if (params.revision !== undefined && snapshotRevision !== params.revision) {
      throw new Error('Codex app-server thread/read revision does not match requested revision.')
    }
    const revision = params.revision ?? snapshotRevision
    const turn = (snapshot.thread.turns ?? []).find((candidate) => candidate.id === params.turnId)
    if (!turn) {
      throw new Error(`Codex app-server thread ${params.threadId} does not contain turn ${params.turnId}.`)
    }
    const parsedTurn = CodexThreadTurnReadResultSchema.safeParse({
      ...turn,
      turnId: turn.id,
      revision,
    })
    if (!parsedTurn.success) {
      throw new Error('Codex app-server returned an invalid synthesized thread turn body from thread/read fallback.')
    }
    return parsedTurn.data
  }

  private async listThreadTurnsViaThreadRead(
    params: CodexThreadPageParams,
    cause: unknown,
  ): Promise<CodexThreadTurnsListResult> {
    const fallbackCursor = this.parseThreadReadFallbackCursor(params.cursor)
    const snapshot = await this.readThread({ threadId: params.threadId, includeTurns: true })
    const rawTurns = snapshot.thread.turns ?? []
    const orderedTurns = params.sortDirection === 'asc'
      ? rawTurns.slice()
      : rawTurns.slice().reverse()
    const revision = Number.isFinite(snapshot.thread.updatedAt)
      ? Math.max(0, Math.trunc(snapshot.thread.updatedAt))
      : 0
    if (fallbackCursor.revision !== undefined && fallbackCursor.revision !== revision) {
      throw new Error('Codex app-server thread/read fallback snapshot changed while paging thread turns.')
    }
    const offset = fallbackCursor.offset
    const limit = params.limit ?? orderedTurns.length
    const turns = orderedTurns.slice(offset, offset + limit).map((turn) => {
      if (params.itemsView === 'notLoaded') {
        return { ...turn, itemsView: 'notLoaded' as const, items: [] }
      }
      if (params.itemsView === 'summary') {
        return {
          ...turn,
          itemsView: 'summary' as const,
          items: turn.items.map((item) => ({
            type: item.type,
            id: item.id,
            summary: this.summarizeThreadItem(item),
          })),
        }
      }
      return { ...turn, itemsView: 'full' as const }
    })
    const nextOffset = offset + turns.length
    const parsed = CodexThreadTurnsListResultSchema.safeParse({
      revision,
      nextCursor: nextOffset < orderedTurns.length ? this.formatThreadReadFallbackCursor(revision, nextOffset) : null,
      backwardsCursor: null,
      turns,
      bodies: Object.fromEntries(turns.map((turn) => [turn.id, turn])),
    })
    if (!parsed.success) {
      throw new Error(`Codex app-server thread/turns/list fallback returned an invalid payload after paging failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return parsed.data
  }

  private parseThreadReadFallbackCursor(cursor: string | undefined): { offset: number; revision?: number } {
    if (!cursor) return { offset: 0 }
    const match = cursor.match(/^thread-read:(\d+):(\d+)$/)
    if (!match) {
      throw new Error(`Codex app-server thread/turns/list is unavailable and thread/read fallback cannot honor opaque cursor "${cursor}".`)
    }
    return { revision: Number(match[1]), offset: Number(match[2]) }
  }

  private formatThreadReadFallbackCursor(revision: number, offset: number): string {
    return `thread-read:${revision}:${offset}`
  }

  private summarizeThreadItem(item: { type: string; summary?: unknown; text?: unknown; command?: unknown }): string {
    if (typeof item.summary === 'string') return item.summary
    if (typeof item.text === 'string') return item.text
    if (typeof item.command === 'string') return item.command
    return item.type
  }

  private canFallbackToThreadRead(params: CodexThreadPageParams, error: unknown): boolean {
    if (!this.isThreadTurnsListUnavailableError(error)) return false
    if (params.cursor && !this.isThreadReadFallbackCursor(params.cursor)) {
      throw new Error(`Codex app-server thread/turns/list is unavailable and thread/read fallback cannot honor opaque cursor "${params.cursor}".`)
    }
    return true
  }

  private isThreadReadFallbackCursor(cursor: string | undefined): boolean {
    return typeof cursor === 'string' && /^thread-read:\d+:\d+$/.test(cursor)
  }

  async startTurn(params: CodexTurnStartParams): Promise<{ turnId: string }> {
    const result = await this.request('turn/start', CodexTurnStartParamsSchema.parse(params))
    const parsed = CodexTurnStartResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid turn/start payload.')
    }
    return { turnId: parsed.data.turn.id }
  }

  async interruptTurn(params: CodexTurnInterruptParams): Promise<void> {
    const result = await this.request('turn/interrupt', CodexTurnInterruptParamsSchema.parse(params))
    const parsed = CodexTurnInterruptResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid turn/interrupt payload.')
    }
  }

  async close(): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.connectPromise = null
    this.initializePromise = null

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex app-server connection closed before ${pending.method} completed.`))
      this.pendingRequests.delete(id)
    }

    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return
    }

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        socket.off('close', onClose)
        socket.off('error', onClose)
      }
      const onClose = () => {
        cleanup()
        resolve()
      }
      socket.once('close', onClose)
      socket.once('error', onClose)
      socket.close()
    })
  }

  onThreadStarted(handler: (thread: CodexThreadHandle) => void): () => void {
    this.threadStartedHandlers.add(handler)
    return () => {
      this.threadStartedHandlers.delete(handler)
    }
  }

  onThreadLifecycle(handler: (event: CodexThreadLifecycleEvent) => void): () => void {
    this.threadLifecycleHandlers.add(handler)
    return () => {
      this.threadLifecycleHandlers.delete(handler)
    }
  }

  onDisconnect(handler: (event: CodexAppServerDisconnectEvent) => void): () => void {
    this.disconnectHandlers.add(handler)
    return () => {
      this.disconnectHandlers.delete(handler)
    }
  }

  onFsChanged(handler: (event: { watchId: string; changedPaths: string[] }) => void): () => void {
    this.fsChangedHandlers.add(handler)
    return () => {
      this.fsChangedHandlers.delete(handler)
    }
  }

  onTurnStarted(handler: (event: CodexTurnEvent) => void): () => void {
    this.turnStartedHandlers.add(handler)
    return () => {
      this.turnStartedHandlers.delete(handler)
    }
  }

  onTurnCompleted(handler: (event: CodexTurnEvent) => void): () => void {
    this.turnCompletedHandlers.add(handler)
    return () => {
      this.turnCompletedHandlers.delete(handler)
    }
  }

  onThreadLifecycleLoss(handler: (event: CodexThreadLifecycleLossEvent) => void): () => void {
    this.lifecycleLossHandlers.add(handler)
    return () => {
      this.lifecycleLossHandlers.delete(handler)
    }
  }

  private async ensureSocket(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket
    }
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint.wsUrl)

      const cleanup = () => {
        socket.off('open', onOpen)
        socket.off('error', onError)
      }

      const onOpen = () => {
        cleanup()
        this.socket = socket
        this.installSocketHandlers(socket)
        resolve(socket)
      }

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      socket.once('open', onOpen)
      socket.once('error', onError)
    }).finally(() => {
      this.connectPromise = null
    })

    return this.connectPromise
  }

  private installSocketHandlers(socket: WebSocket): void {
    socket.on('message', (raw) => this.handleSocketMessage(raw))
    socket.on('close', () => this.handleSocketClose(socket, { reason: 'close' }))
    socket.on('error', (error) => this.handleSocketClose(socket, {
      reason: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    }))
  }

  private handleSocketMessage(raw: WebSocket.RawData): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (!this.hasIdField(parsed)) {
      const notification = CodexRpcNotificationEnvelopeSchema.safeParse(parsed)
      if (notification.success) {
        const lifecycle = CodexThreadLifecycleNotificationSchema.safeParse(notification.data)
        if (lifecycle.success) {
          this.emitThreadLifecycle(lifecycle.data)
          this.handleNotification(notification.data)
          return
        }

        const threadStarted = CodexThreadStartedNotificationSchema.safeParse(notification.data)
        if (threadStarted.success) {
          for (const handler of this.threadStartedHandlers) {
            handler(normalizeThread(threadStarted.data.params.thread))
          }
          return
        }

        const fsChanged = CodexFsChangedNotificationSchema.safeParse(notification.data)
        if (fsChanged.success) {
          for (const handler of this.fsChangedHandlers) {
            handler(fsChanged.data.params)
          }
          return
        }

        const turnStarted = CodexTurnStartedNotificationSchema.safeParse(notification.data)
        if (turnStarted.success) {
          this.emitTurnEvent(this.turnStartedHandlers, turnStarted.data.params)
          return
        }

        const turnCompleted = CodexTurnCompletedNotificationSchema.safeParse(notification.data)
        if (turnCompleted.success) {
          this.emitTurnEvent(this.turnCompletedHandlers, turnCompleted.data.params)
          return
        }

        this.handleNotification(notification.data)
        return
      }
    }

    const success = CodexRpcSuccessEnvelopeSchema.safeParse(parsed)
    if (success.success) {
      const pending = this.pendingRequests.get(success.data.id)
      // Timeouts/connection closes drop the pending entry because JSON-RPC over
      // WebSocket does not offer per-request cancellation. Ignore late replies.
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(success.data.id)
      pending.resolve(success.data.result)
      return
    }

    const failure = CodexRpcErrorEnvelopeSchema.safeParse(parsed)
    if (!failure.success || failure.data.id === undefined) {
      return
    }

    const pending = this.pendingRequests.get(failure.data.id)
    // See the success-path comment above: late replies after timeout/close are ignored.
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pendingRequests.delete(failure.data.id)
    pending.reject(this.formatRpcError(pending.method, failure.data.error))
  }

  private handleNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method === 'thread/closed') {
      this.emitLifecycleLoss({
        method: 'thread/closed',
        threadId: this.extractThreadId(notification.params),
      })
      return
    }

    if (notification.method !== 'thread/status/changed') return
    const status = this.extractThreadStatus(notification.params)
    if (status !== 'notLoaded' && status !== 'systemError') return

    this.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: this.extractThreadId(notification.params),
      status,
    })
  }

  private emitLifecycleLoss(event: CodexThreadLifecycleLossEvent): void {
    for (const handler of this.lifecycleLossHandlers) {
      handler(event)
    }
  }

  private emitTurnEvent(handlers: Set<(event: CodexTurnEvent) => void>, params: { threadId: string; turnId?: string } & Record<string, unknown>): void {
    const event: CodexTurnEvent = {
      threadId: params.threadId,
      ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      params,
    }
    for (const handler of handlers) {
      handler(event)
    }
  }

  private extractThreadId(params: unknown): string | undefined {
    if (!params || typeof params !== 'object') return undefined
    const object = params as Record<string, unknown>
    if (typeof object.threadId === 'string') return object.threadId
    const thread = object.thread
    if (thread && typeof thread === 'object' && typeof (thread as Record<string, unknown>).id === 'string') {
      return (thread as Record<string, string>).id
    }
    return undefined
  }

  private extractThreadStatus(params: unknown): 'notLoaded' | 'systemError' | undefined {
    if (!params || typeof params !== 'object') return undefined
    const object = params as Record<string, unknown>
    const status = this.extractLossStatus(object.status)
    if (status) return status
    const thread = object.thread
    if (thread && typeof thread === 'object') {
      return this.extractLossStatus((thread as Record<string, unknown>).status)
    }
    return undefined
  }

  private extractLossStatus(status: unknown): 'notLoaded' | 'systemError' | undefined {
    if (typeof status === 'string' && LOSS_STATUSES.has(status)) {
      return status as 'notLoaded' | 'systemError'
    }
    if (status && typeof status === 'object') {
      const statusType = (status as Record<string, unknown>).type
      if (typeof statusType === 'string' && LOSS_STATUSES.has(statusType)) {
        return statusType as 'notLoaded' | 'systemError'
      }
    }
    return undefined
  }

  private handleSocketClose(socket: WebSocket, event: CodexAppServerDisconnectEvent): void {
    if (this.socket !== socket) {
      return
    }
    this.socket = null
    this.connectPromise = null
    this.initializePromise = null

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex app-server connection closed before ${pending.method} completed.`))
      this.pendingRequests.delete(id)
    }

    for (const handler of this.disconnectHandlers) {
      handler(event)
    }
  }

  private emitThreadLifecycle(notification: import('./protocol.js').CodexThreadLifecycleNotification): void {
    if (notification.method === 'thread/started') {
      const thread = normalizeThread(notification.params.thread)
      this.emitThreadStartedEvidence(thread)
      return
    }

    if (notification.method === 'thread/closed') {
      const event: CodexThreadLifecycleEvent = {
        kind: 'thread_closed',
        threadId: notification.params.threadId,
      }
      for (const handler of this.threadLifecycleHandlers) {
        handler(event)
      }
      return
    }

    const event: CodexThreadLifecycleEvent = {
      kind: 'thread_status_changed',
      threadId: notification.params.threadId,
      status: notification.params.status,
    }
    for (const handler of this.threadLifecycleHandlers) {
      handler(event)
    }
  }

  private emitThreadStartedEvidence(thread: CodexThreadOperationResult['thread']): void {
    const event: CodexThreadLifecycleEvent = {
      kind: 'thread_started',
      thread,
    }
    for (const handler of this.threadLifecycleHandlers) {
      handler(event)
    }
    for (const handler of this.threadStartedHandlers) {
      handler(thread)
    }
  }

  private async request<TParams extends object>(method: string, params: TParams): Promise<unknown> {
    if (method !== 'initialize') {
      await (this.initializePromise ?? this.initialize())
    }
    const socket = await this.ensureSocket()
    const id = this.nextRequestId++

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Codex app-server did not respond to ${method} within ${this.requestTimeoutMs}ms.`))
      }, this.requestTimeoutMs)

      this.pendingRequests.set(id, {
        method,
        resolve,
        reject,
        timeout,
      })

      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        reject(error)
      })
    })
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const socket = await this.ensureSocket()
    const payload = params === undefined ? { method } : { method, params }
    socket.send(JSON.stringify(payload))
  }

  private isThreadTurnsListUnavailableError(error: unknown): boolean {
    if (error instanceof CodexAppServerRpcError) {
      return error.method === 'thread/turns/list' && error.code === -32601
    }
    const message = error instanceof Error ? error.message : String(error)
    return /\b(method not found|unknown method|not implemented|unsupported method)\b/i.test(message)
  }

  private formatRpcError(method: string, error: CodexRpcError): Error {
    return new CodexAppServerRpcError(method, error.code, error.message, error.data)
  }

  private hasIdField(value: unknown): boolean {
    return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'id')
  }
}
