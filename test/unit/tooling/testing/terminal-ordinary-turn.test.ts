import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { Terminal } from '@xterm/xterm'
import { terminalBufferText } from '../../../../src/lib/terminal-buffer-text.js'

import {
  TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL,
  buildTerminalOrdinaryTurnBrowserScript,
  captureTerminalOrdinaryTurnBaseline,
  reduceTerminalOrdinaryTurnFrames,
  waitForTerminalOrdinaryTurnBaseline,
  waitForTerminalOrdinaryTurn,
  terminalOrdinaryTurnRequest,
  type TerminalOrdinaryTurnBrowserObserver,
} from '../../../../scripts/testing/terminal-ordinary-turn.js'

const target = { provider: 'claude', terminalId: 'terminal-1', streamId: 'stream-1', nativeSessionId: 'native-allocated' } as const

function terminalSnapshot() {
  return { ...target, attachStreamId: target.streamId, text: 'Ready' }
}

function baseline(frames: readonly unknown[] = []) {
  return captureTerminalOrdinaryTurnBaseline(frames, target)
}

function activity(provider: string, terminalId: string = target.terminalId, phase: string = 'busy') {
  return {
    type: `${provider}.activity.updated`,
    upsert: [{ terminalId, phase, updatedAt: 1 }],
    remove: [],
  }
}

function output(terminalId: string = target.terminalId, streamId: string = target.streamId, seqEnd = 11, data: string = 'answer') {
  return { type: 'terminal.output', terminalId, streamId, seqStart: seqEnd, seqEnd, data }
}

function complete(provider: string = target.provider, terminalId: string = target.terminalId, completionSeq = 8) {
  return { type: 'terminal.turn.complete', provider, terminalId, sessionId: target.nativeSessionId, completionSeq, at: 1, outcome: 'completed' }
}

function completeWithoutOutcome(provider: string = target.provider, terminalId: string = target.terminalId, completionSeq = 8) {
  const { outcome: _outcome, ...frame } = complete(provider, terminalId, completionSeq)
  return frame
}

