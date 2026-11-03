// @vitest-environment node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildRunScriptArgs,
  detectProjectManager,
  resolveManagerCommand,
} from '../../../scripts/lib/package-manager.js'
import type { ManagerCommand } from '../../../scripts/lib/package-manager.js'

const JS_DUMP_SCRIPT = `const fs = require('node:fs')
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  npm_lifecycle_event: process.env.npm_lifecycle_event,
}))
`

const NATIVE_DUMP_SCRIPT = `#!/bin/sh
printf '%s\\n' "$0" "$@" > "$FAKE_OUT"
`

interface Fixture {
  root: string
  pnpmCjs: string
  npmCliJs: string
  nativeExe: string
  binDir: string
}

interface EntrypointDump {
  argv: string[]
  cwd: string
  npm_lifecycle_event?: string
}

let fixture: Fixture
let invocation: number

function createFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-package-manager-'))
  const root = `${base} dir with spaces`
  fs.mkdirSync(root)

  const pnpmCjs = path.join(root, 'pnpm.cjs')
  fs.writeFileSync(pnpmCjs, JS_DUMP_SCRIPT)
  fs.chmodSync(pnpmCjs, 0o755)

  const npmCliJs = path.join(root, 'fake-npm-cli.js')
  fs.writeFileSync(npmCliJs, JS_DUMP_SCRIPT)

  const nativeExe = path.join(root, 'fake-pnpm-native')
  fs.writeFileSync(nativeExe, NATIVE_DUMP_SCRIPT)
  fs.chmodSync(nativeExe, 0o755)

  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  fs.symlinkSync(pnpmCjs, path.join(binDir, 'pnpm'))

  return { root, pnpmCjs, npmCliJs, nativeExe, binDir }
}

function managerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.npm_execpath
  delete env.npm_lifecycle_event
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value
  }
  return env
}

function invokeEntrypoint(command: ManagerCommand, env: NodeJS.ProcessEnv, cwd?: string): EntrypointDump {
  invocation += 1
  const outputPath = path.join(fixture.root, `dump-${invocation}.json`)
  const child = spawnSync(command.command, command.args, {
    timeout: 30_000,
    killSignal: 'SIGKILL',
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...env, FAKE_OUT: outputPath },
    encoding: 'utf8',
  })
  expect(child.status, `spawn failed: ${child.stderr ?? child.error?.message ?? ''}`).toBe(0)
  return JSON.parse(fs.readFileSync(outputPath, 'utf8')) as EntrypointDump
}

function invokeNative(command: ManagerCommand, env: NodeJS.ProcessEnv): string[] {
  invocation += 1
  const outputPath = path.join(fixture.root, `dump-${invocation}.txt`)
  const child = spawnSync(command.command, command.args, {
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: { ...env, FAKE_OUT: outputPath },
    encoding: 'utf8',
  })
  expect(child.status, `spawn failed: ${child.stderr ?? child.error?.message ?? ''}`).toBe(0)
  return fs.readFileSync(outputPath, 'utf8').trim().split('\n')
}

beforeEach(() => {
  fixture = createFixture()
  invocation = 0
})

