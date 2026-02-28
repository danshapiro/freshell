import { describe, it, expect } from 'vitest'
import {
  AGENT_CHAT_PROVIDER_CONFIGS,
  AGENT_CHAT_PROVIDERS,
  isAgentChatProviderName,
  getAgentChatProviderConfig,
  getAgentChatProviderLabel,
} from '@/lib/agent-chat-utils'

describe('agent-chat-utils', () => {
  it('exports at least one provider', () => {
    expect(AGENT_CHAT_PROVIDERS.length).toBeGreaterThan(0)
    expect(AGENT_CHAT_PROVIDER_CONFIGS.length).toBeGreaterThan(0)
  })

  it('freshclaude is a valid provider', () => {
    expect(isAgentChatProviderName('freshclaude')).toBe(true)
  })

  it('rejects unknown provider names', () => {
    expect(isAgentChatProviderName('unknown')).toBe(false)
    expect(isAgentChatProviderName(undefined)).toBe(false)
  })

  it('returns config for freshclaude', () => {
    const config = getAgentChatProviderConfig('freshclaude')
    expect(config).toBeDefined()
    expect(config!.label).toBe('Freshclaude')
    expect(config!.defaultModel).toBe('claude-opus-4-6')
    expect(config!.defaultPermissionMode).toBe('bypassPermissions')
    expect(config!.defaultEffort).toBe('high')
  })

  it('returns undefined for unknown provider', () => {
    expect(getAgentChatProviderConfig('nope')).toBeUndefined()
  })

  it('returns label for known provider', () => {
    expect(getAgentChatProviderLabel('freshclaude')).toBe('Freshclaude')
  })

  it('returns fallback label for unknown provider', () => {
    expect(getAgentChatProviderLabel('nope')).toBe('Agent Chat')
  })

  it('kilroy is a valid provider', () => {
    expect(isAgentChatProviderName('kilroy')).toBe(true)
  })

  it('returns config for kilroy', () => {
    const config = getAgentChatProviderConfig('kilroy')
    expect(config).toBeDefined()
    expect(config!.name).toBe('kilroy')
    expect(config!.label).toBe('Kilroy')
    expect(config!.codingCliProvider).toBe('claude')
    expect(config!.defaultModel).toBe('claude-opus-4-6')
    expect(config!.defaultPermissionMode).toBe('bypassPermissions')
    expect(config!.defaultEffort).toBe('high')
    expect(config!.pickerShortcut).not.toBe('A') // must differ from freshclaude
  })

  it('returns label for kilroy provider', () => {
    expect(getAgentChatProviderLabel('kilroy')).toBe('Kilroy')
  })

  it('all providers have unique picker shortcuts', () => {
    const shortcuts = AGENT_CHAT_PROVIDER_CONFIGS.map((c) => c.pickerShortcut)
    expect(new Set(shortcuts).size).toBe(shortcuts.length)
  })
})
