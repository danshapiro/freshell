import { z } from 'zod'

import { DEFAULT_ENABLED_CLI_PROVIDERS } from './coding-cli-defaults.js'
import { normalizeTrimmedStringList } from './string-list.js'

const THEME_VALUES = ['system', 'light', 'dark'] as const
const TERMINAL_THEME_VALUES = [
  'auto',
  'dracula',
  'one-dark',
  'solarized-dark',
  'github-dark',
  'one-light',
  'solarized-light',
  'github-light',
] as const
const OSC52_CLIPBOARD_VALUES = ['ask', 'always', 'never'] as const
const TERMINAL_RENDERER_VALUES = ['auto', 'webgl', 'canvas'] as const
const DEFAULT_NEW_PANE_VALUES = ['ask', 'shell', 'browser', 'editor'] as const
const TAB_ATTENTION_STYLE_VALUES = ['highlight', 'pulse', 'darken', 'none'] as const
const ATTENTION_DISMISS_VALUES = ['click', 'type'] as const
const SIDEBAR_SORT_MODE_VALUES = ['recency', 'recency-pinned', 'activity', 'project'] as const
const CODEX_SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'] as const
const CLAUDE_PERMISSION_MODE_VALUES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const
const EXTERNAL_EDITOR_VALUES = ['auto', 'cursor', 'code', 'custom'] as const
const NETWORK_HOST_VALUES = ['127.0.0.1', '0.0.0.0'] as const
const AGENT_CHAT_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const

const TERMINAL_LOCAL_KEYS = [
  'fontSize',
  'fontFamily',
  'lineHeight',
  'cursorBlink',
  'theme',
  'warnExternalLinks',
  'osc52Clipboard',
  'renderer',
] as const
const PANES_LOCAL_KEYS = ['snapThreshold', 'iconsOnTabs', 'tabAttentionStyle', 'attentionDismiss'] as const
const SIDEBAR_LOCAL_KEYS = [
  'sortMode',
  'showProjectBadges',
  'showSubagents',
  'ignoreCodexSubagents',
  'showNoninteractiveSessions',
  'hideEmptySessions',
  'width',
  'collapsed',
] as const

export type ThemeMode = (typeof THEME_VALUES)[number]
export type TerminalTheme = (typeof TERMINAL_THEME_VALUES)[number]
export type Osc52ClipboardPolicy = (typeof OSC52_CLIPBOARD_VALUES)[number]
export type TerminalRendererMode = (typeof TERMINAL_RENDERER_VALUES)[number]
export type DefaultNewPane = (typeof DEFAULT_NEW_PANE_VALUES)[number]
export type TabAttentionStyle = (typeof TAB_ATTENTION_STYLE_VALUES)[number]
export type AttentionDismiss = (typeof ATTENTION_DISMISS_VALUES)[number]
export type SidebarSortMode = (typeof SIDEBAR_SORT_MODE_VALUES)[number]
export type CodexSandboxMode = (typeof CODEX_SANDBOX_VALUES)[number]
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODE_VALUES)[number]
export type ExternalEditor = (typeof EXTERNAL_EDITOR_VALUES)[number]
export type NetworkHost = (typeof NETWORK_HOST_VALUES)[number]
export type AgentChatEffort = (typeof AGENT_CHAT_EFFORT_VALUES)[number]

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export type CodingCliProviderConfig = {
  model?: string
  sandbox?: CodexSandboxMode
  permissionMode?: ClaudePermissionMode
  maxTurns?: number
  cwd?: string
}

export type CodingCliSettings = {
  enabledProviders: string[]
  knownProviders?: string[]
  providers: Partial<Record<string, CodingCliProviderConfig>>
}

export type AgentChatProviderDefaults = {
  defaultModel?: string
  defaultPermissionMode?: string
  defaultEffort?: AgentChatEffort
}

