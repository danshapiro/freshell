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

  it('returns capitalized provider name for claude mode terminal', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      status: 'running',
      createRequestId: 'test',
    }
    // Without extensions, getProviderLabel capitalizes the provider name
    expect(derivePaneTitle(content)).toBe('Claude')
  })

  it('returns capitalized provider name for codex mode terminal', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'codex',
      status: 'running',
      createRequestId: 'test',
    }
    // Without extensions, getProviderLabel capitalizes the provider name
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

  it('returns "Freshclaude" for fresh-agent content', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'test',
      status: 'idle',
    }
    expect(derivePaneTitle(content)).toBe('Freshclaude')
  })

  it('returns the working-directory basename for a CLI terminal with initialCwd', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      status: 'running',
      createRequestId: 'test',
      initialCwd: '/home/dan/code/freshell',
    }
    expect(derivePaneTitle(content)).toBe('freshell')
  })

  it('returns the working-directory basename for a fresh-agent pane with initialCwd', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'idle',
      createRequestId: 'test',
      initialCwd: '/home/dan/code/freshell',
    }
    expect(derivePaneTitle(content)).toBe('freshell')
  })

  it('returns the working-directory basename for a freshclaude pane with initialCwd', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'test',
      status: 'idle',
      initialCwd: '/home/dan/code/freshell',
    }
    expect(derivePaneTitle(content)).toBe('freshell')
  })

  it('does NOT use initialCwd for a shell terminal (scope guard: shells keep their shell-type label)', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'shell',
      shell: 'wsl',
      status: 'running',
      createRequestId: 'test',
      initialCwd: '/home/dan/code/freshell',
    }
    expect(derivePaneTitle(content)).toBe('WSL')
  })
})
