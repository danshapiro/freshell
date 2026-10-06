import fs from 'node:fs'
import path from 'node:path'

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
