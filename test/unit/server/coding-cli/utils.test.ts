import { describe, it, expect } from 'vitest'
import { isSystemContext, extractFromIdeContext } from '../../../../server/coding-cli/utils'

describe('isSystemContext()', () => {
  describe('XML-wrapped context', () => {
    it('detects <environment_context>', () => {
      expect(isSystemContext('<environment_context>\n  <cwd>/project</cwd>\n</environment_context>')).toBe(true)
    })

    it('detects <user_instructions>', () => {
      expect(isSystemContext('<user_instructions>\nFollow these rules...\n</user_instructions>')).toBe(true)
    })

    it('detects <system_context>', () => {
      expect(isSystemContext('<system_context>\nYou are an assistant...\n</system_context>')).toBe(true)
    })

    it('detects <INSTRUCTIONS> (uppercase)', () => {
      expect(isSystemContext('<INSTRUCTIONS>\nSystem instructions here\n</INSTRUCTIONS>')).toBe(true)
    })

    it('detects XML tag with attributes', () => {
      expect(isSystemContext('<context type="system">\nStuff here\n</context>')).toBe(true)
    })
  })

  describe('instruction file headers', () => {
    it('detects # AGENTS.md', () => {
      expect(isSystemContext('# AGENTS.md instructions for /project\n\nFollow these rules...')).toBe(true)
    })

    it('detects # Instructions', () => {
      expect(isSystemContext('# Instructions\nDo this and that...')).toBe(true)
    })

    it('detects # System', () => {
      expect(isSystemContext('# System\nYou are a helpful assistant...')).toBe(true)
    })

    it('is case-insensitive for instruction headers', () => {
      expect(isSystemContext('# agents.md instructions')).toBe(true)
      expect(isSystemContext('# INSTRUCTIONS')).toBe(true)
    })
  })

  describe('bracketed agent modes', () => {
    it('detects [SUGGESTION MODE: ...]', () => {
      expect(isSystemContext('[SUGGESTION MODE: Suggest what the user might naturally type next...]')).toBe(true)
    })

    it('detects [REVIEW MODE: ...]', () => {
      expect(isSystemContext('[REVIEW MODE: You are reviewing code...] Check for bugs.')).toBe(true)
    })
  })

  describe('IDE context format', () => {
    it('detects "# Context from my IDE setup:"', () => {
      expect(isSystemContext('# Context from my IDE setup:\n\n## My codebase\n...')).toBe(true)
    })
  })

  describe('pasted log/debug output', () => {
    it('detects lines starting with digit+comma (heap stats)', () => {
      expect(isSystemContext('0, totalJsHeapSize: 12345678, usedJsHeapSize: 9876543')).toBe(true)
    })

    it('does not flag normal text starting with a digit', () => {
      expect(isSystemContext('3 things to fix in the code')).toBe(false)
    })
  })

  describe('agent boilerplate', () => {
    it('detects "You are an automated..."', () => {
      expect(isSystemContext('You are an automated coding assistant that helps with...')).toBe(true)
    })

    it('does NOT flag "You are an expert..."', () => {
      expect(isSystemContext('You are an expert in React, help me build a component')).toBe(false)
    })

    it('does NOT flag "You are an experienced..."', () => {
      expect(isSystemContext('You are an experienced developer, review this code')).toBe(false)
    })
  })

  describe('pasted shell output', () => {
    it('detects "> command" format', () => {
      expect(isSystemContext('> npm run build\n\nadded 42 packages')).toBe(true)
    })

    it('detects "$ command" format', () => {
      expect(isSystemContext('$ git status\nOn branch main')).toBe(true)
    })

    it('does NOT flag "> " followed by normal text (quote)', () => {
      // A ">" with no space-then-word after could be a markdown quote
      // but "> command" where command looks shell-like should be caught
      // We'll be conservative: "> " followed by a word that looks like a command
      expect(isSystemContext('> I think this is a good idea')).toBe(false)
    })
  })

  describe('real user prompts (should NOT be system context)', () => {
    it('allows normal user requests', () => {
      expect(isSystemContext('Fix the login bug')).toBe(false)
    })

    it('allows questions', () => {
      expect(isSystemContext('How do I add authentication?')).toBe(false)
    })

    it('allows multi-line user prompts', () => {
      expect(isSystemContext('Please review this code:\n\nfunction foo() { return 1 }')).toBe(false)
    })

    it('allows prompts mentioning system words naturally', () => {
      expect(isSystemContext('Update the instructions page in the docs')).toBe(false)
    })
  })

  describe('whitespace handling', () => {
    it('trims leading whitespace before checking', () => {
      expect(isSystemContext('   <environment_context>...</environment_context>')).toBe(true)
    })

    it('handles empty string', () => {
      expect(isSystemContext('')).toBe(false)
    })

    it('handles whitespace-only string', () => {
      expect(isSystemContext('   ')).toBe(false)
    })
  })
})

describe('extractFromIdeContext()', () => {
  it('extracts user request from IDE context with "## My request for Codex:" section', () => {
    const text = [
      '# Context from my IDE setup:',
      '',
      '## My codebase',
      'This is a React project...',
      '',
      '## My request for Codex:',
      'Fix the authentication bug in the login form',
    ].join('\n')

    expect(extractFromIdeContext(text)).toBe('Fix the authentication bug in the login form')
  })

  it('extracts multi-line request (uses first non-empty line)', () => {
    const text = [
      '# Context from my IDE setup:',
      '',
      '## My request for Codex:',
      'Refactor the database layer',
      'to use connection pooling',
    ].join('\n')

    expect(extractFromIdeContext(text)).toBe('Refactor the database layer')
  })

  it('skips empty lines after the header', () => {
    const text = [
      '# Context from my IDE setup:',
      '',
      '## My request for Codex:',
      '',
      '  ',
      'The actual request here',
    ].join('\n')

    expect(extractFromIdeContext(text)).toBe('The actual request here')
  })

  it('returns undefined for non-IDE-context messages', () => {
    expect(extractFromIdeContext('Fix the bug')).toBeUndefined()
  })

  it('returns undefined when no request section exists', () => {
    const text = [
      '# Context from my IDE setup:',
      '',
      '## My codebase',
      'This is a React project...',
    ].join('\n')

    expect(extractFromIdeContext(text)).toBeUndefined()
  })

  it('returns undefined when request section is empty', () => {
    const text = [
      '# Context from my IDE setup:',
      '',
      '## My request for Codex:',
      '',
      '  ',
    ].join('\n')

    expect(extractFromIdeContext(text)).toBeUndefined()
  })
})
