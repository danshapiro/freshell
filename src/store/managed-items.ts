// Unified view-layer abstraction for extensions and CLI providers.

import { createSelector } from '@reduxjs/toolkit'
import type { ClientExtensionEntry, ContentSchemaField } from '@shared/extension-types'
import {
  CLAUDE_PERMISSION_MODE_VALUES,
  CODEX_SANDBOX_VALUES,
} from '@shared/settings'
import type { RootState } from '@/store/store'

export interface ManagedItemConfig {
  key: string
  label: string
  type: 'text' | 'select' | 'toggle' | 'path'
  value: unknown
  options?: { label: string; value: string }[]
}

export interface ManagedItem {
  id: string
  name: string
  description?: string
  version?: string
  iconUrl?: string
  kind: 'cli' | 'server' | 'client'
  enabled: boolean
  status?: {
    running?: boolean
    port?: number
    error?: string
  }
  config: ManagedItemConfig[]
  picker?: {
    shortcut?: string
    group?: string
  }
  source: ClientExtensionEntry
}

function buildCliConfig(
  ext: ClientExtensionEntry,
  providerSettings: Record<string, unknown> = {},
): ManagedItemConfig[] {
  const config: ManagedItemConfig[] = []
  const cli = ext.cli

  if (cli?.supportsPermissionMode) {
    config.push({
      key: 'permissionMode',
      label: `${ext.label} permission mode`,
      type: 'select',
      value: (providerSettings.permissionMode as string) || 'default',
      options: CLAUDE_PERMISSION_MODE_VALUES.map((v) => ({
        label: v === 'default' ? 'Default'
          : v === 'plan' ? 'Plan'
          : v === 'acceptEdits' ? 'Accept edits'
          : 'Bypass permissions',
        value: v,
      })),
    })
  }

  if (cli?.supportsModel) {
    config.push({
      key: 'model',
      label: `${ext.label} model`,
      type: 'text',
      value: (providerSettings.model as string) || '',
    })
  }

  if (cli?.supportsSandbox) {
    config.push({
      key: 'sandbox',
      label: `${ext.label} sandbox`,
      type: 'select',
      value: (providerSettings.sandbox as string) || '',
      options: [
        { label: 'Default', value: '' },
        ...CODEX_SANDBOX_VALUES.map((v) => ({
          label: v === 'read-only' ? 'Read-only'
            : v === 'workspace-write' ? 'Workspace write'
            : 'Danger full access',
          value: v,
        })),
      ],
    })
  }

  config.push({
    key: 'cwd',
    label: `${ext.label} starting directory`,
    type: 'path',
    value: (providerSettings.cwd as string) || '',
  })

  return config
}

function contentSchemaFieldToConfigType(field: ContentSchemaField): ManagedItemConfig['type'] {
  switch (field.type) {
    case 'boolean': return 'toggle'
    case 'string':
    case 'number':
    default: return 'text'
  }
}

function buildContentSchemaConfig(
  schema: Record<string, ContentSchemaField>,
): ManagedItemConfig[] {
  return Object.entries(schema).map(([key, field]) => ({
    key,
    label: field.label,
    type: contentSchemaFieldToConfigType(field),
    value: field.default ?? (field.type === 'boolean' ? false : ''),
  }))
}

export const selectManagedItems = createSelector(
  [(state: RootState) => state.extensions.entries,
   (state: RootState) => state.settings.settings],
  (entries, resolvedSettings): ManagedItem[] => {
    const enabledProviders = resolvedSettings?.codingCli?.enabledProviders ?? []
    const disabledExtensions = new Set(resolvedSettings?.extensions?.disabled ?? [])
    const providers = resolvedSettings?.codingCli?.providers ?? {}

    return entries.map((ext): ManagedItem => {
      const isCli = ext.category === 'cli'

      const enabled = isCli
        ? enabledProviders.includes(ext.name) && !disabledExtensions.has(ext.name)
        : !disabledExtensions.has(ext.name)

      const config = isCli
        ? buildCliConfig(ext, (providers as Record<string, Record<string, unknown>>)[ext.name] ?? {})
        : ext.contentSchema
          ? buildContentSchemaConfig(ext.contentSchema)
          : []

      const status = ext.category === 'server'
        ? { running: ext.serverRunning, port: ext.serverPort }
        : undefined

      return {
        id: ext.name,
        name: ext.label,
        description: ext.description,
        version: ext.version,
        iconUrl: ext.iconUrl,
        kind: ext.category,
        enabled,
        status,
        config,
        picker: ext.picker,
        source: ext,
      }
    })
  },
)
