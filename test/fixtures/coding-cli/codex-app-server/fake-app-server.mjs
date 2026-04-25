#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const argLogPath = process.env.FAKE_CODEX_APP_SERVER_ARG_LOG
if (argLogPath) {
  fs.writeFileSync(argLogPath, JSON.stringify(process.argv.slice(2)), 'utf8')
}

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

function getCodexHome() {
  return process.env.CODEX_HOME || '/tmp/fake-codex-home'
}

function getRolloutSessionDir() {
  const now = new Date()
  const year = String(now.getUTCFullYear())
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  return path.join(getCodexHome(), 'sessions', year, month, day)
}

function getThreadHandle(threadId) {
  return {
    id: threadId,
    path: path.join(getRolloutSessionDir(), `rollout-${threadId}.jsonl`),
    ephemeral: false,
  }
}

function ensureDurableArtifact(threadId) {
  const thread = getThreadHandle(threadId)
  const codexHome = process.env.CODEX_HOME || '/tmp/fake-codex-home'
  const now = new Date()
  const sessionDir = path.dirname(thread.path)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(thread.path, JSON.stringify({
    threadId,
    createdAt: now.toISOString(),
  }) + '\n', 'utf8')
  return {
    codexHome,
    thread,
  }
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
      codexHome: getCodexHome(),
      platformFamily: 'unix',
      platformOs: 'linux',
    }
  }
  if (method === 'thread/start') {
    return {
      thread: getThreadHandle('thread-new-1'),
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
    const threadId = params?.threadId || 'thread-new-1'
    return {
      thread: getThreadHandle(threadId),
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
  if (method === 'turn/start') {
    return {
      thread: getThreadHandle(params?.threadId || 'thread-new-1'),
    }
  }
  if (method === 'fs/watch') {
    return {
      path: path.resolve(String(params?.path || '')),
    }
  }
  if (method === 'fs/unwatch') {
    return {}
  }
  return {}
}

const listenUrl = parseListenUrl(process.argv.slice(2))
const behavior = loadBehavior()
const closeSocketAfterMethodsOnce = new Set(behavior.closeSocketAfterMethodsOnce || [])
const exitProcessAfterMethodsOnce = new Set(behavior.exitProcessAfterMethodsOnce || [])
const url = new URL(listenUrl)
const host = url.hostname
const port = Number(url.port)
const watches = new Map()

const wss = new WebSocketServer({ host, port })

function broadcastNotification(method, params) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload)
    }
  }
}

function emitConfiguredNotifications(method) {
  const notifications = behavior.notifyAfterMethodsOnce?.[method]
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return
  }
  delete behavior.notifyAfterMethodsOnce[method]
  for (const notification of notifications) {
    broadcastNotification(notification.method, notification.params)
  }
}

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
      const result = override?.result ?? successResult(method, message.params)
      socket.send(JSON.stringify({
        id: message.id,
        result,
      }))
      if (method === 'initialize') {
        initialized = true
      }
      if (method === 'thread/start') {
        const thread = result?.thread || getThreadHandle(message.params?.threadId || 'thread-new-1')
        broadcastNotification('thread/started', {
          thread,
        })
      }
      if (method === 'fs/watch') {
        const watchId = message.params?.watchId
        const watchedPath = result?.path
        if (watchId && watchedPath) {
          watches.set(watchId, watchedPath)
        }
      }
      if (method === 'fs/unwatch') {
        const watchId = message.params?.watchId
        if (watchId) {
          watches.delete(watchId)
        }
      }
      if (method === 'turn/start' && message.params?.threadId) {
        const { thread } = ensureDurableArtifact(message.params.threadId)
        const rolloutPath = thread.path
        const rolloutParent = path.dirname(rolloutPath)
        for (const [watchId, watchedPath] of watches) {
          if (watchedPath !== rolloutPath && watchedPath !== rolloutParent) {
            continue
          }
          broadcastNotification('fs/changed', {
            watchId,
            changedPaths: [rolloutPath],
          })
        }
      }
      emitConfiguredNotifications(method)
      if (closeSocketAfterMethodsOnce.delete(method)) {
        setTimeout(() => socket.close(), 0)
      }
      if (exitProcessAfterMethodsOnce.delete(method)) {
        setTimeout(() => process.exit(0), 0)
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
