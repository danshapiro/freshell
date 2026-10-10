// @vitest-environment node
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawn, execFileSync } = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn,
  execFileSync,
}))

import { main as runSourceRuntimeTests } from '../../../scripts/testing/run-source-runtime-tests.js'
import { main as runStandardTests } from '../../../scripts/run-standard-tests.js'
import { resolveManagerExecFileCommand } from '../../setup/manager-command.js'

const require = createRequire(import.meta.url)
const vitestPackagePath = require.resolve('vitest/package.json')
const vitestManifest = JSON.parse(fs.readFileSync(vitestPackagePath, 'utf8')) as { bin: { vitest: string } }
const expectedVitestEntrypoint = path.resolve(path.dirname(vitestPackagePath), vitestManifest.bin.vitest)
const fixtureCommit = 'a'.repeat(40)

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}

interface LaunchFixture {
  root: string
  pnpmCjs: string
  binDir: string
  winShimDir: string
}

let fixture: LaunchFixture

function createLaunchFixture(): LaunchFixture {
  // The strict sandbox supplies executable storage separately from its /tmp.
  const base = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'freshell-runtime-manager-'))
  // Spaces in the fixture root prove manager argv and entrypoint paths
  // survive child-process spawning without shell re-parsing.
  const root = path.join(base, 'dir with spaces')
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
  // Cloud unit tests have no checkout metadata; commit lookup is a fixture.
  execFileSync.mockReturnValue(`${fixtureCommit}\n`)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  spawn.mockReset()
  execFileSync.mockReset()
  fs.rmSync(path.dirname(fixture.root), { recursive: true, force: true })
})

