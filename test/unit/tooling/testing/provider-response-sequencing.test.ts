import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalBufferText } from '../../../../src/lib/terminal-buffer-text.js'
import { providerStageResponse, sampleProviderResponseBrowser, sequenceProviderResponse, waitForValue,
  type ProviderResponseCompletion, type ProviderResponseSnapshot } from '../../../e2e-browser/helpers/provider-response-sequencing.js'

const terminals: Terminal[] = []
afterEach(() => {
  terminals.splice(0).forEach(terminal => terminal.dispose())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function completion(overrides: Partial<ProviderResponseCompletion> = {}): ProviderResponseCompletion {
  return {
    terminalId: 'terminal', provider: 'opencode', streamId: 'current', sessionId: 'root',
    completionSeq: 1, at: 100, outcome: 'failed', ...overrides,
  }
}

function rig(cols = 120, initial = false) {
  const terminal = new Terminal({ cols, rows: 12, allowProposedApi: true })
  terminals.push(terminal)
  const write = (text: string) => new Promise<void>(done => terminal.write(text, done))
  let snapshot: Omit<ProviderResponseSnapshot, 'text'> | null = {
    terminalId: 'terminal', paneId: 'pane', streamId: 'current', attachStreamId: 'current',
    attachRequestId: 'attach', nativeSessionId: 'root', wsReady: true, replayPending: false,
    writesPending: false, highestObservedSeq: 1, completedSeq: 1, cols, rows: 12, bufferType: 'normal',
  }
  const surface = () => snapshot && ({ ...snapshot, text: terminalBufferText(terminal.buffer.active) })
  let browserSample: (() => ReturnType<typeof sampleProviderResponseBrowser>) | undefined
  const readErrors: Error[] = []
  const read = async () => {
    const error = readErrors.shift()
    if (error) throw error
    return browserSample ? browserSample().snapshot : surface()
  }
  const response = providerStageResponse('codename-public-test', 'after_host', 'fresh-tag', initial)
  const actions: string[] = []
  const reports: string[] = []
  const scheduled: Array<() => Promise<void>> = []
  let duringPrepare: (() => Promise<void>) | undefined
  let duringSubmit: (() => void) | undefined
  const run = (waitFor: Parameters<typeof sequenceProviderResponse>[0]['waitFor'] = async (_description, probe) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await probe()
      if (result !== null) return result
      await scheduled.shift()?.()
    }
    throw new Error('bounded test timeout')
  }) => sequenceProviderResponse({
    provider: 'opencode', paneId: 'pane', terminalId: 'terminal', priorStreamId: 'old', nativeSessionId: 'root', response, read,
    prepare: async command => { actions.push('prepare'); await write(`${command}\r\n`); await duringPrepare?.() },
    submit: async () => { actions.push('submit'); duringSubmit?.() },
    report: phase => { reports.push(phase) }, timeoutMs: 240_000, waitFor,
  })
  return { write, response, actions, reports, scheduled, run, set: (value: typeof snapshot) => { snapshot = value },
    duringPrepare: (callback: () => Promise<void>) => { duringPrepare = callback },
    duringSubmit: (callback: () => void) => { duringSubmit = callback },
    failNextRead: (error: Error) => { readErrors.push(error) },
    update: (value: Partial<NonNullable<typeof snapshot>>) => { if (snapshot) Object.assign(snapshot, value) },
    useBrowserMessages: (messages: unknown[]) => {
      vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: {
        getTerminalSnapshot: surface, getTerminalWriteEvents: () => [], getReceivedWsMessages: () => messages,
        getWsReadyState: () => 'ready', getRegisteredTerminalIds: () => ['terminal'], getTerminalModes: () => null,
      } })
      // Match Playwright's serialization boundary: no module closure survives.
      const sampler = Function(`return (${sampleProviderResponseBrowser.toString()})`)() as typeof sampleProviderResponseBrowser
      browserSample = () => sampler({ id: 'terminal', nonce: response.nonce, expected: response.expected })
      return browserSample
    },
  }
}

