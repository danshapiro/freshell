import { getProviderLabel } from './coding-cli-utils'
import { derivePaneTitle } from './derivePaneTitle'
import { deriveTabName } from './deriveTabName'
import type { PaneNode } from '@/store/paneTypes'
import type { ShellType, TabMode } from '@/store/types'
import type { ClientExtensionEntry } from '@shared/extension-types'

export type DurableTitleSource = 'derived' | 'stable' | 'user'

const DURABLE_TITLE_SOURCE_PRIORITY = {
  derived: 0,
  stable: 1,
  user: 2,
} as const

const BRAILLE_SPINNER_PREFIX = /^[\u2800-\u28ff]\s+/
const TAB_NUMBER_TITLE_PATTERN = /^Tab \d+$/

type BootstrapLegacyTabTitleSourceInput = {
  title?: string
  titleSetByUser?: boolean
  mode?: TabMode
  shell?: ShellType
  extensions?: ClientExtensionEntry[]
}

type ResolveEffectiveLegacyTabTitleSourceInput = {
  storedTitle?: string
  titleSetByUser?: boolean
  layout?: PaneNode
  paneTitle?: string
  paneTitleSource?: DurableTitleSource
  extensions?: ClientExtensionEntry[]
}

type ResolveDurableTabTitleSourceInput = {
  titleSource?: DurableTitleSource
  title?: string
  titleSetByUser?: boolean
  mode?: TabMode
  shell?: ShellType
  layout?: PaneNode
  paneTitle?: string
  paneTitleSource?: DurableTitleSource
  extensions?: ClientExtensionEntry[]
}

type InferLegacyPaneTitleSourceInput = {
  storedTitle?: string
  derivedTitle: string
  titleSetByUser?: boolean
}

function getPlaceholderTitleForMode(
  mode?: TabMode,
  shell?: ShellType,
  extensions?: ClientExtensionEntry[],
): string | null {
  if (!mode || mode === 'shell') {
    switch (shell) {
      case 'powershell':
        return 'PowerShell'
      case 'cmd':
        return 'Command Prompt'
      case 'wsl':
        return 'WSL'
      case 'system':
      default:
        return 'Shell'
    }
  }

  return getProviderLabel(mode, extensions)
}

function isObviouslyDerivedTabTitle(
  title: string | undefined,
  mode?: TabMode,
  shell?: ShellType,
  extensions?: ClientExtensionEntry[],
): boolean {
  if (!title) return true

  const trimmedTitle = title.trim()
  if (!trimmedTitle) return true
  if (trimmedTitle === 'Tab' || trimmedTitle === 'New Tab' || TAB_NUMBER_TITLE_PATTERN.test(trimmedTitle)) {
    return true
  }

  const placeholderTitle = getPlaceholderTitleForMode(mode, shell, extensions)
  return trimmedTitle === placeholderTitle
}

export function shouldReplaceDurableTitleSource(
  current: DurableTitleSource | undefined,
  next: DurableTitleSource,
): boolean {
  return DURABLE_TITLE_SOURCE_PRIORITY[next] >= DURABLE_TITLE_SOURCE_PRIORITY[current ?? 'derived']
}

export function bootstrapLegacyTabTitleSource(
  input: BootstrapLegacyTabTitleSourceInput,
): DurableTitleSource | undefined {
  if (input.titleSetByUser) return 'user'
  if (isObviouslyDerivedTabTitle(input.title, input.mode, input.shell, input.extensions)) {
    return 'derived'
  }
  return undefined
}

export function resolveEffectiveLegacyTabTitleSource(
  input: ResolveEffectiveLegacyTabTitleSourceInput,
): DurableTitleSource | undefined {
  if (input.titleSetByUser) return 'user'

  const layout = input.layout
  const bootstrapSource = bootstrapLegacyTabTitleSource({
    title: input.storedTitle,
    titleSetByUser: input.titleSetByUser,
    mode: layout?.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content.mode : undefined,
    shell: layout?.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content.shell : undefined,
    extensions: input.extensions,
  })
  if (bootstrapSource) return bootstrapSource
  if (!layout) return undefined

  const derivedTabTitle = deriveTabName(layout, input.extensions)
  if (!input.storedTitle || input.storedTitle === derivedTabTitle) {
    return 'derived'
  }

  if (layout.type === 'leaf') {
    const derivedPaneTitle = derivePaneTitle(layout.content, input.extensions)
    if (input.storedTitle === derivedPaneTitle) {
      return 'derived'
    }
    if (input.paneTitle && input.storedTitle === input.paneTitle && input.paneTitleSource) {
      return input.paneTitleSource
    }
  }

  return 'stable'
}

export function resolveDurableTabTitleSource(
  input: ResolveDurableTabTitleSourceInput,
): DurableTitleSource | undefined {
  if (input.titleSource) return input.titleSource

  if (input.layout) {
    return resolveEffectiveLegacyTabTitleSource({
      storedTitle: input.title,
      titleSetByUser: input.titleSetByUser,
      layout: input.layout,
      paneTitle: input.paneTitle,
      paneTitleSource: input.paneTitleSource,
      extensions: input.extensions,
    })
  }

  return bootstrapLegacyTabTitleSource({
    title: input.title,
    titleSetByUser: input.titleSetByUser,
    mode: input.mode,
    shell: input.shell,
    extensions: input.extensions,
  })
}

export function inferLegacyPaneTitleSource(
  input: InferLegacyPaneTitleSourceInput,
): DurableTitleSource {
  if (input.titleSetByUser) return 'user'
  if (!input.storedTitle || input.storedTitle === input.derivedTitle) {
    return 'derived'
  }
  return 'stable'
}

export function normalizeRuntimeTitle(title: string | null | undefined): string | null {
  if (!title) return null
  const trimmedTitle = title.trim()
  if (!trimmedTitle) return null

  const normalizedTitle = trimmedTitle.replace(BRAILLE_SPINNER_PREFIX, '').trim()
  const contentStart = normalizedTitle.match(/[\p{L}\p{N}]/u)
  if (!contentStart?.index && contentStart?.index !== 0) {
    return null
  }

  const cleanedTitle = normalizedTitle.slice(contentStart.index).trim()
  return cleanedTitle || null
}

export function shouldDecorateExitTitle(source: DurableTitleSource | undefined): boolean {
  return source === 'derived'
}