afterEach(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('package-manager', () => {
  it('delivers pnpm run arguments without an inserted separator', () => {
    const runArgs = buildRunScriptArgs('pnpm', 'test:vitest', ['run', 'path/to/file.test.ts', '--config', 'X'])
    expect(runArgs).toEqual(['run', 'test:vitest', 'run', 'path/to/file.test.ts', '--config', 'X'])

    const env = managerEnv({ npm_execpath: fixture.pnpmCjs })
    const command = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env })
    expect(command).toEqual({ command: process.execPath, args: [fixture.pnpmCjs, ...runArgs] })

    const dump = invokeEntrypoint(command, env)
    expect(dump.argv).toEqual(runArgs)
  })

  it('preserves the npm separator for forwarded run arguments', () => {
    const forwarded = ['test/unit/tooling/build-id.test.ts']
    const runArgs = buildRunScriptArgs('npm', 'test:vitest', forwarded)
    expect(runArgs).toEqual(['run', 'test:vitest', '--', ...forwarded])
    expect(buildRunScriptArgs('npm', 'build', [])).toEqual(['run', 'build'])

    const env = managerEnv({ npm_execpath: fixture.npmCliJs })
    const command = resolveManagerCommand({ manager: 'npm', args: runArgs, env })
    expect(command).toEqual({ command: process.execPath, args: [fixture.npmCliJs, ...runArgs] })

    const dump = invokeEntrypoint(command, env)
    expect(dump.argv).toEqual(runArgs)
  })

  it('launches a pnpm .cjs entrypoint from a directory with spaces', () => {
    const env = managerEnv({ npm_execpath: fixture.pnpmCjs, npm_lifecycle_event: 'predev' })
    const runArgs = ['run', 'test:vitest', 'run', 'path/to/file.test.ts']
    const command = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env })
    expect(command).toEqual({ command: process.execPath, args: [fixture.pnpmCjs, ...runArgs] })

    const dump = invokeEntrypoint(command, env, fixture.root)
    expect(dump.argv).toEqual(runArgs)
    expect(dump.cwd).toBe(fixture.root)
    expect(dump.npm_lifecycle_event).toBe('predev')
  })

  it('rejects an inherited npm runner and resolves pnpm from PATH', () => {
    const env = managerEnv({ npm_execpath: fixture.npmCliJs })
    const runArgs = ['run', 'test:vitest']
    const command = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env, envPath: fixture.binDir })
    expect(command).toEqual({ command: process.execPath, args: [fixture.pnpmCjs, ...runArgs] })

    const dump = invokeEntrypoint(command, env)
    expect(dump.argv).toEqual(runArgs)
  })

  it('launches a native pnpm executable directly, never through node', () => {
    const env = managerEnv({ npm_execpath: fixture.nativeExe })
    const runArgs = ['run', 'test:vitest', '--config', 'q']
    const command = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env })
    expect(command).toEqual({ command: fixture.nativeExe, args: runArgs })
    expect(command.command).not.toBe(process.execPath)

    const lines = invokeNative(command, env)
    expect(lines).toEqual([fixture.nativeExe, ...runArgs])
  })

  it('resolves the Windows pnpm shim to its entrypoint or flags shell execution', () => {
    const runArgs = ['run', 'test:vitest']
    const env = managerEnv({})
    const shimDir = path.join(fixture.root, 'win-shim')
    fs.mkdirSync(shimDir)
    const shim = path.join(shimDir, 'pnpm.cmd')
    fs.writeFileSync(shim, '@echo off\r\n')

    const fallback = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env, platform: 'win32', envPath: shimDir })
    expect(fallback).toEqual({ command: shim, args: runArgs, viaShell: true })

    const entrypoint = path.join(shimDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true })
    fs.writeFileSync(entrypoint, '')

    const resolved = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env, platform: 'win32', envPath: shimDir })
    expect(resolved).toEqual({ command: process.execPath, args: [entrypoint, ...runArgs] })
  })

  it('resolves a win32 shim dir whose only adjacent entrypoint is pnpm.cjs', () => {
    const runArgs = ['run', 'test:vitest']
    const env = managerEnv({})
    const shimDir = path.join(fixture.root, 'win-shim-adjacent')
    fs.mkdirSync(shimDir)
    fs.writeFileSync(path.join(shimDir, 'pnpm.cmd'), '@echo off\r\n')
    fs.writeFileSync(path.join(shimDir, 'pnpm.cjs'), '')

    const resolved = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env, platform: 'win32', envPath: shimDir })
    expect(resolved).toEqual({ command: process.execPath, args: [path.join(shimDir, 'pnpm.cjs'), ...runArgs] })
  })

  it('detects the project manager from the packageManager field and the lock fallback', () => {
    const pnpmProject = path.join(fixture.root, 'project-pnpm')
    fs.mkdirSync(pnpmProject)
    fs.writeFileSync(path.join(pnpmProject, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }))
    expect(detectProjectManager(pnpmProject)).toEqual({ manager: 'pnpm', source: 'packageManager-field' })

    const npmProject = path.join(fixture.root, 'project-npm')
    fs.mkdirSync(npmProject)
    fs.writeFileSync(path.join(npmProject, 'package.json'), JSON.stringify({ name: 'legacy' }))
    fs.writeFileSync(path.join(npmProject, 'package-lock.json'), '{}')
    expect(detectProjectManager(npmProject)).toEqual({ manager: 'npm', source: 'npm-lock-fallback' })

    const staleProject = path.join(fixture.root, 'project-stale-lock')
    fs.mkdirSync(staleProject)
    fs.writeFileSync(path.join(staleProject, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }))
    fs.writeFileSync(path.join(staleProject, 'package-lock.json'), '{}')
    expect(detectProjectManager(staleProject)).toEqual({ manager: 'pnpm', source: 'packageManager-field' })
  })

  it('resolves pnpm from PATH when the execpath is missing', () => {
    const env = managerEnv({})
    const runArgs = ['run', 'test:vitest']
    const command = resolveManagerCommand({ manager: 'pnpm', args: runArgs, env, envPath: fixture.binDir })
    expect(command).toEqual({ command: process.execPath, args: [fixture.pnpmCjs, ...runArgs] })

    const dump = invokeEntrypoint(command, env)
    expect(dump.argv).toEqual(runArgs)
  })

  it('reports the pinned pnpm install remediation when PATH has no pnpm', () => {
    const env = managerEnv({})
    const emptyBinDir = path.join(fixture.root, 'empty-bin')
    fs.mkdirSync(emptyBinDir)

    let error: unknown
    try {
      resolveManagerCommand({ manager: 'pnpm', args: ['run', 'test:vitest'], env, envPath: emptyBinDir })
    } catch (thrown) {
      error = thrown
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('npm install --global pnpm@10.34.5')
    expect(message).toContain(emptyBinDir)
  })
})
