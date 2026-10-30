export const TERMINAL_ORDINARY_TURN_PROVIDERS = ['claude', 'codex', 'opencode'] as const

export type TerminalOrdinaryTurnProvider = typeof TERMINAL_ORDINARY_TURN_PROVIDERS[number]

export type TerminalOrdinaryTurnTarget = {
  provider: TerminalOrdinaryTurnProvider
  terminalId: string
  streamId: string
  nativeSessionId: string
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
  completionOutcome: 'completed' | 'failed' | null
}

export type TerminalOrdinaryTurnBrowserObservation = TerminalOrdinaryTurnSummary & {
  requestInputSeen: boolean
  renderedAnswerSeen: boolean
}

export function terminalOrdinaryTurnRequest(marker: string): { input: string; expectedAnswer: string } {
  return {
    input: `Convert this marker to lowercase. Reply with only the result, without tools: ${marker.toUpperCase()}`,
    expectedAnswer: marker.toLowerCase(),
  }
}

export type TerminalOrdinaryTurnBrowserObserver = {
  prepareBeforeSend(
    provider: TerminalOrdinaryTurnProvider,
    terminalId: string,
    nativeSessionId: string,
    expectedAnswer: string,
  ): TerminalOrdinaryTurnBaseline | null
  observeAfterSend(baseline: TerminalOrdinaryTurnBaseline, expectedInput: string): TerminalOrdinaryTurnBrowserObservation | null
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

/** Shared ordinary-use waiter; observations contain no prompt or response bodies. */
export async function waitForTerminalOrdinaryTurn(
  read: () => Promise<TerminalOrdinaryTurnBrowserObservation | null>,
  timeoutMs = 240_000,
  intervalMs = 200,
): Promise<TerminalOrdinaryTurnBrowserObservation> {
  const deadline = Date.now() + timeoutMs
  let lastReadError: unknown
  do {
    let facts: TerminalOrdinaryTurnBrowserObservation | null = null
    try { facts = await read() } catch (error) { lastReadError = error }
    if (facts?.completionOutcome === 'failed') {
      throw new Error(`ordinary terminal provider turn failed at completion sequence ${facts.completionSeq}`)
    }
    if (facts?.requestInputSeen && facts.activitySeen && facts.outputSeen && facts.renderedAnswerSeen && facts.completionSeen) return facts
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())))
  } while (Date.now() <= deadline)
  throw new Error('ordinary terminal provider turn completion timed out', { cause: lastReadError })
}

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
      && frame.provider === target.provider
      && frame.sessionId === target.nativeSessionId
      && (frame.streamId === undefined || frame.streamId === target.streamId)) {
      const completion = sequence(frame.completionSeq, false)
      if (completion !== null) completionSeq = Math.max(completionSeq, completion)
    }
  }

  return {
    provider: target.provider,
    terminalId: target.terminalId,
    streamId: target.streamId,
    nativeSessionId: target.nativeSessionId,
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
  initialStreamId: unknown = baseline.streamId,
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
  let completionOutcome: TerminalOrdinaryTurnSummary['completionOutcome'] = null
  let activeStreamId: unknown = initialStreamId

  for (const value of frames) {
    const frame = asRecord(value)
    if (!frame) continue

    if (frame.type === 'terminal.attach.ready' && frame.terminalId === baseline.terminalId) {
      activeStreamId = frame.streamId
      continue
    }

    if (frame.type === `${baseline.provider}.activity.updated` && Array.isArray(frame.upsert)) {
      const matchedActivity = frame.upsert.some((value) => {
        const activity = asRecord(value)
        return activity?.terminalId === baseline.terminalId && isActivePhase(activity.phase)
      })
      if (matchedActivity) activitySeen = true
      continue
    }

    if (frame.type === 'terminal.output' || frame.type === 'terminal.output.batch') {
      if (frame.terminalId !== baseline.terminalId || frame.streamId !== baseline.streamId) continue
      const seqEnd = sequence(frame.seqEnd, true)
      if (seqEnd === null || seqEnd <= baseline.outputSeq || typeof frame.data !== 'string' || frame.data.length === 0) continue
      outputFrameCount += 1
      outputSeq = outputSeq === null ? seqEnd : Math.max(outputSeq, seqEnd)
      continue
    }

    if (frame.type !== 'terminal.turn.complete'
      || frame.terminalId !== baseline.terminalId
      || frame.provider !== baseline.provider
      || frame.sessionId !== baseline.nativeSessionId
      || activeStreamId !== baseline.streamId
      || (frame.streamId !== undefined && frame.streamId !== baseline.streamId)
      || (frame.outcome !== 'completed' && frame.outcome !== 'failed')) continue
    const completion = sequence(frame.completionSeq, false)
    if (completion !== null && completion > baseline.completionSeq
      && (completionSeq === null || completion >= completionSeq)) {
      completionSeq = completion
      completionOutcome = frame.outcome
    }
  }

  return {
    activitySeen,
    outputSeen: outputFrameCount > 0,
    outputFrameCount,
    outputSeq,
    completionSeen: completionOutcome === 'completed',
    completionSeq,
    completionOutcome,
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
    let accumulatedObservation = null;
    let observedStreamId = null;
    let expectedAnswer = null;
    // The existing snapshot reads the active xterm buffer after parsing writes.
    const readRenderedText = ({ terminalId, streamId, nativeSessionId }) => {
      const snapshot = window.__FRESHELL_TEST_HARNESS__?.getTerminalSnapshot?.(terminalId);
      return snapshot && snapshot.terminalId === terminalId && snapshot.nativeSessionId === nativeSessionId
        && snapshot.streamId === streamId && snapshot.attachStreamId === streamId
        && typeof snapshot.text === 'string' ? snapshot.text.replaceAll('\\n', '') : null;
    };
    const observationKey = (baseline) => JSON.stringify([
      baseline.provider,
      baseline.terminalId,
      baseline.streamId,
      baseline.nativeSessionId,
      baseline.outputSeq,
      baseline.completionSeq,
    ]);
    const latestSequence = (previous, current) => previous === null
      ? current
      : current === null ? previous : Math.max(previous, current);
    const emptyObservation = (key) => ({
      key,
      requestInputSeen: false,
      renderedAnswerSeen: false,
      activitySeen: false,
      outputSeen: false,
      outputFrameCount: 0,
      outputSeq: null,
      completionSeen: false,
      completionSeq: null,
      completionOutcome: null,
    });
    const mergeObservation = (key, previous, current) => {
      const completion = current.completionSeq !== null
        && (previous.completionSeq === null || current.completionSeq >= previous.completionSeq) ? current : previous;
      return {
        key,
        requestInputSeen: previous.requestInputSeen || current.requestInputSeen,
        renderedAnswerSeen: previous.renderedAnswerSeen || current.renderedAnswerSeen,
        activitySeen: previous.activitySeen || current.activitySeen,
        outputSeen: previous.outputSeen || current.outputSeen,
        // Keep the largest count observed in any rolling-buffer snapshot.
        outputFrameCount: Math.max(previous.outputFrameCount, current.outputFrameCount),
        outputSeq: latestSequence(previous.outputSeq, current.outputSeq),
        completionSeen: completion.completionSeen,
        completionSeq: completion.completionSeq,
        completionOutcome: completion.completionOutcome,
      };
    };
    window[globalName] = {
      prepareBeforeSend(provider, terminalId, nativeSessionId, answer) {
        accumulatedObservation = null;
        expectedAnswer = null;
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

        if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0
          || typeof answer !== 'string' || answer.length === 0) return null;
        const target = { provider, terminalId, streamId, nativeSessionId };
        const text = readRenderedText(target);
        if (text === null || text.includes(answer)) return null;
        expectedAnswer = answer;
        const baseline = captureTerminalOrdinaryTurnBaseline(frames, target);
        accumulatedObservation = emptyObservation(observationKey(baseline));
        observedStreamId = streamId;
        harness.clearReceivedWsMessages();
        harness.clearSentWsMessages();
        return baseline;
      },
      observeAfterSend(baseline, expectedInput) {
        const harness = window.__FRESHELL_TEST_HARNESS__;
        if (!harness
          || typeof harness.getReceivedWsMessages !== 'function'
          || typeof harness.getSentWsMessages !== 'function') return null;
        const received = harness.getReceivedWsMessages();
        const sent = harness.getSentWsMessages();
        if (!Array.isArray(received) || !Array.isArray(sent)) return null;

        const isTerminalResponseFrame = (data) => {
          const escape = 27;
          const bell = 7;
          const stringTerminator = String.fromCharCode(escape, 92);
          const last = data.length - 1;
          if (data.length < 3 || data.charCodeAt(0) !== escape) return false;
          const introducer = data.charCodeAt(1);
          if (introducer === 91) {
            const finalByte = data.charCodeAt(last);
            if (![0x63, 0x6e, 0x52, 0x74, 0x75, 0x79].includes(finalByte)) return false;
            for (let cursor = 2; cursor < last; cursor += 1) {
              const code = data.charCodeAt(cursor);
              if (code < 0x20 || code > 0x3f) return false;
            }
            return true;
          }
          if (introducer === 93) {
            return data.indexOf(String.fromCharCode(bell), 2) === last
              || (last >= 3 && data.indexOf(stringTerminator, 2) === last - 1);
          }
          if ([80, 88, 94, 95].includes(introducer)) {
            return last >= 3 && data.indexOf(stringTerminator, 2) === last - 1;
          }
          return false;
        };
        // xterm returns device and mode reports through the same input path as keystrokes.
        // Ignore complete response-only frames before comparing the typed request.
        const inputParts = [];
        for (const value of sent) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          if (value.type === 'terminal.input'
            && value.terminalId === baseline.terminalId
            && typeof value.data === 'string'
            && !isTerminalResponseFrame(value.data)) inputParts.push(value.data);
        }
        const sentInput = inputParts.join('');
        const carriageReturn = String.fromCharCode(13);
        const lineFeed = String.fromCharCode(10);
        const requestInputSeen = expectedInput.length > 0 && (
          sentInput === expectedInput
          || sentInput === expectedInput + carriageReturn
          || sentInput === expectedInput + lineFeed
          || sentInput === expectedInput + carriageReturn + lineFeed
        );
        const key = observationKey(baseline);
        const sameBaseline = accumulatedObservation && accumulatedObservation.key === key;
        const previous = sameBaseline
          ? accumulatedObservation
          : emptyObservation(key);
        const text = readRenderedText(baseline);
        const current = {
          requestInputSeen,
          renderedAnswerSeen: expectedAnswer !== null && text !== null && text.includes(expectedAnswer),
          ...reduceTerminalOrdinaryTurnFrames(received, baseline, sameBaseline ? observedStreamId : baseline.streamId),
        };
        // Completion frames have no stream ID on the wire. Remember attach context
        // between polls even after its frame leaves the harness's rolling buffer.
        if (!sameBaseline) observedStreamId = baseline.streamId;
        for (const frame of received) {
          if (frame && typeof frame === 'object' && !Array.isArray(frame)
            && frame.type === 'terminal.attach.ready' && frame.terminalId === baseline.terminalId) observedStreamId = frame.streamId;
        }
        accumulatedObservation = mergeObservation(key, previous, current);
        return {
          requestInputSeen: accumulatedObservation.requestInputSeen,
          renderedAnswerSeen: accumulatedObservation.renderedAnswerSeen,
          activitySeen: accumulatedObservation.activitySeen,
          outputSeen: accumulatedObservation.outputSeen,
          outputFrameCount: accumulatedObservation.outputFrameCount,
          outputSeq: accumulatedObservation.outputSeq,
          completionSeen: accumulatedObservation.completionSeen,
          completionSeq: accumulatedObservation.completionSeq,
          completionOutcome: accumulatedObservation.completionOutcome,
        };
      },
    };
  })()`
}
