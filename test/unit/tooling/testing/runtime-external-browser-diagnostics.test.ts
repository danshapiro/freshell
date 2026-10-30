import { describe, expect, it } from 'vitest'
import { parseManagedOrdinaryTurnDiagnosticText } from '../../../../scripts/testing/runtime-external-browser.js'

describe('managed ordinary-turn diagnostics', () => {
  it('accepts the logger none fallback for FreshAgent startup diagnostics', () => {
    const diagnostic = {
      event: 'durable_souls.ordinary_turn_failed',
      lane: 'fresh-agent',
      mode: 'freshopencode',
      stage: 'creating',
      createCompleted: false,
      composerFilled: false,
      assistantBaselineCaptured: false,
      composerSubmitted: false,
      sendObserved: false,
      turnCompleteObserved: false,
      assistantTextDisplayed: false,
      assistantDom: { available: true, rows: 0, textCharacters: 0 },
      providerEvents: {
        counts: { created: 0, createFailed: 0, assistant: 0, stream: 0, error: 0, snapshot: 0, changed: 0, turnComplete: 0, result: 0 },
        createFailureCodes: ['FRESH_AGENT_PROVIDER_START_FAILED'],
        createFailureDiagnostics: ['none'],
        errorCodePresent: false,
        errorMessagePresent: false,
      },
    }

    expect(parseManagedOrdinaryTurnDiagnosticText(JSON.stringify(diagnostic))).toMatchObject([
      { event: 'durable_souls.ordinary_turn_failed', lane: 'fresh-agent', mode: 'freshopencode',
        providerEvents: { createFailureDiagnostics: ['none'] } },
    ])
  })
})
