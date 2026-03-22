import { describe, expect, it } from 'vitest'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { buildResumeCommand } from '@/lib/coding-cli-utils'

const extensions: ClientExtensionEntry[] = [
  {
    name: 'claude',
    version: '1.0.0',
    label: 'Claude CLI',
    description: '',
    category: 'cli',
    cli: {
      supportsResume: true,
      resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'],
    },
  },
  {
    name: 'kimi',
    version: '1.0.0',
    label: 'Kimi',
    description: '',
    category: 'cli',
    cli: {
      supportsResume: true,
      resumeCommandTemplate: ['kimi', '--session', '{{sessionId}}'],
    },
  },
]

describe('buildResumeCommand', () => {
  it('builds cwd-sensitive shell-safe Kimi resume commands', () => {
    expect(buildResumeCommand('kimi', 'named kimi session', extensions, {
      cwd: '/repo/root/apps/team app',
    })).toBe(`cd '/repo/root/apps/team app' && kimi --session 'named kimi session'`)
  })

  it('fails closed for Kimi when cwd is missing', () => {
    expect(buildResumeCommand('kimi', 'named kimi session', extensions)).toBeNull()
  })

  it('keeps simple non-cwd-scoped resume commands unchanged', () => {
    expect(buildResumeCommand('claude', 'session-1', extensions)).toBe('claude --resume session-1')
  })
})
