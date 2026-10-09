// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const tsx = require.resolve('tsx')
const launcher = path.resolve('scripts/testing/run-rust-tests.ts')

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rust-launcher-'))
  mkdirSync(path.join(root, 'scripts/testing'), { recursive: true })
  mkdirSync(path.join(root, 'target'))
  mkdirSync(path.join(root, 'bin'))
  copyFileSync(launcher, path.join(root, 'scripts/testing/run-rust-tests.ts'))
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir')
  const receipt = path.join(root, 'receipt.jsonl')
  const executable = (file: string, body: string) => {
    writeFileSync(`${file}.mjs`, body)
    const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`
    writeFileSync(file, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(`${file}.mjs`)} "$@"\n`)
    chmodSync(file, 0o755)
  }
  executable(path.join(root, 'bin/cargo'), `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.RECEIPT, JSON.stringify({kind:'cargo', args,
      binary:process.env.FRESHELL_SERVER_BIN, route:process.env.FRESHELL_RUST_TEST_SANDBOX, jobs:process.env.CARGO_BUILD_JOBS,
      tmp:process.env.TMPDIR, executableTmp:process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR})+'\\n');
    process.exit(Number(args[0]==='build' ? process.env.BUILD_EXIT || 0 : process.env.TEST_EXIT || 0));
  `)
  executable(path.join(root, 'scripts/sandbox-test.sh'), `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.RECEIPT, JSON.stringify({kind:'sandbox', args})+'\\n');
    if (process.env.SANDBOX_EXIT) process.exit(Number(process.env.SANDBOX_EXIT));
    const command = args[1]
      .replace('mktemp -d /workspace/target/', 'mktemp -d ' + ${JSON.stringify(root)} + '/target/')
      .replace('node --import tsx /workspace/scripts/testing/run-rust-tests.ts', 'node --import tsx ' + ${JSON.stringify(root)} + '/scripts/testing/run-rust-tests.ts');
    const result = cp.spawnSync('bash', ['-c', command], {env:process.env, stdio:'inherit'});
    process.exit(result.status ?? 1);
  `)
  return {
    root,
    run(env: NodeJS.ProcessEnv = {}, args: string[] = []) {
      const result = spawnSync(process.execPath, ['--import', tsx, path.join(root, 'scripts/testing/run-rust-tests.ts'), ...args], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RECEIPT: receipt,
          FRESHELL_RUST_TEST_SANDBOX: '0', FRESHELL_SERVER_BIN: '/host/stale-server', ...env },
        encoding: 'utf8', timeout: 15_000,
      })
      const events = existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
      return { ...result, events }
    },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}

describe('Rust test launcher children', () => {
  it('builds before testing and selects the current checkout binary with disabled routing', () => {
    const f = fixture()
    try {
      const result = f.run({ CARGO_BUILD_JOBS: '7' })
      expect(result.status, result.stderr).toBe(0)
      expect(result.events.map(e => e.args)).toEqual([
        ['build', '-p', 'freshell-server', '--locked'], ['test', '--workspace', '--locked'],
      ])
      expect(result.events[1].binary).toBe(path.join(f.root, 'target/debug/freshell-server'))
      expect(result.events[1].jobs).toBe('7')
    } finally { f.cleanup() }
  })

  it('preserves build failure and does not launch tests', () => {
    const f = fixture()
    try {
      const result = f.run({ BUILD_EXIT: '23' })
      expect(result.status).toBe(23)
      expect(result.events.map(e => e.args[0])).toEqual(['build'])
    } finally { f.cleanup() }
  })

  it('requires exact opt-in rather than cloud settings or truthy values', () => {
    const f = fixture()
    try {
      const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: 'true', FRESHELL_VITEST_BACKEND: 'cloud' })
      expect(result.status).toBe(0)
      expect(result.events.map(e => e.kind)).toEqual(['cargo', 'cargo'])
    } finally { f.cleanup() }
  })

  it('routes first to strict sandbox, disables recursion, owns executable temp and preserves arguments', () => {
    const f = fixture()
    try {
      const args = ['--', 'filter with space', "quote'word", '$(touch SHOULD_NOT_EXIST)', 'a;echo nope', '', '/workspace/target/argument', 'line\nbreak', 'unicode-🚀', '--nocapture']
      const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1' }, args)
      expect(result.status, result.stderr).toBe(0)
      expect(result.events.map(e => e.kind)).toEqual(['sandbox', 'cargo', 'cargo'])
      expect(result.events[0].args[0]).toBe('--runtime-suite')
      expect(result.events[1].route).toBe('0')
      expect(result.events[1].jobs).toBe('3')
      expect(result.events[2].args).toEqual(['test', '--workspace', '--locked', ...args.slice(1)])
      expect(result.events[2].binary).toBe(path.join(f.root, 'target/debug/freshell-server'))
      expect(result.events[2].tmp).toBe(result.events[2].executableTmp)
      expect(result.events[2].tmp).toMatch(new RegExp(`^${f.root}/target/\\.freshell-rust-tests-[^/]+$`))
      expect(existsSync(result.events[2].tmp)).toBe(false)
    } finally { f.cleanup() }
  })

  it.each([17, 125, 143])('fails closed on sandbox failure %s without host Cargo', code => {
    const f = fixture()
    try {
      const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', SANDBOX_EXIT: String(code) })
      expect(result.status).toBe(code)
      expect(result.events.map(e => e.kind)).toEqual(['sandbox'])
    } finally { f.cleanup() }
  })

  it('cleans only its temporary directory while preserving inner failure', () => {
    const f = fixture()
    try {
      const sentinel = path.join(f.root, 'target/preexisting')
      writeFileSync(sentinel, 'keep')
      const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', TEST_EXIT: '31' })
      expect(result.status).toBe(31)
      expect(readFileSync(sentinel, 'utf8')).toBe('keep')
      expect(result.events[2].tmp).toBeTruthy()
      expect(existsSync(result.events[2].tmp)).toBe(false)
    } finally { f.cleanup() }
  })
})
