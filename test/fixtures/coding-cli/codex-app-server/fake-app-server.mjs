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
    return { protocolVersion: '2026-04-17' }
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
const url = new URL(listenUrl)
const host = url.hostname
const port = Number(url.port)

const wss = new WebSocketServer({ host, port })

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const method = message.method

    if (behavior.ignoreMethods?.includes(method)) {
      return
    }

    const override = behavior.overrides?.[method]
    if (override?.error) {
      socket.send(JSON.stringify({
        id: message.id,
        error: override.error,
      }))
      return
    }

    socket.send(JSON.stringify({
      id: message.id,
      result: override?.result ?? successResult(method, message.params),
    }))
  })
})

process.on('SIGTERM', () => {
  wss.close(() => process.exit(0))
})
