import { describe, expect, it } from 'vitest'

import {
  buildServerSettingsPatchSchema,
  composeResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  type LocalSettingsPatch,
  migrateLegacyFreshAgentSettingsInput,
  mergeLocalSettings,
  mergeServerSettings,
  resolveLocalSettings,
  stripLocalSettings,
  TERMINAL_FONT_SIZE_PX_OPTIONS,
  UI_SCALE_PERCENT_OPTIONS,
} from '@shared/settings'

import { buildLocalSettingsPatch } from '@/store/browserPreferencesPersistence'
import { parseBrowserPreferencesRaw } from '@/lib/browser-preferences'

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

  it('accepts an explicit coding CLI effort setting', () => {
    const parsed = buildServerSettingsPatchSchema(['claude', 'codex']).parse({
      codingCli: {
        providers: {
          claude: { model: 'haiku', effort: 'low' },
          codex: { model: 'gpt-5.6-luna', effort: 'minimal' },
        },
      },
    })

    expect(parsed.codingCli?.providers?.claude).toEqual({ model: 'haiku', effort: 'low' })
    expect(parsed.codingCli?.providers?.codex).toEqual({ model: 'gpt-5.6-luna', effort: 'minimal' })
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
      freshAgent: { expandThinking: true },
      agentChat: { showTools: true, showThinking: true, fontScale: 1.25 },
    } as never)

    expect(resolved.freshAgent.expandThinking).toBe(true)
    expect(resolved.freshAgent.expandTools).toBe(false)
    expect('showThinking' in resolved.freshAgent).toBe(false)
    expect('showTools' in resolved.freshAgent).toBe(false)
    expect('fontScale' in resolved.freshAgent).toBe(false)
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
    expect(schema.safeParse({ freshAgent: { expandThinking: true } }).success).toBe(false)
    expect(schema.safeParse({ freshAgent: { expandTools: true } }).success).toBe(false)
    expect(schema.safeParse({ freshAgent: { showTimecodes: true } }).success).toBe(false)
    expect(schema.safeParse({ freshAgent: { showTranscriptMinimap: true } }).success).toBe(false)
    expect(schema.safeParse({ agentChat: { defaultPlugins: ['fs'] } }).success).toBe(false)
  })

  it('defaults local sort mode to activity', () => {
    expect(resolveLocalSettings(undefined).sidebar.sortMode).toBe('activity')
  })

  it('defaults the transcript minimap setting on', () => {
    expect(resolveLocalSettings(undefined).freshAgent.showTranscriptMinimap).toBe(true)
  })

  it('round-trips the transcript minimap setting and drops non-boolean values', () => {
    expect(resolveLocalSettings({ freshAgent: { showTranscriptMinimap: false } }).freshAgent.showTranscriptMinimap).toBe(false)
    expect(resolveLocalSettings({ freshAgent: { showTranscriptMinimap: 'yes' } } as never).freshAgent.showTranscriptMinimap).toBe(true)
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
      freshAgent: {
        expandThinking: true,
        expandTools: true,
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
        expandThinking: true,
        expandTools: true,
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
        fontSize: 64,
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

  it('clamps oversized uiScale to the 400% maximum when extracting a legacy seed', () => {
    expect(extractLegacyLocalSettingsSeed({
      uiScale: 999,
    })).toEqual({
      uiScale: 4,
    })
  })

  it('pins the UI scale percent options: 5% steps to 200, 25% steps to 400', () => {
    expect(UI_SCALE_PERCENT_OPTIONS).toEqual([
      75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150,
      155, 160, 165, 170, 175, 180, 185, 190, 195, 200,
      225, 250, 275, 300, 325, 350, 375, 400,
    ])

    // Invariants: ascending integers spanning the shared clamp range.
    expect(UI_SCALE_PERCENT_OPTIONS[0]).toBe(75)
    expect(UI_SCALE_PERCENT_OPTIONS[UI_SCALE_PERCENT_OPTIONS.length - 1]).toBe(400)
    for (let i = 0; i < UI_SCALE_PERCENT_OPTIONS.length; i++) {
      expect(Number.isInteger(UI_SCALE_PERCENT_OPTIONS[i])).toBe(true)
      if (i === 0) continue
      const delta = UI_SCALE_PERCENT_OPTIONS[i] - UI_SCALE_PERCENT_OPTIONS[i - 1]
      expect(delta).toBeGreaterThan(0)
      expect(delta).toBe(UI_SCALE_PERCENT_OPTIONS[i] <= 200 ? 5 : 25)
    }
  })

  it('pins the terminal font size px options: 1px steps to 32, 2px to 48, 4px to 64', () => {
    expect(TERMINAL_FONT_SIZE_PX_OPTIONS).toEqual([
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
      34, 36, 38, 40, 42, 44, 46, 48,
      52, 56, 60, 64,
    ])
  })

  it('keeps the terminal font size px options strictly ascending integers spanning 12..64', () => {
    expect(TERMINAL_FONT_SIZE_PX_OPTIONS[0]).toBe(12)
    expect(TERMINAL_FONT_SIZE_PX_OPTIONS[TERMINAL_FONT_SIZE_PX_OPTIONS.length - 1]).toBe(64)
    for (let i = 0; i < TERMINAL_FONT_SIZE_PX_OPTIONS.length; i++) {
      expect(Number.isInteger(TERMINAL_FONT_SIZE_PX_OPTIONS[i])).toBe(true)
      if (i === 0) continue
      expect(TERMINAL_FONT_SIZE_PX_OPTIONS[i]).toBeGreaterThan(TERMINAL_FONT_SIZE_PX_OPTIONS[i - 1])
    }
    // Backward compatibility: every previously reachable value 12..32 stays on-list.
    for (let px = 12; px <= 32; px++) {
      expect(TERMINAL_FONT_SIZE_PX_OPTIONS).toContain(px)
    }
  })

  it('ties the font size options max to the legacy-seed clamp maximum', () => {
    const clamped = extractLegacyLocalSettingsSeed({
      terminal: { fontSize: 1_000_000 },
    })
    expect(clamped).toEqual({
      terminal: {
        fontSize: TERMINAL_FONT_SIZE_PX_OPTIONS[TERMINAL_FONT_SIZE_PX_OPTIONS.length - 1],
      },
    })
  })

  it('clamps legacy-seed font sizes at the 64px boundary with round-after-clamp', () => {
    expect(extractLegacyLocalSettingsSeed({ terminal: { fontSize: 64 } }))
      .toEqual({ terminal: { fontSize: 64 } })
    expect(extractLegacyLocalSettingsSeed({ terminal: { fontSize: 65 } }))
      .toEqual({ terminal: { fontSize: 64 } })
    expect(extractLegacyLocalSettingsSeed({ terminal: { fontSize: 63.5 } }))
      .toEqual({ terminal: { fontSize: 64 } })
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

  it('defaults multirowTabs to true in resolved local settings', () => {
    expect(resolveLocalSettings(undefined).panes.multirowTabs).toBe(true)
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

  describe('panes.repoIconsOnTabs (browser-local)', () => {
    it('defaults to true', () => {
      const local = resolveLocalSettings(undefined)
      expect(local.panes.repoIconsOnTabs).toBe(true)
    })

    it('applies a boolean patch', () => {
      const local = resolveLocalSettings({ panes: { repoIconsOnTabs: false } })
      expect(local.panes.repoIconsOnTabs).toBe(false)
    })

    it('merges patches preserving other pane keys', () => {
      const merged = mergeLocalSettings(
        { panes: { iconsOnTabs: false } },
        { panes: { repoIconsOnTabs: false } },
      )
      expect(merged.panes?.iconsOnTabs).toBe(false)
      expect(merged.panes?.repoIconsOnTabs).toBe(false)
    })

    it('is rejected by the server patch schema (stays local)', () => {
      const schema = buildServerSettingsPatchSchema()
      expect(schema.safeParse({ panes: { repoIconsOnTabs: true } }).success).toBe(false)
    })
  })

  describe('panes.floatingActionButton (browser-local)', () => {
    it('defaults to false', () => {
      const local = resolveLocalSettings(undefined)
      expect(local.panes.floatingActionButton).toBe(false)
    })

    it('applies a boolean patch', () => {
      const local = resolveLocalSettings({ panes: { floatingActionButton: true } })
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('merges patches preserving other pane keys', () => {
      const merged = mergeLocalSettings(
        { panes: { iconsOnTabs: false } },
        { panes: { floatingActionButton: true } },
      )
      expect(merged.panes?.iconsOnTabs).toBe(false)
      expect(merged.panes?.floatingActionButton).toBe(true)
    })

    it('preserves floatingActionButton when extracting the legacy local settings seed', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: {
          floatingActionButton: true,
        },
      } as Record<string, unknown>)).toEqual({
        panes: {
          floatingActionButton: true,
        },
      })
    })

    it('rejects non-boolean floatingActionButton in legacy seed extraction', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: {
          floatingActionButton: 'yes',
        },
      } as Record<string, unknown>)).toEqual(undefined)
    })

    it('is rejected by the server patch schema (stays local)', () => {
      const schema = buildServerSettingsPatchSchema()
      expect(schema.safeParse({ panes: { floatingActionButton: true } }).success).toBe(false)
    })

    it('includes floatingActionButton in composed resolved settings', () => {
      const resolved = composeResolvedSettings(
        createDefaultServerSettings({ loggingDebug: false }),
        resolveLocalSettings({ panes: { floatingActionButton: true } }),
      )
      expect(resolved.panes.floatingActionButton).toBe(true)
    })

    it('persists a non-default value through the browser-preferences diff', () => {
      const resolved = resolveLocalSettings({ panes: { floatingActionButton: true } })
      const patch = buildLocalSettingsPatch(resolved)
      expect(patch.panes?.floatingActionButton).toBe(true)
    })

    it('produces no persisted patch entry at the default value', () => {
      const patch = buildLocalSettingsPatch(resolveLocalSettings({}))
      expect(patch.panes?.floatingActionButton).toBeUndefined()
    })

    it('survives the reload path: a parsed browser-preferences record preserves floatingActionButton', () => {
      const raw = JSON.stringify({ settings: { panes: { floatingActionButton: true } } })
      const record = parseBrowserPreferencesRaw(raw)
      expect(record?.settings?.panes?.floatingActionButton).toBe(true)
    })

    it('defaults to true when the desktop platform default is provided', () => {
      const local = resolveLocalSettings(undefined, { floatingActionButtonDefault: true })
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('defaults to false when the mobile platform default is provided', () => {
      const local = resolveLocalSettings(undefined, { floatingActionButtonDefault: false })
      expect(local.panes.floatingActionButton).toBe(false)
    })

    it('keeps an explicit value over the platform default (old default-off-era opt-ins survive the flip)', () => {
      const local = resolveLocalSettings(
        { panes: { floatingActionButton: true } },
        { floatingActionButtonDefault: false },
      )
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('persists a value that differs from the provided platform default and omits one that equals it (desktop base)', () => {
      const off = resolveLocalSettings({ panes: { floatingActionButton: false } }, { floatingActionButtonDefault: true })
      expect(buildLocalSettingsPatch(off, { floatingActionButtonDefault: true }).panes?.floatingActionButton).toBe(false)
      const on = resolveLocalSettings({ panes: { floatingActionButton: true } }, { floatingActionButtonDefault: true })
      expect(buildLocalSettingsPatch(on, { floatingActionButtonDefault: true }).panes?.floatingActionButton).toBeUndefined()
    })

    it('persists a value that differs from the provided platform default and omits one that equals it (mobile base)', () => {
      const on = resolveLocalSettings({ panes: { floatingActionButton: true } }, { floatingActionButtonDefault: false })
      expect(buildLocalSettingsPatch(on, { floatingActionButtonDefault: false }).panes?.floatingActionButton).toBe(true)
      const off = resolveLocalSettings({ panes: { floatingActionButton: false } }, { floatingActionButtonDefault: false })
      expect(buildLocalSettingsPatch(off, { floatingActionButtonDefault: false }).panes?.floatingActionButton).toBeUndefined()
    })

    it('resolves an old default-off-era blob as an explicit true even under the mobile platform default', () => {
      const raw = JSON.stringify({ settings: { panes: { floatingActionButton: true } } })
      const record = parseBrowserPreferencesRaw(raw)
      const local = resolveLocalSettings(record?.settings, { floatingActionButtonDefault: false })
      expect(local.panes.floatingActionButton).toBe(true)
    })

    it('preserves an explicitly saved false across a flush under the platform default it equals (sticky explicit)', () => {
      const previous: LocalSettingsPatch = { panes: { floatingActionButton: false } }
      const local = resolveLocalSettings(previous, { floatingActionButtonDefault: false })
      const patch = buildLocalSettingsPatch(local, { floatingActionButtonDefault: false }, previous)
      expect(patch.panes?.floatingActionButton).toBe(false)
    })

    it('preserves an explicitly saved true across a flush under the desktop platform default (sticky explicit)', () => {
      const previous: LocalSettingsPatch = { panes: { floatingActionButton: true } }
      const local = resolveLocalSettings(previous, { floatingActionButtonDefault: true })
      const patch = buildLocalSettingsPatch(local, { floatingActionButtonDefault: true }, previous)
      expect(patch.panes?.floatingActionButton).toBe(true)
    })

    it('omits a fresh platform-default value when no explicit choice was ever saved', () => {
      const local = resolveLocalSettings(undefined, { floatingActionButtonDefault: true })
      const patch = buildLocalSettingsPatch(local, { floatingActionButtonDefault: true })
      expect(patch.panes?.floatingActionButton).toBeUndefined()
    })

    it('keeps an explicit value change flowing through the sticky rule (user toggles under the opposite class)', () => {
      const previous: LocalSettingsPatch = { panes: { floatingActionButton: true } }
      const local = resolveLocalSettings({ panes: { floatingActionButton: false } }, { floatingActionButtonDefault: true })
      const patch = buildLocalSettingsPatch(local, { floatingActionButtonDefault: true }, previous)
      expect(patch.panes?.floatingActionButton).toBe(false)
    })
  })

  describe('panes.tabBarRows (browser-local)', () => {
    it('defaults to 3', () => {
      expect(resolveLocalSettings(undefined).panes.tabBarRows).toBe(3)
    })

    it('applies a numeric patch', () => {
      expect(resolveLocalSettings({ panes: { tabBarRows: 5 } }).panes.tabBarRows).toBe(5)
    })

    it('merges patches preserving other pane keys', () => {
      const merged = mergeLocalSettings(
        { panes: { multirowTabs: false } },
        { panes: { tabBarRows: 6 } },
      )
      expect(merged.panes?.multirowTabs).toBe(false)
      expect(merged.panes?.tabBarRows).toBe(6)
    })

    it('rounds and clamps tabBarRows in legacy seed extraction', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: { tabBarRows: 4.4 },
      } as Record<string, unknown>)).toEqual({ panes: { tabBarRows: 4 } })
      expect(extractLegacyLocalSettingsSeed({
        panes: { tabBarRows: 42 },
      } as Record<string, unknown>)).toEqual({ panes: { tabBarRows: 10 } })
    })

    it('rejects a non-numeric tabBarRows in legacy seed extraction', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: { tabBarRows: 'lots' },
      } as Record<string, unknown>)).toEqual(undefined)
    })

    it('is rejected by the server patch schema (stays local)', () => {
      const schema = buildServerSettingsPatchSchema()
      expect(schema.safeParse({ panes: { tabBarRows: 5 } }).success).toBe(false)
    })
  })

  describe('deprecated fresh-agent font scale is dropped', () => {
    it('resolves the default fresh-agent settings without a fontScale key', () => {
      expect(resolveLocalSettings(undefined).freshAgent).toEqual({
        expandThinking: false,
        expandTools: false,
        showTimecodes: false,
        showTranscriptMinimap: true,
      })
    })

    it('drops a canonical freshAgent.fontScale regardless of value', () => {
      for (const value of [1.75, 5, 'big']) {
        expect(resolveLocalSettings({ freshAgent: { fontScale: value } } as never).freshAgent).toEqual({
          expandThinking: false,
          expandTools: false,
          showTimecodes: false,
          showTranscriptMinimap: true,
        })
      }
    })

    it('drops the legacy agentChat alias fontScale while keeping its siblings', () => {
      const resolved = resolveLocalSettings({ agentChat: { showTools: true, expandTools: true, fontScale: 1.25 } } as never)
      expect(resolved.freshAgent.expandTools).toBe(true)
      expect('showTools' in resolved.freshAgent).toBe(false)
      expect('fontScale' in resolved.freshAgent).toBe(false)
      expect('agentChat' in resolved).toBe(false)
    })

    it('carries no fontScale into composed settings', () => {
      const resolved = composeResolvedSettings(
        createDefaultServerSettings({ loggingDebug: false }),
        resolveLocalSettings({ freshAgent: { fontScale: 2 } } as never),
      )
      expect('fontScale' in resolved.freshAgent).toBe(false)
    })

    it('drops fontScale when extracting a legacy local seed', () => {
      expect(
        extractLegacyLocalSettingsSeed({ agentChat: { fontScale: 9 } } as Record<string, unknown>),
      ).toEqual(undefined)
      expect(
        extractLegacyLocalSettingsSeed({ agentChat: { expandTools: true, fontScale: 9 } } as Record<string, unknown>),
      ).toEqual({ freshAgent: { expandTools: true } })
    })
  })
})
