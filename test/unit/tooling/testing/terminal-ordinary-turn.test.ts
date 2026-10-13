import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'

import {
  TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL,
  buildTerminalOrdinaryTurnBrowserScript,
  captureTerminalOrdinaryTurnBaseline,
  reduceTerminalOrdinaryTurnFrames,
  waitForTerminalOrdinaryTurnBaseline,
} from '../../../../scripts/testing/terminal-ordinary-turn.js'

const target = { provider: 'claude', terminalId: 'terminal-1', streamId: 'stream-1' } as const

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
  return { type: 'terminal.turn.complete', provider, terminalId, completionSeq, at: 1 }
}

describe('body-free terminal ordinary-turn reduction', () => {
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
      outputSeq: 12,
      completionSeq: 9,
    })
  })

  it('requires matching activity, then fresh nonempty same-stream output, then advanced completion', () => {
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
    })
    expect(summary).not.toHaveProperty('data')
    expect(summary).not.toHaveProperty('frames')
  })

  it('accepts a pending Codex activity update', () => {
    const codexTarget = { provider: 'codex', terminalId: 'codex-1', streamId: 'codex-stream' } as const
    const summary = reduceTerminalOrdinaryTurnFrames([
      { type: 'codex.activity.updated', upsert: [{ terminalId: codexTarget.terminalId, phase: 'pending' }] },
      output(codexTarget.terminalId, codexTarget.streamId, 4),
      { ...complete('codex', codexTarget.terminalId, 1), outcome: 'completed' },
    ], captureTerminalOrdinaryTurnBaseline([], codexTarget))

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: true, completionSeen: true })
  })

  it('accepts Codex completion only when the outcome explicitly succeeded', () => {
    const codexTarget = { provider: 'codex', terminalId: 'codex-1', streamId: 'codex-stream' } as const
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
      complete('codex', codexTarget.terminalId, 1),
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

    expect(failed).toMatchObject({ outputSeen: true, completionSeen: false, completionSeq: null })
    expect(unavailable).toMatchObject({ outputSeen: true, completionSeen: false, completionSeq: null })
    expect(completed).toMatchObject({ outputSeen: true, completionSeen: true, completionSeq: 1 })
    expect(completedAfterProvisional).toMatchObject({ outputSeen: true, completionSeen: true, completionSeq: 1 })
  })

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
    ['wrong terminal activity', [activity('claude', 'other-terminal'), output(), complete()], false, false],
    ['wrong provider activity', [activity('codex'), output(), complete()], false, false],
    ['wrong terminal output', [activity('claude'), output('other-terminal'), complete()], true, false],
    ['wrong stream output', [activity('claude'), output(target.terminalId, 'other-stream'), complete()], true, false],
    ['wrong terminal completion', [activity('claude'), output(), complete(target.provider, 'other-terminal')], true, true],
    ['wrong provider completion', [activity('claude'), output(), complete('codex')], true, true],
  ])('ignores %s', (_label, frames, activitySeen, outputSeen) => {
    const summary = reduceTerminalOrdinaryTurnFrames(frames, baseline())
    expect(summary.activitySeen).toBe(activitySeen)
    expect(summary.outputSeen).toBe(outputSeen)
    expect(summary.completionSeen).toBe(false)
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

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: false, outputFrameCount: 0, completionSeen: false })
  })

  it('does not accept output that arrived before matching activity', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      output(),
      activity('claude'),
      complete(),
    ], baseline())

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: false, outputFrameCount: 0, completionSeen: false })
  })

  it('requires completion sequence advancement beyond the captured baseline', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      activity('claude'),
      output(),
      complete(target.provider, target.terminalId, 8),
    ], baseline([complete(target.provider, target.terminalId, 8)]))

    expect(summary).toMatchObject({ activitySeen: true, outputSeen: true, completionSeen: false, completionSeq: null })
  })

  it('requires completion to arrive after fresh output', () => {
    const summary = reduceTerminalOrdinaryTurnFrames([
      activity('claude'),
      complete(target.provider, target.terminalId, 9),
      output(),
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
    const harness = {
      getReceivedWsMessages: () => received,
      clearReceivedWsMessages: () => { received.length = 0 },
      getSentWsMessages: () => sent,
      clearSentWsMessages: () => { sent.length = 0 },
    }
    const browserWindow: Record<string, unknown> = { __FRESHELL_TEST_HARNESS__: harness }
    runInNewContext(buildTerminalOrdinaryTurnBrowserScript(), { window: browserWindow })
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL] as {
      prepareBeforeSend: (provider: string, terminalId: string) => unknown
      observeAfterSend: (baseline: unknown) => unknown
    }

    const captured = observer.prepareBeforeSend(target.provider, target.terminalId)
    expect(captured).toEqual({
      provider: target.provider,
      terminalId: target.terminalId,
      streamId: target.streamId,
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
    const observed = observer.observeAfterSend(captured)
    expect(observed).toEqual({
      inputSeen: true,
      activitySeen: true,
      outputSeen: true,
      outputFrameCount: 1,
      outputSeq: 11,
      completionSeen: true,
      completionSeq: 8,
    })
    expect(JSON.stringify(observed)).not.toContain(outputSentinel)
    expect(JSON.stringify(observed)).not.toContain(promptSentinel)
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
    const observer = browserWindow[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL] as {
      prepareBeforeSend: (provider: string, terminalId: string) => unknown
    }

    expect(observer.prepareBeforeSend(target.provider, target.terminalId)).toBeNull()
    expect(received).toHaveLength(1)
  })
})
