// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { extractUserMessages } from '../../server/ai-user-message-extractor.js'

describe('extractUserMessages', () => {
  it('extracts user messages from Claude JSONL and joins with ... placeholders', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/user', sessionId: 'abc' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix bug 123.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I will fix that.' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Now fix bug 456.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('Fix bug 123.')
    expect(result).toContain('...')
    expect(result).toContain('Now fix bug 456.')
    expect(result).not.toContain('I will fix that.')
    expect(result).not.toContain('Done.')
  })

  it('extracts user messages from Codex JSONL', () => {
    const jsonl = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Refactor the auth module.' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Refactoring...' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests for it.' }] } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'codex')
    expect(result).toContain('Refactor the auth module.')
    expect(result).toContain('...')
    expect(result).toContain('Add tests for it.')
    expect(result).not.toContain('Refactoring...')
  })

  it('returns empty string for content with no user messages', () => {
    const jsonl = [
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/user' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toBe('')
  })

  it('returns empty string for empty input', () => {
    expect(extractUserMessages('', 'claude')).toBe('')
  })

  it('truncates from the front to keep last 20000 chars, biasing recency', () => {
    const longMessage = 'A'.repeat(15000)
    const recentMessage = 'B'.repeat(10000)
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: longMessage } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: recentMessage } }),
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result.length).toBeLessThanOrEqual(20000)
    // Recent message should be fully preserved
    expect(result).toContain(recentMessage)
  })

  it('strips ANSI codes from user messages', () => {
    const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: '\x1b[32mFix the\x1b[0m bug.' } })
    const result = extractUserMessages(jsonl, 'claude')
    expect(result).not.toContain('\x1b[')
    expect(result).toContain('Fix the bug.')
  })

  it('handles malformed JSON lines gracefully', () => {
    const jsonl = [
      'not valid json',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Valid message.' } }),
      '{ broken',
    ].join('\n')

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('Valid message.')
  })

  it('handles user messages with array content blocks (Claude format)', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First part.' },
          { type: 'text', text: 'Second part.' },
        ],
      },
    })

    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('First part.')
    expect(result).toContain('Second part.')
  })

  it('handles role: "user" at top level (alternative Claude format)', () => {
    const jsonl = JSON.stringify({ role: 'user', content: 'Direct user content.' })
    const result = extractUserMessages(jsonl, 'claude')
    expect(result).toContain('Direct user content.')
  })
})
