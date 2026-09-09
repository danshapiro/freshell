// @vitest-environment node
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn,
}))

import { main as runSourceRuntimeTests } from '../../../scripts/testing/run-source-runtime-tests.js'
import { main as runStandardTests } from '../../../scripts/run-standard-tests.js'
import { resolveManagerExecFileCommand } from '../../setup/manager-command.js'

const require = createRequire(import.meta.url)
const vitestPackagePath = require.resolve('vitest/package.json')
const vitestManifest = JSON.parse(fs.readFileSync(vitestPackagePath, 'utf8')) as { bin: { vitest: string } }
const expectedVitestEntrypoint = path.resolve(path.dirname(vitestPackagePath), vitestManifest.bin.vitest)

interface LaunchFixture {
  root: string
  pnpmCjs: string
  binDir: string
  winShimDir: string
}

let fixture: LaunchFixture

function createLaunchFixture(): LaunchFixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-runtime-manager-'))
  // Spaces in the fixture root prove manager argv and entrypoint paths
  // survive child-process spawning without shell re-parsing.
  const root = `${base} dir with spaces`
  fs.mkdirSync(root)

  const pnpmCjs = path.join(root, 'pnpm.cjs')
  fs.writeFileSync(pnpmCjs, '')

  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  fs.symlinkSync(pnpmCjs, path.join(binDir, 'pnpm'))

  const winShimDir = path.join(root, 'win-shim')
  fs.mkdirSync(winShimDir)
  fs.writeFileSync(path.join(winShimDir, 'pnpm.cmd'), '@echo off\r\n')

  return { root, pnpmCjs, binDir, winShimDir }
}

beforeEach(() => {
  fixture = createLaunchFixture()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  spawn.mockReset()
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('runtime test script manager launches', () => {
  function mockSpawnResolvingChildren(): void {
    spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        if (command.endsWith('.cmd')) child.emit('error', new Error('spawn EINVAL'))
        else child.emit('exit', 0, null)
      })
      return child
    })
  }

  function mockSpawnSucceedingThroughShell(): void {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => child.emit('exit', 0, null))
      return child
    })
  }

  function launchedSpecs(): Array<{ command: unknown; args: unknown; windowsHide: unknown; shell: unknown }> {
    return spawn.mock.calls.map(([command, args, options]) => ({
      command,
      args,
      windowsHide: options?.windowsHide,
      shell: options?.shell,
    }))
  }

  it('launches the source-runtime build phases through node and the detected pnpm entrypoint on native Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    // POSIX-style path so path.basename recognizes the pnpm entrypoint on every
    // test platform; Windows basename accepts forward slashes too.
    const pnpmCjs = '/opt/freshell-test-bin/pnpm.cjs'
    vi.stubEnv('npm_execpath', pnpmCjs)
    mockSpawnResolvingChildren()

    expect(await runSourceRuntimeTests([])).toBe(0)
    const specs = launchedSpecs()
    for (const script of ['prebuild', 'build:client', 'build:tools']) {
      expect(specs).toContainEqual({
        command: process.execPath,
        args: [pnpmCjs, 'run', script],
        windowsHide: true,
        shell: false,
      })
    }
    expect(specs).toContainEqual({
      command: 'cargo',
      args: ['build', '--release', '-p', 'freshell-server', '--locked'],
      windowsHide: true,
      shell: false,
    })
    expect(specs.at(-1)).toMatchObject({
      command: process.execPath,
      args: [expectedVitestEntrypoint, 'run', '--config', expect.stringContaining('vitest.runtime.config.ts')],
      windowsHide: true,
      shell: false,
    })
  })

  it('resolves the detected pnpm executable from PATH when no manager entrypoint is ambient', async () => {
    vi.stubEnv('npm_execpath', '')
    vi.stubEnv('PATH', fixture.binDir)
    mockSpawnResolvingChildren()

    expect(await runSourceRuntimeTests([])).toBe(0)
    expect(launchedSpecs()).toContainEqual({
      command: process.execPath,
      args: [fs.realpathSync(fixture.pnpmCjs), 'run', 'prebuild'],
      windowsHide: true,
      shell: false,
    })
  })

  it('spawns an unresolvable win32 pnpm shim through a shell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('npm_execpath', '')
    vi.stubEnv('PATH', fixture.winShimDir)
    mockSpawnSucceedingThroughShell()

    expect(await runSourceRuntimeTests([])).toBe(0)
    expect(launchedSpecs()[0]).toEqual({
      command: path.join(fixture.winShimDir, 'pnpm.cmd'),
      args: ['run', 'prebuild'],
      windowsHide: true,
      shell: true,
    })
  })

  it('launches the standard source-runtime phase through the detected pnpm entrypoint on native Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    // POSIX-style path so path.basename recognizes the pnpm entrypoint on every
    // test platform; Windows basename accepts forward slashes too.
    const pnpmCjs = '/opt/freshell-test-bin/pnpm.cjs'
    vi.stubEnv('npm_execpath', pnpmCjs)
    mockSpawnResolvingChildren()

    expect(await runStandardTests(['test/integration/tooling/source-runtime-rust.test.ts'])).toBe(0)
    expect(launchedSpecs()).toContainEqual({
      command: process.execPath,
      args: [
        pnpmCjs,
        'run',
        'test:source-runtime',
        'test/integration/tooling/source-runtime-rust.test.ts',
      ],
      windowsHide: true,
    })
  })
})

describe('resolveManagerExecFileCommand', () => {
  function writeProject(name: string, manifest?: Record<string, unknown>): string {
    const projectRoot = path.join(fixture.root, name)
    fs.mkdirSync(projectRoot)
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(manifest ?? { name: 'legacy-project' }))
    return projectRoot
  }

  it('launches the npm JavaScript entrypoint on native Windows for a project without the pnpm pin', () => {
    const projectRoot = writeProject('legacy-project')
    const npmCli = path.join(fixture.root, 'npm-cli.js')
    fs.writeFileSync(npmCli, '')

    const command = resolveManagerExecFileCommand(
      ['run', 'prebuild'],
      { npm_execpath: npmCli },
      'win32',
      process.execPath,
      projectRoot,
    )

    expect(command).toEqual({ command: process.execPath, args: [npmCli, 'run', 'prebuild'] })
  })

  it('detects a pinned pnpm project and launches its entrypoint', () => {
    const projectRoot = writeProject('pnpm-project', { packageManager: 'pnpm@10.34.5' })

    const command = resolveManagerExecFileCommand(
      ['run', 'build:client'],
      { npm_execpath: fixture.pnpmCjs },
      'win32',
      process.execPath,
      projectRoot,
    )

    expect(command).toEqual({ command: process.execPath, args: [fixture.pnpmCjs, 'run', 'build:client'] })
  })

  it('resolves pnpm from PATH for a pinned project without an ambient entrypoint', () => {
    const projectRoot = writeProject('pnpm-path-project', { packageManager: 'pnpm@10.34.5' })

    const command = resolveManagerExecFileCommand(
      ['run', 'prebuild'],
      { PATH: fixture.binDir },
      'linux',
      process.execPath,
      projectRoot,
    )

    expect(command).toEqual({
      command: process.execPath,
      args: [fs.realpathSync(fixture.pnpmCjs), 'run', 'prebuild'],
    })
  })

  it('defaults project detection to the repository root', () => {
    const command = resolveManagerExecFileCommand(['start'], { npm_execpath: fixture.pnpmCjs }, 'linux')

    expect(command).toEqual({ command: process.execPath, args: [fixture.pnpmCjs, 'start'] })
  })
})
