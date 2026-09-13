import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

const roots: string[] = []

function scratchRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-oracle-build-'))
  roots.push(root)
  return root
}

function writeBinary(root: string): string {
  const bin = path.join(root, 'target', 'release', process.platform === 'win32' ? 'freshell-server.exe' : 'freshell-server')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, 'fixture binary')
  return bin
}

beforeEach(() => {
  vi.resetModules()
  vi.mocked(spawnSync).mockReset()
  vi.mocked(spawnSync).mockImplementation((_file, _args, options) => {
    writeBinary(String(options?.cwd))
    return { status: 0 } as ReturnType<typeof spawnSync>
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Rust oracle artifact freshness', () => {
  it('asks Cargo to validate an existing artifact against the locked checkout', async () => {
    const { ensureRustServerBuilt } = await import('../../../port/oracle/harness/external-server.js')
    const root = scratchRoot()
    const bin = writeBinary(root)
    expect(ensureRustServerBuilt(root)).toBe(bin)
    const [command, args, options] = vi.mocked(spawnSync).mock.calls[0]
    expect(command).toBe('cargo')
    expect(args).toEqual(['build', '--release', '-p', 'freshell-server', '--locked'])
    expect(options?.cwd).toBe(root)
  })

  it('reuses a verified artifact within one test process', async () => {
    const { ensureRustServerBuilt } = await import('../../../port/oracle/harness/external-server.js')
    const root = scratchRoot()
    const bin = ensureRustServerBuilt(root)
    expect(ensureRustServerBuilt(root)).toBe(bin)
    expect(spawnSync).toHaveBeenCalledTimes(1)
  })

  it('builds again if the verified artifact has been removed', async () => {
    const { ensureRustServerBuilt } = await import('../../../port/oracle/harness/external-server.js')
    const root = scratchRoot()
    const bin = ensureRustServerBuilt(root)
    fs.unlinkSync(bin)
    expect(ensureRustServerBuilt(root)).toBe(bin)
    expect(fs.existsSync(bin)).toBe(true)
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('does not reuse one worktree verification for another worktree', async () => {
    const { ensureRustServerBuilt } = await import('../../../port/oracle/harness/external-server.js')
    const first = scratchRoot()
    const second = scratchRoot()
    writeBinary(second)
    ensureRustServerBuilt(first)
    ensureRustServerBuilt(second)
    expect(spawnSync).toHaveBeenCalledTimes(2)
    expect(vi.mocked(spawnSync).mock.calls[1][2]?.cwd).toBe(second)
  })

  it('rejects a failed build even if an old artifact exists and permits retry', async () => {
    const { ensureRustServerBuilt } = await import('../../../port/oracle/harness/external-server.js')
    const root = scratchRoot()
    const bin = writeBinary(root)
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 101 } as ReturnType<typeof spawnSync>)
    expect(() => ensureRustServerBuilt(root)).toThrow(/exit 101/)
    expect(ensureRustServerBuilt(root)).toBe(bin)
    expect(spawnSync).toHaveBeenCalledTimes(2)
  })

  it('rejects a successful build that produced no executable', async () => {
    const { ensureRustServerBuilt } = await import('../../../port/oracle/harness/external-server.js')
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
    expect(() => ensureRustServerBuilt(scratchRoot())).toThrow(/still missing/)
  })

  it('resolves the native Windows executable name', async () => {
    const { rustServerBinPath } = await import('../../../port/oracle/harness/external-server.js')
    const root = scratchRoot()
    expect(rustServerBinPath(root, 'win32')).toBe(path.join(root, 'target', 'release', 'freshell-server.exe'))
    expect(rustServerBinPath(root, 'linux')).toBe(path.join(root, 'target', 'release', 'freshell-server'))
  })
})
