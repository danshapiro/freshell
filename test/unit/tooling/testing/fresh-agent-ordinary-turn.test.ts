import { describe, expect, it } from 'vitest'
import {
  freshAgentAssistantResponseFacts,
  freshAgentTurnCompletionStatus,
} from '../../../../scripts/testing/fresh-agent-ordinary-turn.js'

describe('FreshAgent ordinary-turn smoke evidence', () => {
  it('does not count a static assistant label or an empty answer body', () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<article data-turn-role="assistant"><span>Assistant</span><div class="fresh-agent-transcript-copy"><div data-markdown-body=""></div></div></article>'

    expect(freshAgentAssistantResponseFacts(pane)).toEqual({ rows: 1, textCharacters: 0 })
  })

  it('counts nonempty assistant answer bodies and excludes user rows', () => {
    const pane = document.createElement('div')
    pane.innerHTML = [
      '<article data-turn-role="user"><div data-markdown-body="">user text</div></article>',
      '<article data-turn-role="assistant"><span>Assistant</span><div class="fresh-agent-transcript-copy"><div data-markdown-body=""> Answer </div><details class="fresh-agent-thinking-details"><div data-markdown-body="private thought"></div></details></div></article>',
    ].join('')

    expect(freshAgentAssistantResponseFacts(pane)).toEqual({ rows: 1, textCharacters: 6 })
  })

  it('does not count thinking text as an assistant answer', () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<article data-turn-role="assistant"><div class="fresh-agent-transcript-copy"><details class="fresh-agent-thinking-details"><div data-markdown-body="private thought"></div></details></div></article>'

    expect(freshAgentAssistantResponseFacts(pane)).toEqual({ rows: 1, textCharacters: 0 })
  })

  it('accepts a legacy completion without an outcome and a successful OpenCode outcome', () => {
    expect(freshAgentTurnCompletionStatus([
      { type: 'freshAgent.event', event: { type: 'freshAgent.turn.complete' } },
    ])).toBe('completed')
    expect(freshAgentTurnCompletionStatus([
      { type: 'freshAgent.event', event: { type: 'freshAgent.turn.complete', outcome: 'completed' } },
    ])).toBe('completed')
  })

  it('rejects an outcome-less Codex completion because that edge also signals failed turns', () => {
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'codex',
        event: { type: 'freshAgent.turn.complete' },
      },
    ])).toBe('failed')
  })

  it('accepts Codex only when its provider outcome explicitly succeeded', () => {
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'codex',
        event: { type: 'freshAgent.turn.complete', outcome: 'completed' },
      },
    ])).toBe('completed')
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'codex',
        event: { type: 'freshAgent.turn.complete', outcome: 'failed' },
      },
    ])).toBe('failed')
  })

  it.each(['provider_error', 'idle_timeout', 'sidecar_lost', 'request_failed', 'unknown']) (
    'rejects a completion with outcome %s', (outcome) => {
      expect(freshAgentTurnCompletionStatus([
        { type: 'freshAgent.event', event: { type: 'freshAgent.turn.complete', outcome } },
      ])).toBe('failed')
    },
  )

  it('does not treat a different event as turn completion', () => {
    expect(freshAgentTurnCompletionStatus([
      { type: 'freshAgent.event', event: { type: 'freshAgent.session.snapshot' } },
    ])).toBe('absent')
  })
})
