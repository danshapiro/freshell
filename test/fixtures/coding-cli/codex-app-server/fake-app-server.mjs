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

function writeBytes(stream, totalBytes, chunkSize = 16 * 1024) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return Promise.resolve()
  }

  const chunk = Buffer.alloc(Math.max(1, Math.min(chunkSize, totalBytes)), 'x')
  let remaining = totalBytes

  return new Promise((resolve, reject) => {
    const writeNext = () => {
      while (remaining > 0) {
        const size = Math.min(chunk.length, remaining)
        const payload = size === chunk.length ? chunk : chunk.subarray(0, size)
        remaining -= size
        const canContinue = stream.write(payload)
        if (!canContinue) {
          stream.once('drain', writeNext)
          return
        }
      }
      resolve()
    }

    stream.once('error', reject)
    writeNext()
  })
}

function successResult(method, params) {
  if (method === 'initialize') {
    return {
      userAgent: 'freshell-fixture/1.0.0',
      codexHome: '/tmp/fake-codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    }
  }
  if (method === 'thread/start') {
    return {
      thread: {
        id: 'thread-new-1',
      },
      cwd: params?.cwd ?? process.cwd(),
      model: 'fixture-model',
      modelProvider: 'openai',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: {
        type: 'dangerFullAccess',
      },
    }
  }
  if (method === 'thread/resume') {
    return {
      thread: {
        id: params?.threadId,
      },
      cwd: params?.cwd ?? process.cwd(),
      model: 'fixture-model',
      modelProvider: 'openai',
      instructionSources: [],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: {
        type: 'dangerFullAccess',
      },
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
    const floodStdoutBytes = Number(behavior.floodStdoutBeforeMethodsBytes?.[method] || 0)
    const floodStderrBytes = Number(behavior.floodStderrBeforeMethodsBytes?.[method] || 0)
    if (override?.error) {
      setTimeout(() => {
        socket.send(JSON.stringify({
          id: message.id,
          error: override.error,
        }))
      }, delayMs)
      return
    }

    setTimeout(async () => {
      await writeBytes(process.stdout, floodStdoutBytes)
      await writeBytes(process.stderr, floodStderrBytes)
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
