#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..')

type RecoveryTest = {
  package: string
  target: string[]
  name: string
}

const RECOVERY_TESTS: RecoveryTest[] = [
  {
    package: 'freshell-platform',
    target: ['--lib'],
    name: 'provider_environment::tests::abrupt_termination_during_replacement_keeps_existing_leaf',
  },
  {
    package: 'freshell-platform',
    target: ['--lib'],
    name: 'provider_environment::tests::abrupt_termination_after_partial_publish_recovers_prior_home_before_retry',
  },
  {
    package: 'freshell-platform',
    target: ['--lib'],
    name: 'provider_environment::tests::interrupted_committed_cleanup_does_not_restore_committed_home',
  },
  {
    package: 'freshell-platform',
    target: ['--lib'],
    name: 'provider_environment::tests::checkpoint_timeout_cleanup_kills_and_reaps_child',
  },
  {
    package: 'freshell-session-host',
    target: ['--bin', 'freshell-session-host'],
    name: 'tests::opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries',
  },
  {
    package: 'freshell-session-host',
    target: ['--bin', 'freshell-session-host'],
    name: 'tests::provider_config_refresh_recovers_manifest_before_removing_stale_paths',
  },
]

function log(severity: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const stream = severity === 'error' ? process.stderr : process.stdout
  stream.write(`${JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...fields })}\n`)
}

function runTest(test: RecoveryTest): Promise<number> {
  const args = [
    'test',
    '--locked',
    '-p',
    test.package,
    ...test.target,
    test.name,
    '--',
    '--ignored',
    '--exact',
  ]

  return new Promise((resolve) => {
    log('info', 'provider_recovery_test_started', {
      package: test.package,
      target: test.target,
      name: test.name,
      command: 'cargo',
      args,
    })

    let settled = false
    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (code !== 0 || signal) {
        log('error', 'provider_recovery_test_failed', {
          package: test.package,
          name: test.name,
          code,
          signal,
        })
      } else {
        log('info', 'provider_recovery_test_finished', {
          package: test.package,
          name: test.name,
          code,
        })
      }
      resolve(code)
    }

    let child
    try {
      child = spawn('cargo', args, {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      })
    } catch (error) {
      log('error', 'provider_recovery_test_spawn_failed', {
        package: test.package,
        name: test.name,
        error: error instanceof Error ? error.message : String(error),
      })
      resolve(1)
      return
    }

    child.once('error', (error) => {
      log('error', 'provider_recovery_test_spawn_failed', {
        package: test.package,
        name: test.name,
        error: error.message,
      })
      finish(1, null)
    })
    child.once('exit', (code, signal) => {
      finish(code ?? 1, signal)
    })
  })
}

function listIgnoredTests(target: RecoveryTest): Promise<{ code: number; stdout: string }> {
  const args = [
    'test',
    '--locked',
    '-p',
    target.package,
    ...target.target,
    '--',
    '--ignored',
    '--list',
  ]

  return new Promise((resolve) => {
    log('info', 'provider_recovery_test_names_started', {
      package: target.package,
      target: target.target,
      command: 'cargo',
      args,
    })
    let stdout = ''
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      resolve({ code, stdout })
    }

    let child
    try {
      child = spawn('cargo', args, {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true,
      })
    } catch (error) {
      log('error', 'provider_recovery_test_names_spawn_failed', {
        package: target.package,
        target: target.target,
        error: error instanceof Error ? error.message : String(error),
      })
      finish(1)
      return
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.once('error', (error) => {
      log('error', 'provider_recovery_test_names_spawn_failed', {
        package: target.package,
        target: target.target,
        error: error.message,
      })
      finish(1)
    })
    child.once('exit', (code) => finish(code ?? 1))
  })
}

function targetKey(test: RecoveryTest): string {
  return `${test.package}:${test.target.join(':')}`
}

export async function main(): Promise<number> {
  if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
    log('error', 'provider_recovery_selector_refused', {
      reason: 'selector must run inside scripts/sandbox-test.sh --runtime-suite',
      sandboxMode: process.env.FRESHELL_SANDBOX_MODE ?? null,
    })
    return 2
  }

  log('info', 'provider_recovery_selector_started', { testCount: RECOVERY_TESTS.length })
  const targets = new Map<string, RecoveryTest[]>()
  for (const test of RECOVERY_TESTS) {
    const key = targetKey(test)
    const tests = targets.get(key) ?? []
    tests.push(test)
    targets.set(key, tests)
  }
  for (const tests of targets.values()) {
    const target = tests[0]
    const result = await listIgnoredTests(target)
    if (result.code !== 0) {
      log('error', 'provider_recovery_test_names_failed', {
        package: target.package,
        target: target.target,
        code: result.code,
      })
      return result.code
    }
    const available = new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.match(/^(.+): test$/)?.[1])
        .filter((name): name is string => name !== undefined),
    )
    const missing = tests.map((test) => test.name).filter((name) => !available.has(name))
    if (missing.length > 0) {
      log('error', 'provider_recovery_selector_missing_tests', {
        package: target.package,
        target: target.target,
        missing,
      })
      return 1
    }
    log('info', 'provider_recovery_test_names_confirmed', {
      package: target.package,
      target: target.target,
      testCount: tests.length,
    })
  }

  for (const test of RECOVERY_TESTS) {
    const code = await runTest(test)
    if (code !== 0) return code
  }
  log('info', 'provider_recovery_selector_finished', { testCount: RECOVERY_TESTS.length })
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    log('error', 'provider_recovery_selector_unhandled_error', {
      error: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  })
}
