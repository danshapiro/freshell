import { describe, it, expect } from 'vitest'
import { PROMPTS } from '../../../server/ai-prompts'

describe('PROMPTS.sessionTitle', () => {
  it('uses the most-specific-first default prompt', () => {
    expect(PROMPTS.sessionTitle.defaultPrompt).toBe(
      [
        'Generate a title for a tab that contains the coding agent for this conversation.',
        'Only the first word or two will show, so most specific and informative words first.',
        "E.g. if we're investigating a crash in freshell that happens when you mention sardines, \"Sardine crash investigation\" because sardine is specific, crash is less specific, and investigation is common to almost all tabs.",
        'Return ONLY the title text. No quotes, no markdown, no explanation.',
      ].join('\n'),
    )
  })

  it('builds the full prompt with the default instructions and the first message', () => {
    const prompt = PROMPTS.sessionTitle.build('Fix the login redirect bug')
    expect(prompt).toBe(
      [
        PROMPTS.sessionTitle.defaultPrompt,
        '',
        'First message from the user:',
        'Fix the login redirect bug',
      ].join('\n'),
    )
  })

  it('truncates the first message to 2000 characters', () => {
    const long = 'x'.repeat(3000)
    const prompt = PROMPTS.sessionTitle.build(long)
    expect(prompt).toContain('x'.repeat(2000))
    expect(prompt).not.toContain('x'.repeat(2001))
  })

  it('uses a custom prompt when provided', () => {
    const prompt = PROMPTS.sessionTitle.build('hi', 'CUSTOM INSTRUCTIONS')
    expect(prompt.startsWith('CUSTOM INSTRUCTIONS')).toBe(true)
    expect(prompt).not.toContain(PROMPTS.sessionTitle.defaultPrompt)
  })
})