describe('ordinary terminal answer in the selected native conversation', () => {
  function browser(provider: 'codex' | 'opencode' = 'codex') {
    const nativeSessionId = 'native-allocated'
    const { input: requestText, expectedAnswer } = terminalOrdinaryTurnRequest('FRESHELLA19B')
    const received: unknown[] = [{ type: 'terminal.attach.ready', ...target, headSeq: 10 }]
    const sent: unknown[] = []
    const snapshot = { ...target, nativeSessionId, attachStreamId: target.streamId, text: 'Ready' }
    const browserWindow: Record<string, any> = { __FRESHELL_TEST_HARNESS__: {
      getReceivedWsMessages: () => received, clearReceivedWsMessages: () => { received.length = 0 },
      getSentWsMessages: () => sent, clearSentWsMessages: () => { sent.length = 0 },
      getTerminalSnapshot: (id: string) => id === target.terminalId ? snapshot : null,
    } }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL]
    const prepare = () => observer.prepareBeforeSend(provider, target.terminalId, nativeSessionId, expectedAnswer)
    const captured = prepare()
    const read = async () => observer.observeAfterSend(captured, requestText)
    const submit = () => {
      sent.push({ type: 'terminal.input', terminalId: target.terminalId, data: requestText + '\r' })
      received.push(activity(provider))
    }
    const completion = (patch = {}) => ({ ...complete(provider), sessionId: nativeSessionId, ...patch })
    return { nativeSessionId, expectedAnswer, requestText, received, sent, snapshot, prepare, read, submit, completion, browserWindow, observer }
  }

  it.each(['codex', 'opencode'] as const)('rejects prompt echo and loading output without a rendered %s answer', async provider => {
    const f = browser(provider)
    f.submit()
    f.snapshot.text = f.requestText + '\nThinking...'
    f.received.push(output(target.terminalId, target.streamId, 11, f.snapshot.text), f.completion())
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
  })

  it.each(['foreign-native', undefined])('rejects completion for native session %s even with a rendered answer', async sessionId => {
    const f = browser()
    f.submit()
    f.snapshot.text = f.expectedAnswer
    f.received.push(output(), f.completion({ sessionId }))
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
    expect(await f.read()).toMatchObject({ completionSeen: false, completionOutcome: null })
  })

  it('does not treat raw answer bytes as proof that xterm rendered the answer', async () => {
    const f = browser()
    f.submit()
    f.snapshot.text = f.requestText
    f.received.push(output(target.terminalId, target.streamId, 11, f.expectedAnswer), f.completion())
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
  })

  it.each([
    ['codex', 'output-first'], ['codex', 'completion-first'],
    ['opencode', 'output-first'], ['opencode', 'completion-first'],
  ] as const)('accepts the fresh rendered %s answer and exact native completion in %s order across buffer rollover', async (provider, order) => {
    const f = browser(provider)
    expect(f.requestText).not.toContain(f.expectedAnswer)
    f.submit()
    const answer = () => {
      f.snapshot.text = f.expectedAnswer.slice(0, 8) + '\n' + f.expectedAnswer.slice(8)
      f.received.push(output(target.terminalId, target.streamId, 11, f.expectedAnswer))
    }
    if (order === 'output-first') answer()
    else f.received.push(f.completion())
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
    f.received.length = 0
    f.sent.length = 0
    if (order === 'output-first') f.received.push(f.completion())
    else answer()
    const result = await waitForTerminalOrdinaryTurn(f.read, 0)
    expect(result).toMatchObject({ renderedAnswerSeen: true, completionSeen: true, completionOutcome: 'completed' })
    expect(JSON.stringify(result)).not.toContain(f.expectedAnswer)
    expect(JSON.stringify(result)).not.toContain(f.requestText)
  })

  it('rejects a rendered answer that was already present before submission', () => {
    const f = browser()
    f.snapshot.text = f.expectedAnswer
    f.received.push({ type: 'terminal.attach.ready', ...target, headSeq: 10 })
    expect(f.prepare()).toBeNull()
  })

  it('baselines only the allocated native completion and rejects its retained replay', async () => {
    const f = browser()
    f.received.push({ type: 'terminal.attach.ready', ...target, headSeq: 10 },
      f.completion({ completionSeq: 7 }), f.completion({ sessionId: 'foreign-native', completionSeq: 99 }))
    const captured = f.prepare()
    expect(captured).toMatchObject({ nativeSessionId: f.nativeSessionId, completionSeq: 7 })
    const read = async () => f.observer.observeAfterSend(captured, f.requestText)
    f.submit()
    f.snapshot.text = f.expectedAnswer
    f.received.push(output(), f.completion({ completionSeq: 7 }))
    await expect(waitForTerminalOrdinaryTurn(read, 0)).rejects.toThrow(/timed out/)
    f.received.push(f.completion())
    await expect(waitForTerminalOrdinaryTurn(read, 0)).resolves.toMatchObject({ completionSeq: 8, renderedAnswerSeen: true })
  })

  it.each(['normal', 'alternate'])('observes the actual xterm %s buffer after writes, including wrapped styled answers', async buffer => {
    const f = browser('opencode')
    const terminal = new Terminal({ cols: 20, rows: 12, allowProposedApi: true })
    const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve))
    f.browserWindow.__FRESHELL_TEST_HARNESS__.getTerminalSnapshot = (id: string) => id === target.terminalId
      ? { ...f.snapshot, text: terminalBufferText(terminal.buffer.active) } : null
    try {
      if (buffer === 'alternate') await write('\x1b[?1049h')
      f.submit()
      await write(f.requestText + '\r\nThinking...')
      f.received.push(output(target.terminalId, target.streamId, 11, f.expectedAnswer), f.completion())
      await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
      await write('\r\nResponse: \x1b[32m' + f.expectedAnswer + '\x1b[0m')
      await expect(waitForTerminalOrdinaryTurn(f.read, 0)).resolves.toMatchObject({ renderedAnswerSeen: true, completionSeen: true })
    } finally { terminal.dispose() }
  })

  it.each([
    { nativeSessionId: 'foreign-native' }, { terminalId: 'foreign-terminal' },
    { streamId: 'foreign-stream' }, { attachStreamId: 'foreign-stream' },
  ])('rejects rendered answer from another terminal allocation %j', async patch => {
    const f = browser()
    f.submit()
    Object.assign(f.snapshot, patch, { text: f.expectedAnswer })
    f.received.push(output(), f.completion())
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
  })

  it('ignores a foreign failure then reports the allocated conversation failure immediately', async () => {
    const f = browser()
    f.submit()
    f.received.push(f.completion({ sessionId: 'foreign-native', outcome: 'failed', completionSeq: 30 }))
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/timed out/)
    f.received.push(f.completion({ outcome: 'failed' }))
    await expect(waitForTerminalOrdinaryTurn(f.read, 0)).rejects.toThrow(/failed.*sequence 8/)
  })
})

