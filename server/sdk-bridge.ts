import { nanoid } from 'nanoid'
import { EventEmitter } from 'events'
import { query, type SDKMessage, type Query as SdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { logger } from './logger.js'
import type {
  SdkSessionState,
  ContentBlock,
  SdkServerMessage,
} from './sdk-bridge-types.js'

const log = logger.child({ component: 'sdk-bridge' })

interface SessionProcess {
  query: SdkQuery
  abortController: AbortController
  browserListeners: Set<(msg: SdkServerMessage) => void>
  /** Buffer messages until the first subscriber attaches (prevents race condition) */
  messageBuffer: SdkServerMessage[]
  hasSubscribers: boolean
}

export class SdkBridge extends EventEmitter {
  private sessions = new Map<string, SdkSessionState>()
  private processes = new Map<string, SessionProcess>()

  async createSession(options: {
    cwd?: string
    resumeSessionId?: string
    model?: string
    permissionMode?: string
  }): Promise<SdkSessionState> {
    const sessionId = nanoid()
    const state: SdkSessionState = {
      sessionId,
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      status: 'starting',
      createdAt: Date.now(),
      messages: [],
      pendingPermissions: new Map(),
      costUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }
    this.sessions.set(sessionId, state)

    const abortController = new AbortController()

    const sdkQuery = query({
      prompt: this.createInputStream(sessionId),
      options: {
        cwd: options.cwd || undefined,
        resume: options.resumeSessionId,
        model: options.model,
        permissionMode: options.permissionMode as any,
        includePartialMessages: true,
        abortController,
        canUseTool: async (toolName, input, ctx) => {
          return this.handlePermissionRequest(sessionId, toolName, input as Record<string, unknown>, ctx)
        },
        settingSources: ['user', 'project', 'local'],
      },
    })

    this.processes.set(sessionId, {
      query: sdkQuery,
      abortController,
      browserListeners: new Set(),
      messageBuffer: [],
      hasSubscribers: false,
    })

    // Start consuming the message stream in the background
    this.consumeStream(sessionId, sdkQuery).catch((err) => {
      log.error({ sessionId, err }, 'SDK stream error')
    })

    return state
  }

  // Creates an async iterable that yields user messages written via sendUserMessage
  private createInputStream(sessionId: string): AsyncIterable<any> {
    const queue: any[] = []
    let waiting: ((value: IteratorResult<any>) => void) | null = null
    let done = false

    const inputStream = {
      push: (msg: any) => {
        if (waiting) {
          const resolve = waiting
          waiting = null
          resolve({ value: msg, done: false })
        } else {
          queue.push(msg)
        }
      },
      end: () => {
        done = true
        if (waiting) {
          const resolve = waiting
          waiting = null
          resolve({ value: undefined, done: true })
        }
      },
    }

    // Store on the instance for sendUserMessage to find
    ;(this as any)[`_input_${sessionId}`] = inputStream

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<any>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false })
            }
            if (done) {
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolve) => { waiting = resolve })
          },
        }
      },
    }
  }

  private async consumeStream(sessionId: string, sdkQuery: SdkQuery): Promise<void> {
    try {
      for await (const msg of sdkQuery) {
        this.handleSdkMessage(sessionId, msg)
      }
    } catch (err: any) {
      log.error({ sessionId, err: err?.message }, 'SDK stream ended with error')
      this.broadcastToSession(sessionId, {
        type: 'sdk.error',
        sessionId,
        message: `SDK error: ${err?.message || 'Unknown error'}`,
      })
    } finally {
      const state = this.sessions.get(sessionId)
      const sp = this.processes.get(sessionId)
      const wasAborted = sp?.abortController.signal.aborted ?? false

      if (wasAborted) {
        // Session was explicitly killed -- mark as exited and clean up fully
        if (state && state.status !== 'exited') state.status = 'exited'
        this.broadcastToSession(sessionId, {
          type: 'sdk.exit',
          sessionId,
          exitCode: undefined,
        })
        // Clean up input stream
        const inputStream = (this as any)[`_input_${sessionId}`]
        if (inputStream) {
          inputStream.end()
          delete (this as any)[`_input_${sessionId}`]
        }
        this.processes.delete(sessionId)
        this.sessions.delete(sessionId)
      } else {
        // Stream ended naturally (query turn completed) -- session stays alive
        // for multi-turn conversations. Status set by message handlers is preserved.
        log.debug({ sessionId }, 'SDK query stream ended naturally')
      }
    }
  }

  private handleSdkMessage(sessionId: string, msg: SDKMessage): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const init = msg as any
          state.cliSessionId = init.session_id
          state.model = init.model || state.model
          state.tools = (init.tools as string[] | undefined)?.map((t: string) => ({ name: t }))
          state.cwd = init.cwd || state.cwd
          state.status = 'connected'
          this.broadcastToSession(sessionId, {
            type: 'sdk.session.init',
            sessionId,
            cliSessionId: state.cliSessionId,
            model: state.model,
            cwd: state.cwd,
            tools: state.tools,
          })
        } else if (msg.subtype === 'status') {
          const status = (msg as any).status
          if (status === 'compacting') {
            state.status = 'compacting'
            this.broadcastToSession(sessionId, {
              type: 'sdk.status',
              sessionId,
              status: 'compacting',
            })
          }
        }
        break
      }

      case 'assistant': {
        const aMsg = msg as any
        const content = aMsg.message?.content || []
        const blocks: ContentBlock[] = content.map((b: any) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text }
          if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.thinking }
          if (b.type === 'tool_use') return { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input }
          if (b.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }
          return b
        })
        state.messages.push({
          role: 'assistant',
          content: blocks,
          timestamp: new Date().toISOString(),
        })
        state.status = 'running'
        this.broadcastToSession(sessionId, {
          type: 'sdk.assistant',
          sessionId,
          content: blocks,
          model: aMsg.message?.model,
        })
        break
      }

      case 'result': {
        const rMsg = msg as any
        if (rMsg.total_cost_usd != null) state.costUsd += rMsg.total_cost_usd
        if (rMsg.usage) {
          state.totalInputTokens += rMsg.usage.input_tokens ?? 0
          state.totalOutputTokens += rMsg.usage.output_tokens ?? 0
        }
        state.status = 'idle'
        this.broadcastToSession(sessionId, {
          type: 'sdk.result',
          sessionId,
          result: rMsg.subtype,
          durationMs: rMsg.duration_ms,
          costUsd: rMsg.total_cost_usd,
          usage: rMsg.usage,
        })
        break
      }

      case 'stream_event': {
        const sMsg = msg as any
        this.broadcastToSession(sessionId, {
          type: 'sdk.stream',
          sessionId,
          event: sMsg.event,
          parentToolUseId: sMsg.parent_tool_use_id,
        })
        break
      }

      default:
        log.debug({ sessionId, type: msg.type }, 'Unhandled SDK message type')
    }
  }

  private async handlePermissionRequest(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      decisionReason?: string
      toolUseID: string
      agentID?: string
    },
  ): Promise<PermissionResult> {
    const state = this.sessions.get(sessionId)
    if (!state) return { behavior: 'deny', message: 'Session not found' }

    const requestId = nanoid()

    return new Promise((resolve) => {
      state.pendingPermissions.set(requestId, {
        toolName,
        input,
        toolUseID: options.toolUseID,
        suggestions: options.suggestions,
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
        resolve,
      })

      this.broadcastToSession(sessionId, {
        type: 'sdk.permission.request',
        sessionId,
        requestId,
        subtype: 'can_use_tool',
        tool: { name: toolName, input },
        toolUseID: options.toolUseID,
        suggestions: options.suggestions,
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
      })
    })
  }

  getSession(sessionId: string): SdkSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(): SdkSessionState[] {
    return Array.from(this.sessions.values())
  }

  killSession(sessionId: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) {
      // Also check if the session exists without a process (stream ended naturally)
      const state = this.sessions.get(sessionId)
      if (!state) return false
      state.status = 'exited'
      return true
    }

    const state = this.sessions.get(sessionId)
    if (state) state.status = 'exited'

    try {
      sp.abortController.abort()
      sp.query.close()
    } catch { /* ignore */ }

    return true
  }

  subscribe(sessionId: string, listener: (msg: SdkServerMessage) => void): (() => void) | null {
    const sp = this.processes.get(sessionId)
    if (!sp) return null
    sp.browserListeners.add(listener)

    // Replay buffered messages to the first subscriber
    if (!sp.hasSubscribers) {
      sp.hasSubscribers = true
      for (const msg of sp.messageBuffer) {
        try { listener(msg) } catch (err) {
          log.warn({ err, sessionId }, 'Buffer replay error')
        }
      }
      sp.messageBuffer.length = 0
    }

    return () => { sp.browserListeners.delete(listener) }
  }

  sendUserMessage(sessionId: string, text: string, images?: Array<{ mediaType: string; data: string }>): boolean {
    const inputStream = (this as any)[`_input_${sessionId}`]
    if (!inputStream) return false

    const state = this.sessions.get(sessionId)
    if (state) {
      state.messages.push({
        role: 'user',
        content: [{ type: 'text', text } as ContentBlock],
        timestamp: new Date().toISOString(),
      })
    }

    const content: any[] = [{ type: 'text', text }]
    if (images?.length) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })
      }
    }

    inputStream.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: state?.cliSessionId || 'default',
    })

    return true
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionResult,
  ): boolean {
    const state = this.sessions.get(sessionId)
    const pending = state?.pendingPermissions.get(requestId)
    if (!pending) return false

    state!.pendingPermissions.delete(requestId)
    pending.resolve(decision)
    return true
  }

  interrupt(sessionId: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false

    try {
      sp.query.interrupt()
    } catch { /* ignore */ }
    return true
  }

  close(): void {
    for (const [sessionId] of this.processes) {
      this.killSession(sessionId)
    }
  }

  private broadcastToSession(sessionId: string, msg: SdkServerMessage): void {
    const sp = this.processes.get(sessionId)
    if (!sp) return

    // Buffer messages until the first subscriber attaches
    if (!sp.hasSubscribers) {
      sp.messageBuffer.push(msg)
      return
    }

    for (const listener of sp.browserListeners) {
      try { listener(msg) } catch (err) {
        log.warn({ err, sessionId }, 'Browser listener error')
      }
    }
    this.emit('message', sessionId, msg)
  }
}
