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

  it('fails clearly when a selected plugin contains a directory link cycle', async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-profile-cycle-'))
    const plugin = join(directory, 'plugin')
    await mkdir(plugin)
    await symlink(plugin, join(plugin, 'self'), 'dir')

    await expect(nativeProfileDigest({ cwd: directory, plugins: [plugin] }, {}, { HOME: directory }))
      .rejects.toThrow('selected native plugin contains a directory link cycle')
  })
})
