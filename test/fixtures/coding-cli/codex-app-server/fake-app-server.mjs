#!/usr/bin/env node

import { WebSocketServer } from 'ws'

function parseListenUrl(argv) {
  const listenIndex = argv.indexOf('--listen')
  if (listenIndex === -1 || listenIndex === argv.length - 1) {
    throw new Error('Expected --listen <ws://host:port>')
  }
  return argv[listenIndex + 1]
}

function loadBehavior() {
  const raw = process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR
  if (!raw) return {}
  return JSON.parse(raw)
}

function successResult(method, params) {
  if (method === 'initialize') {
    return { protocolVersion: 'fixture-v1' }
  }
  if (method === 'thread/start') {
    return {
      thread: {
        id: 'thread-new-1',
      },
      cwd: params?.cwd ?? process.cwd(),
    }
  }
  if (method === 'thread/resume') {
    return {
      thread: {
        id: params?.threadId,
      },
      cwd: params?.cwd ?? process.cwd(),
    }
  }
  return {}
}

const listenUrl = parseListenUrl(process.argv.slice(2))
const behavior = loadBehavior()
const closeSocketAfterMethodsOnce = new Set(behavior.closeSocketAfterMethodsOnce || [])
const url = new URL(listenUrl)
const host = url.hostname
const port = Number(url.port)

const wss = new WebSocketServer({ host, port })

wss.on('connection', (socket) => {
  let initialized = false
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (behavior.requireJsonRpc && message.jsonrpc !== '2.0') {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32600,
          message: 'Expected jsonrpc: "2.0" request envelope',
        },
      }))
      return
    }
    const method = message.method

    if (behavior.requireInitializeBeforeOtherMethods && method !== 'initialize' && !initialized) {
      socket.send(JSON.stringify({
        id: message.id,
        error: {
          code: -32000,
          message: 'initialize must complete before other RPC methods',
        },
      }))
      return
    }

    if (behavior.ignoreMethods?.includes(method)) {
      return
    }

    const override = behavior.overrides?.[method]
    const delayMs = Number(behavior.delayMethodsMs?.[method] || 0)
    if (override?.error) {
      setTimeout(() => {
        socket.send(JSON.stringify({
          id: message.id,
          error: override.error,
        }))
      }, delayMs)
      return
    }

    setTimeout(() => {
      socket.send(JSON.stringify({
        id: message.id,
        result: override?.result ?? successResult(method, message.params),
      }))
      if (method === 'initialize') {
        initialized = true
      }
      if (closeSocketAfterMethodsOnce.delete(method)) {
        setTimeout(() => socket.close(), 0)
      }
    }, delayMs)
  })
})

process.on('SIGTERM', () => {
  if (process.env.FAKE_CODEX_APP_SERVER_IGNORE_SIGTERM === '1') {
    return
  }
  wss.close(() => process.exit(0))
})
