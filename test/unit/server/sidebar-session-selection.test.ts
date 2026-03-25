import { describe, it, expect } from 'vitest'
import { buildSidebarOpenSessionKeys } from '../../../server/sidebar-session-selection.js'
import { makeSessionKey } from '../../../server/coding-cli/types.js'

describe('buildSidebarOpenSessionKeys', () => {
  it('keeps local explicit and id-less locators, ignores foreign-only locators, and dedupes session keys', () => {
    expect(buildSidebarOpenSessionKeys([
      { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' },
      { provider: 'codex', sessionId: 'shared' },
      { provider: 'codex', sessionId: 'local-explicit', serverInstanceId: 'srv-local' },
      { provider: 'codex', sessionId: 'local-explicit', serverInstanceId: 'srv-local' },
      { provider: 'codex', sessionId: 'remote-only', serverInstanceId: 'srv-remote' },
    ], 'srv-local')).toEqual(new Set([
      'codex:shared',
      'codex:local-explicit',
    ]))
  })

  it('treats Kimi locators with the same session id but different cwd values as distinct', () => {
    expect(buildSidebarOpenSessionKeys([
      { provider: 'kimi', sessionId: 'team:alpha', cwd: '/repo/alpha' },
      { provider: 'kimi', sessionId: 'team:alpha', cwd: '/repo/beta' },
      { provider: 'kimi', sessionId: 'team:alpha', cwd: '/repo/alpha', serverInstanceId: 'srv-local' },
    ], 'srv-local')).toEqual(new Set([
      makeSessionKey('kimi', 'team:alpha', '/repo/alpha'),
      makeSessionKey('kimi', 'team:alpha', '/repo/beta'),
    ]))
  })
})
