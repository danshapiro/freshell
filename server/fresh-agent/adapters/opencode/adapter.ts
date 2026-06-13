import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type {
  FreshAgentCreateRequest,
  FreshAgentRuntimeAdapter,
  FreshAgentSendResult,
  FreshAgentThreadLocator,
} from '../../runtime-adapter.js'
import { FreshAgentLostSessionError } from '../../runtime-manager.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'
import { logger } from '../../../logger.js'
import { defaultOpencodeDataHome } from '../../../coding-cli/providers/opencode.js'
import {
  type OpencodeExport,
  normalizeOpencodeSnapshot,
  normalizeOpencodeTurnBody,
  normalizeOpencodeTurnPage,
} from './normalize.js'
import { DEFAULT_SNAPSHOT_TURN_LIMIT } from './history-query.js'
import {
  createWorkerHistoryReader,
  OpencodeHistoryReaderError,
  type OpencodeHistoryReader,
} from './history-runner.js'

type SpawnFn = typeof spawn

type OpencodeSessionState = {
  placeholderId: string
  realSessionId?: string
  cwd?: string
  model?: string
  effort?: string
  status: string
  activeProcess?: ChildProcessWithoutNullStreams
  events: EventEmitter
  sendQueue: Promise<unknown>
}

type CreateOpencodeFreshAgentAdapterOptions = {
  command?: string
  spawnFn?: SpawnFn
  runTimeoutMs?: number
  historyReader?: OpencodeHistoryReader
  dbPath?: string
  dataHome?: string
}

const OPENCODE_REAL_SESSION_ID = /^ses_/
const OPENCODE_PLACEHOLDER_SESSION_ID = /^freshopencode-/

function makePlaceholderId(requestId: string): string {
  return `freshopencode-${requestId}`
}

function splitModel(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined
}

function isRealOpencodeSessionId(sessionId: string): boolean {
  return OPENCODE_REAL_SESSION_ID.test(sessionId)
}

function isPlaceholderOpencodeSessionId(sessionId: string): boolean {
  return OPENCODE_PLACEHOLDER_SESSION_ID.test(sessionId)
}

function parseRunEvents(stdout: string): { sessionId?: string; ambiguousSessionIds?: string[] } {
  const sessionIds = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const event = JSON.parse(line)
      if (
        event
        && typeof event === 'object'
        && !Array.isArray(event)
        && typeof event.sessionID === 'string'
        && isRealOpencodeSessionId(event.sessionID)
      ) {
        sessionIds.add(event.sessionID)
      }
    } catch {
      // Ignore non-JSON formatted output around raw event lines.
    }
  }
  if (sessionIds.size === 1) return { sessionId: [...sessionIds][0] }
  if (sessionIds.size > 1) return { ambiguousSessionIds: [...sessionIds] }
  return {}
}

function parseExportOutput(stdout: string): OpencodeExport {
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0) {
    throw new Error('OpenCode export output did not contain JSON.')
  }
  return JSON.parse(stdout.slice(jsonStart))
}

function normalizeOpencodeInput(input: FreshAgentCreateRequest): FreshAgentCreateRequest {
  const model = normalizeFreshAgentModel(input.sessionType, 'opencode', input.model)
  return {
    ...input,
    model,
    effort: normalizeFreshAgentEffort(input.sessionType, 'opencode', model, input.effort),
  }
}

