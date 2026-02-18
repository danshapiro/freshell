import { nanoid } from 'nanoid'
import { EventEmitter } from 'events'
import {
  query,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKPartialAssistantMessage,
  type SDKStatusMessage,
  type Query as SdkQuery,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { logger } from './logger.js'
import type {
  SdkSessionState,
  ContentBlock,
  SdkServerMessage,
} from './sdk-bridge-types.js'

const log = logger.child({ component: 'sdk-bridge' })

interface InputStreamHandle {
  push: (msg: unknown) => void
  end: () => void
}

interface SessionProcess {
  query: SdkQuery
  abortController: AbortController
  browserListeners: Set<(msg: SdkServerMessage) => void>
  /** Buffer messages until the first subscriber attaches (prevents race condition) */
  messageBuffer: SdkServerMessage[]
  hasSubscribers: boolean
  inputStream: InputStreamHandle
}

export class SdkBridge extends EventEmitter {
  private sessions = new Map<string, SdkSessionState>()
  private processes = new Map<string, SessionProcess>()
  private cachedModels: Array<{ value: string; displayName: string; description: string }> | null = null

  async createSession(options: {
    cwd?: string
    resumeSessionId?: string
    model?: string
    permissionMode?: string
    effort?: 'low' | 'medium' | 'high' | 'max'
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
    const { iterable: inputIterable, handle: inputStream } = this.createInputStream()

    // Strip env vars that prevent nested Claude Code subprocess startup.
    // CLAUDECODE is set by parent Claude Code sessions and causes the child
    // to refuse startup with "cannot be launched inside another session".
    const { CLAUDECODE: _, ...cleanEnv } = process.env

    const sdkQuery = query({
      prompt: inputIterable as AsyncIterable<any>,
      options: {
        cwd: options.cwd || undefined,
        resume: options.resumeSessionId,
        model: options.model,
        permissionMode: options.permissionMode as any,
        effort: options.effort,
        ...(options.permissionMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
        pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
        includePartialMessages: true,
        abortController,
        env: cleanEnv,
        stderr: (data: string) => {
          log.warn({ sessionId, data: data.trimEnd() }, 'SDK subprocess stderr')
        },
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
      inputStream,
    })

    // Start consuming the message stream in the background
    this.consumeStream(sessionId, sdkQuery).catch((err) => {
      log.error({ sessionId, err }, 'SDK stream error')
    })

    return state
  }

  // Creates an async iterable that yields user messages written via sendUserMessage
  private createInputStream(): { iterable: AsyncIterable<unknown>; handle: InputStreamHandle } {
    const queue: unknown[] = []
    let waiting: ((value: IteratorResult<unknown>) => void) | null = null
    let done = false

    const handle: InputStreamHandle = {
      push: (msg: unknown) => {
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

    const iterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
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

    return { iterable, handle }
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
        this.sessions.delete(sessionId)
      } else {
        // Stream ended naturally (SDK query completed). Session state stays for
        // display but process resources are cleaned up so sendUserMessage/
        // subscribe/interrupt correctly return false instead of silently
        // pushing into a dead queue.
        if (state) state.status = 'idle'
        log.debug({ sessionId }, 'SDK query stream ended naturally')
      }

      // Always clean up process resources (input stream + process entry).
      // Must happen AFTER broadcasts above since broadcastToSession reads
      // the process entry.
      sp?.inputStream.end()
      this.processes.delete(sessionId)
    }
  }

  private handleSdkMessage(sessionId: string, msg: SDKMessage): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const init = msg as SDKSystemMessage
          state.cliSessionId = init.session_id
          state.model = init.model || state.model
          state.tools = init.tools?.map((t) => ({ name: t }))
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

          // Fetch available models and broadcast to client
          this.fetchAndBroadcastModels(sessionId)
        } else if (msg.subtype === 'status') {
          const statusMsg = msg as SDKStatusMessage
          if (statusMsg.status === 'compacting') {
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
        const aMsg = msg as SDKAssistantMessage
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
          model: (aMsg.message as any)?.model,
        })
        break
      }

      case 'result': {
        const rMsg = msg as SDKResultMessage
        if (rMsg.total_cost_usd != null) state.costUsd += rMsg.total_cost_usd
        if (rMsg.usage) {
          state.totalInputTokens += rMsg.usage.input_tokens ?? 0
          state.totalOutputTokens += rMsg.usage.output_tokens ?? 0
        }
        state.status = 'idle'
        // Extract usage fields to satisfy the Zod-inferred structural type (SDK's
        // NonNullableUsage is a mapped type that is structurally compatible but not directly
        // assignable to the Zod output type)
        const usage = rMsg.usage
          ? {
              input_tokens: rMsg.usage.input_tokens,
              output_tokens: rMsg.usage.output_tokens,
              cache_creation_input_tokens: rMsg.usage.cache_creation_input_tokens,
              cache_read_input_tokens: rMsg.usage.cache_read_input_tokens,
            }
          : undefined
        this.broadcastToSession(sessionId, {
          type: 'sdk.result',
          sessionId,
          result: rMsg.subtype,
          durationMs: rMsg.duration_ms,
          costUsd: rMsg.total_cost_usd,
          usage,
        })
        break
      }

      case 'stream_event': {
        const sMsg = msg as SDKPartialAssistantMessage
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
    const sp = this.processes.get(sessionId)
    if (!sp) return false

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

    sp.inputStream.push({
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

    sp.query.interrupt().catch((err) => {
      log.warn({ sessionId, err }, 'Interrupt failed')
    })
    return true
  }

  setModel(sessionId: string, model: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false
    const state = this.sessions.get(sessionId)
    if (state) state.model = model
    sp.query.setModel(model).catch((err) => {
      log.warn({ sessionId, err }, 'setModel failed')
    })
    return true
  }

  setPermissionMode(sessionId: string, mode: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false
    const state = this.sessions.get(sessionId)
    if (state) state.permissionMode = mode
    sp.query.setPermissionMode(mode as any).catch((err) => {
      log.warn({ sessionId, err }, 'setPermissionMode failed')
    })
    return true
  }

  private fetchAndBroadcastModels(sessionId: string): void {
    // Use cache if available
    if (this.cachedModels) {
      this.broadcastToSession(sessionId, {
        type: 'sdk.models',
        sessionId,
        models: this.cachedModels,
      })
      return
    }

    const sp = this.processes.get(sessionId)
    if (!sp) return

    sp.query.supportedModels().then((models) => {
      const mapped = models.map((m: any) => ({
        value: m.value ?? m.id ?? String(m),
        displayName: m.displayName ?? m.display_name ?? m.value ?? String(m),
        description: m.description ?? '',
      }))
      this.cachedModels = mapped
      this.broadcastToSession(sessionId, {
        type: 'sdk.models',
        sessionId,
        models: mapped,
      })
    }).catch((err) => {
      log.warn({ sessionId, err }, 'Failed to fetch supported models')
    })
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