describe('provider browser response diagnostics', () => {
  it.each(['completed', 'failed'] as const)('retains the schema-safe %s outcome without native bodies', outcome => {
    const test = rig()
    const { streamId: _stream, ...native } = completion({ outcome })
    const sample = test.useBrowserMessages([
      { type: 'terminal.attach.ready', terminalId: 'terminal', streamId: 'current' },
      { type: 'terminal.turn.complete', ...native, data: 'synthetic-body', body: 'synthetic-body',
        title: 'synthetic-body', error: { message: 'synthetic-body' } },
    ])()
    expect(sample.snapshot?.turnCompletions).toEqual([completion({ outcome })])
    expect(sample.diagnostics.received.at(-1)).toMatchObject({ provider: 'opencode', outcome, completionSeq: 1 })
    expect(JSON.stringify(sample.diagnostics)).not.toContain('synthetic-body')
    expect(JSON.stringify(sample.snapshot?.turnCompletions)).not.toContain('synthetic-body')
  })

  it('omits malformed outcome, provider, and numeric metadata rather than retaining arbitrary values', () => {
    const test = rig()
    const sample = test.useBrowserMessages([
      { type: 'terminal.turn.complete', terminalId: 'terminal', provider: 'synthetic-body', outcome: 'synthetic-body',
        completionSeq: 'synthetic-body', at: { message: 'synthetic-body' } },
    ])()
    expect(sample.snapshot?.turnCompletions).toEqual([])
    expect(JSON.stringify(sample.diagnostics)).not.toContain('synthetic-body')
  })

  it('retains completion stream context in arrival order and leaves missing context unknown', () => {
    const test = rig()
    const { streamId: _stream, ...native } = completion()
    const sample = test.useBrowserMessages([
      { type: 'terminal.turn.complete', ...native },
      { type: 'terminal.attach.ready', terminalId: 'terminal', streamId: 'old' },
      { type: 'terminal.turn.complete', ...native, completionSeq: 2 },
      { type: 'terminal.stream.changed', terminalId: 'terminal', streamId: 'current' },
      { type: 'terminal.output.batch', terminalId: 'foreign', streamId: 'foreign', data: 'synthetic-body' },
      { type: 'terminal.turn.complete', ...native, completionSeq: 3 },
    ])()
    expect(sample.snapshot?.turnCompletions?.map(({ streamId }) => streamId)).toEqual([null, 'old', 'current'])
    expect(JSON.stringify(sample.diagnostics)).not.toContain('synthetic-body')
  })
})

