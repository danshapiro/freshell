import { expect, test } from '../helpers/fixtures.js'

type TerminalSnapshot = {
  terminalId: string
  streamId: string
  attachRequestId: string
}

function createOpenCodeLikeReplay(seqBase: number) {
  const marker = '__FRESHELL_REPLAY_PROGRESS__'
  const chunks = Array.from({ length: 96 }, (_unused, index) => (
    `\x1b[${30 + (index % 8)}m${marker}${(seqBase + index).toString()}`
  ))
  const data = chunks.join('')
  const segments = chunks.map((chunk, index) => ({
    seqStart: seqBase + index,
    seqEnd: seqBase + index,
    endOffset: chunks.slice(0, index + 1).join('').length,
    rawFrameCount: 1,
    barrier: 'control' as const,
  }))
  return { chunks, data, marker, segments }
}

test.describe('OpenCode replay write progression', () => {
  test('submits barrier-heavy replay to real xterm in bounded writes', async ({ freshellPage, harness, terminal }) => {
    const page = freshellPage
    await terminal.waitForPrompt({ timeout: 30_000 })

    const snapshot = await page.waitForFunction((): TerminalSnapshot | null => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const activeTabId = state?.tabs?.activeTabId
      const findTerminal = (node: any): any => {
        if (!node) return undefined
        if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
        if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
        return undefined
      }
      const content = findTerminal(state?.panes?.layouts?.[activeTabId])
      if (
        typeof content?.terminalId !== 'string'
        || typeof content?.streamId !== 'string'
      ) {
        return null
      }
      const sent = harness?.getSentWsMessages?.() ?? []
      const attach = [...sent].reverse().find((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg.terminalId === content.terminalId
        && typeof msg.attachRequestId === 'string'
      )
      if (!attach) return null
      return {
        terminalId: content.terminalId,
        streamId: content.streamId,
        attachRequestId: attach.attachRequestId,
      }
    }, { timeout: 30_000 })
      .then((handle) => handle.jsonValue() as Promise<TerminalSnapshot>)

    const seqBase = 100_000
    const replay = createOpenCodeLikeReplay(seqBase)
    await harness.clearTerminalWriteEvents()

    await harness.receiveWsMessage({
      type: 'terminal.output.batch',
      terminalId: snapshot.terminalId,
      streamId: snapshot.streamId,
      attachRequestId: snapshot.attachRequestId,
      source: 'replay',
      seqStart: seqBase,
      seqEnd: seqBase + replay.chunks.length - 1,
      data: replay.data,
      serializedBytes: replay.data.length + 512,
      segments: replay.segments,
    })

    await expect.poll(async () => {
      const submitted = (await harness.getTerminalWriteEvents())
        .filter((event) =>
          event.phase === 'submitted'
          && event.terminalId === snapshot.terminalId
          && event.data.includes(replay.marker)
        )
      return submitted.map((event) => event.data).join('')
    }, { timeout: 15_000 }).toBe(replay.data)

    const submitted = (await harness.getTerminalWriteEvents())
      .filter((event) =>
        event.phase === 'submitted'
        && event.terminalId === snapshot.terminalId
        && event.data.includes(replay.marker)
      )
    expect(submitted.length).toBeLessThanOrEqual(2)

    await expect.poll(async () => {
      const written = (await harness.getTerminalWriteEvents())
        .filter((event) =>
          event.phase === 'written'
          && event.terminalId === snapshot.terminalId
          && event.data.includes(replay.marker)
        )
      return written.map((event) => event.data).join('')
    }, { timeout: 15_000 }).toBe(replay.data)
  })
})
