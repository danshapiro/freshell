import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import path from 'node:path'

import type { UpstreamPhase } from './coordinator-command-matrix.js'

const ACTIVE_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_ACTIVE'
const FAKE_UPSTREAM_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM'
const REPO_ROOT_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_REPO_ROOT'

export function assertNoCoordinatorRecursion(envVars: NodeJS.ProcessEnv = process.env): void {
  if (envVars[ACTIVE_ENV_KEY] === '1') {
    throw new Error('Recursive coordinator entry is not allowed while FRESHELL_TEST_COORDINATOR_ACTIVE=1.')
  }
}

export function resolveVitestCommand(repoRoot: string): { command: string; args: string[] } {
  const require = createRequire(path.join(repoRoot, 'package.json'))
  return {
    command: process.execPath,
    args: [require.resolve('vitest/vitest.mjs')],
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

function resolveSpawnSpec(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): { command: string; args: string[]; selector: string } {
  if (phase.runner === 'npm') {
    return {
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['run', phase.script, ...phase.args],
      selector: `npm:${phase.script}`,
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
  )
}

async function runRealPhase(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): Promise<number> {
  const spawnSpec = resolveSpawnSpec(phase, envVars)
  return spawnAndWait(spawnSpec.command, spawnSpec.args, envVars)
}

function spawnAndWait(command: string, args: string[], envVars: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: envVars,
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
