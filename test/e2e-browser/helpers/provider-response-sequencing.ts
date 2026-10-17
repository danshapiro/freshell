import type { TerminalSurfaceSnapshot } from '../../../src/lib/test-harness.js'
import type { TerminalTurnCompleteMessage } from '../../../shared/ws-protocol.js'

export type ProviderResponseCompletion = Pick<TerminalTurnCompleteMessage,
  'terminalId' | 'provider' | 'sessionId' | 'completionSeq' | 'at' | 'outcome'> & { streamId: string | null }
export type ProviderResponseSnapshot = TerminalSurfaceSnapshot & {
  wsReady: boolean
  turnCompletions?: ProviderResponseCompletion[]
}

/** Self-contained: Playwright runs this exact sampler inside the browser. */
export function sampleProviderResponseBrowser({ id, nonce, expected }: { id: string; nonce: string; expected: string }) {
  const harness = window.__FRESHELL_TEST_HARNESS__
  const snapshot = harness?.getTerminalSnapshot?.(id) ?? null
  const writes = (harness?.getTerminalWriteEvents?.() ?? []).filter(event => event.terminalId === id)
  const messages = (harness?.getReceivedWsMessages?.() ?? []).filter((value): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'terminalId' in value && value.terminalId === id)
  const provider = (value: unknown): TerminalTurnCompleteMessage['provider'] | undefined =>
    value === 'claude' || value === 'codex' || value === 'opencode' || value === 'amplifier' ? value : undefined
  const outcome = (value: unknown): TerminalTurnCompleteMessage['outcome'] =>
    value === 'completed' || value === 'failed' ? value : undefined
  const sequence = (value: unknown, minimum = 0): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined
  const count = (text: string, value: string) => text.split(value).length - 1
  const turnCompletions: ProviderResponseCompletion[] = []
  const streamMessageTypes = ['terminal.created', 'terminal.attach.ready', 'terminal.stream.changed', 'terminal.output', 'terminal.output.batch']
  let streamId: string | null = null
  for (const message of messages) {
    // Completion frames do not carry a stream identity. Retain their arrival
    // context; never assign an old completion the stream of a later snapshot.
    if (typeof message.type === 'string' && streamMessageTypes.includes(message.type)
      && typeof message.streamId === 'string' && message.streamId.length > 0) streamId = message.streamId
    if (message.type !== 'terminal.turn.complete') continue
    const completionProvider = provider(message.provider)
    const completionSeq = sequence(message.completionSeq, 1)
    const at = sequence(message.at)
    const completionOutcome = outcome(message.outcome)
    if (!completionProvider || completionSeq === undefined || at === undefined) continue
    turnCompletions.push({
      terminalId: id, provider: completionProvider, streamId, at, completionSeq,
      ...(typeof message.sessionId === 'string' && message.sessionId.length > 0 ? { sessionId: message.sessionId } : {}),
      ...(completionOutcome ? { outcome: completionOutcome } : {}),
    })
  }
  return {
    snapshot: snapshot && { ...snapshot, wsReady: harness?.getWsReadyState() === 'ready', turnCompletions },
    diagnostics: {
      registeredTerminalIds: harness?.getRegisteredTerminalIds().slice(0, 16) ?? [],
      modes: harness?.getTerminalModes(id) ?? null,
      nonceCount: count(snapshot?.text ?? '', nonce),
      expectedCount: count(snapshot?.text ?? '', expected),
      expectedCountIgnoringLineBreaks: count((snapshot?.text ?? '').replaceAll('\n', ''), expected),
      writeTotals: ['submitted', 'written'].map(phase => {
        const events = writes.filter(event => event.phase === phase)
        return { phase, count: events.length, chars: events.reduce((sum, event) => sum + event.chars, 0),
          latestAt: events.at(-1)?.at ?? null }
      }),
      writes: writes.slice(-8).map(({ phase, chars, at, paneId }) => ({ phase, chars, at, paneId })),
      received: messages.slice(-8).map(message => ({
        type: message.type, streamId: message.streamId, attachRequestId: message.attachRequestId,
        seq: message.seq, seqStart: message.seqStart, seqEnd: message.seqEnd,
        ...(message.type === 'terminal.turn.complete' ? {
          provider: provider(message.provider), outcome: outcome(message.outcome),
          completionSeq: sequence(message.completionSeq, 1), at: sequence(message.at),
        } : {}),
      })),
    },
  }
}

