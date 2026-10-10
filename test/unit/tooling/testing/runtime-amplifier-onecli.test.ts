import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  configuredAmplifierOnecliGrantFiles,
  requireAmplifierOnecliBootstrap,
  readAmplifierQualificationProfile,
  stageAmplifierQualificationProfile,
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

  it.each(['CLAUDE', 'CODEX', 'OPENCODE', 'AMPLIFIER'])('admits the typed %s gateway CA grant to the broker', provider => {
    const caGrant = privateGrant('gateway-ca.pem')
    expect(phase2BootstrapFiles({
      [`FRESHELL_MANAGED_${provider}_ONECLI_CA_FILE`]: caGrant,
    })).toEqual([caGrant])
  })

  it.each(['CLAUDE', 'CODEX', 'OPENCODE', 'AMPLIFIER'])('refuses linked and public %s CA references before broker admission', provider => {
    const grant=privateGrant('gateway-ca.pem')
    const key=`FRESHELL_MANAGED_${provider}_ONECLI_CA_FILE`
    const link=path.join(path.dirname(grant),'linked.pem');fs.symlinkSync(grant,link)
    expect(()=>phase2BootstrapFiles({[key]:link})).toThrow(/regular file/)
    fs.chmodSync(grant,0o644)
    expect(()=>phase2BootstrapFiles({[key]:grant})).toThrow(/private/)
  })

  it('a CA file alone does not authorize Amplifier live qualification', () => {
    const caGrant = privateGrant('gateway-ca.pem')
    expect(() => requireAmplifierOnecliBootstrap({ FRESHELL_MANAGED_AMPLIFIER_ONECLI_CA_FILE: caGrant })).toThrow(/ONECLI_ENV_FILE.*ONECLI_AUTH_FILE/)
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

describe('selected ordinary Amplifier full qualification profile', () => {
  function profile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-ordinary-profile-'))
    directories.push(directory)
    fs.mkdirSync(path.join(directory, 'bundles'))
    fs.writeFileSync(path.join(directory, 'settings.yaml'), 'bundle:\n  active: default\n')
    fs.writeFileSync(path.join(directory, 'bundles/default.yaml'), 'providers:\n  - module: provider-vllm\n    config:\n      default_model: selected-unit-model\n')
    return { directory, env: { FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: directory } }
  }
  it('stages a private byte-preserving snapshot without credential or native-history files', () => {
    const { directory, env } = profile()
    fs.writeFileSync(path.join(directory, 'keys.env'), 'credential-must-not-be-copied')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'amplifier-staged-profile-'))
    directories.push(home)
    const selected = readAmplifierQualificationProfile(env)
    stageAmplifierQualificationProfile(selected, home)
    for (const relative of ['settings.yaml', 'bundles/default.yaml']) {
      const file = path.join(home, '.amplifier', relative)
      expect(fs.readFileSync(file)).toEqual(fs.readFileSync(path.join(directory, relative)))
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(fs.readdirSync(path.join(home, '.amplifier'))).toEqual(['bundles', 'settings.yaml'])
  })
  it.each(['settings.yaml', 'bundles/default.yaml'])('refuses a missing or linked selected %s', relative => {
    const { directory, env } = profile()
    const file = path.join(directory, relative), saved = `${file}.saved`
    fs.renameSync(file, saved)
    expect(() => readAmplifierQualificationProfile(env)).toThrow(/missing or unreadable/)
    fs.symlinkSync(saved, file)
    expect(() => readAmplifierQualificationProfile(env)).toThrow(/missing or unreadable/)
  })
  it.each([
    ['settings.yaml', 'bundle: [unclosed', /invalid YAML/],
    ['settings.yaml', 'bundle:\n  active: another\n', /default bundle/],
    ['settings.yaml', 'config: {}\n', /default bundle/],
    ['bundles/default.yaml', 'providers: []\n', /no explicit providers/],
  ] as const)('refuses an unusable ordinary selection from %s: %s', (relative, contents, reason) => {
    const { directory, env } = profile()
    fs.writeFileSync(path.join(directory, relative), contents)
    expect(() => readAmplifierQualificationProfile(env)).toThrow(reason)
  })
  it('requires an explicit absolute ordinary root without reading ambient provider homes', () => {
    expect(() => readAmplifierQualificationProfile({})).toThrow(/CONFIG_HOME/)
    expect(() => readAmplifierQualificationProfile({ FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME: 'relative-root' })).toThrow(/absolute/)
  })
})
