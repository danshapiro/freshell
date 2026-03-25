// Tests for the selectManagedItems selector.

import { describe, it, expect } from 'vitest'
import { selectManagedItems, type ManagedItem } from '@/store/managed-items'
import type { ClientExtensionEntry } from '@shared/extension-types'

function makeState({
  entries = [] as ClientExtensionEntry[],
  enabledProviders = ['claude', 'codex'] as string[],
  disabled = [] as string[],
  providers = {} as Record<string, Record<string, unknown>>,
} = {}) {
  return {
    extensions: { entries },
    settings: {
      serverSettings: {} as any,
      localSettings: {} as any,
      settings: {
        codingCli: { enabledProviders, providers, knownProviders: [] },
        extensions: { disabled },
      } as any,
      loaded: true,
      lastSavedAt: undefined,
    },
  } as any
}

const claudeExt: ClientExtensionEntry = {
  name: 'claude',
  version: '1.0.0',
  label: 'Claude CLI',
  description: 'Claude Code agent',
  category: 'cli',
  cli: {
    supportsPermissionMode: true,
    supportsResume: true,
  },
}

const codexExt: ClientExtensionEntry = {
  name: 'codex',
  version: '1.0.0',
  label: 'Codex CLI',
  description: 'OpenAI Codex agent',
  category: 'cli',
  cli: {
    supportsModel: true,
    supportsSandbox: true,
    supportsResume: true,
  },
}

const kimiExt: ClientExtensionEntry = {
  name: 'kimi',
  version: '1.0.0',
  label: 'Kimi',
  description: 'Kimi CLI agent',
  category: 'cli',
  cli: {
    supportsModel: true,
    supportsPermissionMode: true,
    supportedPermissionModes: ['default', 'bypassPermissions'],
  },
}

const serverExt: ClientExtensionEntry = {
  name: 'my-server',
  version: '2.0.0',
  label: 'My Server Ext',
  description: 'A server extension',
  category: 'server',
  serverRunning: true,
  serverPort: 8080,
  contentSchema: {
    apiKey: { type: 'string', label: 'API Key' },
    verbose: { type: 'boolean', label: 'Verbose', default: false },
  },
}

const clientExt: ClientExtensionEntry = {
  name: 'my-client',
  version: '0.1.0',
  label: 'My Client Ext',
  description: 'A client extension',
  category: 'client',
  picker: { shortcut: 'C', group: 'tools' },
}

describe('selectManagedItems', () => {
  it('builds items from extension entries', () => {
    const state = makeState({ entries: [claudeExt, codexExt] })
    const items = selectManagedItems(state)

    expect(items).toHaveLength(2)
    expect(items[0].id).toBe('claude')
    expect(items[0].kind).toBe('cli')
    expect(items[1].id).toBe('codex')
  })

  it('derives enabled state for CLI extensions from enabledProviders', () => {
    const state = makeState({
      entries: [claudeExt, codexExt],
      enabledProviders: ['claude'],
    })
    const items = selectManagedItems(state)

    expect(items[0].enabled).toBe(true)
    expect(items[1].enabled).toBe(false)
  })

  it('requires both enabledProviders AND not disabled for CLI extensions', () => {
    const state = makeState({
      entries: [claudeExt],
      enabledProviders: ['claude'],
      disabled: ['claude'],
    })
    const items = selectManagedItems(state)

    expect(items[0].enabled).toBe(false)
  })

  it('derives enabled state for non-CLI extensions from disabled list', () => {
    const state = makeState({
      entries: [clientExt],
      disabled: ['my-client'],
    })
    const items = selectManagedItems(state)

    expect(items[0].enabled).toBe(false)
  })

  it('builds config fields for CLI with permission mode support', () => {
    const state = makeState({
      entries: [claudeExt],
      providers: { claude: { permissionMode: 'plan' } },
    })
    const items = selectManagedItems(state)
    const pmConfig = items[0].config.find((c) => c.key === 'permissionMode')

    expect(pmConfig).toBeDefined()
    expect(pmConfig!.type).toBe('select')
    expect(pmConfig!.value).toBe('plan')
    expect(pmConfig!.options).toHaveLength(4)
  })

  it('builds config fields for CLI with model and sandbox support', () => {
    const state = makeState({
      entries: [codexExt],
      providers: { codex: { model: 'gpt-5', sandbox: 'read-only' } },
    })
    const items = selectManagedItems(state)

    const modelConfig = items[0].config.find((c) => c.key === 'model')
    expect(modelConfig).toBeDefined()
    expect(modelConfig!.type).toBe('text')
    expect(modelConfig!.value).toBe('gpt-5')

    const sandboxConfig = items[0].config.find((c) => c.key === 'sandbox')
    expect(sandboxConfig).toBeDefined()
    expect(sandboxConfig!.type).toBe('select')
    expect(sandboxConfig!.value).toBe('read-only')
  })

  it('filters Kimi permission options to the supported subset and coerces unsupported saved values back to default', () => {
    const items = selectManagedItems(makeState({
      entries: [kimiExt],
      enabledProviders: ['kimi'],
      providers: { kimi: { model: 'moonshot-k2', permissionMode: 'plan' } },
    }))

    const permission = items[0].config.find((field) => field.key === 'permissionMode')
    expect(permission?.value).toBe('default')
    expect(permission?.options?.map((option) => option.value)).toEqual(['default', 'bypassPermissions'])
  })

  it('always includes a starting directory field for CLI extensions', () => {
    const state = makeState({ entries: [claudeExt] })
    const items = selectManagedItems(state)

    const cwdConfig = items[0].config.find((c) => c.key === 'cwd')
    expect(cwdConfig).toBeDefined()
    expect(cwdConfig!.type).toBe('path')
  })

  it('builds config from contentSchema for non-CLI extensions', () => {
    const state = makeState({ entries: [serverExt] })
    const items = selectManagedItems(state)

    expect(items[0].config).toHaveLength(2)
    expect(items[0].config[0].key).toBe('apiKey')
    expect(items[0].config[0].type).toBe('text')
    expect(items[0].config[1].key).toBe('verbose')
    expect(items[0].config[1].type).toBe('toggle')
    expect(items[0].config[1].value).toBe(false)
  })

  it('includes server runtime status', () => {
    const state = makeState({ entries: [serverExt] })
    const items = selectManagedItems(state)

    expect(items[0].status).toEqual({ running: true, port: 8080 })
  })

  it('includes picker metadata', () => {
    const state = makeState({ entries: [clientExt] })
    const items = selectManagedItems(state)

    expect(items[0].picker).toEqual({ shortcut: 'C', group: 'tools' })
  })

  it('returns empty config for non-CLI extensions without contentSchema', () => {
    const state = makeState({ entries: [clientExt] })
    const items = selectManagedItems(state)

    expect(items[0].config).toEqual([])
  })

  it('preserves source extension entry', () => {
    const state = makeState({ entries: [claudeExt] })
    const items = selectManagedItems(state)

    expect(items[0].source).toBe(claudeExt)
  })
})
