import { describe, expect, it } from 'vitest'
import fixtures from '../../../fixtures/fresh-agent/claude-create-defaults.json'
import { createDefaultServerSettings, type ServerSettings } from '@shared/settings'
import { buildFreshAgentPaneContent } from '@/lib/fresh-agent-create-content'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

describe('fresh-agent create defaults shared with REST', () => {
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
