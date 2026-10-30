import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProviderParityFixture } from './provider-parity-fixture.js'
import { runtimeCargoBuildAndCopy } from '../../../scripts/testing/runtime-cargo-artifacts.js'

const owned: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir(), 'parity-routing-'))
  owned.push(root)
  const bin = path.join(root, 'bin')
  const artifacts = path.join(root, 'artifacts')
  const observed = path.join(root, 'observed.json')
  const hostCargo = path.join(root, 'host-cargo.jsonl')
  const sandboxCalls = path.join(root, 'sandbox-calls.jsonl')
  fs.mkdirSync(bin)
  fs.mkdirSync(artifacts)
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true })
  fs.writeFileSync(path.join(bin, 'cargo'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), guest = process.env.PARITY_ROUTING_GUEST === '1';
if (!guest) fs.appendFileSync(${JSON.stringify(hostCargo)}, JSON.stringify(args) + '\\n');
if (args[0] === 'test') {
  fs.writeFileSync(path.join(process.env.FRESHELL_PROVIDER_PARITY_ROWS_DIR, 'controlled-row.json'), JSON.stringify({ route: guest ? 'sandbox' : 'host', mode: process.env.FRESHELL_SANDBOX_MODE }));
} else if (args[0] === 'build') {
  fs.mkdirSync('target/debug', { recursive: true });
  fs.writeFileSync('target/debug/freshell-session-host', 'host artifact', { mode: 0o755 });
} else process.exit(41);
`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'scripts/sandbox-test.sh'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
if (process.argv[2] !== '--runtime-suite') process.exit(42);
fs.appendFileSync(${JSON.stringify(sandboxCalls)}, 'entered\\n');
// Model the two existing bind-mount namespaces while executing the real
// helper payload against controlled Cargo, without running host Rust tests.
const script = process.argv[3].replaceAll('/freshell-test-artifacts/', ${JSON.stringify(`${artifacts}/`)}).replaceAll('/workspace/', ${JSON.stringify(`${root}/`)});
const result = cp.spawnSync('bash', ['-c', script], { stdio: 'inherit', env: { ...process.env, PARITY_ROUTING_GUEST: '1', FRESHELL_SANDBOX_MODE: 'runtime-suite' } });
process.exit(result.status ?? 43);
`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const directory = process.env.FRESHELL_PROVIDER_PARITY_ROWS_DIR;
const row = JSON.parse(fs.readFileSync(path.join(directory, 'controlled-row.json'), 'utf8'));
fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ row, directory }));
process.exit(73);
`)
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`)
  vi.stubEnv('FRESHELL_RUST_TEST_SANDBOX', '1')
  return { root, observed, hostCargo, sandboxCalls }
}

describe('provider parity fixture Rust routing', () => {
  it('keeps every Cargo selector behind the strict sandbox and hands its rows to the nested consumer', async () => {
    const f = fixture()
    await expect(runProviderParityFixture(f.root)).rejects.toThrow('failed (73)')
    const observed = JSON.parse(fs.readFileSync(f.observed, 'utf8'))
    expect(observed.row).toEqual({ route: 'sandbox', mode: 'runtime-suite' })
    expect(path.relative(path.join(f.root, 'dist'), observed.directory)).not.toMatch(/^\.\./)
    expect(fs.existsSync(observed.directory), 'the fixture settles its exact shared row directory').toBe(false)
    expect(fs.existsSync(f.hostCargo), 'a strict selector must never execute host Cargo').toBe(false)
    expect(fs.readFileSync(f.sandboxCalls, 'utf8').trim().split('\n')).toHaveLength(4)
  })

  it('keeps non-test artifact builds on their existing native build-and-copy route', () => {
    const f = fixture()
    const snapshot = path.join(f.root, 'owned-host-snapshot')
    runtimeCargoBuildAndCopy(f.root, 'cargo', ['build', '-p', 'freshell-session-host'], [{
      source: path.join(f.root, 'target/debug/freshell-session-host'), target: snapshot,
    }])
    expect(fs.readFileSync(snapshot, 'utf8')).toBe('host artifact')
    expect(JSON.parse(fs.readFileSync(f.hostCargo, 'utf8'))).toEqual(['build', '-p', 'freshell-session-host'])
    expect(fs.existsSync(f.sandboxCalls)).toBe(false)
  })
})
