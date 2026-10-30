// @vitest-environment node
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createClaudeFixture } from '../../integration/providers/claude-local-provider.mjs'

const fixtureModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../integration/providers/claude-local-provider.mjs')

// Run in a fresh Node process so the public fs.rmdir hook is installed before
// Node's recursive remover captures it. Every removal still hits the real
// filesystem: a late directory entry lands after traversal, before rmdir.
async function cleanupDuringWrite(mode: 'transient' | 'persistent' | 'denied') {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'
    import path from 'node:path'
    import { pathToFileURL } from 'node:url'
    const mode = process.argv[1]
    const rmdir = fs.rmdir
    let root
    let removals = 0
    let writes = 0
    let enabled = true
    fs.rmdir = function (target, ...args) {
      if (enabled && String(target) === root) {
        removals += 1
        if (mode === 'denied') {
          const callback = args.at(-1)
          return queueMicrotask(() => callback(Object.assign(new Error('permission denied'), { code: 'EACCES' })))
        }
        if (removals % 2 === 0 && (mode === 'persistent' || writes === 0)) {
          fs.writeFileSync(path.join(root, 'late-directory-entry'), 'transient entry')
          writes += 1
        }
      }
      return rmdir.call(this, target, ...args)
    }
    const { createClaudeFixture } = await import(pathToFileURL(process.argv[2]).href)
    const fixture = await createClaudeFixture()
    root = fixture.root
    let error
    try { await fixture.cleanup() } catch (caught) { error = caught.code }
    const removed = !fs.existsSync(root)
    enabled = false
    await fs.promises.rm(root, { recursive: true, force: true })
    process.stdout.write(JSON.stringify({ error, removed, writes, removals }))
  `, mode, fixtureModule], { timeout: 15_000 })
  return JSON.parse(stdout) as { error?: string; removed: boolean; writes: number; removals: number }
}

describe('Claude fixture cleanup', () => {
  it('retries a transient ENOTEMPTY during final directory removal', async () => {
    const result = await cleanupDuringWrite('transient')

    expect(result).toMatchObject({ removed: true, writes: 1 })
    expect(result.error).toBeUndefined()
  })

  it('reports ENOTEMPTY after bounded retries when writes never settle', async () => {
    const result = await cleanupDuringWrite('persistent')

    expect(result).toMatchObject({ removed: false, error: 'ENOTEMPTY' })
    expect(result.writes).toBeGreaterThan(0)
  })

  it('propagates a permanent filesystem refusal', async () => {
    expect(await cleanupDuringWrite('denied')).toMatchObject({ removed: false, error: 'EACCES', removals: 1 })
  })

  it('can clean a fixture again after it is already absent', async () => {
    const fixture = await createClaudeFixture()
    try {
      await fixture.cleanup()
      await fixture.cleanup()
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  })
})
