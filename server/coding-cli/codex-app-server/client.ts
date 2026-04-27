import WebSocket from 'ws'
import {
  CodexFsChangedNotificationSchema,
  CodexFsUnwatchParamsSchema,
  CodexFsWatchParamsSchema,
  CodexFsWatchResultSchema,
  CodexInitializeParamsSchema,
  CodexInitializeResultSchema,
  CodexRpcErrorEnvelopeSchema,
  CodexRpcNotificationEnvelopeSchema,
  CodexRpcSuccessEnvelopeSchema,
  CodexThreadLifecycleNotificationSchema,
  CodexThreadStartedNotificationSchema,
  CodexThreadOperationResultSchema,
  type CodexInitializeResult,
  type CodexRpcError,
  type CodexThreadHandle,
  type CodexThreadOperationResult,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
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

function normalizeThread(thread: CodexThreadHandle): CodexThreadHandle {
  return {
    ...thread,
    path: thread.path ?? null,
    ephemeral: thread.ephemeral ?? false,
  }
}

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number
  private socket: WebSocket | null = null
  private connectPromise: Promise<WebSocket> | null = null
  private initializePromise: Promise<CodexInitializeResult> | null = null
  private nextRequestId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private readonly threadStartedHandlers = new Set<(thread: CodexThreadHandle) => void>()
  private readonly threadLifecycleHandlers = new Set<(event: CodexThreadLifecycleEvent) => void>()
  private readonly disconnectHandlers = new Set<(event: CodexAppServerDisconnectEvent) => void>()
  private readonly fsChangedHandlers = new Set<(event: { watchId: string; changedPaths: string[] }) => void>()

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
      },
    })).then((result) => {
      const parsed = CodexInitializeResultSchema.safeParse(result)
      if (!parsed.success) {
        throw new Error('Codex app-server returned an invalid initialize payload.')
      }
      return parsed.data
    }).catch((error) => {
      this.initializePromise = null
      throw error
    })

    return this.initializePromise
  }

  async startThread(
    params: Omit<CodexThreadStartParams, 'experimentalRawEvents' | 'persistExtendedHistory'>,
  ): Promise<CodexThreadOperationResult> {
    const result = await this.request('thread/start', {
      ...params,
      // Freshell attaches the visible TUI over `codex --remote`, so it does not
      // need the app-server's raw event stream for fresh threads.
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    })
    const parsed = CodexThreadOperationResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/start payload.')
    }
    return {
      thread: normalizeThread(parsed.data.thread),
    }
  }

  async resumeThread(
    params: Omit<CodexThreadResumeParams, 'persistExtendedHistory'>,
  ): Promise<CodexThreadOperationResult> {
    // Intentionally preserve Codex's default raw-event behavior for resume calls.
    const result = await this.request('thread/resume', {
      ...params,
      persistExtendedHistory: true,
    })
    const parsed = CodexThreadOperationResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/resume payload.')
    }
    return {
      thread: normalizeThread(parsed.data.thread),
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
        }
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
    pending.reject(new Error(this.formatRpcError(pending.method, failure.data.error)))
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

      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pendingRequests.delete(id)
        reject(error)
      })
    })
  }

  private formatRpcError(method: string, error: CodexRpcError): string {
    return `Codex app-server ${method} failed: ${error.message}`
  }

  private hasIdField(value: unknown): boolean {
    return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'id')
  }
}
