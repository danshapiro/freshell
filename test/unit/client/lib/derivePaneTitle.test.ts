import { describe, it, expect } from 'vitest'
import { derivePaneTitle } from '@/lib/derivePaneTitle'
import type { TerminalPaneContent, BrowserPaneContent } from '@/store/paneTypes'

describe('derivePaneTitle', () => {
  describe('terminal panes', () => {
    it('returns "Shell" for shell mode', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'shell',
      }
      expect(derivePaneTitle(content)).toBe('Shell')
    })

    it('returns "Claude" for claude mode', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'claude',
      }
      expect(derivePaneTitle(content)).toBe('Claude')
    })

    it('returns "Codex" for codex mode', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'codex',
      }
      expect(derivePaneTitle(content)).toBe('Codex')
    })

    it('returns "PowerShell" for powershell shell', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'shell',
        shell: 'powershell',
      }
      expect(derivePaneTitle(content)).toBe('PowerShell')
    })

    it('returns "Command Prompt" for cmd shell', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'shell',
        shell: 'cmd',
      }
      expect(derivePaneTitle(content)).toBe('Command Prompt')
    })

    it('returns "WSL" for wsl shell', () => {
      const content: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-1',
        status: 'running',
        mode: 'shell',
        shell: 'wsl',
      }
      expect(derivePaneTitle(content)).toBe('WSL')
    })
  })

  describe('browser panes', () => {
    it('returns hostname from URL', () => {
      const content: BrowserPaneContent = {
        kind: 'browser',
        url: 'https://example.com/path/to/page',
        devToolsOpen: false,
      }
      expect(derivePaneTitle(content)).toBe('example.com')
    })

    it('returns "Browser" for invalid URL', () => {
      const content: BrowserPaneContent = {
        kind: 'browser',
        url: 'not-a-valid-url',
        devToolsOpen: false,
      }
      expect(derivePaneTitle(content)).toBe('Browser')
    })

    it('returns "Browser" for empty URL', () => {
      const content: BrowserPaneContent = {
        kind: 'browser',
        url: '',
        devToolsOpen: false,
      }
      expect(derivePaneTitle(content)).toBe('Browser')
    })
  })
})
