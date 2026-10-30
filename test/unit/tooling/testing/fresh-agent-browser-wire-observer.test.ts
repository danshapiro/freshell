// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import type { Page } from '@playwright/test'
import {
  installFreshAgentBrowserWireProjector,
  observeFreshAgentBrowserWire,
} from '../../../../test/e2e-browser/helpers/fresh-agent-browser-wire-observer.js'

class SyntheticWebSocket extends EventTarget {
  readonly url: string
  readonly sent: unknown[] = []

  constructor(url: string) {
    super()
    this.url = url
  }

  send(data: unknown): void {
    this.sent.push(data)
  }
}

function dispatchMessage(socket: EventTarget, payload: unknown): void {
  const event = new Event('message')
  Object.defineProperty(event, 'data', { value: JSON.stringify(payload) })
  socket.dispatchEvent(event)
}

function runPageFunction(fn: Function, arg: unknown, browserWindow: object): unknown {
  // Playwright serializes init/evaluate functions and does not carry module
  // closures into the page. Exercise that exact standalone-function contract.
  return runInNewContext(`(${fn.toString()})(arg)`, { arg, window: browserWindow, URL })
}

describe('FreshAgent browser wire projector', () => {
  it('sends only allowlisted facts and never transfers provider response bodies', () => {
    const sentinel = 'PRIVATE_PROVIDER_RESPONSE_SENTINEL_74f8c2'
    const prompt = 'Reply ready. Do not use tools.'
    const facts: Array<{ direction: string; frame: Record<string, any> }> = []
    const bindingName = '__freshAgentWireBinding'
    const stateKey = '__freshAgentWireState'
    const browserWindow = {
      WebSocket: SyntheticWebSocket,
      location: { href: 'http://freshell.test/' },
      [bindingName]: (direction: string, frame: Record<string, any>) => {
        facts.push({ direction, frame })
        return Promise.resolve()
      },
    }
    vi.stubGlobal('window', browserWindow)
    try {
      // This is the same function passed to Playwright's addInitScript.
      runPageFunction(installFreshAgentBrowserWireProjector, { bindingName, stateKey, allowedSendPrompts: [prompt] }, browserWindow)
      const socket = new browserWindow.WebSocket('ws://freshell.test/ws')

      socket.send(JSON.stringify({ type: 'freshAgent.send', requestId: 'send-1', sessionId: 'session-1',
        sessionType: 'freshclaude', provider: 'claude', text: prompt, images: [{ data: sentinel }] }))
      socket.send(JSON.stringify({ type: 'freshAgent.send', requestId: 'send-2', sessionId: 'session-1',
        sessionType: 'freshclaude', provider: 'claude', text: sentinel, images: [{ data: sentinel }] }))

      for (const event of [
        { type: 'freshAgent.assistant', text: sentinel },
        { type: 'freshAgent.stream', delta: sentinel },
        { type: 'freshAgent.result', result: sentinel, text: sentinel },
        { type: 'freshAgent.error', code: 'PRIVATE_' + sentinel, message: sentinel },
        { type: 'freshAgent.turn.complete', outcome: 'completed', output: sentinel },
      ]) {
        dispatchMessage(socket, { type: 'freshAgent.event', sessionId: 'session-1',
          sessionType: 'freshclaude', provider: 'claude', event })
      }
      dispatchMessage(socket, { type: 'freshAgent.create.failed', requestId: 'create-1',
        code: 'CREATE_FAILED', message: `startup diagnostic: network ${sentinel}` })
      dispatchMessage(socket, { type: 'terminal.output', data: sentinel })

      const sent = facts.filter(({ direction }) => direction === 'sent').map(({ frame }) => frame)
      const received = facts.filter(({ direction }) => direction === 'received').map(({ frame }) => frame)
      expect(sent).toHaveLength(2)
      expect(sent[0]).toEqual({ type: 'freshAgent.send', requestId: 'send-1', sessionId: 'session-1',
        sessionType: 'freshclaude', provider: 'claude', text: prompt })
      expect(sent[1]).not.toHaveProperty('text')
      expect(sent[0]).not.toHaveProperty('images')
      expect(received.filter(frame => frame.event).map(frame => frame.event?.type)).toEqual([
        'freshAgent.assistant', 'freshAgent.stream', 'freshAgent.result',
        'freshAgent.error', 'freshAgent.turn.complete',
      ])
      expect(received.find(frame => frame.event?.type === 'freshAgent.error')?.event).toEqual({
        type: 'freshAgent.error', codePresent: true, messagePresent: true,
      })
      expect(received.find(frame => frame.event?.type === 'freshAgent.turn.complete')?.event).toEqual({
        type: 'freshAgent.turn.complete', outcome: 'completed',
      })
      expect(received.at(-1)).toEqual({ type: 'freshAgent.create.failed', requestId: 'create-1',
        code: 'CREATE_FAILED', startupDiagnostic: 'network' })
      expect(JSON.stringify(facts)).not.toContain(sentinel)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores non-Freshell sockets and unrecognized message types', () => {
    const facts: unknown[] = []
    const bindingName = '__freshAgentWireBinding'
    const browserWindow = {
      WebSocket: SyntheticWebSocket,
      location: { href: 'http://freshell.test/' },
      [bindingName]: (_direction: string, fact: unknown) => facts.push(fact),
    }
    vi.stubGlobal('window', browserWindow)
    try {
      installFreshAgentBrowserWireProjector({ bindingName, stateKey: '__freshAgentWireState', allowedSendPrompts: [] })
      const unrelated = new browserWindow.WebSocket('ws://freshell.test/other')
      unrelated.send(JSON.stringify({ type: 'freshAgent.send', text: 'not observed' }))
      const freshell = new browserWindow.WebSocket('ws://freshell.test/ws')
      dispatchMessage(freshell, { type: 'unrecognized', payload: 'private' })
      expect(facts).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps browser-projected facts in its Node arrays across document reloads', async () => {
    type InitCall = { fn: (arg: any) => void; arg: any }
    let bindingCallback: ((source: any, direction: unknown, fact: unknown) => unknown) | undefined
    const initCalls: InitCall[] = []
    let currentWindow: object | undefined
    const page = {
      exposeBinding: async (_name: string, callback: typeof bindingCallback) => { bindingCallback = callback },
      addInitScript: async (fn: (arg: any) => void, arg: any) => { initCalls.push({ fn, arg }) },
      evaluate: async (fn: (arg: any) => unknown, arg: any) => await runPageFunction(fn, arg, currentWindow!),
    } as unknown as Page
    const wire = await observeFreshAgentBrowserWire(page)
    const prompt = 'Reply ready. Do not use tools.'
    const sentinel = 'PRIVATE_PROVIDER_RESPONSE_SENTINEL_RELOAD'

    const makeDocument = () => {
      class DocumentWebSocket extends EventTarget {
        readonly url: string
        constructor(url: string) { super(); this.url = url }
        send(_data: unknown): void {}
      }
      const bindingName = initCalls[0]!.arg.bindingName
      const browserWindow = {
        WebSocket: DocumentWebSocket,
        location: { href: 'http://freshell.test/' },
        [bindingName]: (direction: unknown, fact: unknown) => Promise.resolve(bindingCallback?.({}, direction, fact)),
      }
      currentWindow = browserWindow
      vi.stubGlobal('window', browserWindow)
      initCalls.forEach(({ fn, arg }) => runPageFunction(fn, arg, browserWindow))
      return browserWindow
    }

    try {
      let browserWindow = makeDocument()
      await wire.allowSendPrompt(prompt)
      let socket = new browserWindow.WebSocket('ws://freshell.test/ws')
      socket.send(JSON.stringify({ type: 'freshAgent.send', requestId: 'send-a', sessionId: 'session-a',
        sessionType: 'freshclaude', provider: 'claude', text: prompt }))
      dispatchMessage(socket, { type: 'freshAgent.event', sessionId: 'session-a', event: { type: 'freshAgent.result', text: sentinel } })
      await wire.flush()
      expect(wire.sent).toEqual([{ type: 'freshAgent.send', requestId: 'send-a', sessionId: 'session-a',
        sessionType: 'freshclaude', provider: 'claude', text: prompt }])
      expect(JSON.stringify(wire.received)).not.toContain(sentinel)

      const sentArray = wire.sent
      await wire.flush()
      browserWindow = makeDocument()
      socket = new browserWindow.WebSocket('ws://freshell.test/ws')
      socket.send(JSON.stringify({ type: 'freshAgent.attach', sessionId: 'session-a', sessionType: 'freshclaude', provider: 'claude' }))
      await wire.flush()
      expect(wire.sent).toBe(sentArray)
      expect(wire.sent).toHaveLength(2)
      expect(wire.sent[1]).toEqual({ type: 'freshAgent.attach', sessionId: 'session-a', sessionType: 'freshclaude', provider: 'claude' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
