import { test, expect } from '../helpers/fixtures.js'

test.describe('Tab recency sync', () => {
  test('rapid terminal input sends a bounded number of tab activity pushes', async ({
    freshellPage,
    harness,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    await freshellPage.waitForTimeout(1000)
    await harness.clearSentWsMessages()
    await freshellPage.waitForTimeout(250)
    expect((await harness.getSentWsMessages()).filter((message: any) => message?.type === 'tabs.sync.push')).toHaveLength(0)

    const startBucket = await freshellPage.evaluate(() => Math.floor(Date.now() / 60_000) * 60_000)
    await terminal.typeInTerminal('aaaaaaaaaaaaaaaaaaaaaaaa')
    await freshellPage.waitForTimeout(500)
    const endBucket = await freshellPage.evaluate(() => Math.floor(Date.now() / 60_000) * 60_000)

    const messages = await harness.getSentWsMessages()
    const pushes = messages.filter((message: any) => message?.type === 'tabs.sync.push')
    const allowedActivityPushes = endBucket > startBucket ? 2 : 1

    expect(pushes.length).toBeLessThanOrEqual(allowedActivityPushes)
    const updatedAtBuckets = pushes
      .map((push: any) => push.records?.[0]?.updatedAt)
      .filter((updatedAt: any): updatedAt is number => typeof updatedAt === 'number')
    expect(updatedAtBuckets).toHaveLength(pushes.length)
    expect(new Set(updatedAtBuckets).size).toBeLessThanOrEqual(allowedActivityPushes)
    for (const updatedAt of updatedAtBuckets) {
      expect(updatedAt % 60_000).toBe(0)
    }
  })
})
