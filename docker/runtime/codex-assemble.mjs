import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { validateManagedLayout } from './launch.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const { native: identity } = JSON.parse(fs.readFileSync(path.join(directory, 'codex-native-sandbox.json'), 'utf8'))
if (process.getuid() !== 0 || process.env.FRESHELL_CODEX_BUILD_VERSION !== identity.version) throw new Error('Codex assembly requires the exact declared version and owned root build context')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const requireCodex = createRequire(path.join(identity.packageRoot, 'package.json'))
const platformPackageRoot = path.dirname(requireCodex.resolve('@openai/codex-linux-x64/package.json'))
const layout = {
  version: identity.version, launchWrapper: identity.launchWrapper, nodeExecutable: identity.nodeExecutable,
  npmWrapper: identity.npmWrapper, packageRoot: fs.realpathSync(identity.packageRoot), platformPackageRoot,
  nativeExecutable: path.join(platformPackageRoot, identity.executable), bwrap: path.join(platformPackageRoot, identity.bwrap), helperDirectory: identity.helperDirectory,
}
function readableOwnedTree(root) {
  fs.chmodSync(root, 0o755)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) readableOwnedTree(file)
    else if (entry.isFile()) fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644)
    else throw new Error('Unexpected native package resource type')
  }
}
function protectedAncestors(file) {
  for (let current = file; ; current = path.dirname(current)) {
    const stat = fs.statSync(current)
    if (stat.uid !== 0 || stat.mode & 0o022) throw new Error(`Codex managed resource is replaceable: ${current}`)
    if (path.dirname(current) === current) break
  }
}
readableOwnedTree(platformPackageRoot)
fs.chmodSync(identity.packageRoot, 0o755)
fs.chmodSync(path.dirname(fs.realpathSync(identity.npmWrapper)), 0o755)
fs.chmodSync(fs.realpathSync(identity.npmWrapper), 0o755)
if (hash(layout.nativeExecutable) !== identity.executableSha256) throw new Error('Installed Codex native bytes differ from the verified release')
if (hash(layout.bwrap) !== identity.bwrapSha256 || hash(fs.realpathSync(identity.npmWrapper)) !== identity.npmEntrypointSha256) throw new Error('Installed Codex helper or npm entrypoint bytes differ from the verified release')
fs.mkdirSync(identity.helperDirectory, { recursive: true, mode: 0o755 })
fs.symlinkSync(layout.bwrap, path.join(identity.helperDirectory, 'bwrap'))
fs.symlinkSync('launch.mjs', identity.launchWrapper)
fs.chmodSync(path.join(directory, 'launch.mjs'), 0o755)
for (const file of [layout.nativeExecutable, layout.bwrap, fs.realpathSync(identity.npmWrapper), identity.launchWrapper, identity.helperDirectory]) protectedAncestors(file)
validateManagedLayout(layout, identity)
fs.writeFileSync(identity.layoutFile, `${JSON.stringify(layout, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
console.log(JSON.stringify({ severity: 'info', event: 'codex_managed_layout_assembled', version: identity.version, nativeSha256: identity.executableSha256, helperSha256: identity.bwrapSha256, npmSha256: identity.npmEntrypointSha256, layout }))
