import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRustServerBin, rustServerBinSha256 } from './rust-server.js'

describe('resolveRustServerBin (fail-closed override, :2015)', () => {
  const buildHead = () => '/BUILT/head/freshell-server' // sentinel: never used on the override paths
  it('aborts nonzero-equivalent (throws) when the override path is MISSING', () => {
    expect(() => resolveRustServerBin(
      { FRESHELL_E2E_RUST_SERVER_BIN: '/no/such/binary' }, buildHead)).toThrow(/does not exist/)
  })
  it('THROWS when the override is a non-executable file', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'bin')
    fs.writeFileSync(f, 'not exec', { mode: 0o644 })
    expect(() => resolveRustServerBin({ FRESHELL_E2E_RUST_SERVER_BIN: f }, buildHead))
      .toThrow(/not executable/)
  })
  it('SELECTS the override (never buildHead) for a valid executable + exposes its sha', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'server')
    fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const r = resolveRustServerBin({ FRESHELL_E2E_RUST_SERVER_BIN: f }, buildHead)
    expect(r).toEqual({ bin: f, source: 'override' })
    expect(rustServerBinSha256(f)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('resolves a slashless override once so validation and spawn select the same file', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-relative-'))
    const f = path.join(cwd, 'historical-server')
    fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const r = resolveRustServerBin(
      { FRESHELL_E2E_RUST_SERVER_BIN: 'historical-server' },
      buildHead,
      cwd,
    )
    expect(r).toEqual({ bin: f, source: 'override' })
    expect(path.isAbsolute(r.bin)).toBe(true)
    expect(rustServerBinSha256(r.bin)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('falls back to the built HEAD binary when the override is UNSET', () => {
    expect(resolveRustServerBin({}, buildHead)).toEqual({ bin: '/BUILT/head/freshell-server', source: 'built' })
  })
})
