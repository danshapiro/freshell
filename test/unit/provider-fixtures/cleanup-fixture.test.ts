// @vitest-environment node
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createClaudeFixture } from '../../integration/providers/claude-local-provider.mjs'
import { cleanupFixture } from '../../support/cleanup-fixture.mjs'
import { stopFixtureProcess, type FixtureProcess } from '../../support/stop-fixture-process.js'

describe('fixture teardown', () => {
  it('releases the fixture after exact-child shutdown fails and preserves the failure', async () => {
    const fixture = await createClaudeFixture()
    const refused = new Error('signal refused')
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill() { throw refused },
    }) satisfies FixtureProcess
    let providerClosed = false
    try {
      const error = await cleanupFixture(fixture,
        () => stopFixtureProcess(child),
        async () => { providerClosed = true },
      ).catch((error: Error) => error)

      expect(error).toMatchObject({ cause: refused })
      expect(providerClosed).toBe(true)
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('still cleans owned files when closing the provider fails', async () => {
    const fixture = await createClaudeFixture()
    const refused = new Error('provider close failed')
    try {
      await expect(cleanupFixture(fixture, async () => { throw refused })).rejects.toBe(refused)
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports every teardown failure, including owner cleanup refusal', async () => {
    const stopFailure = new Error('stop failed')
    const providerFailure = new Error('provider close failed')
    const ownerFailure = new Error('fixture owner could not contain its writer')
    const error = await cleanupFixture({ cleanup: async () => { throw ownerFailure } },
      async () => { throw stopFailure },
      async () => { throw providerFailure },
    ).catch((error: AggregateError) => error)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([stopFailure, providerFailure, ownerFailure])
  })
})
