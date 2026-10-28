import { describe, expect, it } from 'vitest'
import fixtures from '../../../fixtures/fresh-agent/claude-create-defaults.json'
import { createDefaultServerSettings, mergeServerSettings, type ServerSettings } from '@shared/settings'
import { buildFreshAgentPaneContent } from '@/lib/fresh-agent-create-content'
import { getEffectiveFreshAgentEffort, resolveFreshAgentType } from '@/lib/fresh-agent-registry'

describe('fresh-agent create defaults shared with REST', () => {
  it('keeps a stated native-default effort distinct from fallback provider defaults and explicit next-turn choices', () => {
    const content = { sessionType: 'freshcodex' as const, provider: 'codex' as const, model: 'provider-current', effortIsNativeDefault: true }
    const inherited = { ...content, effortIsNativeDefault: false }
    expect(getEffectiveFreshAgentEffort(inherited, { effort: 'ultra' })).toBe('ultra')
    expect(getEffectiveFreshAgentEffort({ ...content, effort: 'max' }, { effort: 'ultra' })).toBe('max')
    expect(getEffectiveFreshAgentEffort(content, { effort: 'ultra' })).toBeUndefined()
  })
  it('retains Codex work mode, file access and cwd through the saved-default settings path', () => {
    const settings = mergeServerSettings(createDefaultServerSettings(), JSON.parse(JSON.stringify({ freshAgent: { providers: { freshcodex: {
      modelSelection: { kind: 'exact', modelId: 'provider-current' }, effort: 'ultra',
      defaultPermissionMode: 'never', sandbox: 'read-only', cwd: '/work', collaborationMode: 'plan',
    } } } })))
    const content = buildFreshAgentPaneContent({ entry: resolveFreshAgentType('freshcodex')!, createRequestId: 'complete-defaults', freshAgentSettings: settings.freshAgent, codingCliSettings: settings.codingCli })
    expect(content).toMatchObject({ model: 'provider-current', effort: 'ultra', permissionMode: 'never', sandbox: 'read-only', initialCwd: '/work', collaborationMode: 'plan' })
  })
  it('leaves an omitted Codex effort to the installed model instead of fabricating max for a custom model', () => {
    const defaults = createDefaultServerSettings()
    const content = buildFreshAgentPaneContent({
      entry: resolveFreshAgentType('freshcodex')!, createRequestId: 'native-default',
      codingCliSettings: defaults.codingCli,
      freshAgentSettings: {...defaults.freshAgent,providers:{...defaults.freshAgent.providers,
        freshcodex:{modelSelection:{kind:'exact',modelId:'provider-current'}},
      }},
    })
    expect(content.model).toBe('provider-current')
    expect(content.effort).toBeUndefined()
  })
  it('creates Codex with the exact saved custom model and native effort', () => {
    const defaults = createDefaultServerSettings()
    const content = buildFreshAgentPaneContent({
      entry: resolveFreshAgentType('freshcodex')!, createRequestId: 'native-choice',
      codingCliSettings: defaults.codingCli,
      freshAgentSettings: { ...defaults.freshAgent, providers: { ...defaults.freshAgent.providers,
        freshcodex: { modelSelection: { kind: 'exact', modelId: 'provider-current' }, effort: 'ultra' },
      } },
    })
    expect(content).toMatchObject({ model: 'provider-current', effort: 'ultra', status: 'creating' })
  })
  it.each(fixtures)('$name', ({ sessionType, settings, expected }) => {
    const defaultServerSettings = createDefaultServerSettings()
    const entry = resolveFreshAgentType(sessionType)!
    const input = settings as Partial<ServerSettings>
    const content = buildFreshAgentPaneContent({
      entry,
      createRequestId: 'fixture-create',
      codingCliSettings: {
        ...defaultServerSettings.codingCli,
        ...input.codingCli,
      },
      freshAgentSettings: {
        ...defaultServerSettings.freshAgent,
        ...input.freshAgent,
      },
    })
    const { model, modelSelection, modelEffortLevels, permissionMode, effort, plugins } = content
    expect(JSON.parse(JSON.stringify({ model, modelSelection, modelEffortLevels, permissionMode, effort, plugins })))
      .toEqual(expected)
    expect(content).toMatchObject({
      kind: 'fresh-agent', provider: 'claude', sessionType,
      createRequestId: 'fixture-create', status: 'creating',
    })
  })
})