export type ServerSettings = {
  defaultCwd?: string
  allowedFilePaths?: string[]
  logging: {
    debug: boolean
  }
  safety: {
    autoKillIdleMinutes: number
  }
  terminal: {
    scrollback: number
  }
  panes: {
    defaultNewPane: DefaultNewPane
  }
  sidebar: {
    excludeFirstChatSubstrings: string[]
    excludeFirstChatMustStart: boolean
  }
  codingCli: CodingCliSettings
  editor: {
    externalEditor: ExternalEditor
    customEditorCommand?: string
  }
  agentChat: {
    initialSetupDone?: boolean
    defaultPlugins: string[]
    providers: Partial<Record<string, AgentChatProviderDefaults>>
  }
  network: {
    host: NetworkHost
    configured: boolean
  }
}

export type ServerSettingsPatch = DeepPartial<ServerSettings>

export type LocalSettings = {
  theme: ThemeMode
  uiScale: number
  terminal: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    cursorBlink: boolean
    theme: TerminalTheme
    warnExternalLinks: boolean
    osc52Clipboard: Osc52ClipboardPolicy
    renderer: TerminalRendererMode
  }
  panes: {
    snapThreshold: number
    iconsOnTabs: boolean
    tabAttentionStyle: TabAttentionStyle
    attentionDismiss: AttentionDismiss
  }
  sidebar: {
    sortMode: SidebarSortMode
    showProjectBadges: boolean
    showSubagents: boolean
    ignoreCodexSubagents: boolean
    showNoninteractiveSessions: boolean
    hideEmptySessions: boolean
    width: number
    collapsed: boolean
  }
  notifications: {
    soundEnabled: boolean
  }
}

export type LocalSettingsPatch = DeepPartial<LocalSettings>

export type ResolvedSettings = {
  theme: ThemeMode
  uiScale: number
  terminal: ServerSettings['terminal'] & LocalSettings['terminal']
  defaultCwd?: string
  allowedFilePaths?: string[]
  logging: ServerSettings['logging']
  safety: ServerSettings['safety']
  sidebar: ServerSettings['sidebar'] & LocalSettings['sidebar']
  notifications: LocalSettings['notifications']
  codingCli: ServerSettings['codingCli']
  panes: ServerSettings['panes'] & LocalSettings['panes']
  editor: ServerSettings['editor']
  agentChat: ServerSettings['agentChat']
  network: ServerSettings['network']
}

type SettingsDefaultsOptions = {
  loggingDebug?: boolean
}

const ThemeSchema = z.enum(THEME_VALUES)
const TerminalThemeSchema = z.enum(TERMINAL_THEME_VALUES)
const Osc52ClipboardSchema = z.enum(OSC52_CLIPBOARD_VALUES)
const TerminalRendererSchema = z.enum(TERMINAL_RENDERER_VALUES)
const DefaultNewPaneSchema = z.enum(DEFAULT_NEW_PANE_VALUES)
const TabAttentionStyleSchema = z.enum(TAB_ATTENTION_STYLE_VALUES)
const AttentionDismissSchema = z.enum(ATTENTION_DISMISS_VALUES)
const ExternalEditorSchema = z.enum(EXTERNAL_EDITOR_VALUES)
const NetworkHostSchema = z.enum(NETWORK_HOST_VALUES)
const AgentChatEffortSchema = z.enum(AGENT_CHAT_EFFORT_VALUES)

function hasOwn<T extends object>(value: T | undefined | null, key: PropertyKey): boolean {
  return !!value && Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeDefined<T extends Record<string, unknown>>(base: T, patch?: Partial<T>): T {
  if (!patch) return { ...base }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged as T
}

function mergeRecordOfObjects<T extends Record<string, unknown>>(
  base?: Partial<Record<string, T>>,
  patch?: Partial<Record<string, T>>,
): Partial<Record<string, T>> {
  const merged: Partial<Record<string, T>> = { ...(base || {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    merged[key] = mergeDefined((merged[key] || {}) as T, value || {})
  }
  return merged
}

function normalizeLocalSortMode(mode: unknown): SidebarSortMode {
  if (mode === 'hybrid') {
    return 'activity'
  }
  return SIDEBAR_SORT_MODE_VALUES.includes(mode as SidebarSortMode) ? (mode as SidebarSortMode) : 'activity'
}

function omitKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (keys.includes(key)) {
      continue
    }
    next[key] = value
  }
  return next
}

function pickKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue
    }
    const value = source[key]
    if (value === undefined) {
      continue
    }
    next[key] = value
  }
  return next
}

