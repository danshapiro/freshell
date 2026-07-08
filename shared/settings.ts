import { z } from 'zod'

import {
  FreshAgentModelSelectionSchema,
  FreshAgentModelCapabilitiesOpaqueStringSchema,
  type FreshAgentModelSelection,
} from './fresh-agent-model-capabilities.js'
import { sanitizeFreshAgentPluginPaths } from './fresh-agent-plugins.js'
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
const SESSION_OPEN_MODE_VALUES = ['tab', 'split'] as const
const SIDEBAR_SORT_MODE_VALUES = ['recency', 'recency-pinned', 'activity', 'project'] as const
const WORKTREE_GROUPING_VALUES = ['repo', 'worktree'] as const
export const CODEX_SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const CLAUDE_PERMISSION_MODE_VALUES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const
const EXTERNAL_EDITOR_VALUES = ['auto', 'cursor', 'code', 'custom'] as const
const NETWORK_HOST_VALUES = ['127.0.0.1', '0.0.0.0'] as const
const UI_SCALE_MIN = 0.75
const UI_SCALE_MAX = 4
// Slider stops for the UI scale control, in integer percent (avoids float drift).
// Fine 5% steps up to 200%, coarse 25% steps to 400%.
export const UI_SCALE_PERCENT_OPTIONS: readonly number[] = [
  75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150,
  155, 160, 165, 170, 175, 180, 185, 190, 195, 200,
  225, 250, 275, 300, 325, 350, 375, 400,
]
const TERMINAL_FONT_SIZE_MIN = 12
const TERMINAL_FONT_SIZE_MAX = 32
const TERMINAL_LINE_HEIGHT_MIN = 1
const TERMINAL_LINE_HEIGHT_MAX = 1.8
const PANE_SNAP_THRESHOLD_MIN = 0
const PANE_SNAP_THRESHOLD_MAX = 8
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 500
const FRESH_AGENT_FONT_SCALE_MIN = 1
const FRESH_AGENT_FONT_SCALE_MAX = 2
// Fresh-agent panes render 50% larger than the base UI by default.
export const FRESH_AGENT_FONT_SCALE_DEFAULT = 1.5
export const FRESH_AGENT_FONT_SCALE_OPTIONS = [1, 1.25, 1.5, 1.75, 2] as const
export const FRESH_AGENT_STYLE_VALUES = ['sans', 'serif', 'mono'] as const
export type FreshAgentStyle = (typeof FRESH_AGENT_STYLE_VALUES)[number]
export const DEFAULT_FRESH_AGENT_STYLE: FreshAgentStyle = 'sans'

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
const PANES_LOCAL_KEYS = ['snapThreshold', 'iconsOnTabs', 'tabAttentionStyle', 'attentionDismiss', 'sessionOpenMode', 'multirowTabs'] as const
const SIDEBAR_LOCAL_KEYS = [
  'sortMode',
  'worktreeGrouping',
  'showProjectBadges',
  'showSubagents',
  'ignoreCodexSubagents',
  'showNoninteractiveSessions',
  'hideEmptySessions',
  'width',
  'collapsed',
] as const
const FRESH_AGENT_LOCAL_KEYS = [
  'showThinking',
  'showTools',
  'showTimecodes',
  'fontScale',
] as const

export type ThemeMode = (typeof THEME_VALUES)[number]
export type TerminalTheme = (typeof TERMINAL_THEME_VALUES)[number]
export type Osc52ClipboardPolicy = (typeof OSC52_CLIPBOARD_VALUES)[number]
export type TerminalRendererMode = (typeof TERMINAL_RENDERER_VALUES)[number]
export type DefaultNewPane = (typeof DEFAULT_NEW_PANE_VALUES)[number]
export type TabAttentionStyle = (typeof TAB_ATTENTION_STYLE_VALUES)[number]
export type AttentionDismiss = (typeof ATTENTION_DISMISS_VALUES)[number]
export type SessionOpenMode = (typeof SESSION_OPEN_MODE_VALUES)[number]
export type SidebarSortMode = (typeof SIDEBAR_SORT_MODE_VALUES)[number]
export type WorktreeGrouping = (typeof WORKTREE_GROUPING_VALUES)[number]
export type CodexSandboxMode = (typeof CODEX_SANDBOX_VALUES)[number]
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODE_VALUES)[number]
export type ExternalEditor = (typeof EXTERNAL_EDITOR_VALUES)[number]
export type NetworkHost = (typeof NETWORK_HOST_VALUES)[number]
export type FreshAgentEffort = string

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
  mcpServer: boolean
}

