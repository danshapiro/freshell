import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)
const wsPackageRoot = path.dirname(require.resolve('ws/package.json'))

export const FAKE_CODEX_APP_SERVER = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Install a self-contained DUAL-ROLE `codex` binary into `binDir`: argv
 * containing `app-server` routes to a staged copy of the fake app-server;
 * everything else execs the given terminal fake (`terminalSource`, an .mjs
 * path). The app-server module and its `ws` dependency live beside the shim,
 * so a managed container needs only the mounted fixture workspace, not the
 * test checkout. Returns the shim path (to be set as CODEX_CMD).
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
  appServerSource = FAKE_CODEX_APP_SERVER,
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true, mode: 0o755 })
  // The managed terminal runs as uid 65534. Test processes can have a private
  // umask (0077), so mkdir's default would leave this mounted executable
  // directory inaccessible even though its parent workspace is readable.
  await fs.chmod(binDir, 0o755)
  const target = path.join(binDir, 'codex')
  const stagedAppServer = path.join(binDir, 'fake-codex-app-server.mjs')
  const stagedTerminal = path.join(binDir, 'fake-codex-terminal.mjs')
  await fs.copyFile(appServerSource, stagedAppServer)
  await fs.chmod(stagedAppServer, 0o644)
  await fs.copyFile(terminalSource, stagedTerminal)
  await fs.chmod(stagedTerminal, 0o644)
  const wsDestination = path.join(binDir, 'node_modules', 'ws')
  await fs.cp(wsPackageRoot, wsDestination, {
    recursive: true,
    dereference: true,
  })
  await fs.chmod(path.dirname(wsDestination), 0o755)
  const makeProviderReadable = async (directory: string): Promise<void> => {
    await fs.chmod(directory, 0o755)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await makeProviderReadable(file)
      else if (entry.isFile()) {
        const executable = (await fs.stat(file)).mode & 0o111
        await fs.chmod(file, executable ? 0o755 : 0o644)
      } else {
        throw new Error('unexpected file type in staged Codex app-server dependency')
      }
    }
  }
  await makeProviderReadable(wsDestination)
  const terminalEnvExtra = JSON.stringify(terminalEnv ?? {})
  const fakeAppServerUrl = pathToFileURL(stagedAppServer).href
  const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
if (argv.includes('app-server')) {
  // Load the ESM fixture into this process rather than creating a wrapper
  // plus sidecar child. The caller therefore owns one direct process on every
  // platform; forceful Windows termination cannot orphan an inner listener.
  void import(${JSON.stringify(fakeAppServerUrl)}).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  const result = spawnSync(process.execPath, [${JSON.stringify(stagedTerminal)}, ...argv], { stdio: 'inherit', env: { ...process.env, ...${terminalEnvExtra} } })
  process.exit(result.status ?? 1)
}
`
  await fs.writeFile(target, script, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}
