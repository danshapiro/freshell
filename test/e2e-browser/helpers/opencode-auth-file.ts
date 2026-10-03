import fs from 'node:fs'
import path from 'node:path'

/** Require the explicit typed OneCLI auth-file grant used by isolated OpenCode gates. */
export function requireOpenCodeAuthFile(
  env: NodeJS.ProcessEnv = process.env,
  qualification = 'P2-G04',
): string {
  const configured = env.FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE?.trim()
  if (!configured) {
    throw new Error(
      `${qualification} requires FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE to point at a private OpenCode auth.json OneCLI grant`,
    )
  }

  const authFile = path.resolve(configured)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(authFile)
  } catch {
    throw new Error(`${qualification} OpenCode OneCLI auth grant is not an existing file: ${authFile}`)
  }
  if (!stat.isFile()) {
    throw new Error(`${qualification} OpenCode OneCLI auth grant must be a regular file: ${authFile}`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${qualification} OpenCode OneCLI auth grant must be private (mode 0600 or stricter): ${authFile}`)
  }
  if ((stat.mode & 0o400) === 0) {
    throw new Error(`${qualification} OpenCode OneCLI auth grant must be owner-readable: ${authFile}`)
  }
  try {
    const descriptor = fs.openSync(authFile, 'r')
    fs.closeSync(descriptor)
    return fs.realpathSync(authFile)
  } catch {
    throw new Error(`${qualification} OpenCode OneCLI auth grant is unreadable: ${authFile}`)
  }
}
