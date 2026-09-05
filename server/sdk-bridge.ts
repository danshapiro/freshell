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
  type SDKCommandsChangedMessage,
  type Query as SdkQuery,
  type Options as SdkOptions,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk'
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { buildMcpServerCommandArgs } from './mcp/config-writer.js'
import { sanitizeFreshAgentPluginPaths } from '../shared/fresh-agent-plugins.js'
import { FreshAgentSessionCommandSchema, type FreshAgentSessionCommand } from '../shared/fresh-agent-contract.js'
import { logger } from './logger.js'
import { synthesizeClaudeFreshAgentLiveMessageId } from './fresh-agent/history/claude/history-ledger.js'
import { nextMonotonicTurnCompleteAt } from './fresh-agent/turn-complete-clock.js'
import type { ClaudeFreshAgentHistorySource } from './fresh-agent/history/claude/history-source.js'
import type {
  SdkSessionState,
  SdkCreatedSession,
  SdkReplayDrain,
  SdkReplayState,
  ContentBlock,
  SdkServerMessage,
  QuestionDefinition,
} from './sdk-bridge-types.js'

const log = logger.child({ component: 'sdk-bridge' })

interface InputStreamHandle {
  push: (msg: unknown) => void
  end: () => void
}

interface SessionProcess {
  query: SdkQuery
  abortController: AbortController
  browserListeners: Set<(msg: SdkServerMessage, meta?: { sequence: number }) => void>
  /** Buffer messages until the first subscriber attaches (prevents race condition) */
  messageBuffer: Array<{ sequence: number; message: SdkServerMessage }>
  nextSequence: number
  hasSubscribers: boolean
  inputStream: InputStreamHandle
}

type ClaudeSdkOptionsInput = {
  cwd?: string
  resumeSessionId?: string
  model?: string
  permissionMode?: string
  effort?: string
  plugins?: string[]
  abortController?: AbortController
  includePartialMessages?: boolean
  stderr?: (data: string) => void
  canUseTool?: CanUseTool
  env?: NodeJS.ProcessEnv
}

export function createClaudeSdkCleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { CLAUDECODE: _, ANTHROPIC_API_KEY: __, ...cleanEnv } = env
  return cleanEnv
}

export function createClaudeSdkMcpServers(env: NodeJS.ProcessEnv = process.env): NonNullable<SdkOptions['mcpServers']> {
  return {
    freshell: {
      command: 'node',
      args: buildMcpServerCommandArgs(),
      env: {
        FRESHELL_URL: env.FRESHELL_URL || `http://localhost:${Number(env.PORT || 3001)}`,
        FRESHELL_TOKEN: env.AUTH_TOKEN || '',
      },
    },
  }
}

export function createClaudeSdkOptions(input: ClaudeSdkOptionsInput): SdkOptions {
  const options: SdkOptions = {
    cwd: input.cwd || undefined,
    resume: input.resumeSessionId,
    model: input.model,
    permissionMode: input.permissionMode as any,
    // Permit a later explicit UI selection; this does not enable bypass itself.
    allowDangerouslySkipPermissions: true,
    effort: input.effort as any,
    pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
    includePartialMessages: input.includePartialMessages,
    abortController: input.abortController,
    env: createClaudeSdkCleanEnv(input.env),
    mcpServers: createClaudeSdkMcpServers(input.env),
    stderr: input.stderr,
    canUseTool: input.canUseTool,
    settingSources: ['user', 'project', 'local'],
  }

  if (input.plugins !== undefined) {
    options.plugins = sanitizeFreshAgentPluginPaths(input.plugins)
      .map((pluginPath) => ({ type: 'local' as const, path: pluginPath }))
  }

  return options
}

/**
 * Normalize ONE raw SDK slash-command row through the shared contract schema.
 * Field coercion before validation: description absent/non-string becomes '';
 * aliases is dropped unless it is an array (the SDK has been observed emitting
 * explicit null); name passes through so schema min(1) can reject it. Returns
 * null when the row cannot be repaired.
 */
