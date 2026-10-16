import { describe, expect, it } from 'vitest'
import {
  phase2RuntimeImageBuildTag,
  selectDockerSocketPath,
} from '../../../../scripts/testing/runtime-sandbox.js'
import { selectPinnedRustCommand } from '../../../../scripts/testing/rust-toolchain.js'

describe('runtime test harness identities', () => {
  it('gives each phase-2 harness run its own stable Docker build tag', () => {
    const first = phase2RuntimeImageBuildTag('run-one')
    const second = phase2RuntimeImageBuildTag('run-two')

    expect(first).toMatch(/^freshell-managed-runtime:phase2-[a-f0-9]{32}$/)
    expect(phase2RuntimeImageBuildTag('run-one')).toBe(first)
    expect(second).not.toBe(first)
  })

  it('uses the configured Unix Docker socket when DOCKER_HOST is set', () => {
    expect(selectDockerSocketPath('unix:///run/user/1000/docker.sock', 'unix:///var/run/docker.sock'))
      .toBe('/run/user/1000/docker.sock')
  })

  it('uses the selected Docker context socket when DOCKER_HOST is unset', () => {
    expect(selectDockerSocketPath(undefined, 'unix:///var/run/docker.sock'))
      .toBe('/var/run/docker.sock')
  })

  it('rejects Docker endpoints the Unix socket broker cannot use', () => {
    expect(() => selectDockerSocketPath('tcp://127.0.0.1:2375', 'unix:///var/run/docker.sock'))
      .toThrow('Runtime parity tests require a Unix Docker socket')
  })

  it('uses mise with the pinned Rust version when it is installed', () => {
    expect(selectPinnedRustCommand('/home/test/.local/bin/mise', '/home/test/.cargo/bin/rustup')).toEqual({
      manager: 'mise',
      executable: '/home/test/.local/bin/mise',
      prefixArgs: ['exec', 'rust@1.96', '--'],
    })
  })

  it('runs the pinned Rust toolchain through rustup when mise is absent', () => {
    expect(selectPinnedRustCommand(undefined, '/home/test/.cargo/bin/rustup')).toEqual({
      manager: 'rustup',
      executable: '/home/test/.cargo/bin/rustup',
      prefixArgs: ['run', '1.96.0'],
    })
  })

  it('explains how to install the pinned toolchain when neither manager exists', () => {
    expect(() => selectPinnedRustCommand(undefined, undefined)).toThrow(
      'rustup toolchain install 1.96.0',
    )
  })
})
