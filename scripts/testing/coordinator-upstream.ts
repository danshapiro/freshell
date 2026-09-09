import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildRunScriptArgs,
  detectProjectManager,
  resolveManagerCommand,
  type PackageManagerKind,
} from '../lib/package-manager.js'

import type { UpstreamPhase } from './coordinator-command-matrix.js'

const ACTIVE_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_ACTIVE'
const FAKE_UPSTREAM_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM'
const REPO_ROOT_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_REPO_ROOT'

const managerByRepoRoot = new Map<string, PackageManagerKind>()

function detectPhaseManager(repoRoot: string): PackageManagerKind {
  const cached = managerByRepoRoot.get(repoRoot)
  if (cached !== undefined) {
    return cached
  }
  const manager = detectProjectManager(repoRoot).manager
  managerByRepoRoot.set(repoRoot, manager)
  return manager
}

export function assertNoCoordinatorRecursion(envVars: NodeJS.ProcessEnv = process.env): void {
  if (envVars[ACTIVE_ENV_KEY] === '1') {
    throw new Error('Recursive coordinator entry is not allowed while FRESHELL_TEST_COORDINATOR_ACTIVE=1.')
  }
}

export function resolveVitestCommand(repoRoot: string): { command: string; args: string[] } {
  const require = createRequire(path.join(repoRoot, 'package.json'))
  const packagePath = require.resolve('vitest/package.json')
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { bin?: string | Record<string, string> }
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest
  if (!relativeBin || path.isAbsolute(relativeBin) || relativeBin.split(/[\/]/).includes('..')) {
    throw new Error('Vitest package does not expose a safe CLI entrypoint.')
  }
  return {
    command: process.execPath,
    args: [path.resolve(path.dirname(packagePath), relativeBin)],
  }
}

export function resolveCargoCommand(): { command: string; args: string[] } {
  return {
    command: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    args: [],
  }
}

export async function runUpstreamPhase(
  phase: UpstreamPhase,
  envVars: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const childEnv: NodeJS.ProcessEnv = {
    ...envVars,
    [ACTIVE_ENV_KEY]: '1',
  }

  if (envVars[FAKE_UPSTREAM_ENV_KEY]) {
    return runFakePhase(phase, childEnv)
  }

  return runRealPhase(phase, childEnv)
}

interface SpawnSpec {
  command: string
  args: string[]
  selector: string
  viaShell?: boolean
}

function resolveSpawnSpec(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): SpawnSpec {
  if (phase.runner === 'npm') {
    const repoRoot = envVars[REPO_ROOT_ENV_KEY] ?? process.cwd()
    const manager = detectPhaseManager(repoRoot)
    const scriptArgs = buildRunScriptArgs(manager, phase.script, phase.args)
    const resolved = resolveManagerCommand({ manager, args: scriptArgs, env: envVars })
    return {
      command: resolved.command,
      args: resolved.args,
      ...(resolved.viaShell === true ? { viaShell: true } : {}),
      selector: `npm:${phase.script}${phase.args.length > 0 ? ` ${phase.args.join(' ')}` : ''}`,
    }
  }

  if (phase.runner === 'cargo') {
    const cargo = resolveCargoCommand()
    return {
      command: cargo.command,
      args: [...cargo.args, ...phase.args],
      selector: `cargo:${phase.args.join(' ')}`.trimEnd(),
    }
  }

  const repoRoot = envVars[REPO_ROOT_ENV_KEY] ?? process.cwd()
  const vitest = resolveVitestCommand(repoRoot)
  return {
    command: vitest.command,
    args: [...vitest.args, ...phase.args],
    selector: `vitest:${phase.config}:${phase.args.join(' ')}`.trimEnd(),
  }
}

async function runFakePhase(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): Promise<number> {
  const fakeUpstreamPath = envVars[FAKE_UPSTREAM_ENV_KEY]
  if (!fakeUpstreamPath) {
    throw new Error('Fake upstream path was not provided.')
  }

  const spawnSpec = resolveSpawnSpec(phase, envVars)
  return spawnAndWait(
    process.execPath,
    [
      fakeUpstreamPath,
      JSON.stringify({
        selector: spawnSpec.selector,
        command: spawnSpec.command,
        args: spawnSpec.args,
      }),
    ],
    envVars,
    false,
  )
}

async function runRealPhase(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): Promise<number> {
  const spawnSpec = resolveSpawnSpec(phase, envVars)
  return spawnAndWait(spawnSpec.command, spawnSpec.args, envVars, spawnSpec.viaShell === true)
}

function spawnAndWait(
  command: string,
  args: string[],
  envVars: NodeJS.ProcessEnv,
  viaShell: boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: envVars,
      ...(viaShell ? { shell: true } : {}),
    })

    child.once('error', (error) => reject(error))
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code)
        return
      }

      if (signal) {
        resolve(128 + (osConstants.signals[signal as keyof typeof osConstants.signals] ?? 1))
        return
      }

      resolve(1)
    })
  })
}
