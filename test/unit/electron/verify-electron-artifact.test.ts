import { describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  resolveArtifactPath,
  resolveDefaultArtifactPath,
  verifyElectronArtifact,
} from '../../../scripts/verify-electron-artifact.js'

const nativePlatform = process.platform as 'darwin' | 'linux' | 'win32'

function artifactRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'freshell-electron-artifact-'))
}

function writeArtifact(root: string, platform: 'darwin' | 'linux' | 'win32' = 'linux'): string {
  const binary = path.join(root, 'bin', platform === 'win32' ? 'freshell-server.exe' : 'freshell-server')
  mkdirSync(path.dirname(binary), { recursive: true })
  const magic = platform === 'win32'
    ? Buffer.from('MZ')
    : platform === 'darwin'
      ? Buffer.from([0xfe, 0xed, 0xfa, 0xcf])
      : Buffer.from([0x7f, 0x45, 0x4c, 0x46])
  writeFileSync(binary, Buffer.concat([magic, Buffer.alloc(32)]))
  chmodSync(binary, 0o755)
  mkdirSync(path.join(root, 'client'), { recursive: true })
  writeFileSync(path.join(root, 'client', 'index.html'), '<!doctype html>')
  mkdirSync(path.join(root, 'node', 'bin'), { recursive: true })
  writeFileSync(path.join(root, 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node'), 'node')
  mkdirSync(path.join(root, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })
  writeFileSync(path.join(root, 'claude-sidecar', 'index.mjs'), 'process.stdin.resume()')
  writeFileSync(path.join(root, 'claude-sidecar', 'package.json'), JSON.stringify({ name: 'freshell-claude-sidecar', version: '0.1.0' }))
  writeFileSync(path.join(root, 'claude-sidecar', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
  writeFileSync(path.join(root, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), '{}')
  mkdirSync(path.join(root, 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true })
  mkdirSync(path.join(root, 'mcp', 'node_modules', 'zod'), { recursive: true })
  writeFileSync(path.join(root, 'mcp', 'server.js'), 'process.stdin.resume()')
  writeFileSync(path.join(root, 'mcp', 'package.json'), JSON.stringify({ name: 'freshell', version: '0.7.5' }))
  writeFileSync(path.join(root, 'mcp', 'package-lock.json'), JSON.stringify({ name: 'freshell', version: '0.7.5', lockfileVersion: 3, packages: {} }))
  writeFileSync(path.join(root, 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}')
  writeFileSync(path.join(root, 'mcp', 'node_modules', 'zod', 'package.json'), '{}')
  mkdirSync(path.join(root, 'node-client-runtime'), { recursive: true })
  writeFileSync(path.join(root, 'node-client-runtime', 'keys.js'), 'export {}\n')
  writeFileSync(path.join(root, 'node-client-runtime', 'action-capabilities.js'), 'export {}\n')
  return binary
}

describe('verify-electron-artifact', () => {
  it('checks required files and runs the native probe in a sanitized empty cwd', () => {
    const root = artifactRoot()
    const binary = writeArtifact(root, nativePlatform)
    mkdirSync(path.join(root, 'client', 'assets'), { recursive: true })
    writeFileSync(path.join(root, 'client', 'assets', 'index-hash.js'), 'export {}\n')
    writeFileSync(path.join(root, '.electron-runtime-receipt.json'), '{}\n')
    const probe = vi.fn((command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => {
      expect(command).toBe(binary)
      expect(options.cwd).not.toBe(root)
      expect(options.env.AUTH_TOKEN).toBeUndefined()
      expect(Object.keys(options.env).some((key) => key.startsWith('FRESHELL_'))).toBe(false)
      expect(options.timeout).toBeGreaterThan(0)
      return { status: 1, stdout: '', stderr: 'AUTH_TOKEN is required. Refusing to start without authentication.\n' }
    })

    expect(verifyElectronArtifact(root, nativePlatform, { probe })).toMatchObject({ ok: true, platform: nativePlatform, executed: true })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('rejects every forbidden backend or native-module path', () => {
    const forbidden = ['dist/server/index.js', 'server-node-modules/index.js', 'bundled-node/bin/node', 'native-modules/pty.node', 'node_modules/node-pty/index.js']
    for (const relative of forbidden) {
      const root = artifactRoot()
      writeArtifact(root)
      const target = path.join(root, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, 'forbidden')
      expect(() => verifyElectronArtifact(root, 'linux', { probe: () => ({ status: 1, stdout: '', stderr: 'AUTH_TOKEN is required. Refusing to start without authentication.' }) })).toThrow(/forbidden/i)
    }
  })

  it('rejects unapproved runtime files even when they are not forbidden names', () => {
    const root = artifactRoot()
    writeArtifact(root)
    const extra = path.join(root, 'unapproved-runtime', 'server.js')
    mkdirSync(path.dirname(extra), { recursive: true })
    writeFileSync(extra, 'export {}\n')

    expect(() => verifyElectronArtifact(root, 'linux', {
      probe: () => ({ status: 1, stdout: '', stderr: 'AUTH_TOKEN is required. Refusing to start without authentication.' }),
    })).toThrow(/unapproved/i)
  })

  it('performs structural checks for a foreign platform without executing it', () => {
    const root = artifactRoot()
    const foreignPlatform = nativePlatform === 'win32' ? 'darwin' : 'win32'
    writeArtifact(root, foreignPlatform)
    const probe = () => { throw new Error('foreign binary must not execute locally') }
    expect(verifyElectronArtifact(root, foreignPlatform, { probe })).toMatchObject({ ok: true, executed: false })
  })

  it('does not require POSIX permission bits when inspecting a foreign artifact on Windows', () => {
    const root = artifactRoot()
    const binary = writeArtifact(root, 'linux')
    chmodSync(binary, 0o644)
    const probe = vi.fn(() => { throw new Error('foreign binary must not execute locally') })

    expect(verifyElectronArtifact(root, 'linux', { hostPlatform: 'win32', probe })).toMatchObject({ ok: true, executed: false })
    expect(probe).not.toHaveBeenCalled()
  })

  it('accepts the macOS icon and Windows NSIS helper in their resource roots', () => {
    const cases = [
      { platform: 'darwin' as const, file: 'icon.icns' },
      { platform: 'win32' as const, file: 'elevate.exe' },
    ]
    for (const { platform, file } of cases) {
      const root = artifactRoot()
      writeArtifact(root, platform)
      writeFileSync(path.join(root, file), 'electron-builder resource')
      expect(verifyElectronArtifact(root, platform, {
        hostPlatform: platform === nativePlatform ? 'linux' : nativePlatform,
        probe: () => { throw new Error('foreign binary must not execute locally') },
      })).toMatchObject({ ok: true, platform, executed: false })
    }
  })

  it('resolves the architecture-specific macOS release directory', () => {
    expect(resolveDefaultArtifactPath('darwin', 'x64')).toBe(
      path.join(process.cwd(), 'release', 'mac', 'Freshell.app', 'Contents', 'Resources'),
    )
    expect(resolveDefaultArtifactPath('darwin', 'arm64')).toBe(
      path.join(process.cwd(), 'release', 'mac-arm64', 'Freshell.app', 'Contents', 'Resources'),
    )
  })

  it('resolves architecture-specific Windows and Linux release directories', () => {
    expect(resolveDefaultArtifactPath('win32', 'x64')).toBe(
      path.join(process.cwd(), 'release', 'win-unpacked', 'resources'),
    )
    expect(resolveDefaultArtifactPath('win32', 'arm64')).toBe(
      path.join(process.cwd(), 'release', 'win-arm64-unpacked', 'resources'),
    )
    expect(resolveDefaultArtifactPath('linux', 'x64')).toBe(
      path.join(process.cwd(), 'release', 'linux-unpacked', 'resources'),
    )
    expect(resolveDefaultArtifactPath('linux', 'arm64')).toBe(
      path.join(process.cwd(), 'release', 'linux-arm64-unpacked', 'resources'),
    )
  })

  it('does not parse architecture when an explicit artifact path is provided', () => {
    const explicitPath = path.join(tmpdir(), 'prebuilt-electron-resources')

    expect(resolveArtifactPath(explicitPath, 'darwin', 'unsupported-host-architecture')).toBe(explicitPath)
  })

  it.each([
    { status: 0, stdout: 'listening', stderr: '' },
    { status: 1, stdout: '', stderr: 'unrelated startup failure' },
    { status: 1, stdout: 'listening on port 3001', stderr: 'AUTH_TOKEN is required. Refusing to start without authentication.' },
  ])('rejects an invalid native probe result: %j', (result) => {
    const root = artifactRoot()
    writeArtifact(root, nativePlatform)
    const probe = vi.fn(() => result)
    expect(() => verifyElectronArtifact(root, nativePlatform, { probe })).toThrow(/authentication|listen|exit with code/i)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
