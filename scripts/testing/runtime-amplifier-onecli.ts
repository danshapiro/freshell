import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'

type OnecliProvider = 'claude' | 'codex' | 'opencode' | 'amplifier'

/** The exact typed paths read by managed_provider_bootstrap.rs; values stay private. */
export function configuredProviderOnecliGrantFiles(provider: OnecliProvider, env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = ['ENV_FILE', 'AUTH_FILE', 'CA_FILE'].map(suffix => `FRESHELL_MANAGED_${provider.toUpperCase()}_ONECLI_${suffix}`)
  const files: string[] = []
  for (const key of keys) {
    const configured = env[key]
    if (configured === undefined) continue
    const source = configured.trim()
    if (!path.isAbsolute(source)) throw new Error(`${key} must name an absolute OneCLI grant file`)

    let stat: fs.Stats
    try {
      stat = fs.lstatSync(source)
    } catch {
      throw new Error(`${key} OneCLI grant is missing or inaccessible`)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${key} OneCLI grant must be a regular file, not a link`)
    }
    if ((stat.mode & 0o077) !== 0) throw new Error(`${key} OneCLI grant must be private`)
    if ((stat.mode & 0o400) === 0) throw new Error(`${key} OneCLI grant must be readable by its owner`)
    try {
      const descriptor = fs.openSync(source, 'r')
      fs.closeSync(descriptor)
      files.push(fs.realpathSync(source))
    } catch {
      throw new Error(`${key} OneCLI grant is inaccessible`)
    }
  }
  return files
}

export function configuredAmplifierOnecliGrantFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  return configuredProviderOnecliGrantFiles('amplifier', env)
}

export function requireAmplifierOnecliBootstrap(env: NodeJS.ProcessEnv = process.env): string[] {
  const files = configuredAmplifierOnecliGrantFiles(env)
  if (!env.FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE && !env.FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE) {
    throw new Error(
      'Amplifier live qualification requires FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE or FRESHELL_MANAGED_AMPLIFIER_ONECLI_AUTH_FILE',
    )
  }
  return files
}

export type AmplifierQualificationProfile = { settings: Buffer; bundle: Buffer }

/** Select ordinary config separately from grants and native session storage. */
export function readAmplifierQualificationProfile(env: NodeJS.ProcessEnv): AmplifierQualificationProfile {
  const root = env.FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME?.trim()
  if (!root || !path.isAbsolute(root)) {
    throw new Error('Amplifier full qualification requires an absolute FRESHELL_RUNTIME_AMPLIFIER_CONFIG_HOME ordinary configuration root')
  }
  const read = (relative: string): Buffer => {
    const file = path.join(root, relative)
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile()) throw new Error('not a regular file')
      return fs.readFileSync(file)
    } catch {
      throw new Error(`selected ordinary Amplifier ${relative} is missing or unreadable`)
    }
  }
  const settings = read('settings.yaml')
  const bundle = read('bundles/default.yaml')
  let selected: unknown, definition: unknown
  try { selected = parse(settings.toString('utf8')); definition = parse(bundle.toString('utf8')) }
  catch { throw new Error('selected ordinary Amplifier profile contains invalid YAML') }
  if (!selected || typeof selected !== 'object' || !('bundle' in selected)
    || !selected.bundle || typeof selected.bundle !== 'object' || !('active' in selected.bundle)
    || selected.bundle.active !== 'default') {
    throw new Error('Amplifier full qualification requires the selected ordinary default bundle')
  }
  if (!definition || typeof definition !== 'object' || !('providers' in definition)
    || !Array.isArray(definition.providers) || definition.providers.length === 0) {
    throw new Error('selected ordinary Amplifier bundle has no explicit providers')
  }
  return { settings, bundle }
}

export function stageAmplifierQualificationProfile(profile: AmplifierQualificationProfile, home: string): void {
  const root = path.join(home, '.amplifier')
  fs.mkdirSync(path.join(root, 'bundles'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(root, 'settings.yaml'), profile.settings, { mode: 0o600 })
  fs.writeFileSync(path.join(root, 'bundles/default.yaml'), profile.bundle, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'amplifier.selected_profile.staged',
    settingsSha256: createHash('sha256').update(profile.settings).digest('hex'),
    bundleSha256: createHash('sha256').update(profile.bundle).digest('hex') })}\n`)
}
