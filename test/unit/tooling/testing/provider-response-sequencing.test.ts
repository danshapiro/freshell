import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalBufferText } from '../../../../src/lib/terminal-buffer-text.js'
import { providerStageResponse, sequenceProviderResponse, type ProviderResponseSnapshot } from '../../../e2e-browser/helpers/provider-response-sequencing.js'

const terminals: Terminal[] = []
afterEach(() => terminals.splice(0).forEach(terminal => terminal.dispose()))

function rig(cols = 120, initial = false) {
  const terminal = new Terminal({ cols, rows: 12, allowProposedApi: true })
  terminals.push(terminal)
  const write = (text: string) => new Promise<void>(done => terminal.write(text, done))
  let snapshot: Omit<ProviderResponseSnapshot, 'text'> | null = {
    terminalId: 'terminal', paneId: 'pane', streamId: 'current', attachStreamId: 'current',
    attachRequestId: 'attach', nativeSessionId: 'root', wsReady: true, replayPending: false,
    writesPending: false, highestObservedSeq: 1, completedSeq: 1, cols, rows: 12, bufferType: 'normal',
  }
  const read = async () => snapshot && ({ ...snapshot, text: terminalBufferText(terminal.buffer.active) })
  const response = providerStageResponse('codename-public-test', 'after_host', 'fresh-tag', initial)
  const actions: string[] = []
  const scheduled: Array<() => Promise<void>> = []
  let duringPrepare: (() => Promise<void>) | undefined
  const run = () => sequenceProviderResponse({
    paneId: 'pane', terminalId: 'terminal', priorStreamId: 'old', nativeSessionId: 'root', response, read,
    prepare: async command => { actions.push('prepare'); await write(`${command}\r\n`); await duringPrepare?.() },
    submit: async () => { actions.push('submit') }, report: () => {}, timeoutMs: 240_000,
    waitFor: async (_description, probe) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await probe()
        if (result !== null) return result
        await scheduled.shift()?.()
      }
      throw new Error('bounded test timeout')
    },
  })
  return { write, response, actions, scheduled, run, set: (value: typeof snapshot) => { snapshot = value },
    duringPrepare: (callback: () => Promise<void>) => { duringPrepare = callback },
    update: (value: Partial<NonNullable<typeof snapshot>>) => { if (snapshot) Object.assign(snapshot, value) } }
}

describe('provider browser response sequencing with the actual emulator', () => {
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
