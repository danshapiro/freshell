import { randomBytes } from 'node:crypto'

import type { Page } from '@playwright/test'

export type FreshAgentWireDirection = 'sent' | 'received'
export type FreshAgentSessionType = 'freshclaude' | 'kilroy' | 'freshcodex' | 'freshopencode'
export type FreshAgentProvider = 'claude' | 'codex' | 'opencode' | 'kilroy' | 'amplifier'

type FreshAgentEventType = 'freshAgent.assistant' | 'freshAgent.stream' | 'freshAgent.error'
  | 'freshAgent.session.snapshot' | 'freshAgent.session.changed'
  | 'freshAgent.turn.complete' | 'freshAgent.result'

type FreshAgentEventFact = {
  type: FreshAgentEventType
  outcome?: string
  codePresent?: boolean
  messagePresent?: boolean
}

type FreshAgentSessionRef = { provider?: FreshAgentProvider; sessionId?: string }
type FreshAgentStartupDiagnostic = 'authentication' | 'arguments' | 'listener' | 'configuration' | 'network' | 'unclassified' | 'no-diagnostic'

type FreshAgentIdentity = {
  sessionType?: FreshAgentSessionType
  provider?: FreshAgentProvider
}

export type FreshAgentWireFrame =
  | (FreshAgentIdentity & {
    type: 'freshAgent.create'
    requestId: string | number
    sessionType: FreshAgentSessionType
    sessionRef?: FreshAgentSessionRef
  })
  | (FreshAgentIdentity & { type: 'freshAgent.attach'; sessionId: string })
  | (FreshAgentIdentity & { type: 'freshAgent.send'; requestId: string | number; sessionId: string; text?: string })
  | (FreshAgentIdentity & { type: 'freshAgent.approval.respond'; requestId: string | number; sessionId?: string; decision?: { behavior: 'allow' | 'deny' | 'other' } })
  | (FreshAgentIdentity & { type: 'freshAgent.created'; requestId: string | number; sessionId: string })
  | (FreshAgentIdentity & { type: 'freshAgent.create.failed'; requestId: string | number; code?: string; startupDiagnostic?: FreshAgentStartupDiagnostic })
  | (FreshAgentIdentity & { type: 'freshAgent.send.accepted'; requestId: string | number; sessionId: string })
  | (FreshAgentIdentity & { type: 'freshAgent.event'; sessionId: string; event: FreshAgentEventFact })

export type FreshAgentWireObservations = {
  sent: FreshAgentWireFrame[]
  received: FreshAgentWireFrame[]
  /** Permit exactly this controlled synthetic prompt to cross in a send fact. */
  allowSendPrompt(prompt: string): Promise<void>
  /** Wait until the browser has delivered every projected fact emitted so far. */
  flush(): Promise<void>
}

export type FreshAgentWireObserverInit = {
  bindingName: string
  stateKey: string
  allowedSendPrompts: string[]
}

/**
 * Runs in the browser at document start. Raw JSON is parsed and projected here;
 * the exposed Playwright binding receives only the newly constructed safe fact.
 */
