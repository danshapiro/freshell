import { describe, expect, it } from 'vitest'

import { createDefaultServerSettings, mergeServerSettings } from '@shared/settings'

describe('config-store fresh-agent settings compatibility', () => {
  it('migrates legacy settings.agentChat to settings.freshAgent', () => {
    const settings = mergeServerSettings(
      createDefaultServerSettings({ loggingDebug: false }),
      {
        agentChat: {
          defaultPlugins: ['/tmp/plugin'],
          providers: {
            freshclaude: { defaultModel: 'fixture-claude-model', defaultEffort: 'high' },
          },
        },
      },
    )

    expect(settings.freshAgent.defaultPlugins).toEqual(['/tmp/plugin'])
    expect(settings.agentChat.defaultPlugins).toEqual(['/tmp/plugin'])
    expect(settings.freshAgent.providers.freshclaude).toEqual({
      modelSelection: { kind: 'exact', modelId: 'fixture-claude-model' },
      effort: 'high',
    })
    expect(settings.agentChat.providers.freshclaude).toEqual({
      modelSelection: { kind: 'exact', modelId: 'fixture-claude-model' },
      effort: 'high',
    })
  })
})