function normalizeSlashCommandRow(row: unknown): FreshAgentSessionCommand | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const raw = row as { name?: unknown; description?: unknown; argumentHint?: unknown; aliases?: unknown }
  const candidate: Record<string, unknown> = {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
  }
  if (typeof raw.argumentHint === 'string') candidate.argumentHint = raw.argumentHint
  if (Array.isArray(raw.aliases)) candidate.aliases = raw.aliases
  const parsed = FreshAgentSessionCommandSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/**
 * Normalize raw SDK slash-command rows from a commands_changed push through the
 * shared contract schema at the state boundary. Push-level tolerance: if ANY row
 * is invalid, the whole payload is rejected (returns null) so a malformed push
 * cannot partially clobber the prior catalog.
 */
function normalizeSlashCommandRows(rows: unknown): FreshAgentSessionCommand[] | null {
  if (!Array.isArray(rows)) return null
  const normalized: FreshAgentSessionCommand[] = []
  for (const row of rows) {
    const parsed = normalizeSlashCommandRow(row)
    if (parsed === null) return null
    normalized.push(parsed)
  }
  return normalized
}

/**
 * Create-time probe variant: invalid rows are DROPPED individually, keeping their
 * valid siblings — a probe has no prior catalog a partial payload could clobber,
 * and one malformed SDK row must not leave the pane with no command menu until a
 * mid-session push happens to arrive (the per-row-drop convention of the opencode
 * catalog's normalizeOpencodeCommandCatalog). Returns null only when the payload
 * is not an array at all; an empty listing is a real, publishable catalog.
 */
function normalizeSlashCommandProbeRows(rows: unknown): FreshAgentSessionCommand[] | null {
  if (!Array.isArray(rows)) return null
  const normalized: FreshAgentSessionCommand[] = []
  for (const row of rows) {
    const parsed = normalizeSlashCommandRow(row)
    if (parsed !== null) normalized.push(parsed)
  }
  return normalized
}

export class SdkBridge extends EventEmitter {
  private sessions = new Map<string, SdkSessionState>()
  private processes = new Map<string, SessionProcess>()

  constructor(private readonly agentHistorySource?: ClaudeFreshAgentHistorySource) {
    super()
  }

  private cloneSessionState(state: SdkSessionState): SdkSessionState {
    return {
      ...state,
      plugins: state.plugins ? [...state.plugins] : undefined,
      tools: state.tools ? state.tools.map((tool) => ({ ...tool })) : undefined,
      messages: state.messages.map((message) => ({
        ...message,
        content: message.content.map((block) => ({ ...block })),
      })),
      pendingPermissions: new Map(state.pendingPermissions),
      pendingQuestions: new Map(state.pendingQuestions),
      terminalCommandNames: state.terminalCommandNames ? [...state.terminalCommandNames] : undefined,
      commandCatalog: state.commandCatalog ? [...state.commandCatalog] : undefined,
      commands: state.commands ? [...state.commands] : undefined,
    }
  }

  private assignMessageId(
    state: SdkSessionState,
    message: { role: 'user' | 'assistant'; content: ContentBlock[]; timestamp: string; model?: string; messageId?: string },
  ): string {
    if (typeof message.messageId === 'string' && message.messageId.trim().length > 0) {
      return message.messageId
    }
    return synthesizeClaudeFreshAgentLiveMessageId(state.sessionId, state.messages.length)
  }

  private syncRestoreLedger(state: SdkSessionState): void {
    void this.agentHistorySource?.syncLiveSession?.(state).catch((err) => {
      log.warn({
        err: err instanceof Error ? err : new Error(String(err)),
        sessionId: state.sessionId,
      }, 'Failed to sync restore ledger from SDK state')
    })
  }

  private readReplayState(sessionId: string): { sp: SessionProcess; currentState: SdkSessionState } | null {
    const sp = this.processes.get(sessionId)
    const currentState = this.sessions.get(sessionId)
    if (!sp || !currentState) {
      return null
    }
    return { sp, currentState }
  }

