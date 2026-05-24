import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { FreshAgentCreateRequest, FreshAgentRuntimeAdapter, FreshAgentThreadLocator } from '../../runtime-adapter.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'
import { logger } from '../../../logger.js'
import {
  normalizeOpencodeSnapshot,
  normalizeOpencodeTurnBody,
  normalizeOpencodeTurnPage,
} from './normalize.js'

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
}

function makePlaceholderId(requestId: string): string {
  return `freshopencode-${requestId}`
}

function splitModel(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined
}

function parseRunEvents(stdout: string): { sessionId?: string } {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const event = JSON.parse(line)
      if (typeof event?.sessionID === 'string') return { sessionId: event.sessionID }
    } catch {
      // Ignore non-JSON formatted output around raw event lines.
    }
  }
  return {}
}

function parseExportOutput(stdout: string): unknown {
  const jsonStart = stdout.indexOf('{')
  if (jsonStart < 0) return undefined
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

export function createOpencodeFreshAgentAdapter(options: {
  command?: string
  spawnFn?: SpawnFn
  runTimeoutMs?: number
} = {}): FreshAgentRuntimeAdapter {
  const command = options.command ?? 'opencode'
  const spawnFn = options.spawnFn ?? spawn
  const runTimeoutMs = options.runTimeoutMs ?? 180_000
  const log = logger.child({ component: 'freshopencode-adapter' })
  const sessions = new Map<string, OpencodeSessionState>()

  function remember(state: OpencodeSessionState) {
    sessions.set(state.placeholderId, state)
    if (state.realSessionId) sessions.set(state.realSessionId, state)
  }

  function requireState(sessionId: string): OpencodeSessionState {
    const state = sessions.get(sessionId)
    if (!state) {
      throw new Error(`OpenCode fresh-agent session ${sessionId} is not available.`)
    }
    return state
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

  async function exportSession(state: OpencodeSessionState): Promise<any | undefined> {
    if (!state.realSessionId) return undefined
    const { stdout } = await runCli(['export', state.realSessionId], state.cwd)
    return parseExportOutput(stdout)
  }

  async function materializeOrSend(
    state: OpencodeSessionState,
    text: string,
    settings?: Partial<FreshAgentCreateRequest>,
  ): Promise<void> {
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
      '--dangerously-skip-permissions',
      ...(state.realSessionId ? ['--session', state.realSessionId] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--variant', effort] : []),
    ]
    state.status = 'running'
    state.events.emit('event', { type: 'sdk.session.snapshot', sessionId: state.placeholderId, status: 'running' })
    try {
      const { stdout } = await runCli(args, normalized?.cwd ?? state.cwd, state, runTimeoutMs)
      const parsed = parseRunEvents(stdout)
      if (parsed.sessionId && !state.realSessionId) {
        state.realSessionId = parsed.sessionId
        remember(state)
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
      }
      remember(state)
      return { sessionId: state.placeholderId, sessionRef: { provider: 'opencode', sessionId: state.placeholderId } }
    },

    async resume(input) {
      const normalized = normalizeOpencodeInput(input)
      const sessionId = normalized.resumeSessionId
      if (!sessionId) throw new Error('OpenCode resume requires a session id.')
      const state: OpencodeSessionState = {
        placeholderId: sessionId,
        realSessionId: sessionId,
        cwd: normalized.cwd,
        model: normalized.model,
        effort: normalized.effort,
        status: 'idle',
        events: new EventEmitter(),
      }
      remember(state)
      return { sessionId, sessionRef: { provider: 'opencode', sessionId } }
    },

    attach(locator) {
      const existing = sessions.get(locator.sessionId)
      if (existing) {
        remember(existing)
        return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
      }
      const state: OpencodeSessionState = {
        placeholderId: locator.sessionId,
        realSessionId: locator.sessionId,
        status: 'idle',
        events: new EventEmitter(),
      }
      remember(state)
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
      await materializeOrSend(state, input.text, input.settings)
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
      await materializeOrSend(state, `/compact${suffix}`)
    },

    kill(sessionId) {
      const state = requireState(sessionId)
      state.activeProcess?.kill('SIGTERM')
      sessions.delete(state.placeholderId)
      if (state.realSessionId) sessions.delete(state.realSessionId)
      return true
    },

    async getSnapshot(thread: FreshAgentThreadLocator) {
      const state = sessions.get(thread.threadId) ?? {
        placeholderId: thread.threadId,
        realSessionId: thread.threadId,
        status: 'idle',
        events: new EventEmitter(),
      }
      const exported = await exportSession(state).catch(() => undefined)
      return normalizeOpencodeSnapshot({
        sessionType: 'freshopencode',
        threadId: thread.threadId,
        exported,
        status: state.status,
        model: state.model,
        effort: state.effort,
      })
    },

    async getTurnPage(thread, query) {
      const state = requireState(thread.threadId)
      const exported = await exportSession(state).catch(() => undefined)
      return normalizeOpencodeTurnPage({
        threadId: thread.threadId,
        exported,
        revision: Number(query.revision) || 0,
      })
    },

    async getTurnBody(thread, revision) {
      const state = requireState(thread.threadId)
      const exported = await exportSession(state).catch(() => undefined)
      return normalizeOpencodeTurnBody({
        threadId: thread.threadId,
        exported,
        turnId: thread.turnId,
        revision,
      })
    },
  }
}
