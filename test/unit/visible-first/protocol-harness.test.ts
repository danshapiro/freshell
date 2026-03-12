// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { inspectVisibleFirstTranscript } from '@test/helpers/visible-first/acceptance-contract'
import { createProtocolHarness } from '@test/helpers/visible-first/protocol-harness'

describe('createProtocolHarness', () => {
  let harness: Awaited<ReturnType<typeof createProtocolHarness>> | null = null

  afterEach(async () => {
    await harness?.dispose()
    harness = null
  })

  it('starts the real websocket handler, captures the transcript, and proves legacy messages stayed absent', async () => {
    harness = await createProtocolHarness()

    const client = await harness.connect()
    await client.sendHello()

    const ready = await client.waitForMessage((message) => message.type === 'ready')

    expect(ready).toMatchObject({
      type: 'ready',
      serverInstanceId: expect.stringMatching(/^srv-/),
    })
    expect(client.getTranscript().map((message) => message.type)).toContain('ready')
    expect(client.getRawTranscript()[0]).toContain('"type":"ready"')
    expect(() => client.assertNoLegacyMessages()).not.toThrow()

    await client.close()
  })

  it('reports forbidden websocket types separately from forbidden hello capabilities', async () => {
    harness = await createProtocolHarness()

    const client = await harness.connect()
    await client.sendHello({
      capabilities: {
        sessionsPatchV1: true,
        uiScreenshotV1: true,
      },
    })

    await client.waitForMessage((message) => message.type === 'ready')
    harness.broadcast({ type: 'sessions.updated', projects: [] })
    await client.waitForMessage((message) => message.type === 'sessions.updated')

    expect(inspectVisibleFirstTranscript(client.getCapturedTranscript())).toEqual({
      forbiddenTypes: ['sessions.updated'],
      forbiddenCapabilities: ['sessionsPatchV1'],
    })

    await client.close()
  })
})
