import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const FAKE_CODEX_APP_SERVER = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Install a DUAL-ROLE `codex` binary into `binDir`: argv containing
 * `app-server` routes to the shared fake app-server; everything else execs
 * the given terminal fake (`terminalSource`, an .mjs path). Returns the shim
 * path (to be set as CODEX_CMD).
 *
 * Required by the Rust server's codex terminal lane v2: the lane boots a
 * `codex app-server` sidecar FIRST, spawned from the SAME CODEX_CMD. A
 * terminal-only fake exits 0 instantly on that spawn (stdin is /dev/null),
 * so every codex pane create fails PTY_SPAWN_FAILED ("codex app-server
 * exited before listening: exit status: 0"). Any rust e2e spec that creates
 * a codex TERMINAL pane must use this helper (or an equivalent shim — see
 * restore-contract-wall-rust's installDualRoleCodex, which additionally
 * overrides CODEX_HOME for rollout writes).
 */
export async function installDualRoleCodexCli(
  binDir: string,
  terminalSource: string,
  terminalEnv?: Record<string, string>,
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  const terminalEnvExtra = JSON.stringify(terminalEnv ?? {})
  const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
if (argv.includes('app-server')) {
  const result = spawnSync(process.execPath, [${JSON.stringify(FAKE_CODEX_APP_SERVER)}, ...argv], { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
const result = spawnSync(process.execPath, [${JSON.stringify(terminalSource)}, ...argv], { stdio: 'inherit', env: { ...process.env, ...${terminalEnvExtra} } })
process.exit(result.status ?? 1)
`
  await fs.writeFile(target, script, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}
