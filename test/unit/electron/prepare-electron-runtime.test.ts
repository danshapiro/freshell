import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) }
})

import {
  RUNTIME_LAYOUT,
  buildDeployArgs,
  extractNodeArchive,
  findUnapprovedRuntimePaths,
  getRuntimeAllowlist,
  getNodeBinaryName,
  getNodeDownloadUrl,
  getRuntimeBinaryName,
  getRuntimePaths,
  moduleDirectoryFromUrl,
  stageElectronRuntime,
  type DeployRuntimeArgs,
} from '../../../scripts/prepare-electron-runtime.js'

function nativePlatform(): 'darwin' | 'linux' | 'win32' {
  return process.platform as 'darwin' | 'linux' | 'win32'
}

function nativeArch(): 'x64' | 'arm64' {
  return process.arch as 'x64' | 'arm64'
}

function temporaryRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'freshell-electron-runtime-'))
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(members: Array<{ name: string; bytes: Buffer }>): Buffer {
  const localRecords: Buffer[] = []
  const directoryRecords: Buffer[] = []
  let offset = 0
  for (const { name, bytes } of members) {
    const fileName = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32(bytes), 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(fileName.length, 26)
    localRecords.push(local, fileName, bytes)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(crc32(bytes), 16)
    directory.writeUInt32LE(bytes.length, 20)
    directory.writeUInt32LE(bytes.length, 24)
    directory.writeUInt16LE(fileName.length, 28)
    directory.writeUInt32LE(offset, 42)
    directoryRecords.push(directory, fileName)
    offset += local.length + fileName.length + bytes.length
  }
  const directorySize = directoryRecords.reduce((total, record) => total + record.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(members.length, 8)
  end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localRecords, ...directoryRecords, end])
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
  mcpDistDir: string
} {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'freshell',
    version: '0.7.5',
    packageManager: 'pnpm@10.34.5',
  }))
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '10.0'\n")
  writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - crates/*\n  - packages/*\n')
  const packagingDir = path.join(root, 'packages', 'freshell-mcp-runtime')
  mkdirSync(packagingDir, { recursive: true })
  writeFileSync(path.join(packagingDir, 'package.json'), JSON.stringify({
    name: 'freshell-mcp-runtime',
    version: '0.1.0',
    private: true,
    type: 'module',
    dependencies: {
      '@modelcontextprotocol/sdk': '1.30.0',
      zod: '4.3.6',
    },
    files: ['generated'],
  }))
  const sidecarDir = path.join(root, 'crates', 'freshell-claude-sidecar')
  mkdirSync(sidecarDir, { recursive: true })
  writeFileSync(path.join(sidecarDir, 'package.json'), JSON.stringify({
    name: 'freshell-claude-sidecar',
    version: '0.1.0',
    type: 'module',
  }))

  const serverBinary = path.join(root, 'target', 'release', 'freshell-server')
  const clientDir = path.join(root, 'dist', 'client')
  const nodeBinary = path.join(root, 'node-bin', 'node')
  const mcpDistDir = path.join(root, 'dist', 'tools')

  writeExecutable(serverBinary)
  mkdirSync(clientDir, { recursive: true })
  writeFileSync(path.join(clientDir, 'index.html'), '<!doctype html><title>Freshell</title>')
  writeExecutable(nodeBinary)
  mkdirSync(path.join(mcpDistDir, 'freshell-mcp'), { recursive: true })
  mkdirSync(path.join(mcpDistDir, 'node-client-runtime'), { recursive: true })
  writeFileSync(path.join(mcpDistDir, 'freshell-mcp', 'server.js'), 'import "@modelcontextprotocol/sdk/server/stdio.js"\n')
  writeFileSync(path.join(mcpDistDir, 'freshell-mcp', 'freshell-tool.js'), 'export const executeAction = () => ({})\n')
  writeFileSync(path.join(mcpDistDir, 'node-client-runtime', 'keys.js'), 'export const keys = 1\n')
  writeFileSync(path.join(mcpDistDir, 'node-client-runtime', 'action-capabilities.js'), 'export const caps = 2\n')

  return { serverBinary, clientDir, nodeBinary, mcpDistDir }
}

function writeBinShim(root: string, packageDir: string, binName: string, binRelative: string): void {
  // Hoisted deploys emit relative .bin shims; everything else is ordinary files.
  writeExecutable(path.join(root, 'node_modules', packageDir, binRelative), '#!/usr/bin/env node\nconsole.log("shim")\n')
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  symlinkSync(path.join('..', packageDir, binRelative), path.join(root, 'node_modules', '.bin', binName))
}

function sidecarDeployFixture(destination: string): void {
  writeFileSync(path.join(destination, 'index.mjs'), [
    "import { configureSession } from './session-settings.mjs'",
    "import { probeModelCatalog } from './model-catalog.mjs'",
    "console.log(JSON.stringify({ configureSession: typeof configureSession, probeModelCatalog: typeof probeModelCatalog }))",
  ].join('\n') + '\n')
  writeFileSync(path.join(destination, 'permission-channel.mjs'), 'export {}\n')
  writeFileSync(path.join(destination, 'session-settings.mjs'), 'export const configureSession = () => ({ staged: true })\n')
  writeFileSync(path.join(destination, 'model-catalog.mjs'), 'export const probeModelCatalog = () => [{ value: "staged-model" }]\n')
  // Unified agent names (Task 3): the standalone session-names helper —
  // one JSON line in, one structured line out. Executed below against a
  // staged fake SDK to prove the staged copy RUNS, not just copies.
  writeFileSync(path.join(destination, 'session-names.mjs'), [
    "const sdk = await import(process.env.FRESHELL_CLAUDE_SDK_SESSION_NAMES_MODULE)",
    "const { getSessionInfo } = sdk",
    "import { createInterface } from 'node:readline'",
    "const lines = createInterface({ input: process.stdin })",
    "lines.once('line', async (line) => {",
    "  const request = JSON.parse(line)",
    "  const info = await getSessionInfo(request.sessionId, { dir: request.dir })",
    "  process.stdout.write(JSON.stringify({ ok: true, op: request.op, staged: info.summary }) + '\\n')",
    "  process.exit(0)",
    "})",
  ].join('\n') + '\n')
  writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name: 'freshell-claude-sidecar', version: '0.1.0', type: 'module' }))
  writeFileSync(path.join(destination, 'pnpm-lock.yaml'), "lockfileVersion: '10.0'\n")
  const sdkDir = path.join(destination, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.237' }))
  writeBinShim(destination, 'which', 'node-which', 'bin/node-which')
  mkdirSync(path.join(destination, 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(path.join(destination, 'node_modules', '.pnpm', 'lock.yaml'), 'inert pnpm install state\n')
}

function mcpDeployFixture(destination: string, generatedSource: string): void {
  writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
    name: 'freshell-mcp-runtime',
    version: '0.1.0',
    private: true,
    type: 'module',
    dependencies: {
      // pnpm's deploy annotates peer resolutions in the exported manifest.
      '@modelcontextprotocol/sdk': '1.30.0(zod@4.3.6)',
      zod: '4.3.6',
    },
    files: ['generated'],
  }))
  writeFileSync(path.join(destination, 'pnpm-lock.yaml'), "lockfileVersion: '10.0'\n")
  const generatedDir = path.join(destination, 'generated')
  mkdirSync(generatedDir, { recursive: true })
  for (const name of ['freshell-mcp', 'node-client-runtime']) {
    const source = path.join(generatedSource, name)
    for (const entry of readdirSync(source)) {
      const from = path.join(source, entry)
      const to = path.join(generatedDir, name, entry)
      mkdirSync(path.dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(from))
    }
  }
  const sdkDir = path.join(destination, 'node_modules', '@modelcontextprotocol', 'sdk')
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/sdk', version: '1.30.0' }))
  const zodDir = path.join(destination, 'node_modules', 'zod')
  mkdirSync(zodDir, { recursive: true })
  writeFileSync(path.join(zodDir, 'package.json'), JSON.stringify({ name: 'zod', version: '4.3.6' }))
  writeBinShim(destination, 'which', 'node-which', 'bin/node-which')
  mkdirSync(path.join(destination, 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(path.join(destination, 'node_modules', '.pnpm', 'lock.yaml'), 'inert pnpm install state\n')
}

function createRecordingDeploySeam(root: string): { calls: DeployRuntimeArgs[]; deployRuntime: (args: DeployRuntimeArgs) => void } {
  const calls: DeployRuntimeArgs[] = []
  const deployRuntime = (args: DeployRuntimeArgs): void => {
    calls.push(args)
    if (args.packageName === 'freshell-claude-sidecar') {
      sidecarDeployFixture(args.destination)
      return
    }
    mcpDeployFixture(args.destination, path.join(root, 'packages', 'freshell-mcp-runtime', 'generated'))
  }
  return { calls, deployRuntime }
}

function collectFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (lstatSync(absolute).isDirectory()) walk(absolute, relative)
      else files.push(relative)
    }
  }
  walk(root, '')
  return files.sort()
}

function collectLinks(root: string): string[] {
  const links: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) links.push(absolute)
      else if (stats.isDirectory()) walk(absolute)
    }
  }
  walk(root)
  return links.sort()
}

function stageFixture(root: string, runtimeDir: string, extra: { deployRuntime?: (args: DeployRuntimeArgs) => void } = {}) {
  const fixture = createSourceFixture(root)
  return stageElectronRuntime({
    rootDir: root,
    runtimeDir,
    platform: nativePlatform(),
    arch: nativeArch(),
    releaseVersion: '9.9.9',
    nodeVersion: '22.12.0',
    packageManagerVersion: '10.34.5',
    ...fixture,
    ...extra,
  })
}

describe('prepare-electron-runtime staging', () => {
  it('extracts only the expected Windows Node executable from a ZIP archive', async () => {
    const root = temporaryRoot()
    try {
      const archive = path.join(root, 'node.zip')
      const destination = path.join(root, 'staged', 'node.exe')
      const nodeBytes = Buffer.from('synthetic Windows Node executable')
      writeFileSync(archive, storedZip([
        { name: 'node-v22.12.0-win-x64/README.md', bytes: Buffer.from('not an executable') },
        { name: 'node-v22.12.0-win-x64/node.exe', bytes: nodeBytes },
      ]))

      await extractNodeArchive('22.12.0', 'win32', 'x64', archive, destination)

      expect(readFileSync(destination)).toEqual(nodeBytes)
      expect(readdirSync(path.dirname(destination))).toEqual(['node.exe'])
      expect(readdirSync(root)).toEqual(['node.zip', 'staged'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('plans the Rust app resources and keeps Node paths limited to sanctioned clients', () => {
    const runtimeRoot = path.resolve('/tmp/electron-runtime')
    expect(getRuntimeBinaryName('linux')).toBe('freshell-server')
    expect(getRuntimeBinaryName('win32')).toBe('freshell-server.exe')
    expect(getRuntimePaths(runtimeRoot, 'win32')).toMatchObject({
      serverBinary: path.join(runtimeRoot, 'bin', 'freshell-server.exe'),
      clientDir: path.join(runtimeRoot, 'client'),
      nodeBinary: path.join(runtimeRoot, 'node', 'bin', 'node.exe'),
      claudeSidecarEntry: path.join(runtimeRoot, 'claude-sidecar', 'index.mjs'),
      mcpEntry: path.join(runtimeRoot, 'mcp', 'server.js'),
      nodeClientRuntimeDir: path.join(runtimeRoot, 'node-client-runtime'),
    })
  })

  it('uses platform-aware file URL conversion for Windows module paths', () => {
    expect(moduleDirectoryFromUrl(
      'file:///C:/repo/scripts/prepare-electron-runtime.ts',
      true,
    )).toBe('C:\\repo\\scripts')
  })

  it('keeps POSIX path semantics when a POSIX file URL is requested on another host', () => {
    expect(moduleDirectoryFromUrl(
      'file:///C:/repo/scripts/prepare-electron-runtime.ts',
      false,
    )).toBe('/C:/repo/scripts')
  })

  it('allows the platform resources electron-builder puts beside the runtime', () => {
    expect(findUnapprovedRuntimePaths(['icon.icns'], 'darwin')).toEqual([])
    expect(findUnapprovedRuntimePaths(['elevate.exe'], 'win32')).toEqual([])
  })

  it('requires no lock files in the staged runtime layout', () => {
    expect(Object.keys(RUNTIME_LAYOUT).filter((key) => /lock/i.test(key))).toEqual([])
    const allowlist = getRuntimeAllowlist('linux')
    expect(allowlist.requiredFiles.filter((file) => /lock/i.test(file))).toEqual([])
    expect(allowlist.requiredFiles).toContain('claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json')
    expect(allowlist.requiredFiles).toContain('mcp/node_modules/@modelcontextprotocol/sdk/package.json')
    // A stray lock inside a recursive runtime directory is not an allowlist violation.
    expect(findUnapprovedRuntimePaths(['claude-sidecar/package-lock.json'], 'linux')).toEqual([])
  })

  it('builds the exact filtered production deploy argv for both runtime packages', () => {
    expect(buildDeployArgs('freshell-claude-sidecar', '/tmp/sidecar-out')).toEqual([
      '--filter', 'freshell-claude-sidecar', '--prod', '--config.node-linker=hoisted', 'deploy', '/tmp/sidecar-out',
    ])
    expect(buildDeployArgs('freshell-mcp-runtime', '/tmp/mcp-out')).toEqual([
      '--filter', 'freshell-mcp-runtime', '--prod', '--config.node-linker=hoisted', 'deploy', '/tmp/mcp-out',
    ])
    for (const args of [
      buildDeployArgs('freshell-claude-sidecar', '/tmp/sidecar-out'),
      buildDeployArgs('freshell-mcp-runtime', '/tmp/mcp-out'),
    ]) {
      expect(args).not.toContain('--')
      expect(args).not.toContain('--legacy')
      expect(args).not.toContain('--frozen-lockfile')
    }
  })

  it('stages the portable runtime from pnpm deploy exports', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    createSourceFixture(sourceRoot)
    const { calls, deployRuntime } = createRecordingDeploySeam(sourceRoot)

    const receipt = await stageFixture(sourceRoot, outputRoot, { deployRuntime })
    const serverName = getRuntimeBinaryName(nativePlatform())
    const nodeName = getNodeBinaryName(nativePlatform())

    expect(calls.map((call) => call.packageName)).toEqual(['freshell-claude-sidecar', 'freshell-mcp-runtime'])
    expect(calls.map((call) => call.destination)).toEqual(calls.map((call) => path.resolve(call.destination)))

    expect(readFileSync(path.join(outputRoot, 'bin', serverName), 'utf8')).toContain('exit 0')
    expect(readFileSync(path.join(outputRoot, 'client', 'index.html'), 'utf8')).toContain('Freshell')
    expect(readFileSync(path.join(outputRoot, 'node', 'bin', nodeName), 'utf8')).toContain('exit 0')
    expect(JSON.parse(execFileSync('node', [path.join(outputRoot, 'claude-sidecar', 'index.mjs')], { encoding: 'utf8' }))).toEqual({
      configureSession: 'function',
      probeModelCatalog: 'function',
    })
    expect(readFileSync(path.join(outputRoot, 'claude-sidecar', 'session-settings.mjs'), 'utf8')).toContain('staged')
    expect(readFileSync(path.join(outputRoot, 'claude-sidecar', 'model-catalog.mjs'), 'utf8')).toContain('staged-model')
    expect(receipt.files).toEqual(expect.arrayContaining([
      'claude-sidecar/session-settings.mjs',
      'claude-sidecar/session-names.mjs',
      'claude-sidecar/model-catalog.mjs',
    ]))
    // Unified agent names (Task 3): the staged session-names helper EXECUTES
    // from the staged runtime — one JSON line in, one structured line out,
    // with the staged SDK boundary injected. (The fixture's fake SDK lives
    // outside the required-file list's exhaustive naming only through the
    // claude-sidecar recursive directory, which the allowlist already
    // admits.)
    // The staged helper's SDK boundary is injected from a test-local fake
    // module written INTO the staged runtime (the production copy list stays
    // exactly the sidecar's real files).
    const stagedFakeSdk = path.join(outputRoot, 'node-client-runtime', '.staged-session-names-sdk.mjs')
    writeFileSync(stagedFakeSdk, [
      'export async function getSessionInfo(sessionId, options) {',
      "  return { sessionId, summary: 'staged helper ran', customTitle: null }",
      '}',
    ].join('\n') + '\n')
    const stagedHelper = execFileSync('node', [path.join(outputRoot, 'claude-sidecar', 'session-names.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FRESHELL_CLAUDE_SDK_SESSION_NAMES_MODULE: pathToFileURL(stagedFakeSdk).href,
      },
      input: JSON.stringify({ op: 'read', sessionId: 'staged-session', dir: '/work/project' }) + '\n',
    })
    expect(JSON.parse(stagedHelper)).toEqual({ ok: true, op: 'read', staged: 'staged helper ran' })
    expect(readFileSync(path.join(outputRoot, 'mcp', 'server.js'), 'utf8')).toContain('modelcontextprotocol')
    expect(readFileSync(path.join(outputRoot, 'node-client-runtime', 'keys.js'), 'utf8')).toContain('export')

    const stagedManifest = JSON.parse(readFileSync(path.join(outputRoot, 'mcp', 'package.json'), 'utf8'))
    expect(stagedManifest).toEqual({
      name: 'freshell',
      version: '9.9.9',
      private: true,
      type: 'module',
      dependencies: {
        '@modelcontextprotocol/sdk': '1.30.0',
        zod: '4.3.6',
      },
    })

    const stagedFiles = collectFiles(outputRoot)
    expect(stagedFiles.filter((file) =>
      file.endsWith('package-lock.json') || file.endsWith('pnpm-lock.yaml') || file.includes('/.pnpm/'))).toEqual([])
    expect(stagedFiles.some((file) => file.includes('.pnpm'))).toBe(false)
    expect(collectLinks(outputRoot)).toEqual([])
    expect(lstatSync(path.join(outputRoot, 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk')).isSymbolicLink()).toBe(false)
    expect(lstatSync(path.join(outputRoot, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(outputRoot, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).toContain('0.3.237')

    expect(receipt).toMatchObject({ severity: 'info', event: 'electron_runtime_prepared' })
    expect(receipt.files).toEqual([...receipt.files].sort())
    expect(Object.keys(receipt.fileHashes)).toEqual(receipt.files)
    expect(receipt.fileHashes[`bin/${serverName}`]).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.packageManager).toEqual({ name: 'pnpm', version: '10.34.5' })
    const expectedFingerprint = createHash('sha256')
      .update(readFileSync(path.join(sourceRoot, 'pnpm-lock.yaml')))
      .digest('hex')
    expect(receipt.sourceLockFingerprint).toBe(expectedFingerprint)
    expect(receipt.exportedPackages).toEqual([
      { name: 'freshell-claude-sidecar', version: '0.1.0' },
      { name: 'freshell-mcp-runtime', version: '0.1.0' },
      { name: 'freshell', version: '9.9.9' },
    ])
    expect(JSON.parse(readFileSync(path.join(outputRoot, '.electron-runtime-receipt.json'), 'utf8'))).toMatchObject({
      severity: 'info',
      event: 'electron_runtime_prepared',
      packageManager: { name: 'pnpm', version: '10.34.5' },
      fileHashes: receipt.fileHashes,
    })
    expect(() => readFileSync(path.join(outputRoot, 'dist', 'server', 'index.js'))).toThrow()
    expect(() => readFileSync(path.join(outputRoot, 'server-node-modules', 'index.js'))).toThrow()
    expect(() => readFileSync(path.join(outputRoot, 'node-pty', 'index.js'))).toThrow()
  })

  it('refreshes the generated runtime tree before the MCP deploy consumes it', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    createSourceFixture(sourceRoot)
    const staleGenerated = path.join(sourceRoot, 'packages', 'freshell-mcp-runtime', 'generated', 'stale.txt')
    mkdirSync(path.dirname(staleGenerated), { recursive: true })
    writeFileSync(staleGenerated, 'stale output from a previous run\n')
    const { deployRuntime } = createRecordingDeploySeam(sourceRoot)

    await stageFixture(sourceRoot, outputRoot, { deployRuntime })

    expect(() => readFileSync(staleGenerated)).toThrow()
    const refreshed = path.join(sourceRoot, 'packages', 'freshell-mcp-runtime', 'generated', 'freshell-mcp', 'server.js')
    expect(readFileSync(refreshed, 'utf8')).toContain('modelcontextprotocol')
    expect(readFileSync(path.join(outputRoot, 'mcp', 'server.js'), 'utf8')).toContain('modelcontextprotocol')
  })

  it('fails before deploying when compiled tool output is missing', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    const fixture = createSourceFixture(sourceRoot)
    mkdirSync(outputRoot, { recursive: true })
    writeFileSync(path.join(outputRoot, 'sentinel.txt'), 'previous runtime\n')
    rmSync(path.join(sourceRoot, 'dist', 'tools', 'freshell-mcp'), { recursive: true, force: true })
    const { calls, deployRuntime } = createRecordingDeploySeam(sourceRoot)

    await expect(stageElectronRuntime({
      rootDir: sourceRoot,
      runtimeDir: outputRoot,
      platform: nativePlatform(),
      arch: nativeArch(),
      releaseVersion: '9.9.9',
      nodeVersion: '22.12.0',
      packageManagerVersion: '10.34.5',
      deployRuntime,
      ...fixture,
    })).rejects.toThrow(/missing/i)
    expect(calls).toEqual([])
    expect(collectFiles(outputRoot)).toEqual(['sentinel.txt'])
  })

  it('materializes deploy links into ordinary files while preserving content and permissions', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    createSourceFixture(sourceRoot)
    const deployRuntime = (args: DeployRuntimeArgs): void => {
      if (args.packageName === 'freshell-claude-sidecar') {
        sidecarDeployFixture(args.destination)
        const storeTool = path.join(args.destination, 'node_modules', '.pnpm', 'tool@1.0.0', 'bin', 'tool')
        writeExecutable(storeTool, '#!/bin/sh\necho tool\n')
        const binDir = path.join(args.destination, 'node_modules', '.bin')
        mkdirSync(binDir, { recursive: true })
        symlinkSync('../.pnpm/tool@1.0.0/bin/tool', path.join(binDir, 'tool'))
        const sharedDir = path.join(args.destination, 'node_modules', '.pnpm', 'shared@1.0.0', 'shared')
        mkdirSync(sharedDir, { recursive: true })
        writeFileSync(path.join(sharedDir, 'nested.js'), 'export const nested = true\n')
        symlinkSync(sharedDir, path.join(args.destination, 'node_modules', 'shared-link'))
        return
      }
      mcpDeployFixture(args.destination, path.join(sourceRoot, 'packages', 'freshell-mcp-runtime', 'generated'))
    }

    await stageFixture(sourceRoot, outputRoot, { deployRuntime })

    expect(collectLinks(outputRoot)).toEqual([])
    const materializedTool = path.join(outputRoot, 'claude-sidecar', 'node_modules', '.bin', 'tool')
    expect(lstatSync(materializedTool).isFile()).toBe(true)
    expect(readFileSync(materializedTool, 'utf8')).toContain('echo tool')
    if (process.platform !== 'win32') {
      expect(statSync(materializedTool).mode & 0o111).not.toBe(0)
    }
    expect(readFileSync(path.join(outputRoot, 'claude-sidecar', 'node_modules', 'shared-link', 'nested.js'), 'utf8')).toContain('nested = true')
  })

  it('rejects escaping, broken, and cyclic deploy links', async () => {
    const outsideRoot = temporaryRoot()
    writeFileSync(path.join(outsideRoot, 'outside.txt'), 'outside the deploy tree\n')

    const cases: Array<{ name: string; plant: (deployDir: string) => void; pattern: RegExp }> = [
      {
        name: 'escaping',
        plant: (deployDir) => {
          symlinkSync(path.join(outsideRoot, 'outside.txt'), path.join(deployDir, 'node_modules', '@anthropic-ai', 'escape-link'))
        },
        pattern: /escape/i,
      },
      {
        name: 'broken',
        plant: (deployDir) => {
          symlinkSync('does-not-exist-anywhere', path.join(deployDir, 'node_modules', '@anthropic-ai', 'broken-link'))
        },
        pattern: /broken|cyclic/i,
      },
      {
        name: 'cyclic',
        plant: (deployDir) => {
          const linkDir = path.join(deployDir, 'node_modules', '@anthropic-ai')
          symlinkSync('cyclic-b', path.join(linkDir, 'cyclic-a'))
          symlinkSync('cyclic-a', path.join(linkDir, 'cyclic-b'))
        },
        pattern: /broken|cyclic/i,
      },
    ]
    for (const { name, plant, pattern } of cases) {
      const sourceRoot = temporaryRoot()
      const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
      createSourceFixture(sourceRoot)
      mkdirSync(outputRoot, { recursive: true })
      writeFileSync(path.join(outputRoot, 'sentinel.txt'), 'previous runtime\n')
      const deployRuntime = (args: DeployRuntimeArgs): void => {
        if (args.packageName === 'freshell-claude-sidecar') {
          sidecarDeployFixture(args.destination)
          plant(args.destination)
          return
        }
        mcpDeployFixture(args.destination, path.join(sourceRoot, 'packages', 'freshell-mcp-runtime', 'generated'))
      }

      await expect(stageFixture(sourceRoot, outputRoot, { deployRuntime })).rejects.toThrow(pattern)
      expect(readFileSync(path.join(outputRoot, 'sentinel.txt'), 'utf8')).toContain('previous runtime')
      expect(collectLinks(outputRoot)).toEqual([])
      const stagingPath = `${outputRoot}.staging`
      expect(lstatSafe(stagingPath)).toBeUndefined()
    }
  })

  it('refuses cross-target staging before any deploy', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    const fixture = createSourceFixture(sourceRoot)
    const { calls, deployRuntime } = createRecordingDeploySeam(sourceRoot)
    const foreignPlatform = process.platform === 'win32' ? 'darwin' : 'win32'
    const foreignArch = process.arch === 'x64' ? 'arm64' : 'x64'

    await expect(stageElectronRuntime({
      rootDir: sourceRoot,
      runtimeDir: outputRoot,
      platform: foreignPlatform,
      arch: nativeArch(),
      releaseVersion: '9.9.9',
      nodeVersion: '22.12.0',
      packageManagerVersion: '10.34.5',
      deployRuntime,
      ...fixture,
    })).rejects.toThrow(/native/i)
    await expect(stageElectronRuntime({
      rootDir: sourceRoot,
      runtimeDir: outputRoot,
      platform: nativePlatform(),
      arch: foreignArch,
      releaseVersion: '9.9.9',
      nodeVersion: '22.12.0',
      packageManagerVersion: '10.34.5',
      deployRuntime,
      ...fixture,
    })).rejects.toThrow(/native/i)
    expect(calls).toEqual([])
  })

  it('keeps the previous runtime when the deploy fails mid-staging', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    createSourceFixture(sourceRoot)
    mkdirSync(outputRoot, { recursive: true })
    writeFileSync(path.join(outputRoot, 'sentinel.txt'), 'previous runtime\n')
    const deployRuntime = (args: DeployRuntimeArgs): void => {
      if (args.packageName === 'freshell-claude-sidecar') {
        sidecarDeployFixture(args.destination)
        return
      }
      throw new Error('pnpm deploy failed for freshell-mcp-runtime with exit code 1.')
    }

    await expect(stageFixture(sourceRoot, outputRoot, { deployRuntime })).rejects.toThrow(/freshell-mcp-runtime/)
    expect(readFileSync(path.join(outputRoot, 'sentinel.txt'), 'utf8')).toContain('previous runtime')
    expect(lstatSafe(`${outputRoot}.staging`)).toBeUndefined()
  })

  it('ensures staged POSIX binaries are executable even when inputs are not', async () => {
    const sourceRoot = temporaryRoot()
    const outputRoot = path.join(temporaryRoot(), 'electron-runtime')
    const fixture = createSourceFixture(sourceRoot)
    chmodSync(fixture.serverBinary, 0o644)
    chmodSync(fixture.nodeBinary, 0o644)
    const { deployRuntime } = createRecordingDeploySeam(sourceRoot)

    await stageElectronRuntime({
      rootDir: sourceRoot,
      runtimeDir: outputRoot,
      platform: nativePlatform(),
      arch: nativeArch(),
      releaseVersion: '9.9.9',
      nodeVersion: '22.12.0',
      packageManagerVersion: '10.34.5',
      deployRuntime,
      ...fixture,
    })

    for (const [source, binary] of [
      [fixture.serverBinary, path.join(outputRoot, 'bin', getRuntimeBinaryName(nativePlatform()))],
      [fixture.nodeBinary, path.join(outputRoot, 'node', 'bin', getNodeBinaryName(nativePlatform()))],
    ]) {
      // POSIX exec bits only apply to POSIX targets. The stager deliberately
      // skips the permission operation for win32 targets (Windows executability
      // comes from the .exe extension; the filesystem does not retain the
      // bit), so a win32 host staging a win32 runtime must show NO operation,
      // while POSIX hosts show the operation AND its filesystem effect.
      const expectedMode = (statSync(source).mode & 0o777) | 0o111
      const stagedBinary = path.join(`${outputRoot}.staging`, path.relative(outputRoot, binary))
      expect(
        vi.mocked(chmodSync).mock.calls.some(([target, mode]) =>
          (target === binary || target === stagedBinary) && mode === expectedMode),
      ).toBe(nativePlatform() !== 'win32')
      if (nativePlatform() !== 'win32') expect(statSync(binary).mode & 0o111).not.toBe(0)
    }
  })

  it('uses the locked Node archive URL for each supported target', () => {
    expect(getNodeDownloadUrl('22.12.0', 'linux', 'x64')).toBe('https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz')
    expect(getNodeDownloadUrl('22.12.0', 'darwin', 'arm64')).toBe('https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz')
    expect(getNodeDownloadUrl('22.12.0', 'win32', 'x64')).toBe('https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip')
  })
})

function lstatSafe(target: string): string | undefined {
  try {
    return lstatSync(target).isDirectory() ? target : undefined
  } catch {
    return undefined
  }
}