export class ProviderResponseTurnFailedError extends Error {
  readonly outcome = 'failed'
  readonly provider: ProviderResponseCompletion['provider']
  readonly completionSeq: number
  constructor(completion: ProviderResponseCompletion) {
    super('current provider terminal turn failed')
    this.name = 'ProviderResponseTurnFailedError'
    this.provider = completion.provider
    this.completionSeq = completion.completionSeq
  }
}

export async function waitForValue<T>(
  description: string,
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined) return value
    } catch (error) {
      // A native failed turn is final; browser/transport probe failures may
      // still recover on the next poll.
      if (error instanceof ProviderResponseTurnFailedError) throw error
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${suffix}`)
}

export function providerStageResponse(nonce: string, stage: string, tag: string, initial = false) {
  const suffix = `${stage}-${tag}`
  return {
    nonce,
    expected: `${nonce}/${suffix}`,
    command: `${initial ? `The private project codename for this conversation is ${nonce}.` : 'Recall the private project codename from the start of this same conversation.'} Without using tools or files, reply with only the codename followed immediately by a slash and this suffix: ${suffix}`,
  }
}

type WaitFor = <T>(description: string, probe: () => Promise<T | null>, timeoutMs: number) => Promise<T>

export async function sequenceProviderResponse(options: {
  provider: ProviderResponseCompletion['provider']
  paneId: string
  terminalId: string
  priorStreamId?: string
  nativeSessionId?: string
  response: ReturnType<typeof providerStageResponse>
  read: () => Promise<ProviderResponseSnapshot | null>
  prepare: (command: string) => Promise<void>
  submit: () => Promise<void>
  waitFor: WaitFor
  report: (phase: 'pre_send' | 'failed' | 'timeout', snapshot: ProviderResponseSnapshot | null) => void
  timeoutMs: number
  requireSettledOutput?: boolean
}): Promise<string> {
  const ready = (snapshot: ProviderResponseSnapshot | null): snapshot is ProviderResponseSnapshot => !!snapshot
    && snapshot.terminalId === options.terminalId && snapshot.paneId === options.paneId
    && snapshot.wsReady && !!snapshot.streamId && snapshot.streamId === snapshot.attachStreamId
    && !!snapshot.attachRequestId && snapshot.streamId !== options.priorStreamId
    && (!options.nativeSessionId || snapshot.nativeSessionId === options.nativeSessionId)
    && !snapshot.replayPending && !snapshot.writesPending
    && (options.requireSettledOutput === false || snapshot.completedSeq >= snapshot.highestObservedSeq)
  let latest: ProviderResponseSnapshot | null = null
  const read = async () => { latest = await options.read(); return latest }
  const awaitReady = () => options.waitFor('current browser terminal readiness', async () => {
    const snapshot = await read()
    return ready(snapshot) && !snapshot.text.includes(options.response.expected) ? snapshot : null
  }, 90_000)
  try {
    const beforePrepare = await awaitReady()
    await options.prepare(options.response.command)
    // Replay can arrive during focus/typing. Sample current completed writes
    // again immediately before Enter; no historical count is carried forward.
    const beforeSend = await awaitReady()
    // A replacement must not receive Enter for input typed on the prior stream.
    if (beforeSend.streamId !== beforePrepare.streamId) {
      throw new Error('browser terminal stream changed during prompt preparation')
    }
    const matchesSubmittedTurn = (completion: ProviderResponseCompletion) => completion.terminalId === options.terminalId
      && completion.provider === options.provider && completion.streamId === beforeSend.streamId
      && (!completion.sessionId || completion.sessionId === beforeSend.nativeSessionId)
    const completionBaseline = Math.max(0, ...(beforeSend.turnCompletions ?? [])
      .filter(matchesSubmittedTurn).map(completion => completion.completionSeq))
    options.report('pre_send', beforeSend)
    await options.submit()
    await options.waitFor('provider response sequencing signal', async () => {
      const snapshot = await read()
      if (snapshot?.terminalId === options.terminalId && snapshot.paneId === options.paneId
        && snapshot.streamId === beforeSend.streamId && snapshot.attachStreamId === beforeSend.streamId
        && snapshot.nativeSessionId === beforeSend.nativeSessionId) {
        const failed = snapshot.turnCompletions?.find(completion => matchesSubmittedTurn(completion)
          && completion.completionSeq > completionBaseline && completion.outcome === 'failed')
        if (failed) throw new ProviderResponseTurnFailedError(failed)
      }
      return ready(snapshot) && snapshot.streamId === beforeSend.streamId
        && snapshot.text.includes(options.response.expected) ? true : null
    }, options.timeoutMs)
    return beforeSend.streamId!
  } catch (error) {
    options.report(error instanceof ProviderResponseTurnFailedError ? 'failed' : 'timeout', latest)
    throw error
  }
}
