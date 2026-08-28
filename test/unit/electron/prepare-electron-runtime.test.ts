import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectProductionDependencyClosure,
  findUnapprovedRuntimePaths,
  getNodeDownloadUrl,
  getRuntimeBinaryName,
  getRuntimePaths,
  moduleDirectoryFromUrl,
  stageElectronRuntime,
} from '../../../scripts/prepare-electron-runtime.js'

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'freshell-electron-runtime-'))
}

function writeExecutable(filePath: string, contents = '#!/bin/sh\nexit 0\n'): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
  chmodSync(filePath, 0o755)
}

function createSourceFixture(root: string): {
  serverBinary: string
  clientDir: string
  nodeBinary: string
  claudeSidecarDir: string
  mcpDistDir: string
  nodeModulesDir: string
  packageLockPath: string
} {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'freshell', version: '0.7.5', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^4.0.0' } }))
  const serverBinary = path.join(root, 'target', 'release', 'freshell-server')
  const clientDir = path.join(root, 'dist', 'client')
  const nodeBinary = path.join(root, 'node-bin', 'node')
  const claudeSidecarDir = path.join(root, 'crates', 'freshell-claude-sidecar')
  const mcpDistDir = path.join(root, 'dist', 'tools')
  const nodeModulesDir = path.join(root, 'node_modules')

  writeExecutable(serverBinary)
  mkdirSync(clientDir, { recursive: true })
  writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Freshell</title>')
  writeExecutable(nodeBinary)
  mkdirSync(claudeSidecarDir, { recursive: true })
  writeFileSync(path.join(claudeSidecarDir, 'index.mjs'), 'process.stdin.resume()\n')
  writeFileSync(path.join(claudeSidecarDir, 'permission-channel.mjs'), 'export {}\n')
  writeFileSync(path.join(claudeSidecarDir, 'package.json'), JSON.stringify({ name: 'freshell-claude-sidecar', version: '0.1.0' }))
  writeFileSync(path.join(claudeSidecarDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }))
  mkdirSync(path.join(claudeSidecarDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })
  writeFileSync(path.join(claudeSidecarDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '1.0.0' }))

  mkdirSync(path.join(mcpDistDir, 'freshell-mcp'), { recursive: true })
  mkdirSync(path.join(mcpDistDir, 'node-client-runtime'), { recursive: true })
  writeFileSync(path.join(mcpDistDir, 'freshell-mcp', 'server.js'), 'import "@modelcontextprotocol/sdk/server/stdio.js"\n')
  writeFileSync(path.join(mcpDistDir, 'freshell-mcp', 'freshell-tool.js'), 'export const executeAction = () => ({})\n')
  writeFileSync(path.join(mcpDistDir, 'node-client-runtime', 'keys.js'), 'export {}\n')

  const packageLock = {
    name: 'freshell',
    version: '0.7.5',
    lockfileVersion: 3,
    packages: {
      '': { name: 'freshell', version: '0.7.5' },
      'node_modules/@modelcontextprotocol/sdk': { version: '1.0.0', dependencies: { zod: '^4.0.0', transitive: '^1.0.0' } },
      'node_modules/zod': { version: '4.0.0' },
      'node_modules/transitive': { version: '1.0.0', dependencies: { leaf: '^1.0.0' } },
      'node_modules/leaf': { version: '1.0.0' },
      'node_modules/unrelated': { version: '1.0.0' },
    },
  }
  const packageLockPath = path.join(root, 'package-lock.json')
  writeFileSync(packageLockPath, JSON.stringify(packageLock, null, 2))
  for (const [name, version] of [['@modelcontextprotocol/sdk', '1.0.0'], ['zod', '4.0.0'], ['transitive', '1.0.0'], ['leaf', '1.0.0'], ['unrelated', '1.0.0']]) {
    const packageDir = path.join(nodeModulesDir, name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }))
    writeFileSync(path.join(packageDir, 'index.js'), `export const version = ${JSON.stringify(version)}\n`)
  }

  return { serverBinary, clientDir, nodeBinary, claudeSidecarDir, mcpDistDir, nodeModulesDir, packageLockPath }
}

