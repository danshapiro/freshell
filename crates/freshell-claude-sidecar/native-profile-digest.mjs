import { createHash } from 'node:crypto'
import { lstat, open, opendir, readlink, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// These resources have already passed the managed projection's copy policy.
// Fingerprinting compares that selection before releasing a pending command;
// it must not impose another, smaller plugin admission policy.
export async function nativeResourceDigest(req, environment = process.env) {
  const digest = createHash('sha256')
  const visited = new Set()
  const userDirectory = environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? '', '.claude')
  const projectDirectory = join(resolve(req.cwd ?? process.cwd()), '.claude')
  async function addFile(path) {
    let file
    try {
      const canonical = await realpath(path)
      if (visited.has(canonical)) return
      visited.add(canonical)
      file = await open(canonical, 'r')
      digest.update('file\0').update(canonical).update('\0')
      for await (const bytes of file.createReadStream({ autoClose: false })) digest.update(bytes)
      digest.update('\0')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      digest.update(path).update('\0absent\0')
    } finally { await file?.close() }
  }
  for (const path of [join(userDirectory, 'settings.json'), join(projectDirectory, 'settings.json'),
    join(projectDirectory, 'settings.local.json')]) await addFile(path)
  async function addPlugin(directory) {
    const canonical = await realpath(directory)
    if (visited.has(canonical)) return
    visited.add(canonical)
    digest.update('directory\0').update(canonical).update('\0')
    const names = []
    const entries = await opendir(canonical)
    for await (const entry of entries) {
      if (entry.name === '.git') continue
      names.push(entry.name)
    }
    names.sort()
    for (const name of names) {
      const path = join(canonical, name)
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
        digest.update('link\0').update(path).update('\0').update(target).update('\0')
          .update(canonicalTarget).update('\0')
        if (targetMetadata.isDirectory()) await addPlugin(canonicalTarget)
        else if (targetMetadata.isFile()) await addFile(canonicalTarget)
        else throw new Error('selected native plugin link target is unsupported')
      } else if (metadata.isDirectory()) await addPlugin(path)
      else if (metadata.isFile()) await addFile(path)
      else throw new Error('selected native plugin resource is unsupported')
    }
  }
  for (const plugin of req.plugins ?? []) await addPlugin(plugin)
  return digest.digest('hex')
}

// Idle SDK setting changes reuse the resource selection loaded by this query.
// Callers releasing pending work omit resources and compare current disk bytes.
export async function nativeProfileDigest(req, settings, environment = process.env, resources) {
  return createHash('sha256').update(JSON.stringify({
    cwd: req.cwd ?? null, model: settings.model ?? null, effort: settings.effort ?? null,
    permissionMode: settings.permissionMode ?? null, plugins: req.plugins ?? [],
    resources: resources ?? await nativeResourceDigest(req, environment),
  })).digest('hex')
}
