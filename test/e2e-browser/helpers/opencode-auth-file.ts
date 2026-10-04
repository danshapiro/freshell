import fs from 'node:fs'
import path from 'node:path'

const ONECLI_PROVIDER_CA_PATH = '/home/freshell/provider/.config/onecli/gateway-ca.pem'

type OpenCodeOnecliBootstrap = {
  authFile: string
  environmentFile: string
  caFile: string
}

function requirePrivateGrantFile(
  env: NodeJS.ProcessEnv,
  key: string,
  qualification: string,
  description: string,
): string {
  const configured = env[key]?.trim()
  if (!configured) throw new Error(`${qualification} requires ${key} to point at a private ${description}`)
  if (!path.isAbsolute(configured)) throw new Error(`${qualification} ${key} must be an absolute path`)

  let stat: fs.Stats
  try {
    stat = fs.lstatSync(configured)
  } catch {
    throw new Error(`${qualification} ${description} is not an existing file: ${configured}`)
  }
  if (!stat.isFile()) {
    throw new Error(`${qualification} ${description} must be a regular file: ${configured}`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${qualification} ${description} must be private (mode 0600 or stricter): ${configured}`)
  }
  if ((stat.mode & 0o400) === 0) {
    throw new Error(`${qualification} ${description} must be owner-readable: ${configured}`)
  }
  try {
    const descriptor = fs.openSync(configured, 'r')
    fs.closeSync(descriptor)
    return fs.realpathSync(configured)
  } catch {
    throw new Error(`${qualification} ${description} is unreadable: ${configured}`)
  }
}

/** Require the explicit typed OneCLI auth-file grant used by isolated OpenCode gates. */
export function requireOpenCodeAuthFile(
  env: NodeJS.ProcessEnv = process.env,
  qualification = 'P2-G04',
): string {
  return requirePrivateGrantFile(
    env,
    'FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE',
    qualification,
    'OpenCode auth.json OneCLI grant',
  )
}

function readEnvironmentGrant(file: string, qualification: string): Map<string, string> {
  const values = new Map<string, string>()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`${qualification} OpenCode OneCLI environment grant is unreadable`)
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) throw new Error(`${qualification} OpenCode OneCLI environment grant is invalid`)
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (!key || values.has(key)) throw new Error(`${qualification} OpenCode OneCLI environment grant is invalid`)
    values.set(key, value)
  }
  return values
}

/** Require a safe OpenCode OAuth stub plus the full OneCLI proxy and CA transport. */
export function requireOpenCodeOnecliBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  qualification = 'P2-G04',
): OpenCodeOnecliBootstrap {
  const authFile = requireOpenCodeAuthFile(env, qualification)
  const environmentFile = requirePrivateGrantFile(
    env,
    'FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE',
    qualification,
    'OpenCode OneCLI environment grant',
  )
  const caFile = requirePrivateGrantFile(
    env,
    'FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE',
    qualification,
    'OpenCode OneCLI CA certificate grant',
  )
  if (new Set([authFile, environmentFile, caFile]).size !== 3) {
    throw new Error(`${qualification} OpenCode OneCLI grants must be separate files`)
  }

  let auth: unknown
  try {
    auth = JSON.parse(fs.readFileSync(authFile, 'utf8'))
  } catch {
    throw new Error(`${qualification} OpenCode OneCLI auth grant must be valid JSON`)
  }
  const openai = (auth as { openai?: Record<string, unknown> } | null)?.openai
  const expectedAuthKeys = ['access', 'expires', 'refresh', 'type']
  if (
    !openai
    || Object.keys(auth as Record<string, unknown>).length !== 1
    || Object.keys(openai).sort().join(',') !== expectedAuthKeys.join(',')
    || openai.type !== 'oauth'
    || openai.access !== 'onecli-managed'
    || openai.refresh !== 'onecli-managed'
    || typeof openai.expires !== 'number'
    || !Number.isFinite(openai.expires)
    || openai.expires < Date.now() + 60 * 60 * 1000
  ) {
    throw new Error(`${qualification} requires a future OneCLI placeholder OAuth credential for OpenCode`)
  }

  const environment = readEnvironmentGrant(environmentFile, qualification)
  const proxy = environment.get('HTTPS_PROXY')
  if (
    !proxy
    || environment.get('https_proxy') !== proxy
    || environment.get('HTTP_PROXY') !== proxy
    || environment.get('http_proxy') !== proxy
    || environment.get('OPENAI_BASE_URL') !== 'https://api.openai.com/v1'
    || environment.get('NODE_EXTRA_CA_CERTS') !== ONECLI_PROVIDER_CA_PATH
    || environment.get('NODE_USE_ENV_PROXY') !== '1'
  ) {
    throw new Error(`${qualification} OpenCode OneCLI environment grant is missing required proxy or CA settings`)
  }

  return { authFile, environmentFile, caFile }
}