describe('prepare-electron-runtime staging', () => {
  it('plans the Rust app resources and keeps Node paths limited to sanctioned clients', () => {
    expect(getRuntimeBinaryName('linux')).toBe('freshell-server')
    expect(getRuntimeBinaryName('win32')).toBe('freshell-server.exe')
    expect(getRuntimePaths('/tmp/electron-runtime', 'win32')).toMatchObject({
      serverBinary: path.join('/tmp/electron-runtime', 'bin', 'freshell-server.exe'),
      clientDir: path.join('/tmp/electron-runtime', 'client'),
      nodeBinary: path.join('/tmp/electron-runtime', 'node', 'bin', 'node.exe'),
      claudeSidecarEntry: path.join('/tmp/electron-runtime', 'claude-sidecar', 'index.mjs'),
      mcpEntry: path.join('/tmp/electron-runtime', 'mcp', 'server.js'),
      nodeClientRuntimeDir: path.join('/tmp/electron-runtime', 'node-client-runtime'),
    })
  })

  it('uses platform-aware file URL conversion for Windows module paths', () => {
    expect(moduleDirectoryFromUrl(
      'file:///C:/repo/scripts/prepare-electron-runtime.ts',
      true,
    )).toBe('C:\\repo\\scripts')
  })

  it('allows the platform resources electron-builder puts beside the runtime', () => {
    expect(findUnapprovedRuntimePaths(['icon.icns'], 'darwin')).toEqual([])
    expect(findUnapprovedRuntimePaths(['elevate.exe'], 'win32')).toEqual([])
  })

  it('resolves the locked production closure without pulling unrelated packages', () => {
    const lock = {
      packages: {
        '': {},
        'node_modules/@modelcontextprotocol/sdk': { dependencies: { zod: '^4.0.0', transitive: '^1.0.0' } },
        'node_modules/zod': {},
        'node_modules/transitive': { dependencies: { leaf: '^1.0.0' } },
        'node_modules/leaf': {},
        'node_modules/unrelated': {},
      },
    }
    expect(collectProductionDependencyClosure(lock, ['@modelcontextprotocol/sdk', 'zod'])).toEqual([
      '@modelcontextprotocol/sdk',
      'leaf',
      'transitive',
      'zod',
    ])
  })

  it('stages only Rust, client, Node, Claude, and checkout-free MCP resources', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    const fixture = createSourceFixture(sourceRoot)

    const receipt = await stageElectronRuntime({
      rootDir: sourceRoot,
      runtimeDir: outputRoot,
      platform: 'linux',
      arch: 'x64',
      releaseVersion: '9.9.9',
      nodeVersion: '22.12.0',
      ...fixture,
    })

    expect(readFileSync(path.join(outputRoot, 'bin', 'freshell-server'), 'utf8')).toContain('exit 0')
    expect(readFileSync(path.join(outputRoot, 'client', 'index.html'), 'utf8')).toContain('Freshell')
    expect(readFileSync(path.join(outputRoot, 'node', 'bin', 'node'), 'utf8')).toContain('exit 0')
    expect(readFileSync(path.join(outputRoot, 'claude-sidecar', 'index.mjs'), 'utf8')).toContain('stdin')
    expect(readFileSync(path.join(outputRoot, 'mcp', 'server.js'), 'utf8')).toContain('modelcontextprotocol')
    expect(readFileSync(path.join(outputRoot, 'node-client-runtime', 'keys.js'), 'utf8')).toContain('export')
    expect(receipt).toMatchObject({ severity: 'info', event: 'electron_runtime_prepared' })
    expect(receipt.files).toEqual([...receipt.files].sort())
    expect(Object.keys(receipt.fileHashes)).toEqual(receipt.files)
    expect(receipt.fileHashes['bin/freshell-server']).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(path.join(outputRoot, '.electron-runtime-receipt.json'), 'utf8'))).toMatchObject({
      severity: 'info',
      event: 'electron_runtime_prepared',
      fileHashes: receipt.fileHashes,
    })
    expect(JSON.parse(readFileSync(path.join(outputRoot, 'mcp', 'package.json'), 'utf8'))).toMatchObject({ name: 'freshell', version: '9.9.9' })
    expect(readFileSync(path.join(outputRoot, 'mcp', 'node_modules', 'leaf', 'index.js'), 'utf8')).toContain('1.0.0')
    expect(() => readFileSync(path.join(outputRoot, 'dist', 'server', 'index.js'))).toThrow()
    expect(() => readFileSync(path.join(outputRoot, 'server-node-modules', 'index.js'))).toThrow()
    expect(() => readFileSync(path.join(outputRoot, 'node-pty', 'index.js'))).toThrow()
  })

  it('ensures staged POSIX binaries are executable even when inputs are not', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    const fixture = createSourceFixture(sourceRoot)
    chmodSync(fixture.serverBinary, 0o644)
    chmodSync(fixture.nodeBinary, 0o644)

    await stageElectronRuntime({
      rootDir: sourceRoot,
      runtimeDir: outputRoot,
      platform: 'linux',
      arch: 'x64',
      releaseVersion: '9.9.9',
      nodeVersion: '22.12.0',
      ...fixture,
    })

    expect(statSync(path.join(outputRoot, 'bin', 'freshell-server')).mode & 0o111).not.toBe(0)
    expect(statSync(path.join(outputRoot, 'node', 'bin', 'node')).mode & 0o111).not.toBe(0)
  })

  it('uses the locked Node archive URL for each supported target', () => {
    expect(getNodeDownloadUrl('22.12.0', 'linux', 'x64')).toBe('https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz')
    expect(getNodeDownloadUrl('22.12.0', 'darwin', 'arm64')).toBe('https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz')
    expect(getNodeDownloadUrl('22.12.0', 'win32', 'x64')).toBe('https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip')
  })
})
