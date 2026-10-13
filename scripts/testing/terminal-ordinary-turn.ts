export const TERMINAL_ORDINARY_TURN_PROVIDERS = ['claude', 'codex', 'opencode'] as const

export type TerminalOrdinaryTurnProvider = typeof TERMINAL_ORDINARY_TURN_PROVIDERS[number]

export type TerminalOrdinaryTurnTarget = {
  provider: TerminalOrdinaryTurnProvider
  terminalId: string
  streamId: string
}

export type TerminalOrdinaryTurnBaseline = TerminalOrdinaryTurnTarget & {
  outputSeq: number
  completionSeq: number
}

export type TerminalOrdinaryTurnSummary = {
  activitySeen: boolean
  outputSeen: boolean
  outputFrameCount: number
  outputSeq: number | null
  completionSeen: boolean
  completionSeq: number | null
}

export type TerminalOrdinaryTurnBrowserObservation = TerminalOrdinaryTurnSummary & {
  inputSeen: boolean
}

export type TerminalOrdinaryTurnBrowserObserver = {
  prepareBeforeSend(
    provider: TerminalOrdinaryTurnProvider,
    terminalId: string,
  ): TerminalOrdinaryTurnBaseline | null
  observeAfterSend(baseline: TerminalOrdinaryTurnBaseline): TerminalOrdinaryTurnBrowserObservation | null
}

export async function waitForTerminalOrdinaryTurnBaseline(
  read: () => Promise<TerminalOrdinaryTurnBaseline | null>,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<TerminalOrdinaryTurnBaseline | null> {
  const deadline = Date.now() + timeoutMs
  let baseline = await read()
  while (baseline === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())))
    baseline = await read()
  }
  return baseline
}

export const TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL = '__FRESHELL_TERMINAL_ORDINARY_TURN__'

/**
 * Captures the current stream's sequence and provider completion baselines
 * without retaining any WebSocket frame or terminal output data.
 *
 * This function is self-contained so the browser script builder can install
 * the exact reducer source in the page without bringing a module closure along.
 */
export function captureTerminalOrdinaryTurnBaseline(
  frames: readonly unknown[],
  target: TerminalOrdinaryTurnTarget,
): TerminalOrdinaryTurnBaseline {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  }
  const sequence = (value: unknown, allowZero: boolean): number | null => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) return null
    return value
  }

  let latestAttachHeadSeq: number | null = null
  let outputSeq = 0
  let completionSeq = 0

  for (const value of frames) {
    const frame = asRecord(value)
    if (!frame) continue

    if (frame.type === 'terminal.attach.ready'
      && frame.terminalId === target.terminalId
      && frame.streamId === target.streamId) {
      latestAttachHeadSeq = sequence(frame.headSeq, true)
    }

    if ((frame.type === 'terminal.output' || frame.type === 'terminal.output.batch')
      && frame.terminalId === target.terminalId
      && frame.streamId === target.streamId) {
      const seqEnd = sequence(frame.seqEnd, true)
      if (seqEnd !== null) outputSeq = Math.max(outputSeq, seqEnd)
    }

    if (frame.type === 'terminal.turn.complete'
      && frame.terminalId === target.terminalId
      && frame.provider === target.provider) {
      const completion = sequence(frame.completionSeq, false)
      if (completion !== null) completionSeq = Math.max(completionSeq, completion)
    }
  }

  return {
    provider: target.provider,
    terminalId: target.terminalId,
    streamId: target.streamId,
    outputSeq: Math.max(outputSeq, latestAttachHeadSeq ?? 0),
    completionSeq,
  }
}

/**
 * Reduces frames in arrival order to safe stage facts only. Output bytes are
 * inspected for non-emptiness but never copied into the summary.
 *
 * This function is self-contained so the browser script builder can install
 * the exact reducer source in the page without bringing a module closure along.
 */
