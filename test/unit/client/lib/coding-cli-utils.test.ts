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
  it('builds cwd-sensitive shell-safe Kimi resume commands for POSIX shells', () => {
    expect(buildResumeCommand('kimi', 'named kimi session', extensions, {
      cwd: '/repo/root/apps/team app',
      platform: 'linux',
    })).toBe(`cd '/repo/root/apps/team app' && kimi --session 'named kimi session'`)
  })

  it('fails closed for Kimi when cwd is missing', () => {
    expect(buildResumeCommand('kimi', 'named kimi session', extensions)).toBeNull()
  })

  it('builds cwd-sensitive Kimi resume commands for cmd.exe on Windows', () => {
    expect(buildResumeCommand('kimi', 'team:alpha', extensions, {
      cwd: 'C:\\repo root\\team app',
      platform: 'win32',
    })).toBe(`cd /d "C:\\repo root\\team app" && kimi --session "team:alpha"`)
  })

  it('builds cwd-sensitive Kimi resume commands for PowerShell panes', () => {
    expect(buildResumeCommand('kimi', "team's alpha", extensions, {
      cwd: "C:\\repo root\\team's app",
      platform: 'win32',
      shell: 'powershell',
    })).toBe(`Set-Location -LiteralPath 'C:\\repo root\\team''s app'; & 'kimi' '--session' 'team''s alpha'`)
  })

  it('keeps simple non-cwd-scoped resume commands unchanged', () => {
    expect(buildResumeCommand('claude', 'session-1', extensions)).toBe('claude --resume session-1')
  })
})
