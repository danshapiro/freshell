#!/usr/local/bin/node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const fail = reason => { throw new Error(`Codex managed launch is incompatible: ${reason}`) }

export function validateManagedLayout(layout, identity) {
  if (process.platform !== identity.platform || process.arch !== identity.arch || layout.version !== identity.version) fail('native platform or version changed')
  for (const key of ['launchWrapper', 'nodeExecutable', 'npmWrapper', 'packageRoot', 'helperDirectory']) {
    if (layout[key] !== identity[key] || !path.isAbsolute(layout[key])) fail(`declared ${key} changed`)
  }
  if (layout.nativeExecutable !== path.join(layout.platformPackageRoot, identity.executable)
    || layout.bwrap !== path.join(layout.platformPackageRoot, identity.bwrap)) fail('installed native resource layout changed')
  const main = JSON.parse(fs.readFileSync(path.join(layout.packageRoot, 'package.json'), 'utf8'))
  const platform = JSON.parse(fs.readFileSync(path.join(layout.platformPackageRoot, 'package.json'), 'utf8'))
  if (main.name !== '@openai/codex' || main.version !== identity.version || platform.version !== `${identity.version}-linux-x64`) fail('installed npm package version changed')
  for (const file of [layout.nodeExecutable, layout.npmWrapper, layout.nativeExecutable, layout.bwrap]) fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK)
  if (sha256(fs.realpathSync(layout.npmWrapper)) !== identity.npmEntrypointSha256) fail('published npm entrypoint bytes changed')
  if (sha256(layout.bwrap) !== identity.bwrapSha256) fail('verified native helper bytes changed')
  let helper
  try { helper = fs.realpathSync(path.join(layout.helperDirectory, 'bwrap')) } catch { fail('owned bwrap helper is missing') }
  if (helper !== fs.realpathSync(layout.bwrap)) fail('owned bwrap helper points to a different resource')
}

export function launchManagedCodex(layout, identity, args, environment = process.env) {
  validateManagedLayout(layout, identity)
  if (typeof process.execve !== 'function') fail('the fixed Node runtime does not support execve')
  const child = { ...environment }
  const prefix = `${layout.helperDirectory}${path.delimiter}`
  if (child.PATH !== layout.helperDirectory && !child.PATH?.startsWith(prefix)) child.PATH = child.PATH ? `${prefix}${child.PATH}` : layout.helperDirectory
  for (const name of ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS', 'npm_config_user_agent', 'npm_execpath']) delete child[name]
  // This immutable workload installation belongs to npm; the web server's
  // package-manager environment does not describe this CLI installation.
  child.CODEX_MANAGED_PACKAGE_ROOT = layout.packageRoot
  child.CODEX_MANAGED_BY_NPM = '1'
  process.execve(layout.nodeExecutable, [layout.nodeExecutable, layout.npmWrapper, ...args], child)
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const resource = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-native-sandbox.json'), 'utf8'))
    const identity = resource.native
    const layout = JSON.parse(fs.readFileSync(identity.layoutFile, 'utf8'))
    launchManagedCodex(layout, identity, process.argv.slice(2))
  } catch (error) {
    console.error(JSON.stringify({ severity: 'error', event: 'codex_managed_launch_refused', reason: error.message }))
    process.exitCode = 1
  }
}
