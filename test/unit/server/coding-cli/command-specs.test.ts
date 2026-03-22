import { describe, expect, it } from 'vitest'
import { buildCliCommandSpecsFromEntries } from '../../../../server/coding-cli/command-specs.js'
import type { ExtensionRegistryEntry } from '../../../../server/extension-manager.js'

function makeCliEntry(overrides: Partial<ExtensionRegistryEntry['manifest']> = {}): ExtensionRegistryEntry {
  return {
    path: '/tmp/kimi-extension',
    manifest: {
      name: 'test-cli',
      version: '1.0.0',
      label: 'Test CLI',
      description: 'Test CLI extension',
      category: 'cli',
      cli: {
        command: 'test-cli',
      },
      ...overrides,
    },
  }
}

describe('buildCliCommandSpecsFromEntries', () => {
  it('compiles Kimi value-specific permission args into the runtime command map used by server startup', () => {
    const specs = buildCliCommandSpecsFromEntries([
      makeCliEntry({
        name: 'kimi',
        label: 'Kimi',
        cli: {
          command: 'kimi',
          modelArgs: ['--model', '{{model}}'],
          permissionModeArgsByValue: {
            bypassPermissions: ['--yolo'],
          },
          supportsPermissionMode: true,
          supportsModel: true,
        },
      }),
    ])

    const spec = specs.get('kimi')
    expect(spec?.modelArgs?.('moonshot-k2')).toEqual(['--model', 'moonshot-k2'])
    expect(spec?.permissionModeArgsByValue?.bypassPermissions).toEqual(['--yolo'])
  })

  it('compiles Kimi resumeArgs from the manifest into the runtime command map', () => {
    const specs = buildCliCommandSpecsFromEntries([
      makeCliEntry({
        name: 'kimi',
        label: 'Kimi',
        cli: {
          command: 'kimi',
          resumeArgs: ['--session', '{{sessionId}}'],
          modelArgs: ['--model', '{{model}}'],
          permissionModeArgsByValue: {
            bypassPermissions: ['--yolo'],
          },
          supportsPermissionMode: true,
          supportsModel: true,
        },
      }),
    ])

    expect(specs.get('kimi')?.resumeArgs?.('kimi-session-1')).toEqual(['--session', 'kimi-session-1'])
  })
})