  async createSession(options: {
    cwd?: string
    resumeSessionId?: string
    model?: string
    permissionMode?: string
    effort?: string
    plugins?: string[]
  }): Promise<SdkCreatedSession> {
    const sessionId = nanoid()
    const state: SdkSessionState = {
      sessionId,
      resumeSessionId: options.resumeSessionId,
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      effort: options.effort,
      plugins: options.plugins ? sanitizeFreshAgentPluginPaths(options.plugins) : undefined,
      status: 'starting',
      createdAt: Date.now(),
      messages: [],
      streamingActive: false,
      streamingText: '',
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      costUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }
    this.sessions.set(sessionId, state)

    const abortController = new AbortController()
    const { iterable: inputIterable, handle: inputStream } = this.createInputStream()

    const sdkQuery = query({
      prompt: inputIterable as AsyncIterable<any>,
      options: createClaudeSdkOptions({
        cwd: options.cwd,
        resumeSessionId: options.resumeSessionId,
        model: options.model,
        permissionMode: options.permissionMode,
        effort: options.effort,
        plugins: options.plugins,
        abortController,
        includePartialMessages: true,
        stderr: (data: string) => {
          log.warn({ sessionId, data: data.trimEnd() }, 'SDK subprocess stderr')
        },
        canUseTool: async (toolName, input, ctx) => {
          if (toolName === 'AskUserQuestion') {
            return this.handleAskUserQuestion(sessionId, input as Record<string, unknown>, ctx)
          }
          // Read live permissionMode from session state (not closure) so runtime changes are respected
          const currentState = this.sessions.get(sessionId)
          if (currentState?.permissionMode === 'bypassPermissions') {
            return { behavior: 'allow', updatedInput: input }
          }
          return this.handlePermissionRequest(sessionId, toolName, input as Record<string, unknown>, ctx)
        },
      }),
    })

    this.processes.set(sessionId, {
      query: sdkQuery,
      abortController,
      browserListeners: new Set(),
      messageBuffer: [],
      nextSequence: 1,
      hasSubscribers: false,
      inputStream,
    })

    await this.agentHistorySource?.syncLiveSession?.(state)

    // Start consuming the message stream in the background
    this.consumeStream(sessionId, sdkQuery).catch((err) => {
      log.error({ sessionId, err }, 'SDK stream error')
    })

    // Fire-and-forget slash-command catalog probe (VAL-B: resolves in ~1.2–1.5s over
    // the control channel, independent of the lazy streamed init frame). NEVER awaited —
    // an await here would hold the create path on a low-single-digit-second round-trip.
    // Rejection or a non-array payload = catalog absent; individually malformed rows
    // are dropped, keeping their valid siblings. The session is unaffected either way.
    void sdkQuery.supportedCommands().then((rows) => {
      const current = this.sessions.get(sessionId)
      if (!current) return
      // Stale-probe rule: a commands_changed push incorporated since the probe was
      // fired carries the fresher catalog; the late probe result must not clobber it.
      if (current.commandsChangedSeen) return
      const normalized = normalizeSlashCommandProbeRows(rows)
      if (normalized === null) {
        log.debug({ sessionId }, 'Ignoring invalid supportedCommands probe payload')
        return
      }
      if (normalized.length < rows.length) {
        log.debug({ sessionId, dropped: rows.length - normalized.length }, 'Dropped invalid rows from supportedCommands probe payload')
      }
      current.commandCatalog = normalized
      this.maybePublishSessionCommands(sessionId, current)
    }).catch((err) => {
      log.debug({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'supportedCommands probe failed; command catalog absent')
    })

    return Object.assign(state, {
      replayGate: {
        drain: () => {
          const replayState = this.readReplayState(sessionId)
          if (!replayState) return null
          const { sp, currentState } = replayState
          const bufferedMessages = sp.messageBuffer.splice(0, sp.messageBuffer.length)
          return {
            watermark: sp.nextSequence - 1,
            session: this.cloneSessionState(currentState),
            bufferedMessages,
          }
        },
      },
    })
  }

  captureReplayState(sessionId: string): SdkReplayState | null {
    const replayState = this.readReplayState(sessionId)
    if (!replayState) return null
    const { sp, currentState } = replayState
    return {
      watermark: sp.nextSequence - 1,
      session: this.cloneSessionState(currentState),
    }
  }

  drainReplayBuffer(sessionId: string): SdkReplayDrain | null {
    const replayState = this.readReplayState(sessionId)
    if (!replayState) return null
    const { sp, currentState } = replayState
    const bufferedMessages = sp.messageBuffer.splice(0, sp.messageBuffer.length)
    return {
      watermark: sp.nextSequence - 1,
      session: this.cloneSessionState(currentState),
      bufferedMessages,
    }
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
        // Stream ended (naturally OR via the error catch above, since wasAborted
        // is false in both). Session state stays for display but process resources
        // are cleaned up so sendUserMessage/subscribe/interrupt correctly return
        // false instead of silently pushing into a dead queue. Broadcast an explicit
        // idle status so the client clears blue (busy = streamingActive || running);
        // a natural end / error previously left the pane stuck blue.
        if (state) state.status = 'idle'
        this.broadcastToSession(sessionId, { type: 'sdk.status', sessionId, status: 'idle' })
        log.debug({ sessionId }, 'SDK query stream ended')
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
          if (state.status === 'starting') state.status = 'connected'
          // Capture the init frame's terminal slash-command name-list (optional per
          // sdk.d.ts:4766-4770). It drives the publish subtract; absent = empty
          // subtract list (data-driven, no name denylist).
          state.terminalCommandNames = Array.isArray(init.terminal_slash_commands) ? [...init.terminal_slash_commands] : undefined
          state.commandsInitSeen = true
          this.syncRestoreLedger(state)
          this.broadcastToSession(sessionId, {
            type: 'sdk.session.init',
            sessionId,
            cliSessionId: state.cliSessionId,
            model: state.model,
            cwd: state.cwd,
            tools: state.tools,
          })
          this.maybePublishSessionCommands(sessionId, state)
        } else if (msg.subtype === 'commands_changed') {
          // Fire-and-forget REPLACE push of the full slash-command list (SDK 0.3).
          // On invalid payload: ignore and keep the prior catalog.
          const changed = msg as SDKCommandsChangedMessage
          const rows = normalizeSlashCommandRows(changed.commands)
          if (rows === null) {
            log.debug({ sessionId }, 'Ignoring invalid commands_changed payload; prior catalog kept')
            break
          }
          state.commandCatalog = rows
          state.commandsChangedSeen = true
          this.maybePublishSessionCommands(sessionId, state)
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
          messageId: this.assignMessageId(state, {
            role: 'assistant',
            content: blocks,
            timestamp: new Date().toISOString(),
            model: (aMsg.message as any)?.model,
            messageId: typeof (aMsg.message as any)?.id === 'string' ? (aMsg.message as any).id : undefined,
          }),
          ...(typeof (aMsg.message as any)?.model === 'string' ? { model: (aMsg.message as any).model } : {}),
        })
        this.syncRestoreLedger(state)
        state.streamingActive = false
        state.streamingText = ''
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
        state.streamingActive = false
        state.streamingText = ''
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
        if (rMsg.subtype !== 'success') {
          const message = rMsg.errors?.filter((error) => error.trim()).join('\n')
            || (rMsg.subtype === 'error_max_turns'
              ? 'Claude reached its turn limit. Send a message to continue.'
              : rMsg.subtype === 'error_max_budget_usd'
                ? 'Claude reached the configured spending limit.'
                : 'Claude could not complete this turn. Try sending your message again.')
          log.warn({ sessionId, subtype: rMsg.subtype }, 'Claude turn did not complete')
          this.broadcastToSession(sessionId, { type: 'sdk.error', sessionId, message })
        }
        // Server-authoritative turn-complete edge for the GREEN/SOUND pipeline.
        // Only a positively-completed turn ('success') chimes; interrupts yield no
        // result message at all, and tool-only/error turns surface a non-success
        // subtype, so this never fires green on an aborted or errored turn.
        if (rMsg.subtype === 'success') {
          const at = nextMonotonicTurnCompleteAt(state.lastTurnCompleteAt, Date.now())
          state.lastTurnCompleteAt = at
          this.broadcastToSession(sessionId, {
            type: 'sdk.turn.complete',
            sessionId,
            at,
          })
        }
        break
      }

      case 'stream_event': {
        const sMsg = msg as SDKPartialAssistantMessage
        if (sMsg.event?.type === 'content_block_start') {
          state.streamingActive = true
          state.streamingText = ''
        }
        if (sMsg.event?.type === 'content_block_delta' && sMsg.event.delta?.type === 'text_delta') {
          state.streamingActive = true
          state.streamingText += sMsg.event.delta.text
        }
        if (sMsg.event?.type === 'content_block_stop') {
          state.streamingActive = false
        }
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

  /**
   * Server-authoritative "waiting for approval/question" edge for the GREEN/SOUND
   * pipeline. Fires only on the 0 -> >=1 pending transition (mirrors the deleted
   * client hook's count-based edge), covering both permission and question requests.
   * Uses a per-session monotonic `at` independent of the turn-complete clock; the
   * client routes it under a distinct `#waiting` dedupe namespace.
   */
  private emitWaitingEdge(sessionId: string, state: SdkSessionState): void {
    const at = nextMonotonicTurnCompleteAt(state.lastWaitingAt, Date.now())
    state.lastWaitingAt = at
    this.broadcastToSession(sessionId, { type: 'sdk.turn.waiting', sessionId, at })
  }

  /**
   * Publish the slash-command catalog at the JOIN of (init frame landed, a
   * catalog source present). The streamed system/init frame is lazy (VAL-B: it
   * arrives with the first turn), while supportedCommands() resolves over the
   * control channel pre-first-turn — so whichever of init/probe/push arrives
   * second completes the join here. Publish subtracts rows whose name is in the
   * session's LATEST terminal list (init re-emits per turn and may re-tag), then
   * emits the existing snapshot-invalidation edge (sdk.session.changed →
   * freshAgent.session.changed → the client refetches the snapshot).
   */
  private maybePublishSessionCommands(sessionId: string, state: SdkSessionState): void {
    if (!state.commandsInitSeen || state.commandCatalog === undefined) return
    const terminal = new Set(state.terminalCommandNames ?? [])
    state.commands = state.commandCatalog.filter((row) => !terminal.has(row.name))
    this.broadcastToSession(sessionId, {
      type: 'sdk.session.changed',
      sessionId,
      reason: 'session-commands',
    })
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
    const wasIdle = state.pendingPermissions.size === 0 && state.pendingQuestions.size === 0

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

      if (wasIdle) this.emitWaitingEdge(sessionId, state)
    })
  }

  private async handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal
      toolUseID: string
    },
  ): Promise<PermissionResult> {
    const state = this.sessions.get(sessionId)
    if (!state) return { behavior: 'deny', message: 'Session not found' }

    const requestId = nanoid()
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
      return { behavior: 'allow', updatedInput: input }
    }
    const questions: QuestionDefinition[] = rawQuestions
      .filter((q): q is Record<string, unknown> => q != null && typeof q === 'object')
      .map((q) => {
        const sanitized: QuestionDefinition = {
          // Spread first to preserve any extra fields (e.g. SDK-provided IDs)
          ...(q as unknown as QuestionDefinition),
          // Then override with sanitized known fields
          question: String(q.question ?? ''),
          header: String(q.header ?? ''),
          options: Array.isArray(q.options)
            ? q.options
                .filter((o): o is Record<string, unknown> => o != null && typeof o === 'object')
                .map((o) => ({
                  ...(o as unknown as { label: string; description: string }),
                  label: String(o.label ?? ''),
                  description: String(o.description ?? ''),
                }))
            : [],
          multiSelect: Boolean(q.multiSelect),
        }
        return sanitized
      })
    if (questions.length === 0) {
      return { behavior: 'allow', updatedInput: input }
    }

    const wasIdle = state.pendingPermissions.size === 0 && state.pendingQuestions.size === 0

    return new Promise((resolve) => {
      state.pendingQuestions.set(requestId, {
        originalInput: input,
        questions,
        resolve,
      })

      this.broadcastToSession(sessionId, {
        type: 'sdk.question.request',
        sessionId,
        requestId,
        questions,
      })

      if (wasIdle) this.emitWaitingEdge(sessionId, state)
    })
  }

  respondQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string>,
  ): boolean {
    const state = this.sessions.get(sessionId)
    const pending = state?.pendingQuestions.get(requestId)
    if (!pending) return false

    state!.pendingQuestions.delete(requestId)
    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        ...pending.originalInput,
        questions: pending.questions,
        answers,
      },
    })
    return true
  }

  getSession(sessionId: string): SdkSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  getLiveSession(sessionId: string): SdkSessionState | undefined {
    if (!this.processes.has(sessionId)) return undefined
    return this.sessions.get(sessionId)
  }

  findSessionByCliSessionId(timelineSessionId: string): SdkSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.cliSessionId === timelineSessionId || session.resumeSessionId === timelineSessionId) {
        return session
      }
    }
    return undefined
  }

  findLiveSessionByCliSessionId(timelineSessionId: string): SdkSessionState | undefined {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!this.processes.has(sessionId)) continue
      if (session.cliSessionId === timelineSessionId || session.resumeSessionId === timelineSessionId) {
        return session
      }
    }
    return undefined
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

  subscribe(
    sessionId: string,
    listener: (msg: SdkServerMessage, meta?: { sequence: number }) => void,
    options?: { skipReplayBuffer?: boolean },
  ): { off: () => void; replayed: boolean } | null {
    const sp = this.processes.get(sessionId)
    if (!sp) return null
    sp.browserListeners.add(listener)

    // Replay buffered messages to the first subscriber
    let replayed = false
    if (!sp.hasSubscribers) {
      sp.hasSubscribers = true
      if (!options?.skipReplayBuffer) {
        replayed = true
        for (const entry of sp.messageBuffer) {
          try { listener(entry.message, { sequence: entry.sequence }) } catch (err) {
            log.warn({ err, sessionId }, 'Buffer replay error')
          }
        }
        sp.messageBuffer.length = 0
      }
    }

    return { off: () => { sp.browserListeners.delete(listener) }, replayed }
  }

  sendUserMessage(sessionId: string, text: string, images?: Array<{ mediaType: string; data: string }>): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false

    const state = this.sessions.get(sessionId)
    if (state) {
      // Reserve the turn before the first asynchronous provider event arrives.
      state.status = 'running'
      const timestamp = new Date().toISOString()
      const content = [{ type: 'text', text } as ContentBlock]
      state.messages.push({
        role: 'user',
        content,
        timestamp,
        messageId: this.assignMessageId(state, {
          role: 'user',
          content,
          timestamp,
        }),
      })
      this.syncRestoreLedger(state)
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

  async configureSession(sessionId: string, requested: { model?: string; effort?: string; permissionMode?: string; cwd?: string }): Promise<void> {
    const sp = this.processes.get(sessionId)
    const state = this.sessions.get(sessionId)
    if (!sp || !state || state.status === 'exited') throw new Error(`Claude session ${sessionId} is not available`)
    if (requested.cwd !== undefined && requested.cwd !== state.cwd) {
      throw new Error('Start a new conversation to change the working directory.')
    }
    const modelChanged = requested.model !== undefined && requested.model !== state.model
    const effort = requested.effort ?? (modelChanged ? undefined : state.effort)
    const effortChanged = effort !== state.effort
    const permissionChanged = requested.permissionMode !== undefined && requested.permissionMode !== state.permissionMode
    if ((modelChanged || effortChanged || permissionChanged) && (state.status === 'running' || state.pendingPermissions.size > 0 || state.pendingQuestions.size > 0)) {
      throw new Error('Wait for the current turn to finish before changing agent settings.')
    }
    try {
      // Record each accepted change, including when a later setter fails.
      if (modelChanged) {
        await sp.query.setModel(requested.model!)
        state.model = requested.model
      }
      if (effortChanged) {
        await sp.query.applyFlagSettings({ effortLevel: (effort ?? null) as Parameters<SdkQuery['applyFlagSettings']>[0]['effortLevel'] })
        state.effort = effort
      }
      if (permissionChanged) {
        await sp.query.setPermissionMode(requested.permissionMode as Parameters<SdkQuery['setPermissionMode']>[0])
        state.permissionMode = requested.permissionMode
      }
    } catch (err) {
      log.warn({ sessionId, err }, 'Claude session settings update failed; message not sent')
      throw err
    }
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

  close(): void {
    for (const [sessionId] of this.processes) {
      this.killSession(sessionId)
    }
  }

  private broadcastToSession(sessionId: string, msg: SdkServerMessage): void {
    const sp = this.processes.get(sessionId)
    if (!sp) return
    const sequence = sp.nextSequence++

    // Buffer messages until the first subscriber attaches
    if (!sp.hasSubscribers) {
      sp.messageBuffer.push({ sequence, message: msg })
      return
    }

    for (const listener of sp.browserListeners) {
      try { listener(msg, { sequence }) } catch (err) {
        log.warn({ err, sessionId }, 'Browser listener error')
      }
    }
    this.emit('message', sessionId, msg)
  }
}
