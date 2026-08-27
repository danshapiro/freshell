import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startExternalServer,
  type ExternalServerHandle,
} from '../../../../port/oracle/harness/external-server.js'
import { WsCaptureClient, type CapturedMessage } from '../../../../port/oracle/harness/ws-capture-client.js'
import {
  normalizeTranscript,
  diffNormalized,
  type NormalizedMessage,
  type NormalizedDiff,
} from '../../../../port/oracle/harness/normalize.js'

/**
 * Rust discovery rot-guard. The server boots from the worktree so its
 * committed extension registry is non-empty. A mutation of that field must be
 * visible to the normalized comparator, keeping this check non-vacuous.
 */

interface Boot {
  pid: number
  port: number
  handshake: CapturedMessage[]
}

describe('T0 Rust known-provider discovery and comparator bite', () => {
  const spawned: ExternalServerHandle[] = []
  let first: Boot | null = null
  let second: Boot | null = null
  let normFirst: NormalizedMessage[] = []
  let normSecond: NormalizedMessage[] = []
  let diff: NormalizedDiff | null = null

  async function bootAndCapture(tag: string): Promise<Boot> {
    const server = await startExternalServer({ provider: tag })
    spawned.push(server)
    const client = new WsCaptureClient(server.wsUrl, server.token)
    try {
      await client.connect()
      return { pid: server.pid, port: server.port, handshake: await client.captureHandshake(60_000) }
    } finally {
      await client.close().catch(() => {})
      await server.stop().catch(() => {})
    }
  }

  beforeAll(async () => {
    first = await bootAndCapture('oracle-discovery-rust-1')
    second = await bootAndCapture('oracle-discovery-rust-2')
    normFirst = normalizeTranscript(first.handshake).normalized
    normSecond = normalizeTranscript(second.handshake).normalized
    diff = diffNormalized(normFirst, normSecond)
  }, 240_000)

  afterAll(async () => {
    for (const server of spawned) await server.stop().catch(() => {})
  })

  function findKnownProviders(value: unknown): unknown {
    if (!value || typeof value !== 'object') return undefined
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findKnownProviders(item)
        if (found !== undefined) return found
      }
      return undefined
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'knownProviders') return nested
      const found = findKnownProviders(nested)
      if (found !== undefined) return found
    }
    return undefined
  }

  it('boots two owned Rust servers on non-reserved ports', () => {
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(first!.port).not.toBe(3001)
    expect(second!.port).not.toBe(3001)
    expect(first!.pid).not.toBe(second!.pid)
  })

  it('discovers a non-empty provider registry', () => {
    const providers = findKnownProviders(normFirst)
    expect(Array.isArray(providers) && providers.length > 0, `knownProviders=${JSON.stringify(providers)}`).toBe(true)
  })

  it('keeps the discovery comparator sensitive to a one-field mutation', () => {
    expect(diff!.equal).toBe(true)
    const mutated = structuredClone(normFirst) as NormalizedMessage[]
    let changed = false
    const mutate = (value: unknown): void => {
      if (changed || !value || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const item of value) mutate(item)
        return
      }
      for (const [key, nested] of Object.entries(value)) {
        if (key === 'knownProviders' && Array.isArray(nested) && nested.length > 0) {
          nested[0] = `${String(nested[0])}-mutated`
          changed = true
          return
        }
        mutate(nested)
      }
    }
    mutate(mutated)
    expect(changed).toBe(true)
    expect(diffNormalized(normFirst, mutated).equal).toBe(false)
  })

  it('reaps every owned server process', async () => {
    for (const boot of [first!, second!]) {
      let gone = false
      const start = Date.now()
      while (!gone && Date.now() - start < 10_000) {
        try {
          process.kill(boot.pid, 0)
          await new Promise((resolve) => setTimeout(resolve, 100))
        } catch {
          gone = true
        }
      }
      expect(gone, `Rust server ${boot.pid} should be gone`).toBe(true)
    }
  })
})