export function createOpencodeFreshAgentAdapter(options: CreateOpencodeFreshAgentAdapterOptions = {}): FreshAgentRuntimeAdapter {
  const command = options.command ?? 'opencode'
  const spawnFn = options.spawnFn ?? spawn
  const runTimeoutMs = options.runTimeoutMs ?? 180_000
  const dbPath = options.dbPath ?? path.join(options.dataHome ?? defaultOpencodeDataHome(), 'opencode.db')
  const historyReader = options.historyReader ?? createWorkerHistoryReader({ dbPath })
  const log = logger.child({ component: 'freshopencode-adapter' })
  const sessions = new Map<string, OpencodeSessionState>()

  function remember(state: OpencodeSessionState) {
    sessions.set(state.placeholderId, state)
    if (state.realSessionId) sessions.set(state.realSessionId, state)
  }

  function requireState(sessionId: string): OpencodeSessionState {
    const state = sessions.get(sessionId)
    if (!state) {
      throw new FreshAgentLostSessionError(`OpenCode fresh-agent session ${sessionId} is not available.`)
    }
    return state
  }

  function requireDurableSession(threadId: string): {
    sessionId: string
    cwd?: string
    status: string
    model?: string
    effort?: string
  } {
    const state = sessions.get(threadId)
    if (state) {
      if (!state.realSessionId) {
        throw new FreshAgentLostSessionError(`OpenCode fresh-agent placeholder ${threadId} has not materialized.`)
      }
      return {
        sessionId: state.realSessionId,
        cwd: state.cwd,
        status: state.status,
        model: state.model,
        effort: state.effort,
      }
    }
    if (isPlaceholderOpencodeSessionId(threadId)) {
      throw new FreshAgentLostSessionError(`OpenCode fresh-agent placeholder ${threadId} is not restorable.`)
    }
    if (!isRealOpencodeSessionId(threadId)) {
      throw new FreshAgentLostSessionError(`OpenCode fresh-agent session ${threadId} is not a durable OpenCode session.`)
    }
    return { sessionId: threadId, status: 'idle' }
  }

  function sendResult(sessionId: string | undefined): FreshAgentSendResult {
    return sessionId
      ? { sessionId, sessionRef: { provider: 'opencode', sessionId } }
      : undefined
  }

  function canFallbackToExport(error: unknown): boolean {
    return error instanceof OpencodeHistoryReaderError
      && (error.reason === 'missing_db' || error.reason === 'sqlite_unavailable')
  }

  function logHistoryWarning(
    messageClass: string,
    message: string,
    options: { error?: unknown; sessionId?: string; extra?: Record<string, unknown> } = {},
  ): void {
    log.warn({
      ...(options.error instanceof Error ? { err: options.error } : {}),
      messageClass,
      ...(options.error instanceof OpencodeHistoryReaderError ? { reason: options.error.reason } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.extra ?? {}),
    }, message)
  }

  async function hydrateSessionInfo(state: OpencodeSessionState, sessionId: string, scope: 'materialize' | 'attach' | 'resume'): Promise<void> {
    try {
      const info = await historyReader.readSessionInfo(sessionId)
      if (typeof info?.directory === 'string' && info.directory.length > 0) {
        state.cwd = info.directory
      }
    } catch (error) {
      logHistoryWarning(
        'history_session_info_unavailable',
        'OpenCode session info could not be read from history database.',
        { error, sessionId, extra: { scope } },
      )
    }
  }

  function runCli(
    args: string[],
    cwd?: string,
    state?: OpencodeSessionState,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawnFn(command, args, {
        cwd,
        env: process.env,
      }) as ChildProcessWithoutNullStreams
      child.stdin.end()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timeout = timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            log.warn({
              argv: args,
              cwd,
              timeoutMs,
              sessionId: state?.realSessionId ?? state?.placeholderId,
            }, 'OpenCode fresh-agent subprocess timed out; terminating.')
            child.kill('SIGTERM')
            setTimeout(() => {
              if (!child.killed) child.kill('SIGKILL')
            }, 5_000).unref()
          }, timeoutMs)
        : undefined
      timeout?.unref()
      state && (state.activeProcess = child)
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout)
        if (state?.activeProcess === child) state.activeProcess = undefined
        if (timedOut) {
          reject(new Error(`OpenCode timed out after ${timeoutMs}ms.`))
          return
        }
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr || stdout}`))
        }
      })
    })
  }

  async function exportSession(sessionId: string, cwd?: string): Promise<OpencodeExport> {
    const { stdout } = await runCli(['export', sessionId], cwd)
    return parseExportOutput(stdout)
  }

  async function materializeOrSend(
    state: OpencodeSessionState,
    text: string,
    settings?: Partial<FreshAgentCreateRequest>,
  ): Promise<FreshAgentSendResult> {
    const normalized = settings
      ? normalizeOpencodeInput({
          requestId: state.placeholderId,
          sessionType: 'freshopencode',
          provider: 'opencode',
          ...settings,
        } as FreshAgentCreateRequest)
      : undefined
    const model = splitModel(normalized?.model ?? state.model)
    const effort = normalized?.effort ?? state.effort
    const args = [
      'run',
      text,
      '--format',
      'json',
      ...(state.realSessionId ? ['--session', state.realSessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--variant', effort] : []),
    ]
    state.status = 'running'
    state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'running' })
    const effectiveCwd = normalized?.cwd ?? state.cwd
    try {
      const { stdout } = await runCli(args, effectiveCwd, state, runTimeoutMs)
      const parsed = parseRunEvents(stdout)
      if (!state.realSessionId) {
        if (parsed.sessionId) {
          state.realSessionId = parsed.sessionId
          await hydrateSessionInfo(state, parsed.sessionId, 'materialize')
          remember(state)
        } else if (parsed.ambiguousSessionIds?.length) {
          logHistoryWarning(
            'ambiguous_run_session_id',
            'OpenCode run emitted multiple top-level session ids; leaving placeholder unmaterialized.',
            { sessionId: state.placeholderId, extra: { candidateSessionIds: parsed.ambiguousSessionIds } },
          )
        } else {
          logHistoryWarning(
            'missing_run_session_id',
            'OpenCode run did not emit an authoritative top-level session id; leaving placeholder unmaterialized.',
            { sessionId: state.placeholderId },
          )
        }
      }
    } catch (error) {
      state.status = 'idle'
      state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'idle' })
      throw error
    }
    state.model = model ?? state.model
    state.effort = effort
    state.status = 'idle'
    state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'idle' })
    return sendResult(state.realSessionId)
  }

  function exportedWithRevision(exported: OpencodeExport, revision: number): OpencodeExport {
    return {
      ...exported,
      info: {
        ...(exported.info ?? {}),
        time: {
          ...(exported.info?.time ?? {}),
          updated: revision,
        },
      },
    }
  }

  return {
    runtimeProvider: 'opencode',

    async create(input) {
      const normalized = normalizeOpencodeInput(input)
      const state: OpencodeSessionState = {
        placeholderId: makePlaceholderId(String(input.requestId)),
        cwd: normalized.cwd,
        model: normalized.model,
        effort: normalized.effort,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      remember(state)
      return { sessionId: state.placeholderId, sessionRef: { provider: 'opencode', sessionId: state.placeholderId } }
    },

    async resume(input) {
      const normalized = normalizeOpencodeInput(input)
      const sessionId = normalized.resumeSessionId
      if (!sessionId) throw new Error('OpenCode resume requires a session id.')
      if (isPlaceholderOpencodeSessionId(sessionId) || !isRealOpencodeSessionId(sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: sessionId,
        realSessionId: sessionId,
        cwd: normalized.cwd,
        model: normalized.model,
        effort: normalized.effort,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      remember(state)
      await hydrateSessionInfo(state, sessionId, 'resume')
      return { sessionId, sessionRef: { provider: 'opencode', sessionId } }
    },

    async attach(locator) {
      const existing = sessions.get(locator.sessionId)
      if (existing) {
        remember(existing)
        return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
      }
      if (isPlaceholderOpencodeSessionId(locator.sessionId) || !isRealOpencodeSessionId(locator.sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${locator.sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: locator.sessionId,
        realSessionId: locator.sessionId,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      remember(state)
      await hydrateSessionInfo(state, locator.sessionId, 'attach')
      return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
    },

    subscribe(sessionId, listener) {
      const state = requireState(sessionId)
      const handler = (event: unknown) => listener(event)
      state.events.on('event', handler)
      return () => state.events.off('event', handler)
    },

    async send(sessionId, input) {
      const state = requireState(sessionId)
      const run = state.sendQueue.then(
        () => materializeOrSend(state, input.text, input.settings),
        () => materializeOrSend(state, input.text, input.settings),
      )
      state.sendQueue = run.catch(() => undefined)
      return await run
    },

    interrupt(sessionId) {
      const state = requireState(sessionId)
      state.activeProcess?.kill('SIGINT')
      state.status = 'idle'
      state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'idle' })
    },

    async compact(sessionId, input) {
      const state = requireState(sessionId)
      const suffix = input?.instructions ? ` ${input.instructions.trim()}` : ''
      const run = state.sendQueue.then(
        () => materializeOrSend(state, `/compact${suffix}`),
        () => materializeOrSend(state, `/compact${suffix}`),
      )
      state.sendQueue = run.catch(() => undefined)
      await run
    },

    kill(sessionId) {
      const state = requireState(sessionId)
      state.activeProcess?.kill('SIGTERM')
      sessions.delete(state.placeholderId)
      if (state.realSessionId) sessions.delete(state.realSessionId)
      return true
    },

    async getSnapshot(thread: FreshAgentThreadLocator) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) {
        return normalizeOpencodeSnapshot({
          sessionType: 'freshopencode',
          threadId: thread.threadId,
          status: liveState.status,
          model: liveState.model,
          effort: liveState.effort,
        })
      }
      const durable = requireDurableSession(thread.threadId)
      let exported: OpencodeExport
      try {
        const page = await historyReader.readSnapshotPage(durable.sessionId, DEFAULT_SNAPSHOT_TURN_LIMIT)
        if (!page) {
          throw new FreshAgentLostSessionError(`OpenCode session ${durable.sessionId} was not found in history.`)
        }
        exported = exportedWithRevision(page.exported, page.revision)
      } catch (error) {
        if (!canFallbackToExport(error)) {
          if (error instanceof OpencodeHistoryReaderError) {
            logHistoryWarning(
              'history_snapshot_failed',
              'OpenCode snapshot history read failed.',
              { error, sessionId: durable.sessionId },
            )
          }
          throw error
        }
        logHistoryWarning(
          'history_snapshot_unavailable',
          'OpenCode snapshot history is unavailable; falling back to export.',
          { error, sessionId: durable.sessionId },
        )
        exported = await exportSession(durable.sessionId, durable.cwd)
      }
      return normalizeOpencodeSnapshot({
        sessionType: 'freshopencode',
        threadId: thread.threadId,
        exported,
        status: durable.status,
        model: durable.model,
        effort: durable.effort,
      })
    },

    async getTurnPage(thread, query) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) {
        return normalizeOpencodeTurnPage({
          threadId: thread.threadId,
          exported: { messages: [] },
          revision: Number(query.revision) || 0,
          nextCursor: null,
        })
      }
      const durable = requireDurableSession(thread.threadId)
      try {
        const page = await historyReader.readTurnPage(durable.sessionId, {
          cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
          limit: typeof query.limit === 'number' ? query.limit : undefined,
        })
        if (!page) {
          throw new FreshAgentLostSessionError(`OpenCode session ${durable.sessionId} was not found in history.`)
        }
        return normalizeOpencodeTurnPage({
          threadId: thread.threadId,
          exported: page.exported,
          revision: page.revision,
          nextCursor: page.nextCursor,
        })
      } catch (error) {
        if (!canFallbackToExport(error)) {
          if (error instanceof OpencodeHistoryReaderError) {
            logHistoryWarning(
              'history_turn_page_failed',
              'OpenCode turn page history read failed.',
              { error, sessionId: durable.sessionId },
            )
          }
          throw error
        }
        logHistoryWarning(
          'history_turn_page_unavailable',
          'OpenCode turn page history is unavailable; falling back to export.',
          { error, sessionId: durable.sessionId },
        )
      }
      const exported = await exportSession(durable.sessionId, durable.cwd)
      return normalizeOpencodeTurnPage({
        threadId: thread.threadId,
        exported,
        revision: Number(query.revision) || 0,
      })
    },

    async getTurnBody(thread, revision) {
      const liveState = sessions.get(thread.threadId)
      if (liveState && !liveState.realSessionId) {
        return null
      }
      const durable = requireDurableSession(thread.threadId)
      try {
        const body = await historyReader.readTurnBody(durable.sessionId, thread.turnId)
        if (!body) return null
        return normalizeOpencodeTurnBody({
          threadId: thread.threadId,
          exported: { messages: [body.message] },
          turnId: thread.turnId,
          revision: body.revision,
        })
      } catch (error) {
        if (!canFallbackToExport(error)) {
          if (error instanceof OpencodeHistoryReaderError) {
            logHistoryWarning(
              'history_turn_body_failed',
              'OpenCode turn body history read failed.',
              { error, sessionId: durable.sessionId },
            )
          }
          throw error
        }
        logHistoryWarning(
          'history_turn_body_unavailable',
          'OpenCode turn body history is unavailable; falling back to export.',
          { error, sessionId: durable.sessionId },
        )
      }
      const exported = await exportSession(durable.sessionId, durable.cwd)
      return normalizeOpencodeTurnBody({
        threadId: thread.threadId,
        exported,
        turnId: thread.turnId,
        revision,
      })
    },
  }
}
