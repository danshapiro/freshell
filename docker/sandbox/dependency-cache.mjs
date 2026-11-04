import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function dependencyCacheIdentity(root, foundation, protocol) {
  if (!/^sha256:[a-f0-9]{64}$/.test(foundation) || !Number.isSafeInteger(protocol) || protocol < 1) {
    throw new Error('Sandbox dependency foundation/protocol identity is invalid')
  }
  // This changes only when the installed layout contract changes, independently
  // of application source and workload-image layers.
  const layout = 'tool-caches-v1:.cache,.vite,.vite-temp,.vitest'
  const digest = createHash('sha256').update(`freshell-sandbox-dependencies:${protocol}\0${foundation}\0${layout}\0`)
  const manifestFile = path.join(root, 'package.json')
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {}
  let manager = manifest.packageManager?.split('@')[0]
  if (!['npm', 'pnpm'].includes(manager)) {
    manager = fs.existsSync(path.join(root, 'package-lock.json')) ? 'npm' : 'pnpm'
  }
  const manifests = ['package.json', 'crates/freshell-claude-sidecar/package.json', 'packages/freshell-mcp-runtime/package.json']
  const files = [...manifests, '.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs', ...manifests.slice(1).map(file => path.join(path.dirname(file), '.npmrc')), ...(manager === 'pnpm' ? ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] : ['package-lock.json'])]
  const visited = new Set()
  const active = new Set()
  const append = (absolute, relative) => {
    digest.update(relative + '\0')
    let stat
    try { stat = fs.lstatSync(absolute) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      digest.update('missing\0'); return
    }
    if (stat.isSymbolicLink()) {
      digest.update('link\0' + fs.readlinkSync(absolute) + '\0')
      const target = fs.realpathSync(absolute)
      if (active.has(target)) throw new Error('Cyclic sandbox dependency input')
      append(target, relative + '/target')
      return
    }
    if (stat.isDirectory()) {
      const target = fs.realpathSync(absolute)
      if (active.has(target)) throw new Error('Cyclic sandbox dependency input')
      active.add(target)
      digest.update('directory\0')
      for (const name of fs.readdirSync(absolute).sort()) {
        if (name === 'node_modules' || name === '.git') continue
        append(path.join(absolute, name), relative + '/' + name)
      }
      active.delete(target)
    } else {
      digest.update(`file:${stat.mode & 0o111}\0`).update(fs.readFileSync(absolute)).update('\0')
    }
  }
  for (const file of files) append(path.join(root, file), file)
  // file: packages are copied by the package manager, unlike workspace links.
  // Their content is a dependency input; ordinary application source is not.
  for (const file of manifests) {
    const absolute = path.join(root, file)
    if (!fs.existsSync(absolute)) continue
    const value = JSON.parse(fs.readFileSync(absolute, 'utf8'))
    for (const specifier of Object.values({ ...value.dependencies, ...value.devDependencies, ...value.optionalDependencies })) {
      if (typeof specifier !== 'string' || !specifier.startsWith('file:')) continue
      const declared = path.resolve(path.dirname(absolute), specifier.slice(5))
      const dependency = fs.existsSync(declared) ? fs.realpathSync(declared) : declared
      if (visited.has(dependency)) continue
      visited.add(dependency)
      append(dependency, path.relative(root, declared))
    }
  }
  return digest.digest('hex')
}

export function dependencyVolumeNames(prefix, suffix, identity) {
  return ['node-modules', 'sidecar-node-modules', 'mcp-node-modules']
    .map(kind => `${prefix}-${suffix}-${identity}-${kind}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--key' || process.argv.length !== 6) process.exit(2)
  process.stdout.write(dependencyCacheIdentity(process.argv[3], process.argv[4], Number(process.argv[5])) + '\n')
}
