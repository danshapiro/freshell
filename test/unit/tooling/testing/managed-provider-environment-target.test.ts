import { spawn } from 'node:child_process'
import { createConnection, createServer, type AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  checkpointTcpForwarderSource,
  resolveManagedProviderEnvironmentTargetMode,
  runManagedProviderEnvironmentTarget,
} from '../../../../scripts/testing/managed-provider-environment-target.js'

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return (server.address() as AddressInfo).port
}

describe('managed provider environment target mode', () => {
  it('keeps the existing managed target as the default and selects checkpoint only explicitly', () => {
    expect(resolveManagedProviderEnvironmentTargetMode([])).toBe('managed-environment')
    expect(resolveManagedProviderEnvironmentTargetMode(['--checkpoint'])).toBe('code-checkpoint')
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
