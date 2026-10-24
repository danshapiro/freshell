// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixture } from './run-rust-tests-fixture.js'

describe('Rust test launcher children', () => {
  it('executes CommonJS fixtures without inheriting the checkout module format', () => {
    const f = fixture()
    try {
      const marker = path.join(f.root, 'executed')
      const result = f.run({ FRESHELL_RUST_TEST_SANDBOX: '1', COMMONJS_PROBE: marker })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(marker, 'utf8')).toBe('executed')
    } finally { f.cleanup() }
  })
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

  it.each(['relative target with spaces', '/absolute'])('executes the server built in the effective native Cargo target directory (%s)', target => {
    const f = fixture()
    try {
      const targetDirectory = target === '/absolute' ? path.join(f.root, 'absolute target') : target
      const result = f.run({ CARGO_TARGET_DIR: targetDirectory })
      expect(result.status, result.stderr).toBe(0)
      const effectiveTarget = path.resolve(f.root, targetDirectory)
      expect(result.events.map(e => e.target)).toEqual([effectiveTarget, effectiveTarget])
      expect(result.events[1].binary).toBe(path.join(effectiveTarget, 'debug/freshell-server'))
    } finally { f.cleanup() }
  })

  it('keeps a stable sandbox Cargo namespace per host worktree and replaces a host target override', () => {
    const first = fixture()
    const second = fixture()
    try {
      const one = first.run({ FRESHELL_RUST_TEST_SANDBOX: '1', CARGO_TARGET_DIR: '/host/foreign-target' })
      const repeated = first.run({ FRESHELL_RUST_TEST_SANDBOX: '1' })
      const other = second.run({ FRESHELL_RUST_TEST_SANDBOX: '1' })
      for (const result of [one, repeated, other]) expect(result.status, result.stderr).toBe(0)
      const target = one.events[1].target
      expect(path.dirname(target)).toBe(path.join(first.artifacts, 'targets'))
      expect(repeated.events[4].target).toBe(target)
      expect(path.basename(other.events[1].target)).not.toBe(path.basename(target))
      expect(one.events[0].ownerGuard).toBe('1')
      expect(one.events[1]).toMatchObject({ jobs: '3', testThreads: '4', tokioThreads: '2' })
    } finally { first.cleanup(); second.cleanup() }
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
      expect(result.events[2].binary).toBe(path.join(result.events[1].target, 'debug/freshell-server'))
      expect(existsSync(result.events[2].tmp)).toBe(false)
      expect(existsSync(result.events[2].executableTmp)).toBe(false)
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
      expect(existsSync(result.events[2].executableTmp)).toBe(false)
    } finally { f.cleanup() }
  })
})
