import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirectories: string[] = []
const fetchScript = resolve(process.cwd(), 'docker/cloud-run/cargo-fetch-retry.sh')

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeFixture(failures: number, failureExitCode = 42) {
  const directory = mkdtempSync(join(tmpdir(), 'freshell-cargo-fetch-retry-'))
  tempDirectories.push(directory)
  const bin = join(directory, 'bin')
  mkdirSync(bin)

  const callsPath = join(directory, 'cargo-calls')
  const counterPath = join(directory, 'cargo-counter')
  const sleepsPath = join(directory, 'sleep-calls')
  const cargo = join(bin, 'cargo')
  const sleep = join(bin, 'sleep')

  writeFileSync(cargo, [
    '#!/bin/sh',
    'count=0',
    'if [ -f "$FAKE_CARGO_COUNTER" ]; then IFS= read -r count < "$FAKE_CARGO_COUNTER" || count=0; fi',
    'count=$((count + 1))',
    'printf "%s\\n" "$count" > "$FAKE_CARGO_COUNTER"',
    'printf "%s\\t%s\\n" "$count" "$*" >> "$FAKE_CARGO_CALLS"',
    'printf "cargo-stderr-attempt-%s\\n" "$count" >&2',
    'if [ "$count" -le "$FAKE_CARGO_FAILURES" ]; then exit "$FAKE_CARGO_EXIT_CODE"; fi',
    'exit 0',
    '',
  ].join('\n'))
  writeFileSync(sleep, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$FAKE_SLEEP_CALLS"',
    'exit 0',
    '',
  ].join('\n'))
  chmodSync(cargo, 0o755)
  chmodSync(sleep, 0o755)

  const run = () => spawnSync('/bin/sh', [fetchScript], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_CARGO_CALLS: callsPath,
      FAKE_CARGO_COUNTER: counterPath,
      FAKE_CARGO_FAILURES: String(failures),
      FAKE_CARGO_EXIT_CODE: String(failureExitCode),
      FAKE_SLEEP_CALLS: sleepsPath,
    },
  })

  const cargoArguments = () => readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('\t').slice(1).join('\t'))
  const sleepArguments = () => {
    try {
      return readFileSync(sleepsPath, 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }

  return { run, cargoArguments, sleepArguments }
}

function structuredEvents(stderr: string): Record<string, unknown>[] {
  return stderr.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith('{')) return []
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? [value as Record<string, unknown>]
      : []
  })
}

describe('Cloud Run Cargo fetch retry wrapper', () => {
  it('makes one locked fetch call when Cargo succeeds immediately', () => {
    const fixture = makeFixture(0)
    const result = fixture.run()

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(fixture.cargoArguments()).toEqual(['fetch --locked'])
    expect(fixture.sleepArguments()).toEqual([])
    expect(structuredEvents(result.stderr)).toEqual([
      {
        severity: 'info',
        event: 'cloud_rust.cargo_fetch.succeeded',
        attempt: 1,
        attemptLimit: 3,
      },
    ])
  })

  it('retries two failed fetch processes with bounded backoff, then succeeds', () => {
    const fixture = makeFixture(2, 56)
    const result = fixture.run()

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(fixture.cargoArguments()).toEqual(Array(3).fill('fetch --locked'))
    expect(fixture.sleepArguments()).toEqual(['1', '2'])
    expect(result.stderr).toContain('cargo-stderr-attempt-1')
    expect(result.stderr).toContain('cargo-stderr-attempt-2')
    expect(result.stderr).toContain('cargo-stderr-attempt-3')
    expect(structuredEvents(result.stderr)).toEqual([
      {
        severity: 'warn',
        event: 'cloud_rust.cargo_fetch.retry',
        attempt: 1,
        attemptLimit: 3,
        exitCode: 56,
        backoffSeconds: 1,
      },
      {
        severity: 'warn',
        event: 'cloud_rust.cargo_fetch.retry',
        attempt: 2,
        attemptLimit: 3,
        exitCode: 56,
        backoffSeconds: 2,
      },
      {
        severity: 'info',
        event: 'cloud_rust.cargo_fetch.succeeded',
        attempt: 3,
        attemptLimit: 3,
      },
    ])
  })

  it('preserves every Cargo stderr message and the final exit code when retries exhaust', () => {
    const fixture = makeFixture(3, 42)
    const result = fixture.run()

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(42)
    expect(fixture.cargoArguments()).toEqual(Array(3).fill('fetch --locked'))
    expect(fixture.sleepArguments()).toEqual(['1', '2'])
    for (const attempt of [1, 2, 3]) {
      expect(result.stderr).toContain(`cargo-stderr-attempt-${attempt}`)
    }
    expect(structuredEvents(result.stderr)).toEqual([
      {
        severity: 'warn',
        event: 'cloud_rust.cargo_fetch.retry',
        attempt: 1,
        attemptLimit: 3,
        exitCode: 42,
        backoffSeconds: 1,
      },
      {
        severity: 'warn',
        event: 'cloud_rust.cargo_fetch.retry',
        attempt: 2,
        attemptLimit: 3,
        exitCode: 42,
        backoffSeconds: 2,
      },
      {
        severity: 'error',
        event: 'cloud_rust.cargo_fetch.exhausted',
        attempt: 3,
        attemptLimit: 3,
        exitCode: 42,
      },
    ])
  })
})
