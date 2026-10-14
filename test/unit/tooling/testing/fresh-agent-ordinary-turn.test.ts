import { describe, expect, it } from 'vitest'
import {
  freshAgentAssistantResponseFacts,
  freshAgentAssistantTextAppeared,
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

  it('requires new assistant text beyond an observed pre-send pane baseline', () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<div data-turn-role="assistant"><div class="fresh-agent-transcript-copy"><div data-markdown-body>existing text</div></div></div>'
    const baseline = freshAgentAssistantResponseFacts(pane)

    expect(freshAgentAssistantTextAppeared(baseline, freshAgentAssistantResponseFacts(pane))).toBe(false)

    pane.querySelector('[data-markdown-body]')!.textContent += ' added text'
    expect(freshAgentAssistantTextAppeared(baseline, freshAgentAssistantResponseFacts(pane))).toBe(true)
  })

  it('does not count thinking text as an assistant answer', () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<article data-turn-role="assistant"><div class="fresh-agent-transcript-copy"><details class="fresh-agent-thinking-details"><div data-markdown-body="private thought"></div></details></div></article>'

    expect(freshAgentAssistantResponseFacts(pane)).toEqual({ rows: 1, textCharacters: 0 })
  })

  it('requires an explicit successful outcome for Claude and OpenCode completions', () => {
    expect(freshAgentTurnCompletionStatus([
      { type: 'freshAgent.event', event: { type: 'freshAgent.turn.complete' } },
    ], 'opencode')).toBe('failed')
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'opencode',
        event: { type: 'freshAgent.turn.complete', outcome: 'completed' },
      },
    ], 'opencode')).toBe('completed')
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'claude',
        event: { type: 'freshAgent.turn.complete', outcome: 'completed' },
      },
    ], 'claude')).toBe('completed')
    expect(freshAgentTurnCompletionStatus([
      { type: 'freshAgent.event', provider: 'claude', event: { type: 'freshAgent.turn.complete' } },
    ], 'claude')).toBe('failed')
  })

  it.each(['claude', 'codex', 'opencode'] as const)(
    'requires an explicit successful outcome for %s fresh-agent completion', (provider) => {
      const frame = (outcome?: string) => ({
        type: 'freshAgent.event',
        provider,
        event: { type: 'freshAgent.turn.complete', ...(outcome === undefined ? {} : { outcome }) },
      })

      expect(freshAgentTurnCompletionStatus([frame()], provider)).toBe('failed')
      expect(freshAgentTurnCompletionStatus([frame('failed')], provider)).toBe('failed')
      expect(freshAgentTurnCompletionStatus([frame('completed')], provider)).toBe('completed')
    },
  )

  it('rejects a Codex completion without provider or outcome evidence', () => {
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        event: { type: 'freshAgent.turn.complete' },
      },
    ], 'codex')).toBe('failed')
  })

  it('accepts Codex only when its outcome explicitly succeeded', () => {
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'codex',
        event: { type: 'freshAgent.turn.complete', outcome: 'completed' },
      },
    ], 'codex')).toBe('completed')
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        event: { type: 'freshAgent.turn.complete', outcome: 'completed' },
      },
    ], 'codex')).toBe('completed')
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'codex',
        event: { type: 'freshAgent.turn.complete', outcome: 'failed' },
      },
    ], 'codex')).toBe('failed')
  })

  it('rejects a completion that names a provider other than the selected provider', () => {
    expect(freshAgentTurnCompletionStatus([
      {
        type: 'freshAgent.event',
        provider: 'claude',
        event: { type: 'freshAgent.turn.complete', outcome: 'completed' },
      },
    ], 'codex')).toBe('failed')
  })

  it.each(['provider_error', 'idle_timeout', 'sidecar_lost', 'request_failed', 'unknown']) (
    'rejects a completion with outcome %s', (outcome) => {
      expect(freshAgentTurnCompletionStatus([
        { type: 'freshAgent.event', event: { type: 'freshAgent.turn.complete', outcome } },
      ], 'opencode')).toBe('failed')
    },
  )

  it('does not treat a different event as turn completion', () => {
    expect(freshAgentTurnCompletionStatus([
      { type: 'freshAgent.event', event: { type: 'freshAgent.session.snapshot' } },
    ], 'opencode')).toBe('absent')
  })
})
