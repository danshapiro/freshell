import { describe, expect, it } from 'vitest'

import {
  buildServerSettingsPatchSchema,
  composeResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  migrateLegacyFreshAgentSettingsInput,
  mergeServerSettings,
  resolveLocalSettings,
  stripLocalSettings,
} from '@shared/settings'

describe('shared settings contract', () => {
  it('accepts representative server-backed fields in the server patch schema', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      defaultCwd: '/workspace',
      terminal: { scrollback: 12000 },
      freshAgent: { defaultPlugins: ['fs', 'search'] },
    })

    expect(parsed).toEqual({
      defaultCwd: '/workspace',
      terminal: { scrollback: 12000 },
      freshAgent: { defaultPlugins: ['fs', 'search'] },
    })
  })

  it('accepts tracked and exact fresh-agent model selections with dynamic effort strings', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      freshAgent: {
        providers: {
          freshclaude: {
            modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
            effort: 'ultra',
          },
          kilroy: {
            modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
            defaultPermissionMode: 'plan',
          },
        },
      },
    })

    expect(parsed.freshAgent?.providers?.freshclaude).toEqual({
      modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
      effort: 'ultra',
    })
    expect(parsed.freshAgent?.providers?.kilroy).toEqual({
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
      defaultPermissionMode: 'plan',
    })
  })

  it('accepts empty effort clear sentinels while allowing omitted model selections', () => {
    const schema = buildServerSettingsPatchSchema()

    expect(schema.safeParse({
      freshAgent: {
        providers: {
          freshclaude: {
            defaultPermissionMode: 'plan',
            effort: 'ultra',
          },
        },
      },
    }).success).toBe(true)
    expect(schema.safeParse({
      freshAgent: {
        providers: {
          freshclaude: {
            effort: '',
          },
        },
      },
    }).success).toBe(true)
  })

  it('accepts Freshcodex directory persistence when keyed by the Codex runtime provider', () => {
    const schema = buildServerSettingsPatchSchema(['claude', 'codex', 'opencode'])

    expect(schema.safeParse({
      codingCli: {
        providers: {
          codex: { cwd: '/workspace/freshcodex' },
        },
      },
    }).success).toBe(true)
    expect(schema.safeParse({
      codingCli: {
        providers: {
          freshcodex: { cwd: '/workspace/freshcodex' },
        },
      },
    }).success).toBe(false)
  })

  it('defaults fresh clients off and accepts a server-backed enable switch', () => {
    const defaults = createDefaultServerSettings({ loggingDebug: false })

    expect(defaults.freshAgent.enabled).toBe(false)

    const parsed = buildServerSettingsPatchSchema().parse({
      freshAgent: { enabled: true },
    })
    expect(parsed.freshAgent?.enabled).toBe(true)

    const merged = mergeServerSettings(defaults, {
      freshAgent: { enabled: true },
    })
    expect(merged.freshAgent.enabled).toBe(true)
    expect('agentChat' in merged).toBe(false)
  })

  it('migrates stored legacy agentChat input to canonical freshAgent settings', () => {
    const parsed = migrateLegacyFreshAgentSettingsInput({
      agentChat: {
        enabled: true,
        defaultPlugins: ['/tmp/plugin'],
        providers: {
          freshcodex: { style: 'serif', effort: 'high' },
        },
      },
    } as never)

    expect(parsed).toEqual({
      freshAgent: {
        enabled: true,
        defaultPlugins: ['/tmp/plugin'],
        providers: {
          freshcodex: { style: 'serif', effort: 'high' },
        },
      },
    })
    expect('agentChat' in parsed).toBe(false)
  })

  it('merges server settings into freshAgent without mirroring agentChat', () => {
    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        enabled: true,
        providers: {
          freshclaude: { defaultPermissionMode: 'acceptEdits' },
        },
      },
    })

    expect(merged.freshAgent.enabled).toBe(true)
    expect(merged.freshAgent.providers.freshclaude).toEqual({ defaultPermissionMode: 'acceptEdits' })
    expect('agentChat' in merged).toBe(false)
  })

  it('resolves browser-local fresh-agent settings without exposing agentChat', () => {
    const resolved = resolveLocalSettings({
      agentChat: { showTools: true, showThinking: true, fontScale: 1.25 },
    } as never)

    expect(resolved.freshAgent.showTools).toBe(true)
    expect(resolved.freshAgent.showThinking).toBe(true)
    expect(resolved.freshAgent.fontScale).toBe(1.25)
    expect('agentChat' in resolved).toBe(false)
  })

  it('gives canonical freshAgent stored values precedence over legacy agentChat values', () => {
    const parsed = migrateLegacyFreshAgentSettingsInput({
      agentChat: {
        defaultPlugins: ['/legacy/plugin'],
        providers: {
          freshcodex: { style: 'sans', effort: 'high' },
        },
      },
      freshAgent: {
        defaultPlugins: [],
        providers: {
          freshcodex: { style: 'serif' },
        },
      },
    } as never)

    expect(parsed.freshAgent.defaultPlugins).toEqual([])
    expect(parsed.freshAgent.providers?.freshcodex).toEqual({ style: 'serif', effort: 'high' })
    expect('agentChat' in parsed).toBe(false)
  })

  it('accepts fresh-agent provider style defaults and keeps them per session type', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      freshAgent: {
        providers: {
          freshcodex: { style: 'serif' },
          freshclaude: { style: 'sans' },
        },
      },
    })

    expect(parsed.freshAgent?.providers?.freshcodex).toEqual({ style: 'serif' })
    expect(parsed.freshAgent?.providers?.freshclaude).toEqual({ style: 'sans' })

    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        providers: {
          freshcodex: { style: 'serif' },
          freshclaude: { style: 'sans' },
        },
      },
    })

    expect(merged.freshAgent.providers.freshcodex?.style).toBe('serif')
    expect(merged.freshAgent.providers.freshclaude?.style).toBe('sans')
  })

  it('accepts mono as a fresh-agent provider style default', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      freshAgent: {
        providers: {
          freshcodex: { style: 'mono' },
        },
      },
    })

    expect(parsed.freshAgent?.providers?.freshcodex).toEqual({ style: 'mono' })

    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        providers: {
          freshcodex: { style: 'mono' },
        },
      },
    })

    expect(merged.freshAgent.providers.freshcodex?.style).toBe('mono')
  })

  it('rejects invalid fresh-agent provider style defaults', () => {
    const schema = buildServerSettingsPatchSchema()

    expect(schema.safeParse({
      freshAgent: {
        providers: {
          freshcodex: { style: 'script' },
        },
      },
    }).success).toBe(false)

    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        providers: {
          freshcodex: { style: 'script' as any },
        },
      },
    })

    expect(merged.freshAgent.providers.freshcodex).toBeUndefined()
  })

  it('rejects representative local-only fields in the server patch schema', () => {
    const schema = buildServerSettingsPatchSchema()

    expect(schema.safeParse({ theme: 'dark' }).success).toBe(false)
    expect(schema.safeParse({ terminal: { fontSize: 18 } }).success).toBe(false)
    expect(schema.safeParse({ terminal: { osc52Clipboard: 'always' } }).success).toBe(false)
    expect(schema.safeParse({ sidebar: { sortMode: 'activity' } }).success).toBe(false)
    expect(schema.safeParse({ sidebar: { showSubagents: true } }).success).toBe(false)
    expect(schema.safeParse({ sidebar: { ignoreCodexSubagents: true } }).success).toBe(false)
    expect(schema.safeParse({ freshAgent: { showThinking: true } }).success).toBe(false)
    expect(schema.safeParse({ freshAgent: { showTools: true } }).success).toBe(false)
    expect(schema.safeParse({ freshAgent: { showTimecodes: true } }).success).toBe(false)
    expect(schema.safeParse({ agentChat: { defaultPlugins: ['fs'] } }).success).toBe(false)
  })

  it('defaults local sort mode to activity', () => {
    expect(resolveLocalSettings(undefined).sidebar.sortMode).toBe('activity')
  })

  it('migrates hybrid local sort mode to activity', () => {
    expect(resolveLocalSettings({ sidebar: { sortMode: 'hybrid' as any } }).sidebar.sortMode).toBe('activity')
  })

  it('composes resolved settings from server and local settings', () => {
    const resolved = composeResolvedSettings(
      createDefaultServerSettings({ loggingDebug: false }),
      resolveLocalSettings({
        terminal: { fontFamily: 'Fira Code' },
        sidebar: { sortMode: 'project' },
      }),
    )

    expect(resolved.terminal.fontFamily).toBe('Fira Code')
    expect(resolved.terminal.scrollback).toBe(10000)
    expect(resolved.safety.autoKillIdleMinutes).toBe(15)
    expect(resolved.sidebar.sortMode).toBe('project')
    expect(resolved.freshAgent.defaultPlugins).toEqual([])
    expect('agentChat' in resolved).toBe(false)
  })

  it('strips the removed Freshell orchestration plugin path from fresh-agent defaults', () => {
    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        defaultPlugins: [
          '/worktree/.claude/plugins/freshell-orchestration',
          '/custom/plugins/local-tools',
        ],
      },
    })

    expect(merged.freshAgent.defaultPlugins).toEqual(['/custom/plugins/local-tools'])
  })

  it('migrates legacy defaultModel/defaultEffort values into exact selections and explicit effort overrides', () => {
    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      freshAgent: {
        providers: {
          freshclaude: {
            defaultModel: 'fixture-claude-model',
            defaultEffort: 'high',
          } as any,
        },
      },
    })

    expect(merged.freshAgent.providers.freshclaude).toEqual({
      modelSelection: { kind: 'exact', modelId: 'fixture-claude-model' },
      effort: 'high',
    })
  })

  it('mergeServerSettings preserves runtime CLI providers outside the built-in defaults', () => {
    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      codingCli: {
        enabledProviders: ['claude', 'gemini'],
        knownProviders: ['claude', 'codex', 'opencode', 'gemini'],
        providers: {
          gemini: {
            cwd: '/workspace/gemini',
            model: 'gemini-2.5-pro',
          },
        },
      },
    })

    expect(merged.codingCli.enabledProviders).toEqual(['claude', 'gemini'])
    expect(merged.codingCli.knownProviders).toEqual(['claude', 'codex', 'opencode', 'gemini'])
    expect(merged.codingCli.providers.gemini).toEqual({
      cwd: '/workspace/gemini',
      model: 'gemini-2.5-pro',
    })
  })

  it('extracts only moved local settings into the legacy seed', () => {
    const rawMixedSettings = {
      theme: 'dark',
      uiScale: 1.25,
      terminal: {
        fontFamily: 'Fira Code',
        fontSize: 18,
        scrollback: 9000,
        osc52Clipboard: 'always',
      },
      panes: {
        defaultNewPane: 'browser',
        tabAttentionStyle: 'pulse',
      },
      sidebar: {
        sortMode: 'project',
        showSubagents: true,
        ignoreCodexSubagents: false,
        excludeFirstChatSubstrings: ['ignore'],
        excludeFirstChatMustStart: true,
      },
      notifications: {
        soundEnabled: false,
      },
      agentChat: {
        defaultPlugins: ['fs'],
        showThinking: true,
        showTools: true,
      },
    }

    expect(extractLegacyLocalSettingsSeed(rawMixedSettings)).toEqual({
      theme: 'dark',
      uiScale: 1.25,
      terminal: {
        fontFamily: 'Fira Code',
        fontSize: 18,
        osc52Clipboard: 'always',
      },
      panes: {
        tabAttentionStyle: 'pulse',
      },
      sidebar: {
        sortMode: 'project',
        showSubagents: true,
        ignoreCodexSubagents: false,
      },
      freshAgent: {
        showThinking: true,
        showTools: true,
      },
      notifications: {
        soundEnabled: false,
      },
    })
  })

  it('translates deprecated ignoreCodexSubagentSessions into ignoreCodexSubagents when extracting a legacy seed', () => {
    expect(extractLegacyLocalSettingsSeed({
      sidebar: {
        ignoreCodexSubagentSessions: true,
      },
    } as Record<string, unknown>)).toEqual({
      sidebar: {
        ignoreCodexSubagents: true,
      },
    })
  })

  it('clamps migrated local numeric values into supported ranges when extracting a legacy seed', () => {
    expect(extractLegacyLocalSettingsSeed({
      uiScale: -5,
      terminal: {
        fontSize: 1_000_000,
        lineHeight: -2,
      },
      panes: {
        snapThreshold: 99,
      },
      sidebar: {
        width: -999,
      },
    })).toEqual({
      uiScale: 0.75,
      terminal: {
        fontSize: 32,
        lineHeight: 1,
      },
      panes: {
        snapThreshold: 8,
      },
      sidebar: {
        width: 200,
      },
    })
  })

  it('strips moved local settings while preserving server-backed settings', () => {
    const rawMixedSettings = {
      theme: 'dark',
      uiScale: 1.25,
      defaultCwd: '/workspace',
      terminal: {
        fontFamily: 'Fira Code',
        fontSize: 18,
        scrollback: 9000,
        osc52Clipboard: 'always',
      },
      panes: {
        defaultNewPane: 'browser',
        tabAttentionStyle: 'pulse',
      },
      sidebar: {
        sortMode: 'project',
        showSubagents: true,
        ignoreCodexSubagents: false,
        excludeFirstChatSubstrings: ['ignore'],
        excludeFirstChatMustStart: true,
      },
      notifications: {
        soundEnabled: false,
      },
      agentChat: {
        defaultPlugins: ['fs'],
        showThinking: true,
      },
    }

    expect(stripLocalSettings(rawMixedSettings)).toEqual({
      defaultCwd: '/workspace',
      terminal: {
        scrollback: 9000,
      },
      panes: {
        defaultNewPane: 'browser',
      },
      sidebar: {
        excludeFirstChatSubstrings: ['ignore'],
        excludeFirstChatMustStart: true,
      },
      freshAgent: {
        defaultPlugins: ['fs'],
      },
    })
  })

  it('defaults multirowTabs to false in resolved local settings', () => {
    expect(resolveLocalSettings(undefined).panes.multirowTabs).toBe(false)
  })

  it('accepts multirowTabs boolean in local settings patch', () => {
    const resolved = resolveLocalSettings({ panes: { multirowTabs: true } })
    expect(resolved.panes.multirowTabs).toBe(true)
  })

  it('preserves multirowTabs when extracting legacy local settings seed', () => {
    expect(extractLegacyLocalSettingsSeed({
      panes: {
        multirowTabs: true,
      },
    } as Record<string, unknown>)).toEqual({
      panes: {
        multirowTabs: true,
      },
    })
  })

  it('rejects non-boolean multirowTabs in legacy seed extraction', () => {
    expect(extractLegacyLocalSettingsSeed({
      panes: {
        multirowTabs: 'yes',
      },
    } as Record<string, unknown>)).toEqual(undefined)
  })

  it('includes multirowTabs in composed resolved settings', () => {
    const resolved = composeResolvedSettings(
      createDefaultServerSettings({ loggingDebug: false }),
      resolveLocalSettings({ panes: { multirowTabs: true } }),
    )
    expect(resolved.panes.multirowTabs).toBe(true)
  })

  it('rejects multirowTabs in server patch schema', () => {
    const schema = buildServerSettingsPatchSchema()
    expect(schema.safeParse({ panes: { multirowTabs: true } }).success).toBe(false)
  })

  describe('legacy fresh-agent font scale settings', () => {
    it('keeps the legacy fresh-agent font scale default for old stored settings', () => {
      const resolved = resolveLocalSettings(undefined)
      expect(resolved.freshAgent.fontScale).toBe(1.5)
    })

    it('resolves a configured fresh-agent font scale without mirroring agentChat', () => {
      const resolved = resolveLocalSettings({ freshAgent: { fontScale: 1.75 } })
      expect(resolved.freshAgent.fontScale).toBe(1.75)
      expect('agentChat' in resolved).toBe(false)
    })

    it('accepts the legacy fresh-agent font scale through the agentChat alias', () => {
      const resolved = resolveLocalSettings({ agentChat: { fontScale: 1.25 } } as never)
      expect(resolved.freshAgent.fontScale).toBe(1.25)
      expect('agentChat' in resolved).toBe(false)
    })

    it('clamps an out-of-range legacy fresh-agent font scale into the supported range', () => {
      expect(resolveLocalSettings({ freshAgent: { fontScale: 5 } }).freshAgent.fontScale).toBe(2)
      expect(resolveLocalSettings({ freshAgent: { fontScale: 0.1 } }).freshAgent.fontScale).toBe(1)
    })

    it('falls back to the default when the legacy fresh-agent font scale is not a finite number', () => {
      expect(
        resolveLocalSettings({
          freshAgent: { fontScale: 'big' as unknown as number },
        }).freshAgent.fontScale,
      ).toBe(1.5)
    })

    it('keeps the resolved legacy fresh-agent font scale in composed settings', () => {
      const resolved = composeResolvedSettings(
        createDefaultServerSettings({ loggingDebug: false }),
        resolveLocalSettings({ freshAgent: { fontScale: 2 } }),
      )
      expect(resolved.freshAgent.fontScale).toBe(2)
    })

    it('clamps the legacy fresh-agent font scale when extracting a local seed', () => {
      expect(
        extractLegacyLocalSettingsSeed({ agentChat: { fontScale: 9 } } as Record<string, unknown>),
      ).toEqual({ freshAgent: { fontScale: 2 } })
    })
  })
})
