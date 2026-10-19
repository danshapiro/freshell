import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { nativeProfileDigest } from '../../../crates/freshell-claude-sidecar/native-profile-digest.mjs'

describe('native Claude profile digest', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('follows selected plugin file and directory links while binding link targets and content', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-profile-digest-'))
    const plugin = join(directory, 'plugin')
    const linkedDirectory = join(directory, 'shared-components')
    const firstFileTarget = join(directory, 'first-command.md')
    const alternateFileTarget = join(directory, 'alternate-command.md')
    await mkdir(plugin)
    await mkdir(linkedDirectory)
    await writeFile(firstFileTarget, 'first command')
    await writeFile(alternateFileTarget, 'first command')
    await writeFile(join(linkedDirectory, 'agent.md'), 'first agent')
    await symlink(firstFileTarget, join(plugin, 'command.md'))
    await symlink(linkedDirectory, join(plugin, 'agents'), 'dir')

    const request = { cwd: directory, plugins: [plugin] }
    const settings = { model: 'test-model', permissionMode: 'default' }
    const environment = { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') }
    const initial = await nativeProfileDigest(request, settings, environment)
    await expect(readFile(join(plugin, 'command.md'), 'utf8')).resolves.toBe('first command')

    await writeFile(firstFileTarget, 'changed command')
    const changedFileContent = await nativeProfileDigest(request, settings, environment)
    expect(changedFileContent).not.toBe(initial)

    await writeFile(join(linkedDirectory, 'agent.md'), 'changed agent')
    const changedDirectoryContent = await nativeProfileDigest(request, settings, environment)
    expect(changedDirectoryContent).not.toBe(changedFileContent)

    await rm(join(plugin, 'command.md'))
    await symlink(alternateFileTarget, join(plugin, 'command.md'))
    const changedTarget = await nativeProfileDigest(request, settings, environment)
    expect(changedTarget).not.toBe(changedDirectoryContent)
  })

  it('visits circular shared plugin dependencies once and still observes their content changes', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-profile-cycle-'))
    const plugin = join(directory, 'plugin')
    const dependency = join(directory, 'dependency')
    await mkdir(join(plugin, 'node_modules'), { recursive: true })
    await mkdir(join(dependency, 'node_modules'), { recursive: true })
    await writeFile(join(dependency, 'index.js'), 'export const value = 1')
    await symlink(dependency, join(plugin, 'node_modules/dependency'), 'dir')
    await symlink(plugin, join(dependency, 'node_modules/plugin'), 'dir')

    const request = { cwd: directory, plugins: [plugin] }
    const initial = await nativeProfileDigest(request, {}, { HOME: directory })
    expect(await nativeProfileDigest(request, {}, { HOME: directory })).toBe(initial)
    await writeFile(join(dependency, 'index.js'), 'export const value = 2')
    expect(await nativeProfileDigest(request, {}, { HOME: directory })).not.toBe(initial)
  })

  it('reads plugin payloads above the former 32MiB cap within the accepted projection profile', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-profile-large-'))
    const plugin = join(directory, 'plugin')
    await mkdir(plugin)
    const payload = Buffer.alloc(33 * 1024 * 1024, 'a')
    await writeFile(join(plugin, 'dependency.js'), payload)
    const request = { cwd: directory, plugins: [plugin] }
    const initial = await nativeProfileDigest(request, {}, { HOME: directory })
    payload[payload.length - 1] = 98
    await writeFile(join(plugin, 'dependency.js'), payload)
    expect(await nativeProfileDigest(request, {}, { HOME: directory })).not.toBe(initial)
  })

  it('reads more than ten thousand accepted plugin entries', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-profile-entries-'))
    const plugin = join(directory, 'plugin')
    await mkdir(plugin)
    for (let offset = 0; offset < 10_001; offset += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 10_001 - offset) }, (_, index) =>
        writeFile(join(plugin, `resource-${offset + index}.js`), 'export default 1')))
    }
    await expect(nativeProfileDigest({ cwd: directory, plugins: [plugin] }, {}, { HOME: directory }))
      .resolves.toEqual(expect.any(String))
  })
})
