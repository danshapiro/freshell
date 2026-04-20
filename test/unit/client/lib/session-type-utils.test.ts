import { describe, it, expect } from 'vitest'
import { resolveSessionTypeConfig, buildResumeContent } from '@/lib/session-type-utils'

describe('resolveSessionTypeConfig', () => {
  it('returns claude config for "claude"', () => {
    const config = resolveSessionTypeConfig('claude')
    // Without extensions, getProviderLabel capitalizes the provider name
    expect(config.label).toBe('Claude')
    expect(config.icon).toBeDefined()
  })

  it('returns codex config for "codex"', () => {
    const config = resolveSessionTypeConfig('codex')
    expect(config.label).toBe('Codex')
  })

  it('returns freshclaude config for "freshclaude"', () => {
    const config = resolveSessionTypeConfig('freshclaude')
    expect(config.label).toBe('Freshclaude')
    expect(config.icon).toBeDefined()
  })

  it('returns kilroy config for "kilroy"', () => {
    const config = resolveSessionTypeConfig('kilroy')
    expect(config.label).toBe('Kilroy')
  })

  it('returns fallback for unknown type', () => {
    const config = resolveSessionTypeConfig('graphviz-viewer')
    // Any non-shell mode gets capitalized label via getProviderLabel
    expect(config.label).toBe('Graphviz-viewer')
    expect(config.icon).toBeDefined() // generic fallback icon
  })
})

describe('buildResumeContent', () => {
  it('returns agent-chat content for freshclaude sessionType', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
      cwd: '/home/user/project',
    })
    expect(content.kind).toBe('agent-chat')
    if (content.kind !== 'agent-chat') throw new Error('expected agent-chat')
    expect(content.provider).toBe('freshclaude')
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'abc-123',
    })
    expect(content.resumeSessionId).toBeUndefined()
    expect(content.initialCwd).toBe('/home/user/project')
    expect(content.model).toBe('claude-opus-4-6') // default from provider config
    expect(content.permissionMode).toBe('bypassPermissions') // default from provider config
  })

  it('returns agent-chat content for kilroy sessionType', () => {
    const content = buildResumeContent({
      sessionType: 'kilroy',
      sessionId: 'xyz-789',
    })
    expect(content.kind).toBe('agent-chat')
    if (content.kind !== 'agent-chat') throw new Error('expected agent-chat')
    expect(content.provider).toBe('kilroy')
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'xyz-789',
    })
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('returns terminal content for claude sessionType', () => {
    const content = buildResumeContent({
      sessionType: 'claude',
      sessionId: 'abc-123',
      cwd: '/home/user/project',
    })
    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content.mode).toBe('claude')
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'abc-123',
    })
    expect(content.resumeSessionId).toBeUndefined()
    expect(content.initialCwd).toBe('/home/user/project')
  })

  it('returns terminal content for codex sessionType', () => {
    const content = buildResumeContent({
      sessionType: 'codex',
      sessionId: 'def-456',
    })
    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content.mode).toBe('codex')
    expect(content.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'def-456',
    })
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('defaults to claude terminal for undefined sessionType', () => {
    const content = buildResumeContent({
      sessionType: undefined as unknown as string,
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content.mode).toBe('claude')
  })

  it('returns terminal content without terminalId (set at pane level)', () => {
    const content = buildResumeContent({
      sessionType: 'claude',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content.terminalId).toBeUndefined()
    expect(content.mode).toBe('claude')
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'abc-123',
    })
    expect(content.resumeSessionId).toBeUndefined()
  })

  it('agent-chat panes have no terminalId', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('agent-chat')
    expect('terminalId' in content).toBe(false)
  })

  it('uses provider settings when provided', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
      agentChatProviderSettings: {
        defaultModel: 'claude-sonnet-4-20250514',
        defaultPermissionMode: 'default',
        defaultEffort: 'max',
      },
    })
    expect(content.kind).toBe('agent-chat')
    if (content.kind !== 'agent-chat') throw new Error('expected agent-chat')
    expect(content.model).toBe('claude-sonnet-4-20250514')
    expect(content.permissionMode).toBe('default')
    expect(content.effort).toBe('max')
  })

  it('applies default effort from provider config', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('agent-chat')
    if (content.kind !== 'agent-chat') throw new Error('expected agent-chat')
    expect(content.effort).toBe('high') // freshclaude default
  })

  it('preserves unknown sessionType as mode (was validated at creation)', () => {
    const content = buildResumeContent({
      sessionType: 'bogus-garbage',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('expected terminal')
    // Any non-shell mode is preserved as-is (provider was validated at session creation)
    expect(content.mode).toBe('bogus-garbage')
  })
})