describe('runtime test script manager launches', () => {
  function mockSpawnResolvingChildren(): void {
    spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        if (command.endsWith('.cmd')) child.emit('error', new Error('spawn EINVAL'))
        else {
          child.emit('exit', 0, null)
          child.emit('close', 0, null)
        }
      })
      return child
    })
  }

  function mockSpawnSucceedingThroughShell(): void {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
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

  it('keeps native preparation but routes the process suite through the strict sandbox on exact opt-in', async () => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    mockSpawnResolvingChildren()

    expect(await runSourceRuntimeTests(['--', 'filter with space', '', "quote'word", '$(command)', 'unicode-🚀'])).toBe(0)
    const specs = launchedSpecs()
    expect(specs.slice(0, 4).map(spec => spec.args)).toEqual([
      [fixture.pnpmCjs, 'run', 'prebuild'],
      [fixture.pnpmCjs, 'run', 'build:client'],
      [fixture.pnpmCjs, 'run', 'build:tools'],
      ['build', '--release', '-p', 'freshell-server', '--locked'],
    ])
    expect(specs).toHaveLength(6)
    expect(specs[5].command).toBe(path.resolve('scripts/sandbox-test.sh'))
    expect((specs[5].args as string[])[0]).toBe('--runtime-suite')
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve('.'), encoding: 'utf8',
    })
  })

  it('rejects failed commit lookup before sandbox dispatch', async () => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    mockSpawnResolvingChildren()
    execFileSync.mockImplementationOnce(() => { throw new Error('Git metadata unavailable') })

    await expect(runSourceRuntimeTests([])).rejects.toThrow('Git metadata unavailable')
    expect(spawn).toHaveBeenCalledTimes(4)
  })

  it('rejects an invalid commit identity before sandbox dispatch', async () => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    mockSpawnResolvingChildren()
    execFileSync.mockReturnValueOnce('unknown\n')

    await expect(runSourceRuntimeTests([])).rejects.toThrow('Cannot identify the source-runtime build commit.')
    expect(spawn).toHaveBeenCalledTimes(4)
  })

  it.each(['0', 'true', ''])('keeps direct runtime dispatch for non-opt-in %j even with cloud configured', async value => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', value)
    vi.stubEnv('FRESHELL_VITEST_BACKEND', 'cloud')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    mockSpawnResolvingChildren()
    expect(await runSourceRuntimeTests([])).toBe(0)
    expect(launchedSpecs().at(-1)).toMatchObject({ command: process.execPath, args: [expectedVitestEntrypoint, 'run', '--config', expect.any(String)] })
  })

  it.each([17, 125, 143])('returns sandbox failure %s without a host runtime fallback', async code => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    spawn.mockImplementation((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        const result = command.endsWith('sandbox-test.sh') && args[0] === '--runtime-suite' ? code : 0
        child.emit('exit', result, null)
        child.emit('close', result, null)
      })
      return child
    })
    expect(await runSourceRuntimeTests([])).toBe(code)
    expect(spawn).toHaveBeenCalledTimes(6)
  })

  it.each([0, 31])('executes the sandbox shell boundary with exact argv and cleanup on suite exit %s', async code => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    const receipt = path.join(fixture.root, 'receipt.jsonl')
    const helper = path.join(fixture.root, 'record.mjs')
    fs.writeFileSync(helper, `import fs from 'node:fs';
      fs.appendFileSync(process.env.RECEIPT, JSON.stringify({kind:process.argv[2], args:process.argv.slice(3),
        route:process.env.FRESHELL_RUST_TEST_SANDBOX, jobs:process.env.CARGO_BUILD_JOBS,
        commit:process.env.FRESHELL_BUILD_COMMIT,
        tmp:process.env.TMPDIR, executableTmp:process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR})+'\\n');
      process.exit(process.argv[2]==='node' ? Number(process.env.SUITE_EXIT) : 0);`)
    for (const name of ['cargo', 'node']) {
      fs.writeFileSync(path.join(fixture.binDir, name), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} ${name} "$@"\n`, { mode: 0o755 })
    }
    let shellOutput = ''
    spawn.mockImplementation((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        let status = 0
        if (command.endsWith('sandbox-test.sh') && args[0] === '--runtime-suite') {
          const payload = args[1].replace('/freshell-test-artifacts/', `${shellQuote(fixture.root)}/`)
          const result = spawnSync('bash', ['-c', payload], {
            cwd: fixture.root,
            env: { ...process.env, PATH: `${fixture.binDir}:${process.env.PATH}`, RECEIPT: receipt, SUITE_EXIT: String(code) },
            encoding: 'utf8', timeout: 10_000,
          })
          shellOutput = result.stdout + result.stderr
          status = result.status ?? 1
        }
        child.emit('exit', status, null)
        child.emit('close', status, null)
      })
      return child
    })
    const args = ['--', 'filter with space', '', "quote'word", '$(touch SHOULD_NOT_EXIST)', 'a;echo nope', 'line\nbreak', 'unicode-🚀', '/workspace/target/argument']
    expect(await runSourceRuntimeTests(args), shellOutput).toBe(code)
    const events = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events.map(event => event.kind)).toEqual(['cargo', 'node'])
    expect(events[0].args).toEqual(['build', '--release', '-p', 'freshell-server', '--locked'])
    // Execute the real shell, then inspect the literal node argv that it delivered.
    expect(events[1].args.slice(0, 4)).toEqual(['--import', 'tsx', '--input-type=module', '-e'])
    expect(events[1].args.slice(5)).toEqual(['--', ...args.slice(1)])
    expect(events[1].route).toBe('0')
    expect(events[1].jobs).toBe('3')
    expect(events[1].commit).toBe(fixtureCommit)
    expect(events[1].tmp).toBe(events[1].executableTmp)
    expect(fs.existsSync(events[1].tmp)).toBe(false)
    expect(fs.existsSync(path.join(fixture.root, 'SHOULD_NOT_EXIST'))).toBe(false)
    expect(shellOutput).not.toContain('quote')
    expect(shellOutput).toContain('source_runtime_temp_settled')
  })

  it.each([0, 33])('prepares sandbox prerequisites before the strict suite and propagates preparation exit %s', async preparationExit => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    const readyPath = path.join(fixture.root, 'prerequisites-ready')
    const receiptPath = path.join(fixture.root, 'prerequisite-events.jsonl')
    const helperPath = path.join(fixture.root, 'prerequisite-child.mjs')
    fs.writeFileSync(helperPath, `import fs from 'node:fs';
      const preparing = process.argv.includes('scripts/ensure-claude-sidecar.ts');
      fs.appendFileSync(process.env.RECEIPT, JSON.stringify({preparing, ready:fs.existsSync(process.env.READY)})+'\\n');
      if (preparing) {
        if (Number(process.env.PREPARATION_EXIT)) process.exit(Number(process.env.PREPARATION_EXIT));
        fs.writeFileSync(process.env.READY, 'prepared');
      } else if (!fs.existsSync(process.env.READY)) process.exit(41);`)
    fs.writeFileSync(path.join(fixture.binDir, 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(fixture.binDir, 'node'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helperPath)} "$@"\n`, { mode: 0o755 })
    let shellOutput = ''
    spawn.mockImplementation((command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false })
      queueMicrotask(() => {
        let status = 0
        if (command.endsWith('sandbox-test.sh')) {
          const payload = args.at(-1)!.replace('/freshell-test-artifacts/', `${shellQuote(fixture.root)}/`)
          const result = spawnSync('bash', ['-c', payload], {
            cwd: fixture.root,
            env: { ...process.env, PATH: `${fixture.binDir}:${process.env.PATH}`, RECEIPT: receiptPath, READY: readyPath, PREPARATION_EXIT: String(preparationExit) },
            encoding: 'utf8', timeout: 10_000,
          })
          shellOutput += result.stdout + result.stderr
          status = result.status ?? 1
        }
        child.emit('close', status, null)
      })
      return child
    })

    expect(await runSourceRuntimeTests([]), shellOutput).toBe(preparationExit)
    const events = fs.readFileSync(receiptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(events).toEqual(preparationExit === 0
      ? [{ preparing: true, ready: false }, { preparing: false, ready: true }]
      : [{ preparing: true, ready: false }])
  })

  it('forwards SIGTERM from a simulated listener and removes its handlers after child close', async () => {
    vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
    vi.stubEnv('npm_execpath', fixture.pnpmCjs)
    const before = process.listenerCount('SIGTERM')
    const kill = vi.fn()
    spawn.mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false, kill })
      queueMicrotask(() => {
        if (command.endsWith('sandbox-test.sh')) {
          process.emit('SIGTERM')
          child.emit('exit', null, 'SIGTERM')
          child.emit('close', null, 'SIGTERM')
        } else {
          child.emit('exit', 0, null)
          child.emit('close', 0, null)
        }
      })
      return child
    })
    expect(await runSourceRuntimeTests([])).toBe(143)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it.each(['--passWithNoTests', '--passWithNoTests=true'])('rejects vacuous coverage flag %s before preparation', async arg => {
    expect(await runSourceRuntimeTests(['--', arg])).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
  })

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
