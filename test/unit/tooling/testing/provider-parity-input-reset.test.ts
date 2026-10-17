import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

import { prepareProviderParityUserRoots, resetProviderParityOpenCodeInputs } from '../../../helpers/provider-parity-environment.js'

it('restores the next case inputs after OpenCode recovery removes the original project directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-parity-input-reset-'))
  try {
    const workspace = path.join(directory, 'workspace')
    const xdgConfigHome = path.join(directory, 'home/custom-xdg')
    const project = path.join(workspace, '.opencode')
    const user = path.join(xdgConfigHome, 'opencode')
    prepareProviderParityUserRoots(path.join(directory, 'home'), xdgConfigHome)
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(path.join(user, 'plugins'))
    const inputs = {
      tui: JSON.stringify({ theme: 'original' }),
      project: JSON.stringify({ plugin: ['project-plugin'] }),
      user: JSON.stringify({ plugin: ['user-plugin'] }),
    }
    resetProviderParityOpenCodeInputs(workspace, xdgConfigHome, inputs)
    const plugin = fs.readFileSync(path.join(user, 'plugins/parity-plugin.js'), 'utf8')

    // Match the recovery case's edits, including deletion of the whole source.
    fs.writeFileSync(path.join(user, 'new-provider.jsonc'), '{"replacement":true}\n')
    fs.writeFileSync(path.join(user, 'opencode.jsonc'), '{"replacementOriginal":true}\n')
    fs.rmSync(path.join(user, 'plugins/parity-plugin.js'))
    fs.rmSync(project, { recursive: true, force: true })
    fs.writeFileSync(path.join(user, 'tui.jsonc'), '{"theme":"light"}\n')

    resetProviderParityOpenCodeInputs(workspace, xdgConfigHome, inputs)

    expect(JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8'))).toEqual(JSON.parse(inputs.project))
    expect(fs.statSync(project).mode & 0o777).toBe(0o755)
    expect(fs.statSync(path.join(project, 'opencode.json')).mode & 0o777).toBe(0o644)
    expect(JSON.parse(fs.readFileSync(path.join(user, 'opencode.jsonc'), 'utf8'))).toEqual(JSON.parse(inputs.user))
    expect(JSON.parse(fs.readFileSync(path.join(user, 'tui.jsonc'), 'utf8'))).toEqual(JSON.parse(inputs.tui))
    expect(fs.readFileSync(path.join(user, 'plugins/parity-plugin.js'), 'utf8')).toBe(plugin)
    expect(fs.existsSync(path.join(user, 'new-provider.jsonc'))).toBe(false)

    // A later reset with existing directories must preserve unrelated inputs.
    fs.writeFileSync(path.join(project, 'kept.txt'), 'project resource')
    fs.writeFileSync(path.join(user, 'plugins/kept.txt'), 'user resource')
    resetProviderParityOpenCodeInputs(workspace, xdgConfigHome, inputs)
    expect(fs.readFileSync(path.join(project, 'kept.txt'), 'utf8')).toBe('project resource')
    expect(fs.readFileSync(path.join(user, 'plugins/kept.txt'), 'utf8')).toBe('user resource')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
  expect(fs.existsSync(directory)).toBe(false)
})
