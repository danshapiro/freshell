import { describe, it, expect } from 'vitest'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import type { PaneContent } from '@/store/paneTypes'

describe('derivePaneTitle', () => {
  it('returns "New Tab" for picker content', () => {
    const content: PaneContent = { kind: 'picker' }
    expect(derivePaneTitle(content)).toBe('New Tab')
  })

  it('returns hostname for browser with URL', () => {
    const content: PaneContent = { kind: 'browser', url: 'https://example.com/path', devToolsOpen: false }
    expect(derivePaneTitle(content)).toBe('example.com')
  })

  it('returns "Browser" for browser with empty URL', () => {
    const content: PaneContent = { kind: 'browser', url: '', devToolsOpen: false }
    expect(derivePaneTitle(content)).toBe('Browser')
  })

  it('returns "Shell" for shell mode terminal', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'shell',
      status: 'running',
      createRequestId: 'test',
    }
    expect(derivePaneTitle(content)).toBe('Shell')
  })

  it('returns "Claude" for claude mode terminal', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      status: 'running',
      createRequestId: 'test',
    }
    expect(derivePaneTitle(content)).toBe('Claude')
  })

  it('returns "Codex" for codex mode terminal', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'codex',
      status: 'running',
      createRequestId: 'test',
    }
    expect(derivePaneTitle(content)).toBe('Codex')
  })

  it('returns "Gemini" for gemini mode terminal', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'gemini',
      status: 'running',
      createRequestId: 'test',
    }
    expect(derivePaneTitle(content)).toBe('Gemini')
  })
})
