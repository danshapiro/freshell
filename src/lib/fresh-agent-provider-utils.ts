import type { FreshAgentProviderName, FreshAgentProviderConfig } from './fresh-agent-provider-types'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

export type { FreshAgentProviderName, FreshAgentProviderConfig }

export const FRESH_AGENT_PROVIDERS: FreshAgentProviderName[] = [
  'freshclaude',
  'kilroy',
]

export const FRESH_AGENT_PROVIDER_CONFIGS: FreshAgentProviderConfig[] = [
  {
    name: 'freshclaude',
    ...(() => {
      const entry = resolveFreshAgentType('freshclaude')
      if (!entry) {
        throw new Error('Missing fresh-agent registry entry for freshclaude')
      }
      return {
        label: entry.label,
        codingCliProvider: entry.runtimeProvider,
        icon: entry.icon,
        providerDefaultModelId: 'opus',
        defaultPermissionMode: entry.defaultPermissionMode,
        settingsVisibility: entry.settingsVisibility,
        pickerShortcut: entry.pickerShortcut,
      }
    })(),
  },
  {
    name: 'kilroy',
    ...(() => {
      const entry = resolveFreshAgentType('kilroy')
      if (!entry) {
        throw new Error('Missing fresh-agent registry entry for kilroy')
      }
      return {
        label: entry.label,
        codingCliProvider: entry.runtimeProvider,
        icon: entry.icon,
        providerDefaultModelId: 'opus',
        defaultPermissionMode: entry.defaultPermissionMode,
        settingsVisibility: entry.settingsVisibility,
        pickerShortcut: entry.pickerShortcut,
        hidden: entry.hidden,
        featureFlag: entry.featureFlag,
      }
    })(),
  },
]

export function isFreshAgentProviderName(value?: string): value is FreshAgentProviderName {
  if (!value) return false
  return FRESH_AGENT_PROVIDERS.includes(value as FreshAgentProviderName)
}

export function getFreshAgentProviderConfig(name?: string): FreshAgentProviderConfig | undefined {
  if (!name) return undefined
  return FRESH_AGENT_PROVIDER_CONFIGS.find((c) => c.name === name)
}

export function getFreshAgentProviderLabel(name?: string): string {
  const config = getFreshAgentProviderConfig(name)
  return config?.label ?? 'Fresh Agent'
}

/** Returns provider configs visible in the pane picker, filtering out hidden providers unless their feature flag is enabled. */
export function getVisibleFreshAgentConfigs(featureFlags: Record<string, boolean>): FreshAgentProviderConfig[] {
  return FRESH_AGENT_PROVIDER_CONFIGS.filter((config) => {
    if (!config.hidden) return true
    const flag = config.featureFlag ?? config.name
    return featureFlags[flag] === true
  })
}