export type FreshAgentProviderDefaults = {
  modelSelection?: FreshAgentModelSelection
  defaultPermissionMode?: string
  effort?: FreshAgentEffort
  style?: FreshAgentStyle
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
  freshAgent: {
    enabled: boolean
    initialSetupDone?: boolean
    defaultPlugins: string[]
    providers: Partial<Record<string, FreshAgentProviderDefaults>>
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
    sessionOpenMode: SessionOpenMode
    multirowTabs: boolean
  }
  sidebar: {
    sortMode: SidebarSortMode
    worktreeGrouping: WorktreeGrouping
    showProjectBadges: boolean
    showSubagents: boolean
    ignoreCodexSubagents: boolean
    showNoninteractiveSessions: boolean
    hideEmptySessions: boolean
    width: number
    collapsed: boolean
  }
  freshAgent: {
    showThinking: boolean
    showTools: boolean
    showTimecodes: boolean
    fontScale: number
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
  freshAgent: ServerSettings['freshAgent'] & LocalSettings['freshAgent']
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
const SessionOpenModeSchema = z.enum(SESSION_OPEN_MODE_VALUES)
const ExternalEditorSchema = z.enum(EXTERNAL_EDITOR_VALUES)
const NetworkHostSchema = z.enum(NETWORK_HOST_VALUES)
const FreshAgentStyleSchema = z.enum(FRESH_AGENT_STYLE_VALUES)

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

type LegacyFreshAgentSettingsInput = Partial<ServerSettings['freshAgent'] & LocalSettings['freshAgent']> & {
  providers?: Record<string, unknown>
}

type FreshAgentSettingsPatchInput = Partial<ServerSettings['freshAgent'] & LocalSettings['freshAgent']> & {
  providers?: Partial<Record<string, FreshAgentProviderDefaults>>
}

type FreshAgentAliasMergeOptions = {
  canonicalWins?: boolean
  fieldMergeProviders?: boolean
  preserveExplicitEmptyArrays?: boolean
}

export function readLegacyFreshAgentSettingsInput(candidate: Record<string, unknown>): LegacyFreshAgentSettingsInput | null {
  return isRecord(candidate.agentChat)
    ? candidate.agentChat as LegacyFreshAgentSettingsInput
    : null
}

function mergeFreshAgentAliasObjects(
  legacyFreshAgentInput: Record<string, unknown> | null | undefined,
  canonicalFreshAgentInput: Record<string, unknown> | null | undefined,
  options: FreshAgentAliasMergeOptions = {},
): Record<string, unknown> | null {
  if (!legacyFreshAgentInput && !canonicalFreshAgentInput) {
    return null
  }

  const canonicalWins = options.canonicalWins ?? true
  const fieldMergeProviders = options.fieldMergeProviders ?? true
  const preserveExplicitEmptyArrays = options.preserveExplicitEmptyArrays ?? true
  const lowerPriorityInput = canonicalWins ? legacyFreshAgentInput : canonicalFreshAgentInput
  const higherPriorityInput = canonicalWins ? canonicalFreshAgentInput : legacyFreshAgentInput
  const merged: Record<string, unknown> = { ...(lowerPriorityInput || {}), ...(higherPriorityInput || {}) }

  if (
    preserveExplicitEmptyArrays
    && higherPriorityInput
    && hasOwn(higherPriorityInput, 'defaultPlugins')
    && Array.isArray(higherPriorityInput.defaultPlugins)
  ) {
    merged.defaultPlugins = higherPriorityInput.defaultPlugins
  }

  const rawLegacyProviders = legacyFreshAgentInput && isRecord(legacyFreshAgentInput.providers)
    ? legacyFreshAgentInput.providers
    : null
  const rawCanonicalProviders = canonicalFreshAgentInput && isRecord(canonicalFreshAgentInput.providers)
    ? canonicalFreshAgentInput.providers
    : null

  if (rawLegacyProviders || rawCanonicalProviders) {
    if (fieldMergeProviders) {
      const providers: Record<string, unknown> = {}
      const firstProviders = canonicalWins ? rawLegacyProviders : rawCanonicalProviders
      const secondProviders = canonicalWins ? rawCanonicalProviders : rawLegacyProviders
      for (const [providerName, providerPatch] of Object.entries(firstProviders || {})) {
        providers[providerName] = providerPatch
      }
      for (const [providerName, providerPatch] of Object.entries(secondProviders || {})) {
        const existingProviderPatch = providers[providerName]
        providers[providerName] = isRecord(existingProviderPatch) && isRecord(providerPatch)
          ? { ...existingProviderPatch, ...providerPatch }
          : providerPatch
      }
      merged.providers = providers
    } else {
      merged.providers = canonicalWins
        ? rawCanonicalProviders ?? rawLegacyProviders
        : rawLegacyProviders ?? rawCanonicalProviders
    }
  }

  return merged
}

function normalizeWorktreeGrouping(value: unknown): WorktreeGrouping {
  return WORKTREE_GROUPING_VALUES.includes(value as WorktreeGrouping) ? (value as WorktreeGrouping) : 'repo'
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

function normalizeFreshAgentFontScale(value: unknown): number {
  return (
    normalizeClampedNumber(value, FRESH_AGENT_FONT_SCALE_MIN, FRESH_AGENT_FONT_SCALE_MAX)
    ?? FRESH_AGENT_FONT_SCALE_DEFAULT
  )
}

export function normalizeFreshAgentStyleOverride(value: unknown): FreshAgentStyle | undefined {
  return FreshAgentStyleSchema.safeParse(value).success
    ? value as FreshAgentStyle
    : undefined
}

export function normalizeFreshAgentStyle(value: unknown): FreshAgentStyle {
  return normalizeFreshAgentStyleOverride(value) ?? DEFAULT_FRESH_AGENT_STYLE
}

function normalizeLocalFreshAgent(value: LocalSettings['freshAgent']): LocalSettings['freshAgent'] {
  return { ...value, fontScale: normalizeFreshAgentFontScale(value.fontScale) }
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
    if (SessionOpenModeSchema.safeParse(patch.panes.sessionOpenMode).success) {
      panes.sessionOpenMode = patch.panes.sessionOpenMode as SessionOpenMode
    }
    if (typeof patch.panes.multirowTabs === 'boolean') {
      panes.multirowTabs = patch.panes.multirowTabs as boolean
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
    if (hasOwn(patch.sidebar, 'worktreeGrouping')) {
      sidebar.worktreeGrouping = normalizeWorktreeGrouping(patch.sidebar.worktreeGrouping)
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

  if (isRecord(patch.freshAgent)) {
    const freshAgent: LocalSettingsPatch['freshAgent'] = {}
    if (typeof patch.freshAgent.showThinking === 'boolean') {
      freshAgent.showThinking = patch.freshAgent.showThinking as boolean
    }
    if (typeof patch.freshAgent.showTools === 'boolean') {
      freshAgent.showTools = patch.freshAgent.showTools as boolean
    }
    if (typeof patch.freshAgent.showTimecodes === 'boolean') {
      freshAgent.showTimecodes = patch.freshAgent.showTimecodes as boolean
    }
    const normalizedFontScale = normalizeClampedNumber(
      patch.freshAgent.fontScale,
      FRESH_AGENT_FONT_SCALE_MIN,
      FRESH_AGENT_FONT_SCALE_MAX,
    )
    if (normalizedFontScale !== undefined) {
      freshAgent.fontScale = normalizedFontScale
    }
    if (Object.keys(freshAgent).length > 0) {
      normalized.freshAgent = freshAgent
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

function createFreshAgentProviderDefaultsSchema() {
  return z
    .object({
      modelSelection: FreshAgentModelSelectionSchema.optional(),
      defaultPermissionMode: z.string().optional(),
      effort: FreshAgentModelCapabilitiesOpaqueStringSchema.optional(),
      style: FreshAgentStyleSchema.optional(),
    })
    .strict()
}

function createFreshAgentProviderDefaultsPatchSchema() {
  return z
    .object({
      modelSelection: FreshAgentModelSelectionSchema.nullable().optional(),
      defaultPermissionMode: z.string().optional(),
      effort: z.union([FreshAgentModelCapabilitiesOpaqueStringSchema, z.literal('')]).nullable().optional(),
      style: FreshAgentStyleSchema.optional(),
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
      mcpServer: z.boolean(),
    }).strict(),
    editor: z.object({
      externalEditor: ExternalEditorSchema,
      customEditorCommand: z.string().optional(),
    }).strict(),
    freshAgent: z.object({
      enabled: z.boolean(),
      initialSetupDone: z.boolean().optional(),
      defaultPlugins: z.array(z.string()),
      providers: z.record(z.string(), createFreshAgentProviderDefaultsPatchSchema()),
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
      mcpServer: z.coerce.boolean().optional(),
    }).strict().optional(),
    editor: z.object({
      externalEditor: ExternalEditorSchema.optional(),
      customEditorCommand: z.string().optional(),
    }).strict().optional(),
    freshAgent: z.object({
      enabled: z.coerce.boolean().optional(),
      initialSetupDone: z.boolean().optional(),
      defaultPlugins: z.array(z.string()).optional(),
      providers: z.record(z.string(), createFreshAgentProviderDefaultsPatchSchema()).optional(),
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
      autoKillIdleMinutes: 15,
    },
    terminal: {
      scrollback: 10000,
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
      mcpServer: true,
    },
    editor: {
      externalEditor: 'auto',
    },
    freshAgent: {
      enabled: false,
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
    sessionOpenMode: 'tab',
    multirowTabs: false,
  },
  sidebar: {
    sortMode: 'activity',
    worktreeGrouping: 'repo',
    showProjectBadges: true,
    showSubagents: false,
    ignoreCodexSubagents: true,
    showNoninteractiveSessions: false,
    hideEmptySessions: true,
    width: 288,
    collapsed: false,
  },
  freshAgent: {
    showThinking: false,
    showTools: false,
    showTimecodes: false,
    fontScale: FRESH_AGENT_FONT_SCALE_DEFAULT,
  },
  notifications: {
    soundEnabled: true,
  },
}

export function createDefaultResolvedSettings(options: SettingsDefaultsOptions = {}): ResolvedSettings {
  return composeResolvedSettings(createDefaultServerSettings(options), defaultLocalSettings)
}

function sanitizeFreshAgentLocalSettingsPatchInput(
  rawFreshAgent: Record<string, unknown>,
): LocalSettingsPatch['freshAgent'] {
  const freshAgent: LocalSettingsPatch['freshAgent'] = {}
  if (typeof rawFreshAgent.showThinking === 'boolean') {
    freshAgent.showThinking = rawFreshAgent.showThinking
  }
  if (typeof rawFreshAgent.showTools === 'boolean') {
    freshAgent.showTools = rawFreshAgent.showTools
  }
  if (typeof rawFreshAgent.showTimecodes === 'boolean') {
    freshAgent.showTimecodes = rawFreshAgent.showTimecodes
  }
  const normalizedFontScale = normalizeClampedNumber(
    rawFreshAgent.fontScale,
    FRESH_AGENT_FONT_SCALE_MIN,
    FRESH_AGENT_FONT_SCALE_MAX,
  )
  if (normalizedFontScale !== undefined) {
    freshAgent.fontScale = normalizedFontScale
  }
  return Object.keys(freshAgent).length > 0 ? freshAgent : undefined
}

function sanitizeFreshAgentServerSettingsPatchInput(
  rawFreshAgent: Record<string, unknown>,
): ServerSettingsPatch['freshAgent'] {
  const freshAgent: ServerSettingsPatch['freshAgent'] = {}
  const freshAgentProviderDefaultsPatchSchema = createFreshAgentProviderDefaultsPatchSchema()

  if (hasOwn(rawFreshAgent, 'enabled')) {
    freshAgent.enabled = !!rawFreshAgent.enabled
  }
  if (hasOwn(rawFreshAgent, 'initialSetupDone') && typeof rawFreshAgent.initialSetupDone === 'boolean') {
    freshAgent.initialSetupDone = rawFreshAgent.initialSetupDone
  }
  if (hasOwn(rawFreshAgent, 'defaultPlugins') && Array.isArray(rawFreshAgent.defaultPlugins)) {
    freshAgent.defaultPlugins = sanitizeFreshAgentPluginPaths(rawFreshAgent.defaultPlugins)
  }
  if (isRecord(rawFreshAgent.providers)) {
    const providers: NonNullable<NonNullable<ServerSettingsPatch['freshAgent']>['providers']> = {}
    for (const [providerName, providerPatch] of Object.entries(rawFreshAgent.providers)) {
      const normalizedProviderPatchInput = normalizeLegacyFreshAgentProviderDefaultsInput(providerPatch)
      const parsed = freshAgentProviderDefaultsPatchSchema.safeParse(
        normalizedProviderPatchInput,
      )
      if (
        parsed.success
        && isRecord(normalizedProviderPatchInput)
        && Object.keys(normalizedProviderPatchInput).length > 0
      ) {
        const normalizedProviderPatch: FreshAgentProviderDefaults = {}
        if (hasOwn(normalizedProviderPatchInput, 'modelSelection')) {
          normalizedProviderPatch.modelSelection = parsed.data.modelSelection ?? undefined
        }
        if (hasOwn(normalizedProviderPatchInput, 'defaultPermissionMode')) {
          normalizedProviderPatch.defaultPermissionMode = parsed.data.defaultPermissionMode
        }
        if (hasOwn(normalizedProviderPatchInput, 'effort')) {
          const parsedEffort = parsed.data.effort
          normalizedProviderPatch.effort = typeof parsedEffort === 'string' && parsedEffort.trim().length === 0
            ? undefined
            : parsedEffort ?? undefined
        }
        if (hasOwn(normalizedProviderPatchInput, 'style')) {
          normalizedProviderPatch.style = parsed.data.style
        }
        providers[providerName] = normalizedProviderPatch
      }
    }
    if (Object.keys(providers).length > 0) {
      freshAgent.providers = providers
    }
  }

  return Object.keys(freshAgent).length > 0 ? freshAgent : undefined
}

function sanitizeFreshAgentSettingsPatchInput(
  rawFreshAgent: Record<string, unknown>,
): FreshAgentSettingsPatchInput | undefined {
  const serverFreshAgent = sanitizeFreshAgentServerSettingsPatchInput(rawFreshAgent)
  const localFreshAgent = sanitizeFreshAgentLocalSettingsPatchInput(rawFreshAgent)
  const freshAgent = {
    ...(serverFreshAgent || {}),
    ...(localFreshAgent || {}),
  } as FreshAgentSettingsPatchInput
  return Object.keys(freshAgent).length > 0 ? freshAgent : undefined
}

export function migrateLegacyFreshAgentSettingsInput(
  candidate: Record<string, unknown>,
): Pick<ServerSettingsPatch & LocalSettingsPatch, 'freshAgent'> {
  const legacy = readLegacyFreshAgentSettingsInput(candidate)
  const canonical = isRecord(candidate.freshAgent) ? candidate.freshAgent : null
  const merged = mergeFreshAgentAliasObjects(legacy, canonical, {
    canonicalWins: true,
    fieldMergeProviders: true,
    preserveExplicitEmptyArrays: true,
  })
  const freshAgent = merged ? sanitizeFreshAgentSettingsPatchInput(merged) : undefined
  return (freshAgent ? { freshAgent } : {}) as Pick<ServerSettingsPatch & LocalSettingsPatch, 'freshAgent'>
}

function sanitizeServerSettingsPatch(patch: ServerSettingsPatch): ServerSettingsPatch {
  if (!isRecord(patch)) {
    return {}
  }

  const candidate = stripLocalSettings(patch as Record<string, unknown>, {
    migrateLegacyFreshAgentAlias: false,
  })
  const sanitized: ServerSettingsPatch = {}
  // Merge/load paths must preserve runtime provider names that were already accepted elsewhere.
  const cliProviderNameSchema = z.string().min(1)
  const codingCliProviderConfigPatchSchema = createCodingCliProviderConfigPatchSchema()

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
    if (hasOwn(candidate.codingCli, 'mcpServer')) {
      codingCli.mcpServer = !!candidate.codingCli.mcpServer
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

  if (isRecord(candidate.freshAgent)) {
    const freshAgent = sanitizeFreshAgentServerSettingsPatchInput(candidate.freshAgent)
    if (freshAgent) {
      sanitized.freshAgent = freshAgent
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

function normalizeLegacyFreshAgentProviderDefaultsInput(
  providerPatch: unknown,
): Record<string, unknown> | unknown {
  if (!isRecord(providerPatch)) {
    return providerPatch
  }

  const normalized = pickOwnKeysPreservingUndefined(
    providerPatch,
    ['modelSelection', 'defaultPermissionMode', 'effort', 'style'],
  )

  if (
    !hasOwn(normalized, 'modelSelection')
    && typeof providerPatch.defaultModel === 'string'
    && providerPatch.defaultModel.trim().length > 0
  ) {
    normalized.modelSelection = {
      kind: 'exact',
      modelId: providerPatch.defaultModel,
    }
  }

  if (
    !hasOwn(normalized, 'effort')
    && typeof providerPatch.defaultEffort === 'string'
    && providerPatch.defaultEffort.trim().length > 0
  ) {
    normalized.effort = providerPatch.defaultEffort
  }

  return normalized
}

export function mergeServerSettings(base: ServerSettings, patch: ServerSettingsPatch): ServerSettings {
  const normalizedPatch = sanitizeServerSettingsPatch(patch)
  const codingCliPatch = normalizedPatch.codingCli
  const freshAgentPatch = normalizedPatch.freshAgent as
    | Partial<ServerSettings['freshAgent']>
    | undefined

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
    freshAgent: {
      ...mergeDefined(base.freshAgent, freshAgentPatch),
      defaultPlugins: hasOwn(freshAgentPatch, 'defaultPlugins')
        ? sanitizeFreshAgentPluginPaths(freshAgentPatch?.defaultPlugins)
        : base.freshAgent.defaultPlugins,
      providers: mergeRecordOfObjects(base.freshAgent.providers, freshAgentPatch?.providers),
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
  const migratedFreshAgentPatch = patch
    ? migrateLegacyFreshAgentSettingsInput(patch as Record<string, unknown>).freshAgent as FreshAgentSettingsPatchInput | undefined
    : undefined
  const freshAgentPatch = sanitizeFreshAgentLocalSettingsPatchInput(
    isRecord(migratedFreshAgentPatch) ? migratedFreshAgentPatch : {},
  )
  return {
    ...defaultLocalSettings,
    ...(hasOwn(patch, 'theme') ? { theme: patch?.theme ?? defaultLocalSettings.theme } : {}),
    ...(hasOwn(patch, 'uiScale') ? { uiScale: patch?.uiScale ?? defaultLocalSettings.uiScale } : {}),
    terminal: mergeDefined(defaultLocalSettings.terminal, patch?.terminal),
    panes: mergeDefined(defaultLocalSettings.panes, patch?.panes),
    sidebar: {
      ...mergeDefined(defaultLocalSettings.sidebar, patch?.sidebar),
      sortMode: normalizeLocalSortMode(patch?.sidebar?.sortMode),
      worktreeGrouping: normalizeWorktreeGrouping(patch?.sidebar?.worktreeGrouping),
    },
    freshAgent: normalizeLocalFreshAgent(mergeDefined(defaultLocalSettings.freshAgent, freshAgentPatch)),
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
  if (hasOwn(sidebar, 'worktreeGrouping')) {
    sidebar.worktreeGrouping = normalizeWorktreeGrouping(sidebar.worktreeGrouping)
  }
  if (Object.keys(sidebar).length > 0) {
    next.sidebar = sidebar as LocalSettingsPatch['sidebar']
  }

  const baseFreshAgent = base
    ? migrateLegacyFreshAgentSettingsInput(base as Record<string, unknown>).freshAgent as FreshAgentSettingsPatchInput | undefined
    : undefined
  const patchFreshAgent = migrateLegacyFreshAgentSettingsInput(patch as Record<string, unknown>).freshAgent as
    | FreshAgentSettingsPatchInput
    | undefined
  const freshAgent = mergeDefined(
    (sanitizeFreshAgentLocalSettingsPatchInput(isRecord(baseFreshAgent) ? baseFreshAgent : {}) || {}) as Record<string, unknown>,
    (sanitizeFreshAgentLocalSettingsPatchInput(isRecord(patchFreshAgent) ? patchFreshAgent : {}) || {}) as Record<string, unknown>,
  )
  if (Object.keys(freshAgent).length > 0) {
    next.freshAgent = freshAgent as LocalSettingsPatch['freshAgent']
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
    freshAgent: {
      ...server.freshAgent,
      defaultPlugins: [...server.freshAgent.defaultPlugins],
      providers: mergeRecordOfObjects(server.freshAgent.providers),
      ...local.freshAgent,
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
  const migratedFreshAgentLocal = migrateLegacyFreshAgentSettingsInput(raw).freshAgent as
    | FreshAgentSettingsPatchInput
    | undefined
  if (migratedFreshAgentLocal) {
    const freshAgentPatch = pickKeys(migratedFreshAgentLocal, FRESH_AGENT_LOCAL_KEYS)
    maybeAssignNested(patch, 'freshAgent', freshAgentPatch)
  }
  if (isRecord(raw.notifications)) {
    maybeAssignNested(patch, 'notifications', pickKeys(raw.notifications, ['soundEnabled']))
  }

  return normalizeExtractedLocalSeed(patch)
}

export function stripLocalSettings(
  raw: Record<string, unknown> | null | undefined,
  options: { migrateLegacyFreshAgentAlias?: boolean } = {},
): Record<string, unknown> {
  if (!raw) {
    return {}
  }

  const next = omitKeys(raw, ['theme', 'uiScale', 'notifications', 'agentChat'])

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

  const shouldMigrateFreshAgentAlias = options.migrateLegacyFreshAgentAlias ?? true
  const migratedFreshAgent = shouldMigrateFreshAgentAlias
    ? migrateLegacyFreshAgentSettingsInput(raw).freshAgent as FreshAgentSettingsPatchInput | undefined
    : isRecord(raw.freshAgent)
      ? sanitizeFreshAgentSettingsPatchInput(raw.freshAgent)
      : undefined
  if (migratedFreshAgent) {
    const strippedFreshAgent = omitKeys(migratedFreshAgent, FRESH_AGENT_LOCAL_KEYS)
    if (Object.keys(strippedFreshAgent).length > 0) {
      next.freshAgent = strippedFreshAgent
    } else {
      delete next.freshAgent
    }
  }

  return next
}
