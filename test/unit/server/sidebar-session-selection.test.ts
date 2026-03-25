import { describe, it, expect } from 'vitest'
import { buildSidebarOpenSessionKeys } from '../../../server/sidebar-session-selection.js'

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
})
