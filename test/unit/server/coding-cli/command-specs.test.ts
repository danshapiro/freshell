import path from 'path'
import { describe, expect, it } from 'vitest'
import { buildCliCommandSpecsFromEntries } from '../../../../server/coding-cli/command-specs.js'
import { ExtensionManager, type ExtensionRegistryEntry } from '../../../../server/extension-manager.js'
import { buildSpawnSpec, registerCodingCliCommands } from '../../../../server/terminal-registry.js'

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

  it('drives buildSpawnSpec through registerCodingCliCommands using the manifest-compiled runtime map', () => {
    const manager = new ExtensionManager()
    manager.scan([path.join(process.cwd(), 'extensions')])
    const baselineSpecs = buildCliCommandSpecsFromEntries(manager.getAll())

    const kimiEntry = manager.getAll().find((entry) => entry.manifest.name === 'kimi')
    expect(kimiEntry).toBeTruthy()

    const mutatedEntries = manager.getAll().map((entry) => (
      entry.manifest.name !== 'kimi'
        ? entry
        : {
          ...entry,
          manifest: {
            ...entry.manifest,
            cli: {
              ...entry.manifest.cli!,
              modelArgs: ['--registered-model', '{{model}}'],
              permissionModeArgsByValue: {
                bypassPermissions: ['--registered-yolo'],
              },
              resumeArgs: ['--registered-session', '{{sessionId}}'],
            },
          },
        }
    ))

    registerCodingCliCommands(buildCliCommandSpecsFromEntries(mutatedEntries))
    try {
      const spec = buildSpawnSpec('kimi', '/repo/root', 'system', 'kimi-session-1', {
        model: 'moonshot-k2',
        permissionMode: 'bypassPermissions',
      })

      expect(spec.args).toEqual(expect.arrayContaining([
        '--registered-model',
        'moonshot-k2',
        '--registered-yolo',
        '--registered-session',
        'kimi-session-1',
      ]))
      expect(spec.args).not.toEqual(expect.arrayContaining(['--model', '--yolo', '--session']))
    } finally {
      registerCodingCliCommands(baselineSpecs)
    }
  })
})
