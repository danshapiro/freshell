import WebSocket from 'ws'
import {
  CodexInitializeParamsSchema,
  CodexInitializeResultSchema,
  CodexLoadedThreadListResultSchema,
  CodexRpcErrorEnvelopeSchema,
  CodexRpcNotificationEnvelopeSchema,
  CodexRpcSuccessEnvelopeSchema,
  CodexThreadOperationResultSchema,
  type CodexInitializeResult,
  type CodexRpcError,
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

export type CodexThreadLifecycleLossEvent =
  | { method: 'thread/closed'; threadId?: string }
  | { method: 'thread/status/changed'; threadId?: string; status: 'notLoaded' | 'systemError' }

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const LOSS_STATUSES = new Set(['notLoaded', 'systemError'])

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number
  private socket: WebSocket | null = null
  private connectPromise: Promise<WebSocket> | null = null
  private initializePromise: Promise<CodexInitializeResult> | null = null
  private nextRequestId = 1
  private pendingRequests = new Map<number, PendingRequest>()
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

  async startThread(params: Omit<CodexThreadStartParams, 'experimentalRawEvents' | 'persistExtendedHistory'>): Promise<{ threadId: string }> {
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
    return { threadId: parsed.data.thread.id }
  }

  async resumeThread(params: Omit<CodexThreadResumeParams, 'persistExtendedHistory'>): Promise<{ threadId: string }> {
    // Intentionally preserve Codex's default raw-event behavior for resume calls.
    const result = await this.request('thread/resume', {
      ...params,
      persistExtendedHistory: true,
    })
    const parsed = CodexThreadOperationResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/resume payload.')
    }
    return { threadId: parsed.data.thread.id }
  }

  async listLoadedThreads(): Promise<string[]> {
    const result = await this.request('thread/loaded/list', {})
    const parsed = CodexLoadedThreadListResultSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Codex app-server returned an invalid thread/loaded/list payload.')
    }
    return parsed.data.data
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
    socket.on('close', () => this.handleSocketClose())
    socket.on('error', () => this.handleSocketClose())
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
    pending.reject(new Error(this.formatRpcError(pending.method, failure.data.error)))
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

  private handleSocketClose(): void {
    this.socket = null
    this.connectPromise = null
    this.initializePromise = null

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(`Codex app-server connection closed before ${pending.method} completed.`))
      this.pendingRequests.delete(id)
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

  private async notify<TParams extends object>(method: string, params?: TParams): Promise<void> {
    const socket = await this.ensureSocket()
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      }), (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
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