function maybeAssignNested(
  target: Record<string, unknown>,
  key: string,
  value: Record<string, unknown>,
): void {
  if (Object.keys(value).length > 0) {
    target[key] = value
  }
}

function normalizeExtractedLocalSeed(patch: Record<string, unknown>): LocalSettingsPatch | undefined {
  const normalized: LocalSettingsPatch = {}

  if (patch.theme !== undefined) {
    normalized.theme = patch.theme as ThemeMode
  }
  if (patch.uiScale !== undefined) {
    normalized.uiScale = patch.uiScale as number
  }

  if (isRecord(patch.terminal)) {
    const terminal: LocalSettingsPatch['terminal'] = {}
    if (hasOwn(patch.terminal, 'fontSize')) terminal.fontSize = patch.terminal.fontSize as number
    if (hasOwn(patch.terminal, 'fontFamily')) terminal.fontFamily = patch.terminal.fontFamily as string
    if (hasOwn(patch.terminal, 'lineHeight')) terminal.lineHeight = patch.terminal.lineHeight as number
    if (hasOwn(patch.terminal, 'cursorBlink')) terminal.cursorBlink = patch.terminal.cursorBlink as boolean
    if (hasOwn(patch.terminal, 'theme')) terminal.theme = patch.terminal.theme as TerminalTheme
    if (hasOwn(patch.terminal, 'warnExternalLinks')) {
      terminal.warnExternalLinks = patch.terminal.warnExternalLinks as boolean
    }
    if (hasOwn(patch.terminal, 'osc52Clipboard')) {
      terminal.osc52Clipboard = patch.terminal.osc52Clipboard as Osc52ClipboardPolicy
    }
    if (hasOwn(patch.terminal, 'renderer')) terminal.renderer = patch.terminal.renderer as TerminalRendererMode
    if (Object.keys(terminal).length > 0) {
      normalized.terminal = terminal
    }
  }

  if (isRecord(patch.panes)) {
    const panes: LocalSettingsPatch['panes'] = {}
    if (hasOwn(patch.panes, 'snapThreshold')) panes.snapThreshold = patch.panes.snapThreshold as number
    if (hasOwn(patch.panes, 'iconsOnTabs')) panes.iconsOnTabs = patch.panes.iconsOnTabs as boolean
    if (hasOwn(patch.panes, 'tabAttentionStyle')) {
      panes.tabAttentionStyle = patch.panes.tabAttentionStyle as TabAttentionStyle
    }
    if (hasOwn(patch.panes, 'attentionDismiss')) {
      panes.attentionDismiss = patch.panes.attentionDismiss as AttentionDismiss
    }
    if (Object.keys(panes).length > 0) {
      normalized.panes = panes
    }
  }

  if (isRecord(patch.sidebar)) {
    const sidebar: LocalSettingsPatch['sidebar'] = {}
    if (hasOwn(patch.sidebar, 'sortMode')) {
      sidebar.sortMode = normalizeLocalSortMode(patch.sidebar.sortMode)
    }
    if (hasOwn(patch.sidebar, 'showProjectBadges')) {
      sidebar.showProjectBadges = patch.sidebar.showProjectBadges as boolean
    }
    if (hasOwn(patch.sidebar, 'showSubagents')) sidebar.showSubagents = patch.sidebar.showSubagents as boolean
    if (hasOwn(patch.sidebar, 'ignoreCodexSubagents')) {
      sidebar.ignoreCodexSubagents = patch.sidebar.ignoreCodexSubagents as boolean
    }
    if (hasOwn(patch.sidebar, 'showNoninteractiveSessions')) {
      sidebar.showNoninteractiveSessions = patch.sidebar.showNoninteractiveSessions as boolean
    }
    if (hasOwn(patch.sidebar, 'hideEmptySessions')) {
      sidebar.hideEmptySessions = patch.sidebar.hideEmptySessions as boolean
    }
    if (hasOwn(patch.sidebar, 'width')) sidebar.width = patch.sidebar.width as number
    if (hasOwn(patch.sidebar, 'collapsed')) sidebar.collapsed = patch.sidebar.collapsed as boolean
    if (Object.keys(sidebar).length > 0) {
      normalized.sidebar = sidebar
    }
  }

  if (isRecord(patch.notifications)) {
    const notifications: LocalSettingsPatch['notifications'] = {}
    if (hasOwn(patch.notifications, 'soundEnabled')) {
      notifications.soundEnabled = patch.notifications.soundEnabled as boolean
    }
    if (Object.keys(notifications).length > 0) {
      normalized.notifications = notifications
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function createCliProviderNameSchema(validCliProviders: readonly string[] = DEFAULT_ENABLED_CLI_PROVIDERS) {
  const allowedProviders = new Set(validCliProviders)
  return z.string().min(1).superRefine((value, ctx) => {
    if (allowedProviders.has(value)) {
      return
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown CLI provider: '${value}'`,
    })
  })
}

function createCodingCliProviderConfigSchema() {
  return z
    .object({
      model: z.string().optional(),
      sandbox: z.enum(CODEX_SANDBOX_VALUES).optional(),
      permissionMode: z.enum(CLAUDE_PERMISSION_MODE_VALUES).optional(),
      maxTurns: z.coerce.number().optional(),
      cwd: z.string().optional(),
    })
    .strict()
}

function createAgentChatProviderDefaultsPatchSchema() {
  return z
    .object({
      defaultModel: z.string().optional(),
      defaultPermissionMode: z.string().optional(),
      defaultEffort: AgentChatEffortSchema.optional(),
    })
    .strict()
}

export function buildServerSettingsSchema(validCliProviders: readonly string[] = DEFAULT_ENABLED_CLI_PROVIDERS) {
  const CliProviderNameSchema = createCliProviderNameSchema(validCliProviders)

  return z.object({
    defaultCwd: z.string().optional(),
    allowedFilePaths: z.array(z.string()).optional(),
    logging: z.object({ debug: z.boolean() }).strict(),
    safety: z.object({ autoKillIdleMinutes: z.number() }).strict(),
    terminal: z.object({ scrollback: z.number() }).strict(),
    panes: z.object({ defaultNewPane: DefaultNewPaneSchema }).strict(),
    sidebar: z.object({
      excludeFirstChatSubstrings: z.array(z.string()),
      excludeFirstChatMustStart: z.boolean(),
    }).strict(),
    codingCli: z.object({
      enabledProviders: z.array(CliProviderNameSchema),
      knownProviders: z.array(CliProviderNameSchema).optional(),
      providers: z.record(CliProviderNameSchema, createCodingCliProviderConfigSchema()),
    }).strict(),
    editor: z.object({
      externalEditor: ExternalEditorSchema,
      customEditorCommand: z.string().optional(),
    }).strict(),
    agentChat: z.object({
      initialSetupDone: z.boolean().optional(),
      defaultPlugins: z.array(z.string()),
      providers: z.record(z.string(), createAgentChatProviderDefaultsPatchSchema()),
    }).strict(),
    network: z.object({
      host: NetworkHostSchema,
      configured: z.boolean(),
    }).strict(),
  }).strict()
}

export function buildServerSettingsPatchSchema(validCliProviders: readonly string[] = DEFAULT_ENABLED_CLI_PROVIDERS) {
  const CliProviderNameSchema = createCliProviderNameSchema(validCliProviders)

  return z.object({
    defaultCwd: z.string().nullable().optional(),
    allowedFilePaths: z.array(z.string()).optional(),
    logging: z.object({ debug: z.coerce.boolean().optional() }).strict().optional(),
    safety: z.object({ autoKillIdleMinutes: z.coerce.number().optional() }).strict().optional(),
    terminal: z.object({ scrollback: z.coerce.number().optional() }).strict().optional(),
    panes: z.object({ defaultNewPane: DefaultNewPaneSchema.optional() }).strict().optional(),
    sidebar: z.object({
      excludeFirstChatSubstrings: z.array(z.string()).optional(),
      excludeFirstChatMustStart: z.coerce.boolean().optional(),
    }).strict().optional(),
    codingCli: z.object({
      enabledProviders: z.array(CliProviderNameSchema).optional(),
      knownProviders: z.array(CliProviderNameSchema).optional(),
      providers: z.record(CliProviderNameSchema, createCodingCliProviderConfigSchema()).optional(),
    }).strict().optional(),
    editor: z.object({
      externalEditor: ExternalEditorSchema.optional(),
      customEditorCommand: z.string().optional(),
    }).strict().optional(),
    agentChat: z.object({
      initialSetupDone: z.boolean().optional(),
      defaultPlugins: z.array(z.string()).optional(),
      providers: z.record(z.string(), createAgentChatProviderDefaultsPatchSchema()).optional(),
    }).strict().optional(),
    network: z.object({
      host: NetworkHostSchema.optional(),
      configured: z.coerce.boolean().optional(),
    }).strict().optional(),
  }).strict()
}

export function createDefaultServerSettings(options: SettingsDefaultsOptions = {}): ServerSettings {
  return {
    defaultCwd: undefined,
    allowedFilePaths: undefined,
    logging: {
      debug: options.loggingDebug ?? false,
    },
    safety: {
      autoKillIdleMinutes: 180,
    },
    terminal: {
      scrollback: 5000,
    },
    panes: {
      defaultNewPane: 'ask',
    },
    sidebar: {
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    },
    codingCli: {
      enabledProviders: [...DEFAULT_ENABLED_CLI_PROVIDERS],
      providers: {
        claude: {
          permissionMode: 'default',
        },
        codex: {},
      },
    },
    editor: {
      externalEditor: 'auto',
    },
    agentChat: {
      defaultPlugins: [],
      providers: {},
    },
    network: {
      host: '127.0.0.1',
      configured: false,
    },
  }
}

export const defaultLocalSettings: LocalSettings = {
  theme: 'system',
  uiScale: 1,
  terminal: {
    fontSize: 16,
    fontFamily: 'monospace',
    lineHeight: 1,
    cursorBlink: true,
    theme: 'auto',
    warnExternalLinks: true,
    osc52Clipboard: 'ask',
    renderer: 'auto',
  },
  panes: {
    snapThreshold: 2,
    iconsOnTabs: true,
    tabAttentionStyle: 'highlight',
    attentionDismiss: 'click',
  },
  sidebar: {
    sortMode: 'activity',
    showProjectBadges: true,
    showSubagents: false,
    ignoreCodexSubagents: true,
    showNoninteractiveSessions: false,
    hideEmptySessions: true,
    width: 288,
    collapsed: false,
  },
  notifications: {
    soundEnabled: true,
  },
}

export function createDefaultResolvedSettings(options: SettingsDefaultsOptions = {}): ResolvedSettings {
  return composeResolvedSettings(createDefaultServerSettings(options), defaultLocalSettings)
}

export function mergeServerSettings(base: ServerSettings, patch: ServerSettingsPatch): ServerSettings {
  const codingCliPatch = patch.codingCli
  const agentChatPatch = patch.agentChat

  return {
    ...base,
    ...(hasOwn(patch, 'defaultCwd') ? { defaultCwd: patch.defaultCwd } : {}),
    ...(hasOwn(patch, 'allowedFilePaths') ? { allowedFilePaths: patch.allowedFilePaths } : {}),
    logging: mergeDefined(base.logging, patch.logging),
    safety: mergeDefined(base.safety, patch.safety),
    terminal: mergeDefined(base.terminal, patch.terminal),
    panes: mergeDefined(base.panes, patch.panes),
    sidebar: {
      ...mergeDefined(base.sidebar, patch.sidebar),
      excludeFirstChatSubstrings: hasOwn(patch.sidebar, 'excludeFirstChatSubstrings')
        ? normalizeTrimmedStringList(patch.sidebar?.excludeFirstChatSubstrings)
        : base.sidebar.excludeFirstChatSubstrings,
      excludeFirstChatMustStart: hasOwn(patch.sidebar, 'excludeFirstChatMustStart')
        ? !!patch.sidebar?.excludeFirstChatMustStart
        : base.sidebar.excludeFirstChatMustStart,
    },
    codingCli: {
      ...mergeDefined(base.codingCli, codingCliPatch),
      enabledProviders: hasOwn(codingCliPatch, 'enabledProviders')
        ? [...(codingCliPatch?.enabledProviders || [])]
        : [...base.codingCli.enabledProviders],
      knownProviders: hasOwn(codingCliPatch, 'knownProviders')
        ? codingCliPatch?.knownProviders ? [...codingCliPatch.knownProviders] : undefined
        : base.codingCli.knownProviders ? [...base.codingCli.knownProviders] : undefined,
      providers: mergeRecordOfObjects(base.codingCli.providers, codingCliPatch?.providers),
    },
    editor: mergeDefined(base.editor, patch.editor),
    agentChat: {
      ...mergeDefined(base.agentChat, agentChatPatch),
      defaultPlugins: hasOwn(agentChatPatch, 'defaultPlugins')
        ? normalizeTrimmedStringList(agentChatPatch?.defaultPlugins)
        : base.agentChat.defaultPlugins,
      providers: mergeRecordOfObjects(base.agentChat.providers, agentChatPatch?.providers),
    },
    network: mergeDefined(base.network, patch.network),
  }
}

export function resolveLocalSettings(patch?: LocalSettingsPatch): LocalSettings {
  return {
    ...defaultLocalSettings,
    ...(hasOwn(patch, 'theme') ? { theme: patch?.theme ?? defaultLocalSettings.theme } : {}),
    ...(hasOwn(patch, 'uiScale') ? { uiScale: patch?.uiScale ?? defaultLocalSettings.uiScale } : {}),
    terminal: mergeDefined(defaultLocalSettings.terminal, patch?.terminal),
    panes: mergeDefined(defaultLocalSettings.panes, patch?.panes),
    sidebar: {
      ...mergeDefined(defaultLocalSettings.sidebar, patch?.sidebar),
      sortMode: normalizeLocalSortMode(patch?.sidebar?.sortMode),
    },
    notifications: mergeDefined(defaultLocalSettings.notifications, patch?.notifications),
  }
}

export function mergeLocalSettings(base: LocalSettingsPatch | undefined, patch: LocalSettingsPatch): LocalSettingsPatch {
  const next: LocalSettingsPatch = {
    ...(base || {}),
  }

  if (hasOwn(patch, 'theme')) {
    next.theme = patch.theme
  }
  if (hasOwn(patch, 'uiScale')) {
    next.uiScale = patch.uiScale
  }

  const terminal = mergeDefined((base?.terminal || {}) as Record<string, unknown>, patch.terminal as Record<string, unknown> | undefined)
  if (Object.keys(terminal).length > 0) {
    next.terminal = terminal as LocalSettingsPatch['terminal']
  }

  const panes = mergeDefined((base?.panes || {}) as Record<string, unknown>, patch.panes as Record<string, unknown> | undefined)
  if (Object.keys(panes).length > 0) {
    next.panes = panes as LocalSettingsPatch['panes']
  }

  const sidebar = mergeDefined(
    (base?.sidebar || {}) as Record<string, unknown>,
    patch.sidebar as Record<string, unknown> | undefined,
  )
  if (hasOwn(sidebar, 'sortMode')) {
    sidebar.sortMode = normalizeLocalSortMode(sidebar.sortMode)
  }
  if (Object.keys(sidebar).length > 0) {
    next.sidebar = sidebar as LocalSettingsPatch['sidebar']
  }

  const notifications = mergeDefined(
    (base?.notifications || {}) as Record<string, unknown>,
    patch.notifications as Record<string, unknown> | undefined,
  )
  if (Object.keys(notifications).length > 0) {
    next.notifications = notifications as LocalSettingsPatch['notifications']
  }

  return next
}

export function composeResolvedSettings(server: ServerSettings, local: LocalSettings): ResolvedSettings {
  return {
    theme: local.theme,
    uiScale: local.uiScale,
    terminal: {
      ...server.terminal,
      ...local.terminal,
    },
    defaultCwd: server.defaultCwd,
    allowedFilePaths: server.allowedFilePaths,
    logging: { ...server.logging },
    safety: { ...server.safety },
    sidebar: {
      ...server.sidebar,
      ...local.sidebar,
    },
    notifications: { ...local.notifications },
    codingCli: {
      ...server.codingCli,
      enabledProviders: [...server.codingCli.enabledProviders],
      knownProviders: server.codingCli.knownProviders ? [...server.codingCli.knownProviders] : undefined,
      providers: mergeRecordOfObjects(server.codingCli.providers),
    },
    panes: {
      ...server.panes,
      ...local.panes,
    },
    editor: { ...server.editor },
    agentChat: {
      ...server.agentChat,
      defaultPlugins: [...server.agentChat.defaultPlugins],
      providers: mergeRecordOfObjects(server.agentChat.providers),
    },
    network: { ...server.network },
  }
}

export function extractLegacyLocalSettingsSeed(
  raw: Record<string, unknown> | null | undefined,
): LocalSettingsPatch | undefined {
  if (!raw) {
    return undefined
  }

  const patch: Record<string, unknown> = {}

  if (hasOwn(raw, 'theme')) patch.theme = raw.theme
  if (hasOwn(raw, 'uiScale')) patch.uiScale = raw.uiScale
  if (isRecord(raw.terminal)) {
    maybeAssignNested(patch, 'terminal', pickKeys(raw.terminal, TERMINAL_LOCAL_KEYS))
  }
  if (isRecord(raw.panes)) {
    maybeAssignNested(patch, 'panes', pickKeys(raw.panes, PANES_LOCAL_KEYS))
  }
  if (isRecord(raw.sidebar)) {
    maybeAssignNested(patch, 'sidebar', pickKeys(raw.sidebar, SIDEBAR_LOCAL_KEYS))
  }
  if (isRecord(raw.notifications)) {
    maybeAssignNested(patch, 'notifications', pickKeys(raw.notifications, ['soundEnabled']))
  }

  return normalizeExtractedLocalSeed(patch)
}

export function stripLocalSettings(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!raw) {
    return {}
  }

  const next = omitKeys(raw, ['theme', 'uiScale', 'notifications'])

  if (isRecord(raw.terminal)) {
    const strippedTerminal = omitKeys(raw.terminal, TERMINAL_LOCAL_KEYS)
    if (Object.keys(strippedTerminal).length > 0) {
      next.terminal = strippedTerminal
    } else {
      delete next.terminal
    }
  }

  if (isRecord(raw.panes)) {
    const strippedPanes = omitKeys(raw.panes, PANES_LOCAL_KEYS)
    if (Object.keys(strippedPanes).length > 0) {
      next.panes = strippedPanes
    } else {
      delete next.panes
    }
  }

  if (isRecord(raw.sidebar)) {
    const strippedSidebar = omitKeys(raw.sidebar, SIDEBAR_LOCAL_KEYS)
    if (Object.keys(strippedSidebar).length > 0) {
      next.sidebar = strippedSidebar
    } else {
      delete next.sidebar
    }
  }

  return next
}
