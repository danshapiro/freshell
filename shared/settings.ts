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
export const CODEX_SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const CLAUDE_PERMISSION_MODE_VALUES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const
const EXTERNAL_EDITOR_VALUES = ['auto', 'cursor', 'code', 'custom'] as const
const NETWORK_HOST_VALUES = ['127.0.0.1', '0.0.0.0'] as const
const AGENT_CHAT_EFFORT_VALUES = ['low', 'medium', 'high', 'max'] as const
const UI_SCALE_MIN = 0.75
const UI_SCALE_MAX = 1.5
const TERMINAL_FONT_SIZE_MIN = 12
const TERMINAL_FONT_SIZE_MAX = 32
const TERMINAL_LINE_HEIGHT_MIN = 1
const TERMINAL_LINE_HEIGHT_MAX = 1.8
const PANE_SNAP_THRESHOLD_MIN = 0
const PANE_SNAP_THRESHOLD_MAX = 8
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 500

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
    autoGenerateTitles: boolean
  }
  ai: {
    geminiApiKey?: string
    titlePrompt?: string
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
  extensions: {
    disabled: string[]
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
  ai: ServerSettings['ai']
  notifications: LocalSettings['notifications']
  codingCli: ServerSettings['codingCli']
  panes: ServerSettings['panes'] & LocalSettings['panes']
  editor: ServerSettings['editor']
  agentChat: ServerSettings['agentChat']
  extensions: ServerSettings['extensions']
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

function mergeOwnKeys<T extends Record<string, unknown>>(base: T, patch?: Partial<T>): T {
  if (!patch) return { ...base }
  const merged: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    merged[key] = patch[key as keyof T]
  }
  return merged as T
}

function mergeRecordOfObjects<T extends Record<string, unknown>>(
  base?: Partial<Record<string, T>>,
  patch?: Partial<Record<string, T>>,
): Partial<Record<string, T>> {
  const merged: Partial<Record<string, T>> = { ...(base || {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    merged[key] = mergeOwnKeys((merged[key] || {}) as T, value || {})
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

function pickOwnKeysPreservingUndefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue
    }
    next[key] = source[key]
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeClampedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return clampNumber(value, min, max)
}

function normalizeRoundedClampedNumber(value: unknown, min: number, max: number): number | undefined {
  const normalized = normalizeClampedNumber(value, min, max)
  if (normalized === undefined) {
    return undefined
  }
  return Math.round(normalized)
}

function normalizeExtractedLocalSeed(patch: Record<string, unknown>): LocalSettingsPatch | undefined {
  const normalized: LocalSettingsPatch = {}

  if (ThemeSchema.safeParse(patch.theme).success) {
    normalized.theme = patch.theme as ThemeMode
  }
  const normalizedUiScale = normalizeClampedNumber(patch.uiScale, UI_SCALE_MIN, UI_SCALE_MAX)
  if (normalizedUiScale !== undefined) {
    normalized.uiScale = normalizedUiScale
  }

  if (isRecord(patch.terminal)) {
    const terminal: LocalSettingsPatch['terminal'] = {}
    const normalizedFontSize = normalizeRoundedClampedNumber(
      patch.terminal.fontSize,
      TERMINAL_FONT_SIZE_MIN,
      TERMINAL_FONT_SIZE_MAX,
    )
    if (normalizedFontSize !== undefined) {
      terminal.fontSize = normalizedFontSize
    }
    if (typeof patch.terminal.fontFamily === 'string') {
      terminal.fontFamily = patch.terminal.fontFamily
    }
    const normalizedLineHeight = normalizeClampedNumber(
      patch.terminal.lineHeight,
      TERMINAL_LINE_HEIGHT_MIN,
      TERMINAL_LINE_HEIGHT_MAX,
    )
    if (normalizedLineHeight !== undefined) {
      terminal.lineHeight = normalizedLineHeight
    }
    if (typeof patch.terminal.cursorBlink === 'boolean') {
      terminal.cursorBlink = patch.terminal.cursorBlink
    }
    if (TerminalThemeSchema.safeParse(patch.terminal.theme).success) {
      terminal.theme = patch.terminal.theme as TerminalTheme
    }
    if (typeof patch.terminal.warnExternalLinks === 'boolean') {
      terminal.warnExternalLinks = patch.terminal.warnExternalLinks as boolean
    }
    if (Osc52ClipboardSchema.safeParse(patch.terminal.osc52Clipboard).success) {
      terminal.osc52Clipboard = patch.terminal.osc52Clipboard as Osc52ClipboardPolicy
    }
    if (TerminalRendererSchema.safeParse(patch.terminal.renderer).success) {
      terminal.renderer = patch.terminal.renderer as TerminalRendererMode
    }
    if (Object.keys(terminal).length > 0) {
      normalized.terminal = terminal
    }
  }

  if (isRecord(patch.panes)) {
    const panes: LocalSettingsPatch['panes'] = {}
    const normalizedSnapThreshold = normalizeRoundedClampedNumber(
      patch.panes.snapThreshold,
      PANE_SNAP_THRESHOLD_MIN,
      PANE_SNAP_THRESHOLD_MAX,
    )
    if (normalizedSnapThreshold !== undefined) {
      panes.snapThreshold = normalizedSnapThreshold
    }
    if (typeof patch.panes.iconsOnTabs === 'boolean') {
      panes.iconsOnTabs = patch.panes.iconsOnTabs as boolean
    }
    if (TabAttentionStyleSchema.safeParse(patch.panes.tabAttentionStyle).success) {
      panes.tabAttentionStyle = patch.panes.tabAttentionStyle as TabAttentionStyle
    }
    if (AttentionDismissSchema.safeParse(patch.panes.attentionDismiss).success) {
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
    if (typeof patch.sidebar.showProjectBadges === 'boolean') {
      sidebar.showProjectBadges = patch.sidebar.showProjectBadges as boolean
    }
    if (typeof patch.sidebar.showSubagents === 'boolean') {
      sidebar.showSubagents = patch.sidebar.showSubagents as boolean
    }
    if (typeof patch.sidebar.ignoreCodexSubagents === 'boolean') {
      sidebar.ignoreCodexSubagents = patch.sidebar.ignoreCodexSubagents as boolean
    }
    if (typeof patch.sidebar.showNoninteractiveSessions === 'boolean') {
      sidebar.showNoninteractiveSessions = patch.sidebar.showNoninteractiveSessions as boolean
    }
    if (typeof patch.sidebar.hideEmptySessions === 'boolean') {
      sidebar.hideEmptySessions = patch.sidebar.hideEmptySessions as boolean
    }
    const normalizedSidebarWidth = normalizeRoundedClampedNumber(
      patch.sidebar.width,
      SIDEBAR_WIDTH_MIN,
      SIDEBAR_WIDTH_MAX,
    )
    if (normalizedSidebarWidth !== undefined) {
      sidebar.width = normalizedSidebarWidth
    }
    if (typeof patch.sidebar.collapsed === 'boolean') {
      sidebar.collapsed = patch.sidebar.collapsed as boolean
    }
    if (Object.keys(sidebar).length > 0) {
      normalized.sidebar = sidebar
    }
  }

  if (isRecord(patch.notifications)) {
    const notifications: LocalSettingsPatch['notifications'] = {}
    if (typeof patch.notifications.soundEnabled === 'boolean') {
      notifications.soundEnabled = patch.notifications.soundEnabled as boolean
    }
    if (Object.keys(notifications).length > 0) {
      normalized.notifications = notifications
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function createCliProviderNameSchema(validCliProviders?: readonly string[]) {
  const allowedProviders = validCliProviders ? new Set(validCliProviders) : null
  return z.string().min(1).superRefine((value, ctx) => {
    if (!allowedProviders || allowedProviders.has(value)) {
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

function createCodingCliProviderConfigPatchSchema() {
  return z
    .object({
      model: z.string().nullable().optional(),
      sandbox: z.enum(CODEX_SANDBOX_VALUES).nullable().optional(),
      permissionMode: z.enum(CLAUDE_PERMISSION_MODE_VALUES).optional(),
      maxTurns: z.coerce.number().optional(),
      cwd: z.string().nullable().optional(),
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

export function buildServerSettingsSchema(validCliProviders?: readonly string[]) {
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
      autoGenerateTitles: z.boolean(),
    }).strict(),
    ai: z.object({
      geminiApiKey: z.string().optional(),
      titlePrompt: z.string().optional(),
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
    extensions: z.object({
      disabled: z.array(z.string()),
    }).strict(),
    network: z.object({
      host: NetworkHostSchema,
      configured: z.boolean(),
    }).strict(),
  }).strict()
}

export function buildServerSettingsPatchSchema(validCliProviders?: readonly string[]) {
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
      autoGenerateTitles: z.coerce.boolean().optional(),
    }).strict().optional(),
    ai: z.object({
      geminiApiKey: z.string().nullable().optional(),
      titlePrompt: z.string().nullable().optional(),
    }).strict().optional(),
    codingCli: z.object({
      enabledProviders: z.array(CliProviderNameSchema).optional(),
      knownProviders: z.array(CliProviderNameSchema).optional(),
      providers: z.record(CliProviderNameSchema, createCodingCliProviderConfigPatchSchema()).optional(),
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
    extensions: z.object({
      disabled: z.array(z.string()).optional(),
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
      autoGenerateTitles: true,
    },
    ai: {
      geminiApiKey: undefined,
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
    extensions: {
      disabled: [],
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

function sanitizeServerSettingsPatch(patch: ServerSettingsPatch): ServerSettingsPatch {
  if (!isRecord(patch)) {
    return {}
  }

  const candidate = stripLocalSettings(patch as Record<string, unknown>)
  const sanitized: ServerSettingsPatch = {}
  // Merge/load paths must preserve runtime provider names that were already accepted elsewhere.
  const cliProviderNameSchema = z.string().min(1)
  const codingCliProviderConfigPatchSchema = createCodingCliProviderConfigPatchSchema()
  const agentChatProviderDefaultsPatchSchema = createAgentChatProviderDefaultsPatchSchema()

  if (
    hasOwn(candidate, 'defaultCwd')
    && (typeof candidate.defaultCwd === 'string' || candidate.defaultCwd == null)
  ) {
    sanitized.defaultCwd = candidate.defaultCwd as ServerSettingsPatch['defaultCwd']
  }
  if (hasOwn(candidate, 'allowedFilePaths') && Array.isArray(candidate.allowedFilePaths)) {
    sanitized.allowedFilePaths = candidate.allowedFilePaths.filter((value): value is string => typeof value === 'string')
  }

  if (isRecord(candidate.logging) && hasOwn(candidate.logging, 'debug')) {
    sanitized.logging = { debug: !!candidate.logging.debug }
  }

  if (isRecord(candidate.safety) && hasOwn(candidate.safety, 'autoKillIdleMinutes')) {
    const parsed = z.coerce.number().safeParse(candidate.safety.autoKillIdleMinutes)
    if (parsed.success) {
      sanitized.safety = { autoKillIdleMinutes: parsed.data }
    }
  }

  if (isRecord(candidate.terminal) && hasOwn(candidate.terminal, 'scrollback')) {
    const parsed = z.coerce.number().safeParse(candidate.terminal.scrollback)
    if (parsed.success) {
      sanitized.terminal = { scrollback: parsed.data }
    }
  }

  if (isRecord(candidate.panes) && hasOwn(candidate.panes, 'defaultNewPane')) {
    const parsed = DefaultNewPaneSchema.safeParse(candidate.panes.defaultNewPane)
    if (parsed.success) {
      sanitized.panes = { defaultNewPane: parsed.data }
    }
  }

  if (isRecord(candidate.sidebar)) {
    const sidebar: ServerSettingsPatch['sidebar'] = {}
    if (hasOwn(candidate.sidebar, 'excludeFirstChatSubstrings') && Array.isArray(candidate.sidebar.excludeFirstChatSubstrings)) {
      sidebar.excludeFirstChatSubstrings = candidate.sidebar.excludeFirstChatSubstrings.filter(
        (value): value is string => typeof value === 'string',
      )
    }
    if (hasOwn(candidate.sidebar, 'excludeFirstChatMustStart')) {
      sidebar.excludeFirstChatMustStart = !!candidate.sidebar.excludeFirstChatMustStart
    }
    if (hasOwn(candidate.sidebar, 'autoGenerateTitles')) {
      sidebar.autoGenerateTitles = !!candidate.sidebar.autoGenerateTitles
    }
    if (Object.keys(sidebar).length > 0) {
      sanitized.sidebar = sidebar
    }
  }

  if (isRecord(candidate.ai)) {
    const ai: ServerSettingsPatch['ai'] = {}
    if (hasOwn(candidate.ai, 'geminiApiKey')) {
      ai.geminiApiKey = typeof candidate.ai.geminiApiKey === 'string' ? candidate.ai.geminiApiKey : undefined
    }
    if (hasOwn(candidate.ai, 'titlePrompt')) {
      ai.titlePrompt = typeof candidate.ai.titlePrompt === 'string' ? candidate.ai.titlePrompt : undefined
    }
    if (Object.keys(ai).length > 0) {
      sanitized.ai = ai
    }
  }

  if (isRecord(candidate.codingCli)) {
    const codingCli: ServerSettingsPatch['codingCli'] = {}
    if (hasOwn(candidate.codingCli, 'enabledProviders') && Array.isArray(candidate.codingCli.enabledProviders)) {
      codingCli.enabledProviders = candidate.codingCli.enabledProviders.filter(
        (value): value is string => cliProviderNameSchema.safeParse(value).success,
      )
    }
    if (hasOwn(candidate.codingCli, 'knownProviders') && Array.isArray(candidate.codingCli.knownProviders)) {
      codingCli.knownProviders = candidate.codingCli.knownProviders.filter(
        (value): value is string => cliProviderNameSchema.safeParse(value).success,
      )
    }
    if (isRecord(candidate.codingCli.providers)) {
      const providers: NonNullable<ServerSettingsPatch['codingCli']>['providers'] = {}
      for (const [providerName, providerPatch] of Object.entries(candidate.codingCli.providers)) {
        if (!cliProviderNameSchema.safeParse(providerName).success) {
          continue
        }
        const pickedProviderPatch = isRecord(providerPatch)
          ? pickOwnKeysPreservingUndefined(providerPatch, ['model', 'sandbox', 'permissionMode', 'maxTurns', 'cwd'])
          : providerPatch
        const parsed = codingCliProviderConfigPatchSchema.safeParse(
          pickedProviderPatch,
        )
        if (parsed.success && isRecord(pickedProviderPatch) && Object.keys(pickedProviderPatch).length > 0) {
          const normalizedProviderPatch: Partial<CodingCliProviderConfig> = {}
          if (hasOwn(pickedProviderPatch, 'model')) {
            normalizedProviderPatch.model = parsed.data.model ?? undefined
          }
          if (hasOwn(pickedProviderPatch, 'sandbox')) {
            normalizedProviderPatch.sandbox = parsed.data.sandbox ?? undefined
          }
          if (hasOwn(pickedProviderPatch, 'permissionMode')) {
            normalizedProviderPatch.permissionMode = parsed.data.permissionMode
          }
          if (hasOwn(pickedProviderPatch, 'maxTurns')) {
            normalizedProviderPatch.maxTurns = parsed.data.maxTurns
          }
          if (hasOwn(pickedProviderPatch, 'cwd')) {
            normalizedProviderPatch.cwd = parsed.data.cwd ?? undefined
          }
          providers[providerName] = normalizedProviderPatch
        }
      }
      if (Object.keys(providers).length > 0) {
        codingCli.providers = providers
      }
    }
    if (Object.keys(codingCli).length > 0) {
      sanitized.codingCli = codingCli
    }
  }

  if (isRecord(candidate.editor)) {
    const editor: ServerSettingsPatch['editor'] = {}
    if (hasOwn(candidate.editor, 'externalEditor')) {
      const parsed = ExternalEditorSchema.safeParse(candidate.editor.externalEditor)
      if (parsed.success) {
        editor.externalEditor = parsed.data
      }
    }
    if (hasOwn(candidate.editor, 'customEditorCommand') && typeof candidate.editor.customEditorCommand === 'string') {
      editor.customEditorCommand = candidate.editor.customEditorCommand
    }
    if (Object.keys(editor).length > 0) {
      sanitized.editor = editor
    }
  }

  if (isRecord(candidate.agentChat)) {
    const agentChat: ServerSettingsPatch['agentChat'] = {}
    if (hasOwn(candidate.agentChat, 'initialSetupDone') && typeof candidate.agentChat.initialSetupDone === 'boolean') {
      agentChat.initialSetupDone = candidate.agentChat.initialSetupDone
    }
    if (hasOwn(candidate.agentChat, 'defaultPlugins') && Array.isArray(candidate.agentChat.defaultPlugins)) {
      agentChat.defaultPlugins = candidate.agentChat.defaultPlugins.filter(
        (value): value is string => typeof value === 'string',
      )
    }
    if (isRecord(candidate.agentChat.providers)) {
      const providers: NonNullable<ServerSettingsPatch['agentChat']>['providers'] = {}
      for (const [providerName, providerPatch] of Object.entries(candidate.agentChat.providers)) {
        const parsed = agentChatProviderDefaultsPatchSchema.safeParse(
          isRecord(providerPatch)
            ? pickKeys(providerPatch, ['defaultModel', 'defaultPermissionMode', 'defaultEffort'])
            : providerPatch,
        )
        if (parsed.success && Object.keys(parsed.data).length > 0) {
          providers[providerName] = parsed.data
        }
      }
      if (Object.keys(providers).length > 0) {
        agentChat.providers = providers
      }
    }
    if (Object.keys(agentChat).length > 0) {
      sanitized.agentChat = agentChat
    }
  }

  if (isRecord(candidate.network)) {
    const network: ServerSettingsPatch['network'] = {}
    if (hasOwn(candidate.network, 'host')) {
      const parsed = NetworkHostSchema.safeParse(candidate.network.host)
      if (parsed.success) {
        network.host = parsed.data
      }
    }
    if (hasOwn(candidate.network, 'configured')) {
      network.configured = !!candidate.network.configured
    }
    if (Object.keys(network).length > 0) {
      sanitized.network = network
    }
  }

  if (isRecord(candidate.extensions)) {
    const extensions: ServerSettingsPatch['extensions'] = {}
    if (Array.isArray(candidate.extensions.disabled)) {
      extensions.disabled = candidate.extensions.disabled.filter(
        (item): item is string => typeof item === 'string',
      )
    }
    if (Object.keys(extensions).length > 0) {
      sanitized.extensions = extensions
    }
  }

  return sanitized
}

export function mergeServerSettings(base: ServerSettings, patch: ServerSettingsPatch): ServerSettings {
  const normalizedPatch = sanitizeServerSettingsPatch(patch)
  const codingCliPatch = normalizedPatch.codingCli
  const agentChatPatch = normalizedPatch.agentChat

  return {
    ...base,
    ...(hasOwn(normalizedPatch, 'defaultCwd') ? { defaultCwd: normalizedPatch.defaultCwd } : {}),
    ...(hasOwn(normalizedPatch, 'allowedFilePaths') ? { allowedFilePaths: normalizedPatch.allowedFilePaths } : {}),
    logging: mergeDefined(base.logging, normalizedPatch.logging),
    safety: mergeDefined(base.safety, normalizedPatch.safety),
    terminal: mergeDefined(base.terminal, normalizedPatch.terminal),
    panes: mergeDefined(base.panes, normalizedPatch.panes),
    sidebar: {
      ...mergeDefined(base.sidebar, normalizedPatch.sidebar),
      excludeFirstChatSubstrings: hasOwn(normalizedPatch.sidebar, 'excludeFirstChatSubstrings')
        ? normalizeTrimmedStringList(normalizedPatch.sidebar?.excludeFirstChatSubstrings)
        : base.sidebar.excludeFirstChatSubstrings,
      excludeFirstChatMustStart: hasOwn(normalizedPatch.sidebar, 'excludeFirstChatMustStart')
        ? !!normalizedPatch.sidebar?.excludeFirstChatMustStart
        : base.sidebar.excludeFirstChatMustStart,
    },
    ai: mergeDefined(base.ai, normalizedPatch.ai),
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
    editor: mergeDefined(base.editor, normalizedPatch.editor),
    agentChat: {
      ...mergeDefined(base.agentChat, agentChatPatch),
      defaultPlugins: hasOwn(agentChatPatch, 'defaultPlugins')
        ? normalizeTrimmedStringList(agentChatPatch?.defaultPlugins)
        : base.agentChat.defaultPlugins,
      providers: mergeRecordOfObjects(base.agentChat.providers, agentChatPatch?.providers),
    },
    extensions: {
      disabled: hasOwn(normalizedPatch.extensions, 'disabled')
        ? [...(normalizedPatch.extensions?.disabled || [])]
        : [...base.extensions.disabled],
    },
    network: mergeDefined(base.network, normalizedPatch.network),
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
    ai: { ...server.ai },
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
    extensions: {
      disabled: [...server.extensions.disabled],
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
    const sidebarPatch = pickKeys(raw.sidebar, SIDEBAR_LOCAL_KEYS)
    if (
      !Object.prototype.hasOwnProperty.call(sidebarPatch, 'ignoreCodexSubagents')
      && typeof raw.sidebar.ignoreCodexSubagentSessions === 'boolean'
    ) {
      sidebarPatch.ignoreCodexSubagents = raw.sidebar.ignoreCodexSubagentSessions
    }
    maybeAssignNested(patch, 'sidebar', sidebarPatch)
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
