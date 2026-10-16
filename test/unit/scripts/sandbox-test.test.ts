import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeExecutable(file: string, source: string) {
  fs.writeFileSync(file, source)
  fs.chmodSync(file, 0o755)
}

function invoke(mode: 'ordinary' | 'runtime-suite', code = 0, rootDropping = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-wrapper-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.copyFileSync('scripts/sandbox-test.sh', path.join(root, 'scripts/sandbox-test.sh'))
  const receipt = path.join(root, 'docker.jsonl')
  const docker = path.join(root, 'bin/docker')
  writeExecutable(docker, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.WRAPPER_RECEIPT, JSON.stringify(args) + '\\n');
if (args[0] === 'run') process.exit(Number(process.env.WRAPPER_EXIT));
if (args[0] === 'image' || args[0] === 'network') process.exit(0);
process.exit(89);
`)
  // Exercise the final ownership guard without creating root-owned files.
  const find = path.join(root, 'bin/find')
  writeExecutable(find, '#!/bin/sh\nif [ "$WRAPPER_ROOT_DROPPING" = 1 ]; then printf "%s\\n" "$1/unexpected-root-entry"; else exec /usr/bin/find "$@"; fi\n')
  const command = 'printf "%s\\n" "literal $(not-a-host-command)"'
  const result = spawnSync('bash', [path.join(root, 'scripts/sandbox-test.sh'),
    ...(mode === 'runtime-suite' ? ['--runtime-suite'] : []), command], {
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      WRAPPER_RECEIPT: receipt, WRAPPER_EXIT: String(code), WRAPPER_ROOT_DROPPING: rootDropping ? '1' : '0' },
    encoding: 'utf8',
  })
  const calls: string[][] = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const events = result.stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  return { result, command, events, run: calls.find(args => args[0] === 'run')! }
}

describe('sandbox execution budget', () => {
  for (const mode of ['ordinary', 'runtime-suite'] as const) {
    it(`${mode} bounds Docker/Cargo scheduling and preserves command boundaries`, () => {
      const { result, command, events, run } = invoke(mode)
      expect(result.status).toBe(0)
      for (const [flag, value] of [['--cpus', '2'], ['--memory', '8g'],
        ['--memory-swap', '16g'], ['--pids-limit', '512']]) {
        expect(run[run.indexOf(flag) + 1]).toBe(value)
      }
      expect(run).toContain('CARGO_BUILD_JOBS=2')
      expect(run).toContain('--init')
      expect(run.slice(-4)).toEqual(['freshell-sandbox:latest', 'bash', '-c', command])
      expect(run[run.indexOf('--network') + 1]).toBe(mode === 'ordinary' ? 'freshell-sandbox' : 'none')
      if (mode === 'runtime-suite') expect(run).toContain('--read-only')
      expect(events).toEqual([
        { event: 'sandbox_resources', severity: 'info', mode, cargoJobs: 2, cpus: 2,
          memoryBytes: 8589934592, memorySwapBytes: 17179869184, pidsLimit: 512,
          cause: 'sandbox_requested', action: 'apply_resource_limits', outcome: 'launching' },
        { event: 'sandbox_completed', severity: 'info', mode, exitCode: 0,
          cause: 'workload_completed', action: 'return_exit_status', outcome: 'succeeded' },
      ])
    })

    it(`${mode} preserves a failed workload exit`, () => {
      const { result, events } = invoke(mode, 37)
      expect(result.status).toBe(37)
      expect(events.at(-1)).toEqual({ event: 'sandbox_completed', severity: 'error', mode, exitCode: 37,
        cause: 'workload_completed', action: 'return_exit_status', outcome: 'failed' })
    })

    it(`${mode} reports the final ownership guard failure`, () => {
      const { result, events } = invoke(mode, 37, true)
      expect(result.status).toBe(1)
      expect(events.at(-1)).toEqual({ event: 'sandbox_completed', severity: 'error', mode, exitCode: 1,
        cause: 'root_owned_entries', action: 'return_exit_status', outcome: 'failed' })
    })
  }
})
