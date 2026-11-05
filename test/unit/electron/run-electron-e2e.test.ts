import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clientArtifactContainsBuildId,
  electronE2eBuildEnvironment,
  electronE2eEnvironment,
  playwrightExitResult,
  resolveExactElectronE2eHead,
  rustArtifactName,
  rustArtifactPath,
} from '../../../scripts/run-electron-e2e.js'

const temporaryPaths: string[] = []

beforeEach(() => {
  vi.stubEnv('FRESHELL_BUILD_COMMIT', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true })
  }
})

describe('Electron E2E client preflight', () => {
  it('accepts only a client artifact containing the requested exact build id', () => {
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-electron-client-preflight-'))
    temporaryPaths.push(clientDir)
    const buildId = 'a'.repeat(40)
    fs.mkdirSync(path.join(clientDir, 'assets'))
    fs.writeFileSync(path.join(clientDir, 'assets', 'index.js'), `const build = '${buildId}'`)

    expect(clientArtifactContainsBuildId(clientDir, buildId)).toBe(true)
    expect(clientArtifactContainsBuildId(clientDir, 'b'.repeat(40))).toBe(false)
  })

  it('pins builds to checkout HEAD and rejects a conflicting inherited override', () => {
    const head = 'a'.repeat(40)
    expect(resolveExactElectronE2eHead('/repo', undefined, () => head, () => '')).toBe(head)
    expect(() => resolveExactElectronE2eHead('/repo', head, () => head, () => '')).toThrow(/rejects inherited FRESHELL_BUILD_COMMIT/i)
    expect(() => resolveExactElectronE2eHead('/repo', 'b'.repeat(40), () => head, () => '')).toThrow(/rejects inherited FRESHELL_BUILD_COMMIT/i)
    expect(() => resolveExactElectronE2eHead('/repo', undefined, () => head, () => ' M tracked.ts')).toThrow(/clean checkout/i)
    expect(() => resolveExactElectronE2eHead('/repo', undefined, () => head, () => '?? untracked.ts')).toThrow(/clean checkout/i)
    expect(resolveExactElectronE2eHead('/repo', undefined, () => head, () => '')).toBe(head)
  })

  it('rejects an ambient build pin through its default parameter even when it matches HEAD', () => {
    const head = 'a'.repeat(40)
    vi.stubEnv('FRESHELL_BUILD_COMMIT', head)

    expect(() => resolveExactElectronE2eHead('/repo', undefined, () => head, () => ''))
      .toThrow(/rejects inherited FRESHELL_BUILD_COMMIT/i)
  })

  it('preserves a Playwright child signal instead of collapsing it into exit 1', () => {
    expect(playwrightExitResult({ status: null, signal: 'SIGTERM' })).toBe('SIGTERM')
    expect(playwrightExitResult({ status: 2, signal: null })).toBe(2)
  })

  it('chooses the release Rust executable name for the target platform', () => {
    expect(rustArtifactName('linux')).toBe('freshell-server')
    expect(rustArtifactName('win32')).toBe('freshell-server.exe')
  })

  it('uses the host-native checkout path for the Electron E2E release artifact', () => {
    const repoRoot = path.join(path.parse(process.cwd()).root, 'repo')

    expect(rustArtifactPath(repoRoot, 'linux')).toBe(path.join(repoRoot, 'target', 'release', 'freshell-server'))
    expect(rustArtifactPath(repoRoot, 'win32')).toBe(path.join(repoRoot, 'target', 'release', 'freshell-server.exe'))
  })

  it('overrides a hostile inherited Rust binary path with the exact preflight artifact', () => {
    const env = electronE2eEnvironment(
      { FRESHELL_E2E_RUST_SERVER_BIN: '/other-worktree/target/release/freshell-server', KEEP_ME: 'yes' },
      'a'.repeat(40),
      '/repo/target/release/freshell-server',
    )
    expect(env).toMatchObject({
      FRESHELL_ELECTRON_E2E_BUILD_ID: 'a'.repeat(40),
      FRESHELL_E2E_RUST_SERVER_BIN: '/repo/target/release/freshell-server',
      KEEP_ME: 'yes',
    })
  })

  it('removes case-insensitive inherited Cargo artifact routing for the build and Electron child', () => {
    const inherited = {
      CARGO_TARGET_DIR: '/other-worktree/target',
      cargo_target_dir: '/other-worktree/lowercase-target',
      Cargo_Build_Target: 'aarch64-pc-windows-msvc',
      KEEP_ME: 'yes',
      CARGO_TARGET_DIR_EXTRA: 'must-not-be-removed',
    }
    expect(electronE2eBuildEnvironment(inherited, 'a'.repeat(40))).toEqual({
      FRESHELL_BUILD_COMMIT: 'a'.repeat(40),
      KEEP_ME: 'yes',
      CARGO_TARGET_DIR_EXTRA: 'must-not-be-removed',
    })
    expect(electronE2eEnvironment(
      inherited,
      'a'.repeat(40),
      '/repo/target/release/freshell-server',
    )).toEqual({
      FRESHELL_ELECTRON_E2E_BUILD_ID: 'a'.repeat(40),
      FRESHELL_E2E_RUST_SERVER_BIN: '/repo/target/release/freshell-server',
      KEEP_ME: 'yes',
      CARGO_TARGET_DIR_EXTRA: 'must-not-be-removed',
    })
  })
})