describe('provider response sequencing through the production waiter', () => {
  it.each([false, true])('propagates the typed current-turn failure with transientReadError=%s', async transientReadError => {
    vi.useFakeTimers()
    const test = rig()
    test.duringSubmit(() => {
      if (transientReadError) test.failNextRead(new Error('synthetic transient probe error'))
      test.update({ turnCompletions: [completion()] })
    })
    let settled: unknown
    const result = test.run(waitForValue).then(
      value => { settled = value },
      error => { settled = error },
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(test.actions).toEqual(['prepare', 'submit'])
    if (transientReadError) {
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(settled).toMatchObject({ name: 'ProviderResponseTurnFailedError', provider: 'opencode', outcome: 'failed' })
    expect(test.reports).toEqual(['pre_send', 'failed'])
    await result
  })

  it('retries unrelated errors with a matching name until the production probe succeeds', async () => {
    vi.useFakeTimers()
    const transient = new Error('synthetic transient probe error')
    transient.name = 'ProviderResponseTurnFailedError'
    const probe = vi.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce(null).mockResolvedValueOnce('ready')
    const result = waitForValue('synthetic readiness', probe, 1_000)
    await vi.advanceTimersByTimeAsync(400)
    await expect(result).resolves.toBe('ready')
    expect(probe).toHaveBeenCalledTimes(3)
  })
})

describe('provider browser response sequencing with the actual emulator', () => {
  it('fails on a newly received native failure through the exact serialized browser sampler', async () => {
    const test = rig()
    const messages: unknown[] = [{ type: 'terminal.attach.ready', terminalId: 'terminal', streamId: 'current' }]
    test.useBrowserMessages(messages)
    test.scheduled.push(async () => {
      const { streamId: _stream, ...native } = completion()
      messages.push({ type: 'terminal.turn.complete', ...native })
    })
    await expect(test.run()).rejects.toMatchObject({ name: 'ProviderResponseTurnFailedError', outcome: 'failed' })
  })

  it.each([false, true])('fails immediately on the current submitted turn failure with writesPending=%s', async writesPending => {
    const test = rig()
    test.scheduled.push(async () => {
      test.update({ writesPending, turnCompletions: [completion()] })
    }, async () => { throw new Error('failure must settle before another poll') })
    await expect(test.run()).rejects.toMatchObject({
      name: 'ProviderResponseTurnFailedError', provider: 'opencode', outcome: 'failed', completionSeq: 1,
    })
    expect(test.actions).toEqual(['prepare', 'submit'])
    expect(test.reports).toEqual(['pre_send', 'failed'])
    expect(test.scheduled).toHaveLength(1)
  })

  it('rejects a failed current turn even when the expected response is visible', async () => {
    const test = rig()
    test.scheduled.push(async () => {
      await test.write(test.response.expected)
      test.update({ turnCompletions: [completion()] })
    })
    await expect(test.run()).rejects.toMatchObject({ name: 'ProviderResponseTurnFailedError', outcome: 'failed' })
  })

  it('baselines failed completions from before submit including preparation', async () => {
    const test = rig()
    test.update({ turnCompletions: [completion()] })
    test.duringPrepare(async () => { test.update({ turnCompletions: [completion({ completionSeq: 2 })] }) })
    test.scheduled.push(async () => {
      test.update({ turnCompletions: [completion({ completionSeq: 2 }), completion({ completionSeq: 3, outcome: 'completed' })] })
      await test.write(test.response.expected)
    })
    await expect(test.run()).resolves.toBe('current')
  })

  it.each([
    { terminalId: 'foreign' }, { provider: 'codex' }, { streamId: 'foreign' }, { streamId: null },
    { sessionId: 'foreign' }, { completionSeq: 0 },
  ] satisfies Partial<ProviderResponseCompletion>[])('ignores a foreign or invalid failed completion %j', async overrides => {
    const test = rig()
    test.scheduled.push(async () => {
      test.update({ turnCompletions: [completion(overrides)] })
    }, () => test.write(test.response.expected))
    await expect(test.run()).resolves.toBe('current')
  })

  it('still requires the fresh expected response after successful completion', async () => {
    const test = rig()
    test.scheduled.push(async () => { test.update({ turnCompletions: [completion({ outcome: 'completed' })] }) })
    await expect(test.run()).rejects.toThrow('bounded test timeout')
    expect(test.actions).toEqual(['prepare', 'submit'])
    expect(test.reports).toEqual(['pre_send', 'timeout'])
  })

  it('does not attribute a failed completion to a replaced browser stream', async () => {
    const test = rig()
    test.scheduled.push(async () => {
      test.update({ streamId: 'replacement', attachStreamId: 'replacement', turnCompletions: [completion()] })
    })
    await expect(test.run()).rejects.toThrow('bounded test timeout')
    expect(test.reports).toEqual(['pre_send', 'timeout'])
  })

  it('stays pending when old nonce history replays after dispatch', async () => {
    const test = rig()
    test.scheduled.push(() => test.write('codename-public-test\r\ncodename-public-test'))
    await expect(test.run()).rejects.toThrow('bounded test timeout')
    expect(test.actions).toEqual(['prepare', 'submit'])
  })

  it('stays pending on the actual command echo', async () => {
    const test = rig(120, true)
    await expect(test.run()).rejects.toThrow('bounded test timeout')
  })

  it.each(['normal', 'alternate'])('accepts one current reply after clearing a high-count %s screen', async buffer => {
    const test = rig()
    if (buffer === 'alternate') await test.write('\x1b[?1049h')
    await test.write('codename-public-test\r\n'.repeat(6))
    test.scheduled.push(() => test.write(`\x1b[2J\x1b[H${test.response.expected}`))
    await expect(test.run()).resolves.toBe('current')
  })

  it('accepts a soft-wrapped reply from completed emulator writes', async () => {
    const test = rig(13)
    test.scheduled.push(() => test.write(`\x1b[2J\x1b[H${test.response.expected}`))
    await expect(test.run()).resolves.toBe('current')
  })

  it('preserves hard line breaks rather than manufacturing a reply', async () => {
    const test = rig()
    test.scheduled.push(() => test.write(test.response.expected.replace('/', '\r\n/')))
    await expect(test.run()).rejects.toThrow('bounded test timeout')
  })

  it('rejects a response from an old stage', async () => {
    const test = rig()
    test.scheduled.push(() => test.write(providerStageResponse('codename-public-test', 'initial', 'old-tag', true).expected))
    await expect(test.run()).rejects.toThrow('bounded test timeout')
  })

  it.each(['missing', 'terminal', 'pane', 'stream', 'old-stream', 'native-root', 'ws'])(
    'does not dispatch with %s current readiness', async fault => {
      const test = rig()
      if (fault === 'missing') test.set(null)
      if (fault === 'terminal') test.update({ terminalId: 'other' })
      if (fault === 'pane') test.update({ paneId: 'other' })
      if (fault === 'stream') test.update({ attachStreamId: 'other' })
      if (fault === 'old-stream') test.update({ streamId: 'old', attachStreamId: 'old' })
      if (fault === 'native-root') test.update({ nativeSessionId: 'other' })
      if (fault === 'ws') test.update({ wsReady: false })
      await expect(test.run()).rejects.toThrow('bounded test timeout')
      expect(test.actions).toEqual([])
    },
  )

  it('waits for current completed replay writes before dispatch', async () => {
    const test = rig()
    test.update({ replayPending: true, writesPending: true, highestObservedSeq: 3, completedSeq: 1 })
    test.scheduled.push(async () => {
      expect(test.actions).toEqual([])
      await test.write('codename-public-test\r\n')
      test.update({ replayPending: false, writesPending: false, completedSeq: 3 })
    }, () => test.write(test.response.expected))
    await expect(test.run()).resolves.toBe('current')
  })

  it('resamples replay arriving between readiness and Enter before dispatch', async () => {
    const test = rig()
    test.duringPrepare(async () => {
      test.update({ writesPending: true, highestObservedSeq: 4, completedSeq: 1 })
    })
    test.scheduled.push(async () => {
      expect(test.actions).toEqual(['prepare'])
      await test.write('codename-public-test\r\n')
      test.update({ writesPending: false, completedSeq: 4 })
    }, () => test.write(test.response.expected))
    await expect(test.run()).resolves.toBe('current')
    expect(test.actions).toEqual(['prepare', 'submit'])
  })

  it.each([false, true])('refuses Enter when the stream changes during preparation with writesPending=%s', async writesPending => {
    const test = rig()
    test.duringPrepare(async () => {
      test.update({
        streamId: 'replacement', attachStreamId: 'replacement', attachRequestId: 'replacement-attach',
        writesPending, highestObservedSeq: 2, completedSeq: writesPending ? 1 : 2,
      })
    })
    if (writesPending) test.scheduled.push(async () => { test.update({ writesPending: false, completedSeq: 2 }) })
    test.scheduled.push(() => test.write(test.response.expected))
    await expect(test.run()).rejects.toThrow('stream changed during prompt preparation')
    expect(test.actions).toEqual(['prepare'])
  })

  it('refuses a response on a different stream after dispatch', async () => {
    const test = rig()
    test.scheduled.push(async () => {
      test.update({ streamId: 'unexpected', attachStreamId: 'unexpected' })
      await test.write(test.response.expected)
    })
    await expect(test.run()).rejects.toThrow('bounded test timeout')
  })

  it('waits for completion when the expected response is visible in an in-flight write', async () => {
    const test = rig()
    test.scheduled.push(async () => {
      await test.write(test.response.expected)
      test.update({ writesPending: true, highestObservedSeq: 2 })
    }, async () => { test.update({ writesPending: false, completedSeq: 2 }) })
    await expect(test.run()).resolves.toBe('current')
    expect(test.scheduled).toHaveLength(0)
  })
})
