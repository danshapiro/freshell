import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ManagedRuntimeOwner } from '../../../../scripts/testing/runtime-sandbox.js'
import { applyIsolatedHomeEnvironment } from '../../../e2e-browser/helpers/server-fixture-support.js'

let directory: string
beforeEach(async () => {
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'runtime-owned-home-'))
  execFileSync('git', ['init', '--quiet'], { cwd: directory })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'], { cwd: directory })
})
afterEach(async () => { vi.restoreAllMocks(); await fsp.rm(directory, { recursive: true, force: true }) })

function ownedRuntime(mode: 'terminal' | 'fresh' | 'opencode') {
  const home = path.join(directory, 'owned-home')
  const info = { baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'fixture-token', homeDir: home }
  let selectedCodexHomeExistsAtStart = false
  const rig = new ManagedRuntimeOwner(options => ({
    info,
    start: async () => {
      await options.setupHome?.(home)
      const selected = applyIsolatedHomeEnvironment({}, home).CODEX_HOME
      selectedCodexHomeExistsAtStart = fs.existsSync(selected) && fs.statSync(selected).isDirectory()
      return info
    },
    stop: async () => {},
  }) as any, directory, 5, {}, {}, 'release', {
    enabledProviders: mode === 'terminal' ? ['codex'] : mode === 'opencode' ? ['opencode'] : [],
    freshAgentModes: mode === 'fresh' ? ['freshcodex'] : [],
  })
  vi.spyOn(rig.runtime, 'prepare').mockResolvedValue(undefined)
  vi.spyOn(rig as any, 'buildQualificationSupervisor').mockReturnValue(undefined)
  vi.spyOn(rig as any, 'buildManagedServer').mockReturnValue('/fixture/unused-server')
  vi.spyOn(rig as any, 'pendingQualificationProviders').mockReturnValue([])
  vi.spyOn(rig.runtime, 'recordProviderQualificationBuild').mockImplementation(() => undefined)
  vi.spyOn(rig.runtime, 'recordFreshAgentQualificationBuild').mockImplementation(() => undefined)
  vi.spyOn(rig.runtime, 'startSupervisor').mockResolvedValue({
    containerId: 'f'.repeat(64), controlSocket: '/fixture/socket', controlSecretFile: '/fixture/secret',
  } as any)
  return { rig, home, selectedCodexHomeExistsAtStart: () => selectedCodexHomeExistsAtStart }
}

describe('owned runtime selected Codex home', () => {
  it.each(['terminal', 'fresh'] as const)('creates the selected scratch directory before %s Codex startup', async mode => {
    const fixture = ownedRuntime(mode)
    expect(fs.existsSync(path.join(fixture.home, '.codex'))).toBe(false)
    await fixture.rig.start()
    expect(fixture.selectedCodexHomeExistsAtStart()).toBe(true)
    const selected = applyIsolatedHomeEnvironment({}, fixture.home).CODEX_HOME
    expect(await fsp.realpath(selected)).toBe(path.join(fixture.home, '.codex'))
  })

  it('preserves existing owned native settings while preparing the selected directory', async () => {
    const fixture = ownedRuntime('terminal')
    const file = path.join(fixture.home, '.codex/config.toml')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, 'model = "fixture-model"\n')
    await fixture.rig.start()
    expect(fixture.selectedCodexHomeExistsAtStart()).toBe(true)
    expect(await fsp.readFile(file, 'utf8')).toBe('model = "fixture-model"\n')
  })

  it('does not initialize a Codex store for an OpenCode-only run', async () => {
    const fixture = ownedRuntime('opencode')
    await fixture.rig.start()
    expect(fixture.selectedCodexHomeExistsAtStart()).toBe(false)
  })
})