describe('body-free terminal ordinary-turn reduction', () => {
  it('retains a targeted new failure distinctly from absent completion, without error bodies', () => {
    const prior = baseline([complete(target.provider, target.terminalId, 7)])
    const absent = reduceTerminalOrdinaryTurnFrames([], prior)
    const failed = reduceTerminalOrdinaryTurnFrames([{ ...complete(), outcome: 'failed', error: 'PRIVATE_ERROR_BODY' }], prior)
    expect(absent).toMatchObject({ completionSeen: false, completionOutcome: null, completionSeq: null })
    expect(failed).toMatchObject({ completionSeen: false, completionOutcome: 'failed', completionSeq: 8 })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_ERROR_BODY')
  })

  it.each([
    { completionSeq: 7 }, { provider: 'codex' }, { terminalId: 'foreign' }, { streamId: 'foreign' },
  ])('ignores stale or wrongly targeted failed completion %j', patch => {
    const summary = reduceTerminalOrdinaryTurnFrames([{ ...complete(), outcome: 'failed', ...patch }],
      baseline([complete(target.provider, target.terminalId, 7)]))
    expect(summary).toMatchObject({ completionSeen: false, completionOutcome: null, completionSeq: null })
  })

  it('stops the production waiter at the first matching failed result, even without activity or output', async () => {
    const read = vi.fn(async () => ({ requestInputSeen: true, renderedAnswerSeen: false,
      ...reduceTerminalOrdinaryTurnFrames([{ ...complete(), outcome: 'failed' }], baseline()) }))
    await expect(waitForTerminalOrdinaryTurn(read, 0)).rejects.toThrow(/failed.*completion sequence 8/)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not attribute a streamless failure after a replacement attach to the submitted stream', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: 'replacement-stream', headSeq: 0 },
      { ...complete(), outcome: 'failed' },
    ], baseline())
    expect(summary).toMatchObject({ completionSeen: false, completionOutcome: null, completionSeq: null })
  })

  it('retains a failed outcome through the installed browser observer when the frame buffer rolls over', () => {
    const received: unknown[] = [{ type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 0 }]
    const sent: unknown[] = []
    const browserWindow: Record<string, any> = { __FRESHELL_TEST_HARNESS__: {
      getTerminalSnapshot: () => terminalSnapshot(),
      getReceivedWsMessages: () => received, clearReceivedWsMessages: () => { received.length = 0 },
      getSentWsMessages: () => sent, clearSentWsMessages: () => { sent.length = 0 },
    } }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL]
    const captured = observer.prepareBeforeSend(target.provider, target.terminalId, target.nativeSessionId, 'answer')
    received.push({ ...complete(), outcome: 'failed' })
    expect(observer.observeAfterSend(captured, 'request')).toMatchObject({ completionOutcome: 'failed', completionSeq: 8 })
    received.length = 0
    expect(observer.observeAfterSend(captured, 'request')).toMatchObject({ completionOutcome: 'failed', completionSeq: 8 })
  })

  it('remembers a replacement stream after its attach frame leaves the browser buffer', () => {
    const received: unknown[] = [{ type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 0 }]
    const sent: unknown[] = []
    const browserWindow: Record<string, any> = { __FRESHELL_TEST_HARNESS__: {
      getTerminalSnapshot: () => terminalSnapshot(),
      getReceivedWsMessages: () => received, clearReceivedWsMessages: () => { received.length = 0 },
      getSentWsMessages: () => sent, clearSentWsMessages: () => { sent.length = 0 },
    } }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL]
    const captured = observer.prepareBeforeSend(target.provider, target.terminalId, target.nativeSessionId, 'answer')
    received.push({ type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: 'replacement-stream', headSeq: 0 })
    observer.observeAfterSend(captured, 'request')
    received.length = 0
    received.push({ ...complete(), outcome: 'failed' })
    expect(observer.observeAfterSend(captured, 'request')).toMatchObject({ completionOutcome: null, completionSeq: null })
  })

  it.each(['output-first', 'completion-first'] as const)('waits for successful output and completion in %s order', async order => {
    const events = order === 'output-first' ? [output(), complete()] : [complete(), output()]
    const frames: unknown[] = [activity(target.provider)]
    let reads = 0
    const observed = await waitForTerminalOrdinaryTurn(async () => {
      frames.push(events[reads++])
      return { requestInputSeen: true, renderedAnswerSeen: true, ...reduceTerminalOrdinaryTurnFrames(frames, baseline()) }
    }, 1000, 0)
    expect(reads).toBe(2)
    expect(observed).toMatchObject({ completionSeen: true, completionOutcome: 'completed', outputSeen: true })
  })

  it('waits for the attach-ready baseline before a live turn can be submitted', async () => {
    const ready = baseline([
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 6 },
    ])
    let attempts = 0

    const captured = await waitForTerminalOrdinaryTurnBaseline(async () => {
      attempts += 1
      return attempts < 3 ? null : ready
    }, 1_000, 0)

    expect(attempts).toBe(3)
    expect(captured).toEqual(ready)
  })

  it('stops checking when no attach-ready baseline arrives by the deadline', async () => {
    let attempts = 0

    const captured = await waitForTerminalOrdinaryTurnBaseline(async () => {
      attempts += 1
      return null
    }, 0, 0)

    expect(captured).toBeNull()
    expect(attempts).toBe(1)
  })

  it('captures only same-terminal, same-stream output and matching completion baselines', () => {
    const captured = captureTerminalOrdinaryTurnBaseline([
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 10 },
      output(target.terminalId, target.streamId, 12, 'private pre-send output'),
      output(target.terminalId, 'old-stream', 99, 'other stream'),
      output('other-terminal', target.streamId, 100, 'other terminal'),
      complete(target.provider, target.terminalId, 9),
      complete('codex', target.terminalId, 40),
      { type: 'terminal.turn.complete', provider: target.provider, terminalId: 'other-terminal', completionSeq: 50 },
    ], target)

    expect(captured).toEqual({
      provider: target.provider,
      terminalId: target.terminalId,
      streamId: target.streamId,
      nativeSessionId: target.nativeSessionId,
      outputSeq: 12,
      completionSeq: 9,
    })
  })

  it('requires matching activity, fresh nonempty same-stream output, and advanced completion', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      activity('claude'),
      output(target.terminalId, target.streamId, 11, 'private answer bytes'),
      complete(target.provider, target.terminalId, 9),
    ], baseline([
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 10 },
      complete(target.provider, target.terminalId, 8),
    ]))

    expect(summary).toEqual({
      activitySeen: true,
      outputSeen: true,
      outputFrameCount: 1,
      outputSeq: 11,
      completionSeen: true,
      completionSeq: 9,
      completionOutcome: 'completed',
    })
    expect(summary).not.toHaveProperty('data')
    expect(summary).not.toHaveProperty('frames')
  })

  it('accepts a pending Codex activity update', () => {
    const codexTarget = { provider: 'codex', terminalId: 'codex-1', streamId: 'codex-stream', nativeSessionId: target.nativeSessionId } as const
    const summary = reduceTerminalOrdinaryTurnFrames([
      { type: 'codex.activity.updated', upsert: [{ terminalId: codexTarget.terminalId, phase: 'pending' }] },
      output(codexTarget.terminalId, codexTarget.streamId, 4),
      { ...complete('codex', codexTarget.terminalId, 1), outcome: 'completed' },
    ], captureTerminalOrdinaryTurnBaseline([], codexTarget))

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: true, completionSeen: true })
  })

  it('accepts Codex completion only when the outcome explicitly succeeded', () => {
    const codexTarget = { provider: 'codex', terminalId: 'codex-1', streamId: 'codex-stream', nativeSessionId: target.nativeSessionId } as const
    const frames = [
      { type: 'codex.activity.updated', upsert: [{ terminalId: codexTarget.terminalId, phase: 'busy' }] },
      output(codexTarget.terminalId, codexTarget.streamId, 4),
    ]
    const codexBaseline = captureTerminalOrdinaryTurnBaseline([], codexTarget)

    const failed = reduceTerminalOrdinaryTurnFrames([
      ...frames,
      { ...complete('codex', codexTarget.terminalId, 1), outcome: 'failed' },
    ], codexBaseline)
    const unavailable = reduceTerminalOrdinaryTurnFrames([
      ...frames,
      completeWithoutOutcome('codex', codexTarget.terminalId, 1),
    ], codexBaseline)
    const completed = reduceTerminalOrdinaryTurnFrames([
      ...frames,
      { ...complete('codex', codexTarget.terminalId, 1), outcome: 'completed' },
    ], codexBaseline)
    const completedAfterProvisional = reduceTerminalOrdinaryTurnFrames([
      ...frames,
      complete('codex', codexTarget.terminalId, 1),
      { ...complete('codex', codexTarget.terminalId, 1), outcome: 'completed' },
    ], codexBaseline)

    expect(failed).toMatchObject({ outputSeen: true, completionSeen: false, completionSeq: 1, completionOutcome: 'failed' })
    expect(unavailable).toMatchObject({ outputSeen: true, completionSeen: false, completionSeq: null })
    expect(completed).toMatchObject({ outputSeen: true, completionSeen: true, completionSeq: 1 })
    expect(completedAfterProvisional).toMatchObject({ outputSeen: true, completionSeen: true, completionSeq: 1 })
  })

  it.each(['claude', 'codex', 'opencode'] as const)(
    'requires an explicit successful outcome for %s completion', (provider) => {
      const providerTarget = { provider, terminalId: `${provider}-1`, streamId: `${provider}-stream`, nativeSessionId: target.nativeSessionId } as const
      const shared = [
        activity(provider, providerTarget.terminalId),
        output(providerTarget.terminalId, providerTarget.streamId, 4),
      ]
      const providerBaseline = captureTerminalOrdinaryTurnBaseline([], providerTarget)

      const missing = reduceTerminalOrdinaryTurnFrames([
        ...shared,
        completeWithoutOutcome(provider, providerTarget.terminalId, 1),
      ], providerBaseline)
      const failed = reduceTerminalOrdinaryTurnFrames([
        ...shared,
        { ...complete(provider, providerTarget.terminalId, 1), outcome: 'failed' },
      ], providerBaseline)
      const completed = reduceTerminalOrdinaryTurnFrames([
        ...shared,
        { ...complete(provider, providerTarget.terminalId, 1), outcome: 'completed' },
      ], providerBaseline)

      expect(missing).toMatchObject({ outputSeen: true, completionSeen: false, completionSeq: null })
      expect(failed).toMatchObject({ outputSeen: true, completionSeen: false, completionSeq: 1, completionOutcome: 'failed' })
      expect(completed).toMatchObject({ outputSeen: true, completionSeen: true, completionSeq: 1 })
      expect(JSON.stringify(completed)).not.toContain('data')
    },
  )

  it('counts a nonempty output batch without retaining its body or segment data', () => {
    const batch = {
      type: 'terminal.output.batch',
      terminalId: target.terminalId,
      streamId: target.streamId,
      seqStart: 13,
      seqEnd: 14,
      data: 'private batch body',
      segments: [{ seqStart: 13, seqEnd: 14, endOffset: 18, data: 'private segment body', rawFrameCount: 1 }],
    }
    const summary = reduceTerminalOrdinaryTurnFrames([
      activity('claude'),
      batch,
      complete(),
    ], baseline())

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: true, outputFrameCount: 1, outputSeq: 14, completionSeen: true })
    expect(JSON.stringify(summary)).not.toContain('private batch body')
    expect(JSON.stringify(summary)).not.toContain('private segment body')
  })

  it.each([
    ['wrong terminal activity', [activity('claude', 'other-terminal'), output(), complete()], false, true, true],
    ['wrong provider activity', [activity('codex'), output(), complete()], false, true, true],
    ['wrong terminal output', [activity('claude'), output('other-terminal'), complete()], true, false, true],
    ['wrong stream output', [activity('claude'), output(target.terminalId, 'other-stream'), complete()], true, false, true],
    ['wrong terminal completion', [activity('claude'), output(), complete(target.provider, 'other-terminal')], true, true, false],
    ['wrong provider completion', [activity('claude'), output(), complete('codex')], true, true, false],
  ])('tracks only matching evidence for %s', (_label, frames, activitySeen, outputSeen, completionSeen) => {
    const summary = reduceTerminalOrdinaryTurnFrames(frames, baseline())
    expect(summary.activitySeen).toBe(activitySeen)
    expect(summary.outputSeen).toBe(outputSeen)
    expect(summary.completionSeen).toBe(completionSeen)
  })

  it('does not count empty or baseline-stale output', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      activity('claude'),
      output(target.terminalId, target.streamId, 10, ''),
      output(target.terminalId, target.streamId, 10, 'stale output'),
      complete(),
    ], baseline([
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 10 },
    ]))

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: false, outputFrameCount: 0, completionSeen: true })
  })

  it.each([
    ['activity, output, completion', [activity('claude'), output(), complete()]],
    ['activity, completion, output', [activity('claude'), complete(), output()]],
    ['output, activity, completion', [output(), activity('claude'), complete()]],
    ['output, completion, activity', [output(), complete(), activity('claude')]],
    ['completion, activity, output', [complete(), activity('claude'), output()]],
    ['completion, output, activity', [complete(), output(), activity('claude')]],
  ])('collects matching evidence regardless of arrival order: %s', (_order, frames) => {
    const summary = reduceTerminalOrdinaryTurnFrames(frames, baseline())

    expect(summary).toMatchObject({
      activitySeen: true,
      outputSeen: true,
      outputFrameCount: 1,
      outputSeq: 11,
      completionSeen: true,
      completionSeq: 8,
      completionOutcome: 'completed',
    })
  })

  it('requires completion sequence advancement beyond the captured baseline', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      activity('claude'),
      output(),
      complete(target.provider, target.terminalId, 8),
    ], baseline([complete(target.provider, target.terminalId, 8)]))

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: true, completionSeen: false, completionSeq: null })
  })

  it('installs a browser observer that returns only safe baseline and post-send facts', () => {
    const outputSentinel = 'PRIVATE_TERMINAL_RESPONSE_SENTINEL_36c1'
    const promptSentinel = 'PRIVATE_TERMINAL_PROMPT_SENTINEL_a248'
    const received: unknown[] = [
      { type: 'terminal.attach.ready', terminalId: 'other-terminal', streamId: 'other', headSeq: 1000 },
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: 'old-stream', headSeq: 80 },
      output(target.terminalId, 'old-stream', 81, outputSentinel),
      complete(target.provider, target.terminalId, 7),
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 10 },
    ]
    const sent: unknown[] = [{ type: 'terminal.input', terminalId: target.terminalId, data: promptSentinel }]
    const snapshot = terminalSnapshot()
    const harness = {
      getTerminalSnapshot: () => snapshot,
      getReceivedWsMessages: () => received,
      clearReceivedWsMessages: () => { received.length = 0 },
      getSentWsMessages: () => sent,
      clearSentWsMessages: () => { sent.length = 0 },
    }
    const browserWindow: Record<string, unknown> = { __FRESHELL_TEST_HARNESS__: harness }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL] as TerminalOrdinaryTurnBrowserObserver

    const captured = observer.prepareBeforeSend(target.provider, target.terminalId, target.nativeSessionId, outputSentinel)
    if (!captured) throw new Error('expected a ready terminal baseline')
    expect(captured).toEqual({
      provider: target.provider,
      terminalId: target.terminalId,
      streamId: target.streamId,
      nativeSessionId: target.nativeSessionId,
      outputSeq: 10,
      completionSeq: 7,
    })
    expect(received).toEqual([])
    expect(sent).toEqual([])
    expect(JSON.stringify(captured)).not.toContain(outputSentinel)

    received.push(
      activity('claude'),
      output(target.terminalId, target.streamId, 11, outputSentinel),
      complete(target.provider, target.terminalId, 8),
    )
    sent.push(
      { type: 'terminal.input', terminalId: 'other-terminal', data: promptSentinel },
      { type: 'terminal.input', terminalId: target.terminalId, data: promptSentinel },
    )
    snapshot.text = outputSentinel
    const observed = observer.observeAfterSend(captured, promptSentinel)
    expect(observed).toEqual({
      requestInputSeen: true,
      renderedAnswerSeen: true,
      activitySeen: true,
      outputSeen: true,
      outputFrameCount: 1,
      outputSeq: 11,
      completionSeen: true,
      completionSeq: 8,
      completionOutcome: 'completed',
    })
    expect(JSON.stringify(observed)).not.toContain(outputSentinel)
    expect(JSON.stringify(observed)).not.toContain(promptSentinel)
  })

  it('retains body-free turn evidence when the received-message buffer rolls over between polls', () => {
    const outputSentinel = 'PRIVATE_TERMINAL_RESPONSE_SENTINEL_rolling'
    const promptSentinel = 'PRIVATE_TERMINAL_PROMPT_SENTINEL_rolling'
    const received: unknown[] = []
    const sent: unknown[] = []
    const snapshot = terminalSnapshot()
    const recordReceivedWsMessage = (message: unknown) => {
      received.push(message)
      if (received.length > 500) received.shift()
    }
    recordReceivedWsMessage({
      type: 'terminal.attach.ready',
      terminalId: target.terminalId,
      streamId: target.streamId,
      headSeq: 10,
    })
    const harness = {
      getTerminalSnapshot: () => snapshot,
      getReceivedWsMessages: () => [...received],
      clearReceivedWsMessages: () => { received.length = 0 },
      getSentWsMessages: () => [...sent],
      clearSentWsMessages: () => { sent.length = 0 },
    }
    const browserWindow: Record<string, unknown> = { __FRESHELL_TEST_HARNESS__: harness }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL] as TerminalOrdinaryTurnBrowserObserver

    const captured = observer.prepareBeforeSend(target.provider, target.terminalId, target.nativeSessionId, outputSentinel)
    if (!captured) throw new Error('expected a ready terminal baseline')
    recordReceivedWsMessage(activity(target.provider))
    recordReceivedWsMessage(output(target.terminalId, target.streamId, 11, outputSentinel))
    snapshot.text = outputSentinel
    sent.push({ type: 'terminal.input', terminalId: target.terminalId, data: promptSentinel })
    const firstObservation = observer.observeAfterSend(captured, promptSentinel)
    expect(firstObservation).toMatchObject({
      requestInputSeen: true,
      activitySeen: true,
      outputSeen: true,
      completionSeen: false,
    })

    for (let index = 0; index < 501; index += 1) {
      recordReceivedWsMessage({ type: 'terminal.keepalive', index })
    }
    recordReceivedWsMessage(complete(target.provider, target.terminalId, 9))

    const completedObservation = observer.observeAfterSend(captured, promptSentinel)
    expect(completedObservation).toMatchObject({
      requestInputSeen: true,
      activitySeen: true,
      outputSeen: true,
      outputFrameCount: 1,
      outputSeq: 11,
      completionSeen: true,
      completionSeq: 9,
    })
    expect(JSON.stringify(completedObservation)).not.toContain(outputSentinel)
    expect(JSON.stringify(completedObservation)).not.toContain(promptSentinel)
  })

  it('does not clear history or invent a baseline without a ready stream for the terminal', () => {
    const received: unknown[] = [
      { type: 'terminal.attach.ready', terminalId: 'other-terminal', streamId: 'other-stream', headSeq: 10 },
    ]
    const sent: unknown[] = []
    const browserWindow: Record<string, unknown> = {
      __FRESHELL_TEST_HARNESS__: {
        getReceivedWsMessages: () => received,
        clearReceivedWsMessages: () => { received.length = 0 },
        getSentWsMessages: () => sent,
        clearSentWsMessages: () => { sent.length = 0 },
      },
    }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL] as TerminalOrdinaryTurnBrowserObserver

    expect(observer.prepareBeforeSend(target.provider, target.terminalId, target.nativeSessionId, 'answer')).toBeNull()
    expect(received).toHaveLength(1)
  })

  it('requires the expected request data on the selected terminal', () => {
    const received: unknown[] = [
      { type: 'terminal.attach.ready', terminalId: target.terminalId, streamId: target.streamId, headSeq: 0 },
    ]
    const sent: unknown[] = []
    const browserWindow: Record<string, unknown> = {
      __FRESHELL_TEST_HARNESS__: {
        getTerminalSnapshot: () => terminalSnapshot(),
        getReceivedWsMessages: () => received,
        clearReceivedWsMessages: () => { received.length = 0 },
        getSentWsMessages: () => sent,
        clearSentWsMessages: () => { sent.length = 0 },
      },
    }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL] as TerminalOrdinaryTurnBrowserObserver

    const captured = observer.prepareBeforeSend(target.provider, target.terminalId, target.nativeSessionId, 'answer')
    expect(captured).not.toBeNull()
    if (!captured) throw new Error('expected a ready terminal baseline')

    const expectedInput = 'request'
    sent.push({ type: 'terminal.input', terminalId: target.terminalId, data: '\r' })
    expect(observer.observeAfterSend(captured, expectedInput)).toMatchObject({ requestInputSeen: false })

    sent.length = 0
    sent.push({ type: 'terminal.input', terminalId: 'another-terminal', data: expectedInput })
    expect(observer.observeAfterSend(captured, expectedInput)).toMatchObject({ requestInputSeen: false })

    sent.length = 0
    const splitAt = Math.ceil(expectedInput.length / 2)
    sent.push(
      { type: 'terminal.input', terminalId: target.terminalId, data: expectedInput.slice(0, splitAt) },
      { type: 'terminal.input', terminalId: target.terminalId, data: '\x1b[?1;2c' },
      { type: 'terminal.input', terminalId: target.terminalId, data: '\x1b]10;rgb:0000/0000/0000\x07' },
      { type: 'terminal.input', terminalId: target.terminalId, data: '\x1bP1+r544e=78\x1b\\' },
      { type: 'terminal.input', terminalId: target.terminalId, data: expectedInput.slice(splitAt) },
      { type: 'terminal.input', terminalId: target.terminalId, data: '\r' },
    )
    expect(observer.observeAfterSend(captured, expectedInput)).toMatchObject({ requestInputSeen: true })
  })
})
