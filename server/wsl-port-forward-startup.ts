export const WSL_PORT_FORWARD_DISABLE_ENV = 'FRESHELL_DISABLE_WSL_PORT_FORWARD'

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true'
}

export function wslPortForwardStartupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvFlag(env[WSL_PORT_FORWARD_DISABLE_ENV])
}

export function shouldSetupWslPortForwardingAtStartup(
  bindHost: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return bindHost === '0.0.0.0' && !wslPortForwardStartupDisabled(env)
}
