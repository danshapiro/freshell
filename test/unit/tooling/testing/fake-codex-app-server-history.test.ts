import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const fakeAppServer = path.join(repoRoot, 'test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitForPort(portFile: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 5_000
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4_000) })
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`fake Codex app-server exited before listening: ${stderr}`)
    }
    const raw = await fs.readFile(portFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (raw) {
      const port = Number(raw.trim())
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port
      throw new Error('fake Codex app-server published an invalid port')
    }
    await delay(20)
  }
  throw new Error(`fake Codex app-server did not publish its port: ${stderr}`)
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('fake Codex app-server websocket connection timed out'))
    }, 5_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function rpc(socket: WebSocket, id: string, method: string, params: Record<string, unknown>) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error(`fake Codex app-server ${method} timed out`))
    }, 5_000)
    const onMessage = (raw: WebSocket.RawData) => {
      let frame: Record<string, any>
      try { frame = JSON.parse(raw.toString()) }
      catch { return }
      if (frame.id !== id) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      if (frame.error) reject(new Error(String(frame.error.message ?? method)))
      else resolve(frame)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), error => {
      if (!error) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      reject(error)
    })
  })
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])
  if (!stopped) {
    child.kill('SIGKILL')
    await exited
  }
}

describe('fake Codex app-server history transcript', () => {
  it('persists the submitted user message in the rollout so History can display the session', async () => {
    const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-codex-history-'))
    const workspace = path.join(owned, 'workspace')
    const codexHome = path.join(owned, '.codex')
    const portFile = path.join(owned, 'port')
    const threadId = 'thread-history-visible'
    const prompts = ['Visible checkpoint history title', 'A later visible history message']
    await fs.mkdir(workspace)
    let child: ChildProcess | undefined
    let socket: WebSocket | undefined
    try {
      child = spawn(process.execPath, [fakeAppServer, '--listen', 'ws://127.0.0.1:0'], {
        cwd: workspace,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
          FAKE_CODEX_APP_SERVER_PORT_FILE: portFile,
          FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
            threadStartThreadId: threadId,
            persistRolloutUserMessages: true,
          }),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const port = await waitForPort(portFile, child)
      socket = await connectWebSocket(`ws://127.0.0.1:${port}`)
      await rpc(socket, 'initialize', 'initialize', {})
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
      const started = await rpc(socket, 'thread-start', 'thread/start', { cwd: workspace })
      const rolloutPath = started.result?.thread?.path
      expect(rolloutPath).toEqual(expect.any(String))
      for (const [index, prompt] of prompts.entries()) {
        await rpc(socket, `turn-start-${index}`, 'turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
        })
      }

      let records: Array<Record<string, any>> = []
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const raw = await fs.readFile(rolloutPath, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw error
        })
        records = raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
        const messages = records
          .filter(record => record.type === 'event_msg' && record.payload?.type === 'user_message')
          .map(record => record.payload.message)
        if (messages.length === prompts.length) break
        await delay(20)
      }
      expect(records[0]?.type).toBe('session_meta')
      expect(records
        .filter(record => record.type === 'event_msg' && record.payload?.type === 'user_message')
        .map(record => record.payload.message)).toEqual(prompts)
    } finally {
      socket?.close()
      await stop(child)
      await fs.rm(owned, { recursive: true, force: true })
    }
  }, 15_000)
})
