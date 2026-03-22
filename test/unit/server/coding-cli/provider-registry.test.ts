import path from 'path'
import { describe, expect, it } from 'vitest'
import { ExtensionManager } from '../../../../server/extension-manager.js'
import { codingCliProvidersByName } from '../../../../server/coding-cli/providers/index.js'

describe('codingCli provider registry', () => {
  it('registers every built-in CLI manifest that advertises resumeArgs as a session provider', () => {
    const manager = new ExtensionManager()
    manager.scan([path.join(process.cwd(), 'extensions')])

    const resumeCapable = manager.getAll()
      .filter((entry) => entry.manifest.category === 'cli' && entry.manifest.cli?.resumeArgs)
      .map((entry) => entry.manifest.name)

    for (const providerName of resumeCapable) {
      expect(codingCliProvidersByName.has(providerName)).toBe(true)
    }
  })
})
