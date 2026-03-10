import { afterEach, describe, expect, it } from 'vitest'
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
})
