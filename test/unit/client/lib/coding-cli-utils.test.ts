import { describe, expect, it } from 'vitest'
import { buildResumeCommand, isResumeCommandProvider } from '@/lib/coding-cli-utils'
import type { ClientExtensionEntry } from '@shared/extension-types'

describe('coding CLI resume commands', () => {
  it('uses built-in resume commands before the extension registry is hydrated', () => {
    expect(isResumeCommandProvider('claude', [])).toBe(true)
    expect(buildResumeCommand('claude', 'session-1', [])).toBe('claude --resume session-1')
    expect(buildResumeCommand('codex', 'thread-1', [])).toBe('codex resume thread-1')
    expect(buildResumeCommand('opencode', 'ses_1', [])).toBe('opencode --session ses_1')
  })

  it('prefers an explicit extension registry entry over the built-in fallback', () => {
    const extensions: ClientExtensionEntry[] = [{
      name: 'claude',
      version: '1.0.0',
      label: 'Custom Claude',
      description: '',
      category: 'cli',
      cli: {
        supportsResume: true,
        resumeCommandTemplate: ['custom-claude', 'resume', '{{sessionId}}'],
      },
    }]

    expect(buildResumeCommand('claude', 'session-1', extensions)).toBe('custom-claude resume session-1')
  })

  it('does not fall back when a loaded registry entry lacks resume support', () => {
    const extensions: ClientExtensionEntry[] = [{
      name: 'claude',
      version: '1.0.0',
      label: 'Custom Claude',
      description: '',
      category: 'cli',
      cli: {},
    }]

    expect(isResumeCommandProvider('claude', extensions)).toBe(false)
    expect(buildResumeCommand('claude', 'session-1', extensions)).toBeNull()
  })

  it('renders an antigravity registry entry resume command with no builtin fallback', () => {
    // No builtin template exists for antigravity: before the extension
    // registry hydrates, it is not a resume provider.
    expect(isResumeCommandProvider('antigravity', [])).toBe(false)
    expect(buildResumeCommand('antigravity', 'conv-9', [])).toBeNull()

    // The registry entry (what the server's client_entry derives from the
    // antigravity manifest's resumeArgs) wins and renders the exact
    // `--conversation` resume command.
    const extensions: ClientExtensionEntry[] = [{
      name: 'antigravity',
      version: '1.0.0',
      label: 'Antigravity CLI',
      description: '',
      category: 'cli',
      cli: {
        supportsResume: true,
        resumeCommandTemplate: ['agy', '--conversation', '{{sessionId}}'],
      },
    }]

    expect(isResumeCommandProvider('antigravity', extensions)).toBe(true)
    expect(buildResumeCommand('antigravity', 'conv-9', extensions)).toBe('agy --conversation conv-9')
  })
})