export function installFreshAgentBrowserWireProjector(config: FreshAgentWireObserverInit): void {
  const browserWindow = window as unknown as Window & Record<string, any>
  const sessionTypes = ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] as const
  const providers = ['claude', 'codex', 'opencode', 'kilroy', 'amplifier'] as const
  const eventTypes = [
    'freshAgent.assistant',
    'freshAgent.stream',
    'freshAgent.error',
    'freshAgent.session.snapshot',
    'freshAgent.session.changed',
    'freshAgent.turn.complete',
    'freshAgent.result',
  ] as const
  const startupDiagnostics = [
    'authentication', 'arguments', 'listener', 'configuration', 'network', 'unclassified', 'no-diagnostic',
  ] as const
  const existing = browserWindow[config.stateKey] as {
    allowSendPrompt?: (prompt: string) => void
  } | undefined
  if (existing) {
    for (const prompt of config.allowedSendPrompts) existing.allowSendPrompt?.(prompt)
    return
  }

  const NativeWebSocket = browserWindow.WebSocket
  if (typeof NativeWebSocket !== 'function') return

  const allowedPrompts = new Set(config.allowedSendPrompts)
  const observedSockets = new WeakSet<WebSocket>()
  const pendingBindings: Promise<void>[] = []
  const state = {
    allowSendPrompt: (prompt: string) => allowedPrompts.add(prompt),
    flush: async () => {
      const pending = pendingBindings.splice(0)
      await Promise.all(pending)
    },
  }
  browserWindow[config.stateKey] = state

  const boundedString = (value: unknown, max = 512): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
  const safeId = (value: unknown): string | number | undefined => {
    if (typeof value === 'string') return boundedString(value, 256)
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
  }
  const safeProvider = (value: unknown): FreshAgentProvider | undefined =>
    typeof value === 'string' && (providers as readonly string[]).includes(value)
      ? value as FreshAgentProvider : undefined
  const safeSessionType = (value: unknown): FreshAgentSessionType | undefined =>
    typeof value === 'string' && (sessionTypes as readonly string[]).includes(value)
      ? value as FreshAgentSessionType : undefined

  const project = (direction: FreshAgentWireDirection, input: unknown): FreshAgentWireFrame | null => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const source = input as Record<string, any>
    const type = source.type
    const output: Record<string, any> = { type: '' }

    const copyIdentity = () => {
      const requestId = safeId(source.requestId)
      const sessionId = boundedString(source.sessionId)
      const sessionType = safeSessionType(source.sessionType)
      const provider = safeProvider(source.provider)
      if (requestId !== undefined) output.requestId = requestId
      if (sessionId !== undefined) output.sessionId = sessionId
      if (sessionType !== undefined) output.sessionType = sessionType
      if (provider !== undefined) output.provider = provider
    }

    if (direction === 'sent') {
      if (!['freshAgent.create', 'freshAgent.attach', 'freshAgent.send', 'freshAgent.approval.respond'].includes(type)) return null
      output.type = type
      copyIdentity()
      if (type === 'freshAgent.create' && typeof output.requestId !== 'string' && typeof output.requestId !== 'number') return null
      if (type === 'freshAgent.create' && !output.sessionType) return null
      if (type === 'freshAgent.attach' && typeof output.sessionId !== 'string') return null
      if (type === 'freshAgent.send'
        && ((typeof output.requestId !== 'string' && typeof output.requestId !== 'number') || typeof output.sessionId !== 'string')) return null
      if (type === 'freshAgent.approval.respond'
        && (typeof output.requestId !== 'string' && typeof output.requestId !== 'number')) return null
      if (type === 'freshAgent.create' && source.sessionRef && typeof source.sessionRef === 'object') {
        const sessionRef: FreshAgentSessionRef = {}
        const provider = safeProvider(source.sessionRef.provider)
        const sessionId = boundedString(source.sessionRef.sessionId)
        if (provider !== undefined) sessionRef.provider = provider
        if (sessionId !== undefined) sessionRef.sessionId = sessionId
        if (Object.keys(sessionRef).length) output.sessionRef = sessionRef
      }
      if (type === 'freshAgent.send' && typeof source.text === 'string'
        && source.text.length <= 8192 && allowedPrompts.has(source.text)) output.text = source.text
      if (type === 'freshAgent.approval.respond' && source.decision && typeof source.decision === 'object') {
        const behavior = source.decision.behavior
        if (typeof behavior === 'string') {
          output.decision = { behavior: behavior === 'allow' || behavior === 'deny' ? behavior : 'other' }
        }
      }
      return output as FreshAgentWireFrame
    }

    if (type === 'freshAgent.created' || type === 'freshAgent.create.failed' || type === 'freshAgent.send.accepted') {
      output.type = type
      copyIdentity()
      if ((type === 'freshAgent.created' || type === 'freshAgent.send.accepted')
        && ((typeof output.requestId !== 'string' && typeof output.requestId !== 'number') || typeof output.sessionId !== 'string')) return null
      if (type === 'freshAgent.create.failed'
        && typeof output.requestId !== 'string' && typeof output.requestId !== 'number') return null
      if (type === 'freshAgent.create.failed') {
        if (typeof source.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(source.code)) output.code = source.code
        if (typeof source.message === 'string') {
          const match = source.message.match(/startup diagnostic: (authentication|arguments|listener|configuration|network|unclassified|no-diagnostic)/)
          if (match && (startupDiagnostics as readonly string[]).includes(match[1]!)) {
            output.startupDiagnostic = match[1] as FreshAgentStartupDiagnostic
          }
        }
      }
      return output as FreshAgentWireFrame
    }

    if (type !== 'freshAgent.event' || !source.event || typeof source.event !== 'object') return null
    const eventType = source.event.type
    if (typeof eventType !== 'string' || !(eventTypes as readonly string[]).includes(eventType)) return null
    output.type = 'freshAgent.event'
    copyIdentity()
    if (typeof output.sessionId !== 'string') return null
    const event: FreshAgentEventFact = { type: eventType as FreshAgentEventType }
    if (eventType === 'freshAgent.error') {
      event.codePresent = typeof source.event.code === 'string'
      event.messagePresent = typeof source.event.message === 'string'
    }
    if (eventType === 'freshAgent.turn.complete' && typeof source.event.outcome === 'string'
      && /^[a-z_]{1,32}$/.test(source.event.outcome)) event.outcome = source.event.outcome
    output.event = event
    return output as FreshAgentWireFrame
  }

  const emit = (direction: FreshAgentWireDirection, raw: unknown) => {
    const fact = project(direction, raw)
    if (!fact) return
    const binding = browserWindow[config.bindingName]
    if (typeof binding === 'function') {
      try {
        const pending = binding(direction, fact)
        if (pending && typeof pending.then === 'function') {
          pendingBindings.push(Promise.resolve(pending).then(() => undefined, () => undefined))
        }
      } catch { /* binding can be absent while a document is unloading */ }
    }
  }

  const isFreshellSocket = (value: unknown): boolean => {
    try {
      return new URL(String(value), browserWindow.location.href).pathname.replace(/\/+$/, '') === '/ws'
    } catch {
      return false
    }
  }

  const originalSend = NativeWebSocket.prototype.send
  Object.defineProperty(NativeWebSocket.prototype, 'send', {
    configurable: true,
    writable: true,
    value: function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (observedSockets.has(this) && typeof data === 'string') {
        try { emit('sent', JSON.parse(data)) } catch { /* non-JSON protocol frame */ }
      }
      return originalSend.call(this, data)
    },
  })

  const WrappedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget) as WebSocket
      if (isFreshellSocket(args[0])) {
        observedSockets.add(socket)
        socket.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data !== 'string') return
          try { emit('received', JSON.parse(event.data)) } catch { /* non-JSON protocol frame */ }
        })
      }
      return socket
    },
  })
  Object.defineProperty(browserWindow, 'WebSocket', {
    configurable: true,
    writable: true,
    value: WrappedWebSocket,
  })
}

