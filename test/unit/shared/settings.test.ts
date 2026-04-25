import { describe, expect, it } from 'vitest'

import {
  buildServerSettingsPatchSchema,
  composeResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  mergeServerSettings,
  resolveLocalSettings,
  stripLocalSettings,
} from '@shared/settings'

describe('shared settings contract', () => {
  it('accepts representative server-backed fields in the server patch schema', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      defaultCwd: '/workspace',
      terminal: { scrollback: 12000 },
      agentChat: { defaultPlugins: ['fs', 'search'] },
    })

    expect(parsed).toEqual({
      defaultCwd: '/workspace',
      terminal: { scrollback: 12000 },
      agentChat: { defaultPlugins: ['fs', 'search'] },
    })
  })

  it('accepts tracked and exact agent-chat model selections with dynamic effort strings', () => {
    const parsed = buildServerSettingsPatchSchema().parse({
      agentChat: {
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

    expect(parsed.agentChat?.providers?.freshclaude).toEqual({
      modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
      effort: 'ultra',
    })
    expect(parsed.agentChat?.providers?.kilroy).toEqual({
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
      defaultPermissionMode: 'plan',
    })
  })

  it('accepts empty effort clear sentinels while allowing omitted model selections', () => {
    const schema = buildServerSettingsPatchSchema()

    expect(schema.safeParse({
      agentChat: {
        providers: {
          freshclaude: {
            defaultPermissionMode: 'plan',
            effort: 'ultra',
          },
        },
      },
    }).success).toBe(true)
    expect(schema.safeParse({
      agentChat: {
        providers: {
          freshclaude: {
            effort: '',
          },
        },
      },
    }).success).toBe(true)
  })

  it('rejects representative local-only fields in the server patch schema', () => {
    const schema = buildServerSettingsPatchSchema()

    expect(schema.safeParse({ theme: 'dark' }).success).toBe(false)
    expect(schema.safeParse({ terminal: { fontSize: 18 } }).success).toBe(false)
    expect(schema.safeParse({ terminal: { osc52Clipboard: 'always' } }).success).toBe(false)
    expect(schema.safeParse({ sidebar: { sortMode: 'activity' } }).success).toBe(false)
    expect(schema.safeParse({ sidebar: { showSubagents: true } }).success).toBe(false)
    expect(schema.safeParse({ sidebar: { ignoreCodexSubagents: true } }).success).toBe(false)
    expect(schema.safeParse({ agentChat: { showThinking: true } }).success).toBe(false)
    expect(schema.safeParse({ agentChat: { showTools: true } }).success).toBe(false)
    expect(schema.safeParse({ agentChat: { showTimecodes: true } }).success).toBe(false)
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
    expect(resolved.sidebar.sortMode).toBe('project')
    expect(resolved.agentChat.defaultPlugins).toEqual([])
  })

  it('strips the removed Freshell orchestration plugin path from agent chat defaults', () => {
    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      agentChat: {
        defaultPlugins: [
          '/worktree/.claude/plugins/freshell-orchestration',
          '/custom/plugins/local-tools',
        ],
      },
    })

    expect(merged.agentChat.defaultPlugins).toEqual(['/custom/plugins/local-tools'])
  })

  it('migrates legacy defaultModel/defaultEffort values into exact selections and explicit effort overrides', () => {
    const merged = mergeServerSettings(createDefaultServerSettings({ loggingDebug: false }), {
      agentChat: {
        providers: {
          freshclaude: {
            defaultModel: 'claude-opus-4-6',
            defaultEffort: 'high',
          } as any,
        },
      },
    })

    expect(merged.agentChat.providers.freshclaude).toEqual({
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
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
      agentChat: {
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
      agentChat: {
        defaultPlugins: ['fs'],
      },
    })
  })
})
