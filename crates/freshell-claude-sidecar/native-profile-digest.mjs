import { createHash } from 'node:crypto'
import { lstat, opendir, readlink, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Bind the selected native profile, excluding rotating grant/auth files.
// These are known settings/plugin resources, never a native identity search.
export async function nativeProfileDigest(req, settings, environment = process.env) {
  const digest = createHash('sha256')
  digest.update(JSON.stringify({ cwd: req.cwd ?? null, model: settings.model ?? null,
    effort: settings.effort ?? null, permissionMode: settings.permissionMode ?? null,
    plugins: req.plugins ?? [] }))
  const userDirectory = environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? '', '.claude')
  const projectDirectory = join(resolve(req.cwd ?? process.cwd()), '.claude')
  let bytesRead = 0
  let entriesVisited = 0
  const activeDirectories = new Set()
  async function addFile(path) {
    try {
      const bytes = await readFile(path)
      bytesRead += bytes.length
      if (bytesRead > 32 * 1024 * 1024) throw new Error('selected native profile exceeds bounded read')
      digest.update(path).update('\0').update(bytes).update('\0')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      digest.update(path).update('\0absent\0')
    }
  }
  for (const path of [join(userDirectory, 'settings.json'), join(projectDirectory, 'settings.json'),
    join(projectDirectory, 'settings.local.json')]) await addFile(path)
  async function addPlugin(directory, digestDirectory = directory, depth = 0) {
    if (depth > 64) throw new Error('selected native plugin exceeds bounded directory depth')
    const directoryMetadata = await stat(directory)
    const identity = `${directoryMetadata.dev}:${directoryMetadata.ino}`
    if (activeDirectories.has(identity)) throw new Error('selected native plugin contains a directory link cycle')
    activeDirectories.add(identity)
    try {
      const names = []
      const entries = await opendir(directory)
      for await (const entry of entries) {
        if (entry.name === '.git') continue
        entriesVisited += 1
        if (entriesVisited > 10_000) throw new Error('selected native plugin exceeds bounded entry count')
        names.push(entry.name)
      }
      names.sort()
      for (const name of names) {
        const path = join(directory, name)
        const digestPath = join(digestDirectory, name)
        const metadata = await lstat(path)
        if (metadata.isSymbolicLink()) {
          const target = await readlink(path)
          let targetMetadata
          let canonicalTarget
          try {
            targetMetadata = await stat(path)
            canonicalTarget = await realpath(path)
          } catch (error) {
            if (error?.code === 'ENOENT') throw new Error('selected native plugin contains a dangling link', { cause: error })
            throw error
          }
          digest.update('link\0').update(digestPath).update('\0').update(target).update('\0')
            .update(canonicalTarget).update('\0')
          if (targetMetadata.isDirectory()) await addPlugin(canonicalTarget, digestPath, depth + 1)
          else if (targetMetadata.isFile()) await addFile(canonicalTarget, digestPath)
          else throw new Error('selected native plugin link target is unsupported')
        } else if (metadata.isDirectory()) await addPlugin(path, digestPath, depth + 1)
        else if (metadata.isFile()) await addFile(path, digestPath)
        else throw new Error('selected native plugin resource is unsupported')
      }
    } finally {
      activeDirectories.delete(identity)
    }
  }
  for (const plugin of req.plugins ?? []) await addPlugin(plugin)
  return digest.digest('hex')
}
