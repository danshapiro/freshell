// @vitest-environment node
//
// This file spawns the REAL Codex TUI with --remote and verifies EXTERNAL TUI
// behavior against a fake app-server. It does NOT test Freshell code and does
// not call a model provider. It is gated by FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1
// because it depends on the local Codex binary and PTY behavior.
//
// To run it: FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
//   run test/integration/real/codex-remote-fork-contract.test.ts \
//   --config vitest.server.config.ts
//
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { CODEX_MANAGED_REMOTE_CONFIG_ARGS } from '../../../server/coding-cli/codex-managed-config.js'
import { allocateLocalhostPort } from '../../../server/local-port.js'
import {
  ProbeWorkspace,
  resolveProviderBinaries,
  seedCodexHome,
  type TrackedPtyProcess,
} from '../../helpers/coding-cli/real-session-contract-harness.js'

type ProviderProbeAvailability = {
  ready: boolean
  reason?: string
}

type JsonRpcMessage = {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
}

type CapturedRequest = {
  method: string
  params: Record<string, unknown>
}

const providerBinaries = await resolveProviderBinaries(['codex'] as const)
const codexBinary = providerBinaries.codex

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function codexAvailability(): Promise<ProviderProbeAvailability> {
  if (!codexBinary.resolvedPath) {
    return {
      ready: false,
      reason: 'Skipping Codex remote fork contract: codex is not on PATH.',
    }
  }

  const missing = []
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'auth.json')))) missing.push('~/.codex/auth.json')
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'config.toml')))) missing.push('~/.codex/config.toml')
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Skipping Codex remote fork contract: missing ${missing.join(' and ')}.`,
    }
  }
  return { ready: true }
}

async function waitFor<T>(
  label: string,
  predicate: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

function sendResult(socket: WebSocket, id: string | number | undefined, result: unknown): void {
  if (id === undefined) return
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  }))
}

function sendNotification(socket: WebSocket, method: string, params: Record<string, unknown>): void {
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  }))
}

function threadPayload(id: string, rolloutPath: string): Record<string, unknown> {
  const now = Date.now()
  return {
    id,
    sessionId: id,
    preview: '',
    path: rolloutPath,
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    cwd: process.cwd(),
    cliVersion: 'codex-cli 0.142.5',
    source: 'appServer',
    turns: [],
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
  }
}

async function waitForStillRunning(remote: TrackedPtyProcess, durationMs: number): Promise<void> {
  let exited = false
  await Promise.race([
    remote.waitForExit(durationMs).then(() => {
      exited = true
    }).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, durationMs)),
  ])
  expect(exited).toBe(false)
}

const codexProbe = await codexAvailability()
const realProviderContractsEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const describeCodex = (codexProbe.ready && realProviderContractsEnabled) ? describe : describe.skip

describeCodex(`real Codex TUI remote fork contract${codexProbe.ready ? '' : ` (${codexProbe.reason})`}${realProviderContractsEnabled ? '' : ' (opt-in: FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1)'}`, () => {
  it('continues after a compact thread/fork response with an empty turns array', async () => {
    const codexPath = codexBinary.resolvedPath
    if (!codexPath) throw new Error(codexProbe.reason ?? 'Codex binary unavailable.')

    const workspace = await ProbeWorkspace.create('codex-remote-fork')
    const endpoint = await allocateLocalhostPort()
    const wsUrl = `ws://${endpoint.hostname}:${endpoint.port}`
    const requests: CapturedRequest[] = []
    const parentThreadId = randomUUID()
    const childThreadId = randomUUID()
    const parentRolloutPath = workspace.inTemp('.codex', 'sessions', '2026', '07', '03', 'rollout-parent.jsonl')
    const childRolloutPath = workspace.inTemp('.codex', 'sessions', '2026', '07', '03', 'rollout-child.jsonl')
    let remote: TrackedPtyProcess | undefined
    const wss = new WebSocketServer({ host: endpoint.hostname, port: endpoint.port })

    try {
      await seedCodexHome(workspace)
      wss.on('connection', (socket) => {
        socket.on('message', (raw) => {
          let message: JsonRpcMessage
          try {
            message = JSON.parse(raw.toString()) as JsonRpcMessage
          } catch {
            return
          }
          if (typeof message.method !== 'string') return
          requests.push({ method: message.method, params: message.params ?? {} })

          if (message.method === 'initialize') {
            sendResult(socket, message.id, {
              userAgent: 'freshell-remote-fork-contract/1.0.0',
              codexHome: workspace.inTemp('.codex'),
              platformFamily: 'unix',
              platformOs: process.platform,
            })
            return
          }

          if (message.method === 'account/read') {
            sendResult(socket, message.id, {
              requiresOpenaiAuth: false,
              account: {
                type: 'chatgpt',
                email: 'probe@example.com',
                planType: 'plus',
              },
            })
            return
          }

          if (message.method === 'model/list') {
            sendResult(socket, message.id, {
              data: [{
                id: 'gpt-5-codex',
                model: 'gpt-5-codex',
                displayName: 'GPT-5 Codex',
                description: 'Probe model',
                hidden: false,
                isDefault: true,
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: [],
                inputModalities: ['text'],
                additionalSpeedTiers: [],
                supportsPersonality: false,
                availabilityNux: null,
                upgrade: null,
                upgradeInfo: null,
              }],
              nextCursor: null,
            })
            return
          }

          if (message.method === 'hooks/list') {
            sendResult(socket, message.id, { data: [] })
            return
          }

          if (message.method === 'skills/list') {
            sendResult(socket, message.id, { data: [] })
            return
          }

          if (message.method === 'plugin/list') {
            sendResult(socket, message.id, { data: [] })
            return
          }

          if (message.method === 'command/exec') {
            sendResult(socket, message.id, {
              exitCode: 0,
              stdout: 'codex-fork-oom\n',
              stderr: '',
            })
            return
          }

          if (message.method === 'thread/start') {
            sendResult(socket, message.id, {
              thread: threadPayload(parentThreadId, parentRolloutPath),
              cwd: process.cwd(),
              model: 'gpt-5-codex',
              modelProvider: 'openai',
              instructionSources: [],
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              sandbox: { type: 'dangerFullAccess' },
            })
            return
          }

          if (message.method === 'thread/fork') {
            sendResult(socket, message.id, {
              thread: {
                ...threadPayload(childThreadId, childRolloutPath),
                turns: [],
              },
              cwd: process.cwd(),
              model: 'gpt-5-codex',
              modelProvider: 'openai',
              instructionSources: [],
              approvalPolicy: 'never',
              approvalsReviewer: 'user',
              sandbox: { type: 'dangerFullAccess' },
            })
            sendNotification(socket, 'thread/status/changed', {
              threadId: childThreadId,
              status: { type: 'idle' },
            })
            return
          }

          if (message.method === 'turn/start') {
            sendResult(socket, message.id, {
              turn: {
                id: 'turn-child-1',
                items: [],
                status: 'completed',
              },
            })
            sendNotification(socket, 'turn/started', {
              threadId: message.params?.threadId,
              turnId: 'turn-child-1',
            })
            sendNotification(socket, 'turn/completed', {
              threadId: message.params?.threadId,
              turnId: 'turn-child-1',
              status: 'completed',
              turn: {
                id: 'turn-child-1',
                items: [],
                status: 'completed',
              },
            })
            return
          }

          if (message.method === 'thread/read') {
            const requestedThreadId = typeof message.params?.threadId === 'string'
              ? message.params.threadId
              : childThreadId
            sendResult(socket, message.id, {
              thread: threadPayload(
                requestedThreadId,
                requestedThreadId === childThreadId ? childRolloutPath : parentRolloutPath,
              ),
            })
            return
          }

          if (message.method === 'thread/turns/list') {
            sendResult(socket, message.id, {
              turns: [],
              data: [],
              nextCursor: null,
              backwardsCursor: null,
              revision: 1,
            })
            return
          }

          sendResult(socket, message.id, {})
        })
      })

      remote = workspace.spawnPty(codexPath, [
        '--remote',
        wsUrl,
        ...CODEX_MANAGED_REMOTE_CONFIG_ARGS,
        '--no-alt-screen',
        'fork',
        parentThreadId,
      ], {
        env: {
          CODEX_HOME: workspace.inTemp('.codex'),
        },
      })

      await waitFor('Codex TUI thread/fork', () => (
        requests.find((request) => request.method === 'thread/fork')
      ), 30_000).catch((error) => {
        throw new Error([
          error instanceof Error ? error.message : String(error),
          `Requests: ${JSON.stringify(requests.map((request) => ({ method: request.method, params: request.params })), null, 2)}`,
          `PTY output: ${remote.output().slice(-4000)}`,
        ].join('\n'))
      })

      const forkRequest = requests.find((request) => request.method === 'thread/fork')
      expect(forkRequest?.params).toMatchObject({
        threadId: parentThreadId,
      })
      await waitForStillRunning(remote, 1_000).catch((error) => {
        throw new Error([
          error instanceof Error ? error.message : String(error),
          `Requests: ${JSON.stringify(requests.map((request) => ({ method: request.method, params: request.params })), null, 2)}`,
          `PTY output: ${remote.output().slice(-4000)}`,
        ].join('\n'))
      })
    } finally {
      await remote?.stop().catch(() => undefined)
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await workspace.cleanup().catch(() => undefined)
    }
  }, 90_000)
})