export function reduceTerminalOrdinaryTurnFrames(
  frames: readonly unknown[],
  baseline: TerminalOrdinaryTurnBaseline,
): TerminalOrdinaryTurnSummary {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  }
  const sequence = (value: unknown, allowZero: boolean): number | null => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) return null
    return value
  }
  const isActivePhase = (phase: unknown): boolean => baseline.provider === 'codex'
    ? phase === 'pending' || phase === 'busy'
    : phase === 'busy'

  let activitySeen = false
  let outputFrameCount = 0
  let outputSeq: number | null = null
  let completionSeq: number | null = null

  for (const value of frames) {
    const frame = asRecord(value)
    if (!frame) continue

    if (frame.type === `${baseline.provider}.activity.updated` && Array.isArray(frame.upsert)) {
      const matchedActivity = frame.upsert.some((value) => {
        const activity = asRecord(value)
        return activity?.terminalId === baseline.terminalId && isActivePhase(activity.phase)
      })
      if (matchedActivity) activitySeen = true
      continue
    }

    if (frame.type === 'terminal.output' || frame.type === 'terminal.output.batch') {
      if (!activitySeen || frame.terminalId !== baseline.terminalId || frame.streamId !== baseline.streamId) continue
      const seqEnd = sequence(frame.seqEnd, true)
      if (seqEnd === null || seqEnd <= baseline.outputSeq || typeof frame.data !== 'string' || frame.data.length === 0) continue
      outputFrameCount += 1
      outputSeq = outputSeq === null ? seqEnd : Math.max(outputSeq, seqEnd)
      continue
    }

    if (outputFrameCount === 0
      || frame.type !== 'terminal.turn.complete'
      || frame.terminalId !== baseline.terminalId
      || frame.provider !== baseline.provider
      || (baseline.provider === 'codex' && frame.outcome !== 'completed')) continue
    const completion = sequence(frame.completionSeq, false)
    if (completion !== null && completion > baseline.completionSeq) {
      completionSeq = completionSeq === null ? completion : Math.max(completionSeq, completion)
    }
  }

  return {
    activitySeen,
    outputSeen: outputFrameCount > 0,
    outputFrameCount,
    outputSeq,
    completionSeen: completionSeq !== null,
    completionSeq,
  }
}

/**
 * Builds a standalone browser script that installs a body-free observer on
 * window[TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL]. The browser reads raw harness
 * frames only inside the page and returns synthesized baseline/summary facts.
 */
export function buildTerminalOrdinaryTurnBrowserScript(): string {
  return `(() => {
    const captureTerminalOrdinaryTurnBaseline = ${captureTerminalOrdinaryTurnBaseline.toString()};
    const reduceTerminalOrdinaryTurnFrames = ${reduceTerminalOrdinaryTurnFrames.toString()};
    const globalName = ${JSON.stringify(TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL)};
    window[globalName] = {
      prepareBeforeSend(provider, terminalId) {
        const harness = window.__FRESHELL_TEST_HARNESS__;
        if (!harness
          || typeof harness.getReceivedWsMessages !== 'function'
          || typeof harness.clearReceivedWsMessages !== 'function'
          || typeof harness.getSentWsMessages !== 'function'
          || typeof harness.clearSentWsMessages !== 'function') return null;

        const frames = harness.getReceivedWsMessages();
        if (!Array.isArray(frames)) return null;
        let streamId = null;
        for (const value of frames) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const frame = value;
          if (frame.type !== 'terminal.attach.ready' || frame.terminalId !== terminalId) continue;
          streamId = typeof frame.streamId === 'string' && frame.streamId.length > 0 ? frame.streamId : null;
        }
        if (streamId === null) return null;

        const baseline = captureTerminalOrdinaryTurnBaseline(frames, { provider, terminalId, streamId });
        harness.clearReceivedWsMessages();
        harness.clearSentWsMessages();
        return baseline;
      },
      observeAfterSend(baseline) {
        const harness = window.__FRESHELL_TEST_HARNESS__;
        if (!harness
          || typeof harness.getReceivedWsMessages !== 'function'
          || typeof harness.getSentWsMessages !== 'function') return null;
        const received = harness.getReceivedWsMessages();
        const sent = harness.getSentWsMessages();
        if (!Array.isArray(received) || !Array.isArray(sent)) return null;

        let inputSeen = false;
        for (const value of sent) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          if (value.type === 'terminal.input' && value.terminalId === baseline.terminalId) inputSeen = true;
        }
        return {
          inputSeen,
          ...reduceTerminalOrdinaryTurnFrames(received, baseline),
        };
      },
    };
  })()`
}
