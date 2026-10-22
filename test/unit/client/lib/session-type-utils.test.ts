import { describe, it, expect } from 'vitest'
import { resolveSessionTypeConfig, buildResumeContent, getPairedSessionTypeTarget } from '@/lib/session-type-utils'
import { FreshcodexIcon } from '@/components/icons/provider-icons'

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

  it('returns the registry-backed Freshcodex icon for "freshcodex"', () => {
    const config = resolveSessionTypeConfig('freshcodex')
    expect(config.label).toBe('Freshcodex')
    expect(config.icon).toBe(FreshcodexIcon)
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

  it('keeps freshAgentProviderSettings from adding a Freshopencode permission mode', () => {
    const content = buildResumeContent({
      sessionType: 'freshopencode',
      sessionId: 'ses_opencode_123',
      cwd: '/home/user/project',
      freshAgentProviderSettings: {
        defaultPermissionMode: 'bypassPermissions',
      },
    })

    expect(content.kind).toBe('fresh-agent')
    if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
    expect(content.sessionType).toBe('freshopencode')
    expect(content.provider).toBe('opencode')
    expect(content.resumeSessionId).toBeUndefined()
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

  it('preserves the blocked state when building a resumed managed terminal pane', () => {
    const recoverySummary = {
      desiredState: 'running' as const,
      recoveryState: 'blocked' as const,
      reason: 'host_unreachable',
      durabilityState: 'resume_captured' as const,
      allocationState: 'verified_durable' as const,
    }
    const content = buildResumeContent({
      sessionType: 'codex',
      sessionId: 'blocked-session',
      liveTerminal: {
        terminalId: 'term-blocked',
        serverInstanceId: 'srv-local',
        soulId: 'blocked-soul',
        incarnationId: 'blocked-incarnation',
        runtimeStatus: 'blocked',
        recoverySummary,
      },
    })

    expect(content).toMatchObject({
      kind: 'terminal',
      terminalId: 'term-blocked',
      status: 'error',
      runtimeStatus: 'blocked',
      recoverySummary,
    })
  })

  it('fresh-agent panes have no terminalId', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
    })
    expect(content.kind).toBe('fresh-agent')
    expect('terminalId' in content).toBe(false)
  })

  it('applies freshAgentProviderSettings to fresh-agent resume content', () => {
    const content = buildResumeContent({
      sessionType: 'freshclaude',
      sessionId: 'abc-123',
      freshAgentProviderSettings: {
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

  describe('resumed panes start on the saved fresh-pane default model (G11, decision D2)', () => {
    it('resumes a Freshclaude session on the saved default model', () => {
      const content = buildResumeContent({
        sessionType: 'freshclaude',
        sessionId: 'abc-123',
        freshAgentProviderSettings: {
          modelSelection: { kind: 'exact', modelId: 'sonnet' },
        },
      })
      if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
      expect(content.model).toBe('sonnet')
      expect(content.modelSelection).toEqual({ kind: 'exact', modelId: 'sonnet' })
    })

    it('resumes a Freshclaude session on the registry default when nothing is saved', () => {
      const content = buildResumeContent({ sessionType: 'freshclaude', sessionId: 'abc-123' })
      if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
      expect(content.model).toBe('opus[1m]')
    })

    it('resumes a Kilroy session on the saved Kilroy default model', () => {
      const saved = buildResumeContent({
        sessionType: 'kilroy',
        sessionId: 'xyz-789',
        freshAgentProviderSettings: {
          modelSelection: { kind: 'exact', modelId: 'sonnet' },
        },
      })
      if (saved.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
      expect(saved.model).toBe('sonnet')

      const unsaved = buildResumeContent({ sessionType: 'kilroy', sessionId: 'xyz-789' })
      if (unsaved.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
      expect(unsaved.model).toBe('opus[1m]')
    })

    it('carries the effort levels saved with the default model into resumed claude panes', () => {
      const content = buildResumeContent({
        sessionType: 'freshclaude',
        sessionId: 'abc-123',
        freshAgentProviderSettings: {
          modelSelection: { kind: 'exact', modelId: 'claude-haiku-x' },
          modelEffortLevels: { modelId: 'claude-haiku-x', levels: [] },
        },
      })
      if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
      expect(content.model).toBe('claude-haiku-x')
      expect(content.modelEffortLevels).toEqual([])
    })

    it('resumes a Freshcodex session on the saved Freshcodex default model', () => {
      const content = buildResumeContent({
        sessionType: 'freshcodex',
        sessionId: 'codex-session-1',
        freshAgentProviderSettings: {
          modelSelection: { kind: 'exact', modelId: 'gpt-5.6-luna' },
        },
      })
      if (content.kind !== 'fresh-agent') throw new Error('expected fresh-agent')
      expect(content.model).toBe('gpt-5.6-luna')
    })
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

  it('does not expose unsupported session types (kilroy pairs with the Claude CLI — kata b8ke round-2 R2-10)', () => {
    // kilroy is a hidden flavor, not a public type — but it rides the claude
    // lane, so a kilroy pane DOES offer the Claude CLI reopen (the runtime
    // provider, never a public fresh-agent target, is what pairs).
    expect(getPairedSessionTypeTarget('kilroy')).toMatchObject({
      sourceSessionType: 'kilroy',
      targetSessionType: 'claude',
      runtimeProvider: 'claude',
      targetKind: 'terminal',
      metadataSessionType: 'kilroy',
    })
    expect(getPairedSessionTypeTarget('shell')).toBeNull()
    expect(getPairedSessionTypeTarget(undefined)).toBeNull()
  })
})
