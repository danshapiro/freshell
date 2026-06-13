import { describe, it, expect } from 'vitest'
import { resolveSessionTypeConfig, buildResumeContent, getPairedSessionTypeTarget } from '@/lib/session-type-utils'
import { CodexIcon } from '@/components/icons/provider-icons'

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

  it('returns the registry-backed Codex icon for "freshcodex"', () => {
    const config = resolveSessionTypeConfig('freshcodex')
    expect(config.label).toBe('Freshcodex')
    expect(config.icon).toBe(CodexIcon)
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
  it('returns fresh-agent content for freshclaude sessionType', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
      cwd: '/home/user/project',
    })
    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('freshclaude')
    expect(content.provider).toBe('claude')
    expect(content.resumeSessionId).toBe('abc-123')
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'abc-123',
    })
    expect(content.initialCwd).toBe('/home/user/project')
    expect(content.modelSelection).toBeUndefined()
    expect(content.permissionMode).toBe('bypassPermissions') // default from provider config
    expect(content.effort).toBeUndefined()
  })

  it('returns freshopencode resume content without a Freshell permission mode', () => {
    const content = buildResumeContent({
      sessionType: 'freshopencode',
      sessionId: 'ses_opencode_123',
      cwd: '/home/user/project',
      agentChatProviderSettings: {
        defaultPermissionMode: 'bypassPermissions',
      },
    })

    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('freshopencode')
    expect(content.provider).toBe('opencode')
    expect(content.resumeSessionId).toBe('ses_opencode_123')
    expect(content.sessionRef).toEqual({
      provider: 'opencode',
      sessionId: 'ses_opencode_123',
    })
    expect(content.initialCwd).toBe('/home/user/project')
    expect(content.permissionMode).toBeUndefined()
  })

  it('returns fresh-agent content for kilroy sessionType', () => {
    const content = buildResumeContent({
      sessionType: 'kilroy',
      sessionId: 'xyz-789',
    })
    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('kilroy')
    expect(content.provider).toBe('claude')
    expect(content.resumeSessionId).toBe('xyz-789')
    expect(content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'xyz-789',
    })
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

  it('returns terminal content with live terminal fields when supplied', () => {
    const content = buildResumeContent({
      sessionType: 'codex',
      sessionId: 'def-456',
      liveTerminal: {
        terminalId: 'term-codex-1',
        serverInstanceId: 'srv-local',
      },
    })

    expect(content.kind).toBe('terminal')
    if (content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content).toMatchObject({
      terminalId: 'term-codex-1',
      serverInstanceId: 'srv-local',
      status: 'running',
    })
    expect('liveTerminal' in content).toBe(false)
  })

  it('fresh-agent panes have no terminalId', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('fresh-agent')
    expect('terminalId' in content).toBe(false)
  })

  it('uses provider settings when provided', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
      agentChatProviderSettings: {
        modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
        defaultPermissionMode: 'default',
        effort: 'turbo',
      },
    })
    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.modelSelection).toEqual({ kind: 'tracked', modelId: 'opus[1m]' })
    expect(content.permissionMode).toBe('default')
    expect(content.effort).toBe('turbo')
  })

  it('does not stamp visual style onto fresh-agent resume content', () => {
    const content = buildResumeContent({
      sessionType: 'freshcodex',
      sessionId: 'codex-session-1',
      cwd: '/workspace/codex',
    })

    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('freshcodex')
    expect(content.provider).toBe('codex')
    expect(content.style).toBeUndefined()
  })

  it('does not apply a baked-in provider effort override', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.effort).toBeUndefined()
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

describe('getPairedSessionTypeTarget', () => {
  it.each([
    ['claude', 'freshclaude', 'Reopen as freshclaude', 'fresh-agent'],
    ['codex', 'freshcodex', 'Reopen as freshcodex', 'fresh-agent'],
    ['opencode', 'freshopencode', 'Reopen as freshopencode', 'fresh-agent'],
    ['freshclaude', 'claude', 'Reopen as Claude CLI', 'terminal'],
    ['freshcodex', 'codex', 'Reopen as Codex CLI', 'terminal'],
    ['freshopencode', 'opencode', 'Reopen as OpenCode CLI', 'terminal'],
  ] as const)('maps %s to %s', (sourceSessionType, targetSessionType, label, targetKind) => {
    expect(getPairedSessionTypeTarget(sourceSessionType)).toMatchObject({
      targetSessionType,
      label,
      targetKind,
    })
  })

  it('does not expose hidden or unsupported session types', () => {
    expect(getPairedSessionTypeTarget('kilroy')).toBeNull()
    expect(getPairedSessionTypeTarget('shell')).toBeNull()
    expect(getPairedSessionTypeTarget(undefined)).toBeNull()
  })
})
