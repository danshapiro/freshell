import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createConnection, createServer, type AddressInfo } from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { summarizeRustServerLogEvents } from '../../../../scripts/testing/managed-environment-create.js'
import {
  checkpointTcpForwarderSource,
  externalTargetRead,
  managedEnvironmentFixtureLayout,
  processIdentity,
  resolveManagedProviderEnvironmentTargetMode,
  runManagedProviderEnvironmentTarget,
  stopExact,
} from '../../../../scripts/testing/managed-provider-environment-target.js'

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

describe('managed provider environment target mode', () => {
  it('retains only bounded event names and levels from server logs', () => {
    const logs = [
      JSON.stringify({ level: 'ERROR', event: 'provider.opencode.resource.failed', msg: 'PRIVATE_CONFIG_SENTINEL', token: 'PRIVATE_TOKEN_SENTINEL' }),
      JSON.stringify({ level: 'WARN', event: 'invalid event name', msg: 'PRIVATE_MESSAGE_SENTINEL' }),
      '{invalid json',
    ].join('\n')

    const summary = summarizeRustServerLogEvents(logs)

    expect(summary).toEqual([{ level: 'ERROR', event: 'provider.opencode.resource.failed' }])
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_')
  })

  it('waits for the target Retry-After before retrying a rate-limited control read', async () => {
    const responses = [
      new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
      new Response(JSON.stringify({ content: JSON.stringify({ requestId: 'request-1' }) }), { status: 200 }),
    ]
    const waits: number[] = []
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls += 1
      return responses.shift()!
    }

    const result = await externalTargetRead('http://127.0.0.1:1234', 'token', '/control/request.json', {
      fetcher,
      wait: async milliseconds => { waits.push(milliseconds) },
    })

    expect(result).toEqual({ requestId: 'request-1' })
    expect(calls).toBe(2)
    expect(waits).toEqual([2_000])
  })

  it('keeps the existing managed target as the default and selects checkpoint only explicitly', () => {
    expect(resolveManagedProviderEnvironmentTargetMode([])).toBe('managed-environment')
    expect(resolveManagedProviderEnvironmentTargetMode(['--checkpoint'])).toBe('code-checkpoint')
  })

  it('keeps the OpenCode MCP package and parent dependency outside the mounted workspace', () => {
    const fixture = managedEnvironmentFixtureLayout('/tmp/managed-environment-fixture')
    const packageRelativeToWorkspace = path.relative(fixture.workspace, fixture.mcpPackage)
    expect(packageRelativeToWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(packageRelativeToWorkspace)).toBe(true)
    expect(fixture.mcpParentDependency).toBe(path.join(fixture.resources, 'node_modules/managed-fixture-mcp-dependency'))
  })

  it('forwards one fixed TCP target while preserving streamed client data', async () => {
    const upstream = createServer(socket => {
      socket.on('data', chunk => socket.write(chunk))
    })
    const upstreamPort = await listenOnLoopback(upstream)
    const listenProbe = createServer()
    const listenPort = await listenOnLoopback(listenProbe)
    await new Promise<void>(resolve => listenProbe.close(() => resolve()))

    const forwarder = spawn(process.execPath, ['-e', checkpointTcpForwarderSource], {
      env: {
        ...process.env,
        FRESHELL_CHECKPOINT_FORWARDER_HOST: '127.0.0.1',
        FRESHELL_CHECKPOINT_FORWARDER_PORT: String(listenPort),
        FRESHELL_CHECKPOINT_UPSTREAM_HOST: '127.0.0.1',
        FRESHELL_CHECKPOINT_UPSTREAM_PORT: String(upstreamPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    forwarder.stdout.on('data', chunk => { stdout += chunk.toString() })
    forwarder.stderr.on('data', chunk => { stderr += chunk.toString() })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`forwarder did not become ready: ${stdout} ${stderr}`)), 5_000)
        forwarder.stdout.on('data', () => {
          if (!stdout.includes('code_checkpoint.forwarder_listening')) return
          clearTimeout(timer)
          resolve()
        })
        forwarder.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        forwarder.once('exit', (code, signal) => {
          clearTimeout(timer)
          reject(new Error(`forwarder exited before ready (${code ?? signal}): ${stdout} ${stderr}`))
        })
      })

      const payload = Buffer.from('checkpoint-forwarder-stream-proof')
      const received = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let byteLength = 0
        const client = createConnection({ host: '127.0.0.1', port: listenPort }, () => client.write(payload))
        const timer = setTimeout(() => {
          client.destroy()
          reject(new Error('forwarded TCP stream timed out'))
        }, 5_000)
        client.on('data', chunk => {
          chunks.push(Buffer.from(chunk))
          byteLength += chunk.length
          if (byteLength >= payload.length) {
            clearTimeout(timer)
            resolve(Buffer.concat(chunks))
            client.destroy()
          }
        })
        client.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
      })
      expect(received).toEqual(payload)
    } finally {
      if (forwarder.exitCode === null && forwarder.signalCode === null) {
        forwarder.kill('SIGTERM')
        await new Promise<void>(resolve => forwarder.once('exit', () => resolve()))
      }
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })

  it('settles the exact detached child process group when a wrapper exits before its child', async () => {
    const parentSource = `const {spawn}=require('node:child_process');const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.stdout.write(JSON.stringify({pid:grandchild.pid})+'\\n');setInterval(()=>{},1000)`
    const wrapper = spawn(process.execPath, ['-e', parentSource], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    wrapper.stdout.on('data', chunk => { stdout += chunk.toString() })
    wrapper.stderr.on('data', chunk => { stderr += chunk.toString() })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      wrapper.once('error', reject)
      wrapper.once('close', (code, signal) => resolve({ code, signal }))
    })
    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`wrapper did not publish its child PID: ${stdout} ${stderr}`)), 5_000)
      wrapper.stdout.on('data', () => {
        const match = stdout.match(/\{"pid":(\d+)\}/)
        if (!match) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      })
      wrapper.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      wrapper.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`wrapper exited before publishing its child PID (${code ?? signal}): ${stdout} ${stderr}`))
      })
    })
    const identity = await processIdentity(wrapper)
    expect(identity.processGroupId).toBe(wrapper.pid)
    expect(identity.sessionId).toBe(wrapper.pid)
    await stopExact(wrapper, identity, closed, true)
    expect(wrapper.signalCode).toBe('SIGTERM')
    const childState = await fs.readFile(`/proc/${childPid}/stat`, 'utf8').then(raw =>
      raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[0],
    ).catch(() => undefined)
    expect(childState === undefined || childState === 'Z').toBe(true)
  })

  it.each([['--managed'], ['--checkpoint', '--checkpoint'], ['--checkpoint', 'other'], ['--unknown']])(
    'rejects unsupported or ambiguous target arguments %j', (...args) => {
      expect(() => resolveManagedProviderEnvironmentTargetMode(args)).toThrow(/usage/i)
    },
  )

  it('fails closed on a local backend instead of falling back from checkpoint mode', async () => {
    const priorBackend = process.env.FRESHELL_E2E_BACKEND
    process.env.FRESHELL_E2E_BACKEND = 'local'
    try {
      await expect(runManagedProviderEnvironmentTarget(['--checkpoint']))
        .rejects.toThrow('Checkpoint acceptance requires configured Cloud')
    } finally {
      if (priorBackend === undefined) delete process.env.FRESHELL_E2E_BACKEND
      else process.env.FRESHELL_E2E_BACKEND = priorBackend
    }
  })
})
