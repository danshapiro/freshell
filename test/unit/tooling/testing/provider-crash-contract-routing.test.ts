// @vitest-environment node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const tsx = require.resolve('tsx')

function runFixture(contractExit: number) {
  const root = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'codex-contract-route-'))
  try {
    const scripts = path.join(root, 'scripts/testing')
    const bin = path.join(root, 'bin')
    const receipt = path.join(root, 'calls.jsonl')
    fs.mkdirSync(scripts, { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
    fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
    fs.copyFileSync('scripts/testing/provider-crash-recovery-tests.ts', path.join(scripts, 'provider-crash-recovery-tests.ts'))
    fs.writeFileSync(path.join(scripts, 'controlled-codex-host-contract.ts'), `
      import fs from 'node:fs';
      fs.appendFileSync(process.env.RECEIPT!, JSON.stringify({ kind: 'contract', mode: process.env.FRESHELL_SANDBOX_MODE }) + '\\n');
      process.exit(Number(process.env.CONTRACT_EXIT));
    `)
    fs.writeFileSync(path.join(bin, 'cargo.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const name of [
    'provider_environment::tests::abrupt_termination_during_replacement_keeps_existing_leaf',
    'provider_environment::tests::abrupt_termination_after_partial_publish_recovers_prior_home_before_retry',
    'provider_environment::tests::interrupted_committed_cleanup_does_not_restore_committed_home',
    'provider_environment::tests::checkpoint_timeout_cleanup_kills_and_reaps_child',
    'tests::opencode_host_restarts_at_receipt_and_pre_pty_durable_boundaries',
    'tests::provider_config_refresh_recovers_manifest_before_removing_stale_paths',
  ]) console.log(name + ': test');
} else fs.appendFileSync(process.env.RECEIPT, JSON.stringify({kind:'recovery', args}) + '\\n');
`)
    const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
    fs.writeFileSync(path.join(bin, 'cargo'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(bin, 'cargo.mjs'))} "$@"\n`, { mode: 0o755 })
    const result = spawnSync(process.execPath, ['--import', tsx, path.join(scripts, 'provider-crash-recovery-tests.ts')], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FRESHELL_SANDBOX_MODE: 'runtime-suite',
        RECEIPT: receipt, CONTRACT_EXIT: String(contractExit) },
    })
    const calls = fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
    return { ...result, calls }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

describe('Unix Rust recovery phase', () => {
  it('runs all existing recovery selectors and the controlled host contract', () => {
    const result = runFixture(0)
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls.filter((call: { kind: string }) => call.kind === 'recovery')).toHaveLength(6)
    expect(result.calls.filter((call: { kind: string }) => call.kind === 'contract')).toEqual([{ kind: 'contract', mode: 'runtime-suite' }])
  })

  it('propagates a failing controlled host contract', () => {
    const result = runFixture(41)
    expect(result.status, result.stderr).toBe(41)
    expect(result.calls.filter((call: { kind: string }) => call.kind === 'recovery')).toHaveLength(6)
  })
})
