import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  configuredAmplifierOnecliGrantFiles,
  requireAmplifierOnecliBootstrap,
} from '../../../../scripts/testing/runtime-amplifier-onecli.js'
import { phase2BootstrapFiles } from '../../../../scripts/testing/runtime-sandbox.js'

const directories: string[] = []

function privateGrant(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-onecli-grant-'))
  directories.push(directory)
  const grant = path.join(directory, name)
  fs.writeFileSync(grant, 'ONECLI_GATEWAY=1\n', { mode: 0o600 })
  return grant
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('live Amplifier OneCLI qualification grants', () => {
  it.each(['CLAUDE', 'CODEX', 'OPENCODE'])('admits a named %s OneCLI grant to the sandbox broker', provider => {
    const grant = privateGrant(`${provider.toLowerCase()}.env`)
    expect(phase2BootstrapFiles({ [`FRESHELL_MANAGED_${provider}_ONECLI_ENV_FILE`]: grant })).toEqual([grant])
  })
  it.each(['ENV_FILE', 'AUTH_FILE'])('accepts and admits the documented %s grant', (suffix) => {
    const grant = privateGrant('grant.env')
    const key = `FRESHELL_MANAGED_AMPLIFIER_ONECLI_${suffix}`
    const env = { [key]: grant }

    expect(requireAmplifierOnecliBootstrap(env)).toEqual([grant])
    expect(phase2BootstrapFiles(env)).toContain(grant)
  })

  it('admits both grants for a child with environment and auth-file references', () => {
    const environmentGrant = privateGrant('environment.env')
    const authGrant = privateGrant('auth.json')
    const env = {
      FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE: environmentGrant,
      FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE: authGrant,
    }
    expect(configuredAmplifierOnecliGrantFiles(env)).toEqual([environmentGrant, authGrant])
    expect(phase2BootstrapFiles(env)).toEqual([environmentGrant, authGrant])
  })

  it('admits only the typed OpenCode OneCLI auth grant, not the legacy raw auth path', () => {
    const onecliGrant = privateGrant('onecli-auth.json')
    const legacyAuth = privateGrant('legacy-auth.json')

    expect(phase2BootstrapFiles({
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: onecliGrant,
      FRESHELL_MANAGED_OPENCODE_AUTH_FILE: legacyAuth,
    })).toEqual([onecliGrant])
  })

  it('rejects a missing grant even when the old keys-file input is set', () => {
    const legacyKeys = privateGrant('keys.env')
    const env = { FRESHELL_MANAGED_AMPLIFIER_ONECLI_KEYS_FILE: legacyKeys }
    expect(() => requireAmplifierOnecliBootstrap(env)).toThrow(/ONECLI_ENV_FILE.*ONECLI_AUTH_FILE/)
    expect(phase2BootstrapFiles(env)).toEqual([])
  })

  it('rejects missing, linked, public, and unreadable configured grants', () => {
    const grant = privateGrant('grant.env')
    const link = path.join(path.dirname(grant), 'linked.env')
    fs.symlinkSync(grant, link)
    const key = 'FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE'
    const invalid = [
      path.join(path.dirname(grant), 'absent.env'),
      link,
      'relative-grant.env',
    ]
    for (const candidate of invalid) {
      expect(() => requireAmplifierOnecliBootstrap({ [key]: candidate })).toThrow()
      expect(() => phase2BootstrapFiles({ [key]: candidate })).toThrow()
    }

    fs.chmodSync(grant, 0o644)
    expect(() => requireAmplifierOnecliBootstrap({ [key]: grant })).toThrow(/private/)
    fs.chmodSync(grant, 0o000)
    expect(() => requireAmplifierOnecliBootstrap({ [key]: grant })).toThrow(/readable/)
  })
})
