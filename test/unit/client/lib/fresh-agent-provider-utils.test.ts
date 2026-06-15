import { describe, it, expect } from 'vitest'
import {
  FRESH_AGENT_PROVIDER_CONFIGS,
  FRESH_AGENT_PROVIDERS,
  isFreshAgentProviderName,
  getFreshAgentProviderConfig,
  getFreshAgentProviderLabel,
  getVisibleFreshAgentConfigs,
} from '@/lib/fresh-agent-provider-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'

describe('fresh-agent-provider-utils', () => {
  it('exports at least one provider', () => {
    expect(FRESH_AGENT_PROVIDERS.length).toBeGreaterThan(0)
    expect(FRESH_AGENT_PROVIDER_CONFIGS.length).toBeGreaterThan(0)
  })

  it('recognizes every registered provider name', () => {
    for (const provider of FRESH_AGENT_PROVIDERS) {
      expect(isFreshAgentProviderName(provider)).toBe(true)
    }
  })

  it('rejects unknown provider names', () => {
    expect(isFreshAgentProviderName('unknown')).toBe(false)
    expect(isFreshAgentProviderName(undefined)).toBe(false)
  })

  it('keeps provider configs aligned with the fresh-agent registry', () => {
    for (const config of FRESH_AGENT_PROVIDER_CONFIGS) {
      const registryEntry = resolveFreshAgentType(config.name)
      expect(registryEntry).toBeDefined()
      expect(config.label).toBe(registryEntry!.label)
      expect(config.codingCliProvider).toBe(registryEntry!.runtimeProvider)
      expect(config.icon).toBe(registryEntry!.icon)
      expect(config.defaultPermissionMode).toBe(registryEntry!.defaultPermissionMode)
      expect(config.settingsVisibility).toBe(registryEntry!.settingsVisibility)
      expect(config.pickerShortcut).toBe(registryEntry!.pickerShortcut)
    }
  })

  it('returns undefined for unknown provider', () => {
    expect(getFreshAgentProviderConfig('nope')).toBeUndefined()
  })

  it('returns the configured label for known providers', () => {
    for (const config of FRESH_AGENT_PROVIDER_CONFIGS) {
      expect(getFreshAgentProviderLabel(config.name)).toBe(config.label)
    }
  })

  it('returns fallback label for unknown provider', () => {
    expect(getFreshAgentProviderLabel('nope')).toBe('Fresh Agent')
  })

  it('all providers have unique picker shortcuts', () => {
    const shortcuts = FRESH_AGENT_PROVIDER_CONFIGS.map((c) => c.pickerShortcut)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })

  it('provider config lookups return the same registry-backed config objects', () => {
    for (const config of FRESH_AGENT_PROVIDER_CONFIGS) {
      expect(getFreshAgentProviderConfig(config.name)).toBe(config)
    }
  })

  describe('getVisibleFreshAgentConfigs', () => {
    it('excludes hidden providers when no feature flags are set', () => {
      const visible = getVisibleFreshAgentConfigs({})
      const names = visible.map((c) => c.name)
      for (const config of FRESH_AGENT_PROVIDER_CONFIGS) {
        if (config.hidden) {
          expect(names).not.toContain(config.name)
        } else {
          expect(names).toContain(config.name)
        }
      }
    })

    it('includes hidden providers when their feature flag is true', () => {
      const flags = Object.fromEntries(
        FRESH_AGENT_PROVIDER_CONFIGS
          .filter((config) => config.hidden)
          .map((config) => [config.featureFlag ?? config.name, true]),
      )
      const visible = getVisibleFreshAgentConfigs(flags)
      const names = visible.map((c) => c.name)
      expect(names).toEqual(FRESH_AGENT_PROVIDER_CONFIGS.map((config) => config.name))
    })

    it('still excludes hidden providers when their feature flag is false', () => {
      const flags = Object.fromEntries(
        FRESH_AGENT_PROVIDER_CONFIGS
          .filter((config) => config.hidden)
          .map((config) => [config.featureFlag ?? config.name, false]),
      )
      const visible = getVisibleFreshAgentConfigs(flags)
      const names = visible.map((c) => c.name)
      for (const config of FRESH_AGENT_PROVIDER_CONFIGS) {
        if (config.hidden) {
          expect(names).not.toContain(config.name)
        } else {
          expect(names).toContain(config.name)
        }
      }
    })
  })
})