function installAllowedPrompt(config: { stateKey: string; prompt: string }): void {
  const browserWindow = window as unknown as Window & Record<string, any>
  browserWindow[config.stateKey]?.allowSendPrompt?.(config.prompt)
}

function flushBrowserWireBindings(config: { stateKey: string }): Promise<void> {
  const browserWindow = window as unknown as Window & Record<string, any>
  return browserWindow[config.stateKey]?.flush?.() ?? Promise.resolve()
}

/**
 * Observe FreshAgent WebSocket facts without transferring raw frames to Node.
 * The browser projector emits only allowlisted facts; the observation arrays
 * survive page navigations and reloads.
 */
export async function observeFreshAgentBrowserWire(page: Page): Promise<FreshAgentWireObservations> {
  const suffix = randomBytes(12).toString('hex')
  const bindingName = `__freshellFreshAgentWire_${suffix}`
  const stateKey = `__freshellFreshAgentWireState_${suffix}`
  const allowedPrompts = new Set<string>()
  const sent: FreshAgentWireFrame[] = []
  const received: FreshAgentWireFrame[] = []

  await page.exposeBinding(bindingName, (_source, direction: unknown, fact: unknown) => {
    if (direction !== 'sent' && direction !== 'received') return
    ;(direction === 'sent' ? sent : received).push(fact as FreshAgentWireFrame)
  })
  await page.addInitScript(installFreshAgentBrowserWireProjector, {
    bindingName,
    stateKey,
    allowedSendPrompts: [],
  } satisfies FreshAgentWireObserverInit)

  return {
    sent,
    received,
    allowSendPrompt: async (prompt: string) => {
      if (typeof prompt !== 'string' || prompt.length === 0 || prompt.length > 8192) {
        throw new Error('FreshAgent observer prompt must be a non-empty bounded string')
      }
      allowedPrompts.add(prompt)
      const init = { stateKey, prompt }
      await page.addInitScript(installAllowedPrompt, init)
      await page.evaluate(installAllowedPrompt, init)
    },
    flush: async () => { await page.evaluate(flushBrowserWireBindings, { stateKey }) },
  }
}
