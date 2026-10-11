import type { TerminalSurfaceSnapshot } from '../../../src/lib/test-harness.js'

export type ProviderResponseSnapshot = TerminalSurfaceSnapshot & { wsReady: boolean }

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
  paneId: string
  terminalId: string
  priorStreamId?: string
  nativeSessionId?: string
  response: ReturnType<typeof providerStageResponse>
  read: () => Promise<ProviderResponseSnapshot | null>
  prepare: (command: string) => Promise<void>
  submit: () => Promise<void>
  waitFor: WaitFor
  report: (phase: 'pre_send' | 'timeout', snapshot: ProviderResponseSnapshot | null) => void
  timeoutMs: number
}): Promise<string> {
  const ready = (snapshot: ProviderResponseSnapshot | null): snapshot is ProviderResponseSnapshot => !!snapshot
    && snapshot.terminalId === options.terminalId && snapshot.paneId === options.paneId
    && snapshot.wsReady && !!snapshot.streamId && snapshot.streamId === snapshot.attachStreamId
    && !!snapshot.attachRequestId && snapshot.streamId !== options.priorStreamId
    && (!options.nativeSessionId || snapshot.nativeSessionId === options.nativeSessionId)
    && !snapshot.replayPending && !snapshot.writesPending
    && snapshot.completedSeq >= snapshot.highestObservedSeq
  let latest: ProviderResponseSnapshot | null = null
  const read = async () => { latest = await options.read(); return latest }
  const awaitReady = () => options.waitFor('current browser terminal readiness', async () => {
    const snapshot = await read()
    return ready(snapshot) && !snapshot.text.includes(options.response.expected) ? snapshot : null
  }, 90_000)
  try {
    await awaitReady()
    await options.prepare(options.response.command)
    // Replay can arrive during focus/typing. Sample current completed writes
    // again immediately before Enter; no historical count is carried forward.
    const beforeSend = await awaitReady()
    options.report('pre_send', beforeSend)
    await options.submit()
    await options.waitFor('provider response sequencing signal', async () => {
      const snapshot = await read()
      return ready(snapshot) && snapshot.streamId === beforeSend.streamId
        && snapshot.text.includes(options.response.expected) ? true : null
    }, options.timeoutMs)
    return beforeSend.streamId!
  } catch (error) {
    options.report('timeout', latest)
    throw error
  }
}
