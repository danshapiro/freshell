// Unit tests for the prepare-bundled-node script.
// Tests verify headers validation and node-gyp rebuild flag construction
// using mocked filesystem and child_process.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'


function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries: Array<{ name: string; data: string; mode?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralStart = offset
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

// We test the individual helper functions exported from the module,
// not the full script execution (which would download from the internet).

describe('prepare-bundled-node helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('validateHeaders', () => {
    it('accepts valid headers directory with node_api.h', async () => {
      const { validateHeaders } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const mockExistsSync = vi.fn().mockReturnValue(true)
      expect(() =>
        validateHeaders('/tmp/headers/node-v22.12.0', mockExistsSync)
      ).not.toThrow()
      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining('node_api.h')
      )
    })

    it('rejects missing node_api.h', async () => {
      const { validateHeaders } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const mockExistsSync = vi.fn().mockReturnValue(false)
      expect(() =>
        validateHeaders('/tmp/headers/node-v22.12.0', mockExistsSync)
      ).toThrow(/node_api\.h/)
    })
  })

  describe('buildNodeGypCommand', () => {
    it('includes correct --target and --nodedir flags', async () => {
      const { buildNodeGypCommand } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const cmd = buildNodeGypCommand('22.12.0', '/tmp/headers/node-v22.12.0')
      expect(cmd).toContain('--target=22.12.0')
      expect(cmd).toContain('--nodedir=/tmp/headers/node-v22.12.0')
      expect(cmd).toContain('node-gyp rebuild')
    })
  })

  describe('getBundledNodeVersion', () => {
    it('reads version from bundled-node-version.json', async () => {
      const { getBundledNodeVersion } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const mockReadFileSync = vi
        .fn()
        .mockReturnValue('{ "version": "22.12.0" }')
      const version = getBundledNodeVersion(mockReadFileSync)
      expect(version).toBe('22.12.0')
    })
  })

  describe('getNodeDownloadUrl', () => {
    it('returns tar.gz URL for linux', async () => {
      const { getNodeDownloadUrl } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const url = getNodeDownloadUrl('22.12.0', 'linux', 'x64')
      expect(url).toBe(
        'https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz'
      )
    })

    it('returns tar.gz URL for darwin', async () => {
      const { getNodeDownloadUrl } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const url = getNodeDownloadUrl('22.12.0', 'darwin', 'arm64')
      expect(url).toBe(
        'https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz'
      )
    })

    it('returns zip URL for win32', async () => {
      const { getNodeDownloadUrl } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const url = getNodeDownloadUrl('22.12.0', 'win32', 'x64')
      expect(url).toBe(
        'https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.zip'
      )
    })
  })

  describe('getHeadersDownloadUrl', () => {
    it('returns headers tar.gz URL', async () => {
      const { getHeadersDownloadUrl } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const url = getHeadersDownloadUrl('22.12.0')
      expect(url).toBe(
        'https://nodejs.org/dist/v22.12.0/node-v22.12.0-headers.tar.gz'
      )
    })
  })

  describe('getStagingPaths', () => {
    it('returns correct paths for staging native modules', async () => {
      const { getStagingPaths } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )
      const paths = getStagingPaths()
      expect(paths.nativeModulesDir).toContain(
        path.join('bundled-node', 'native-modules')
      )
      expect(paths.nodePtyTarget).toContain(
        path.join('bundled-node', 'native-modules', 'node-pty')
      )
    })
  })

  describe('secure Windows ZIP extraction', () => {
    it('extracts only the exact expected regular member', async () => {
      const { extractZipMember } = await import('../../../scripts/prepare-bundled-node.js')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-node-zip-'))
      try {
        const archive = path.join(dir, 'node.zip')
        const output = path.join(dir, 'staged', 'node.exe')
        fs.writeFileSync(archive, storedZip([
          { name: 'node-v22.12.0-win-x64/README.md', data: 'ignored' },
          { name: 'node-v22.12.0-win-x64/node.exe', data: 'synthetic-node-binary' },
        ]))
        await extractZipMember(archive, 'node-v22.12.0-win-x64/node.exe', output)
        expect(fs.readFileSync(output, 'utf8')).toBe('synthetic-node-binary')
        expect(fs.existsSync(path.join(dir, 'staged', 'README.md'))).toBe(false)
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })

    it.each(['../node.exe', '/node.exe', 'C:/node.exe', 'dir\\node.exe', 'dir/../node.exe'])(
      'rejects unsafe expected path %s', async (member) => {
        const { validateZipEntryName } = await import('../../../scripts/prepare-bundled-node.js')
        expect(() => validateZipEntryName(member)).toThrow(/unsafe path/)
      },
    )

    it.each([
      [[{ name: '../escape', data: 'x' }, { name: 'node/node.exe', data: 'ok' }]],
      [[{ name: 'node/node.exe', data: 'one' }, { name: 'node/node.exe', data: 'two' }]],
      [[{ name: 'node/node.exe', data: 'target', mode: 0o120777 }]],
      [[{ name: 'node/readme', data: 'missing' }]],
    ] as const)('rejects malicious, duplicate, linked, or missing expected members', async (entries) => {
      const { extractZipMember } = await import('../../../scripts/prepare-bundled-node.js')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-node-zip-invalid-'))
      try {
        const archive = path.join(dir, 'node.zip')
        fs.writeFileSync(archive, storedZip(entries))
        await expect(extractZipMember(archive, 'node/node.exe', path.join(dir, 'node.exe'))).rejects.toThrow()
        expect(fs.existsSync(path.join(dir, 'node.exe'))).toBe(false)
      } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
  })

  describe('electron-builder resource paths', () => {
    it('uses electron-builder os directory names', async () => {
      const { getElectronBuilderOs } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      expect(getElectronBuilderOs('win32')).toBe('win')
      expect(getElectronBuilderOs('darwin')).toBe('mac')
      expect(getElectronBuilderOs('linux')).toBe('linux')
    })

    it('stages Windows Node where electron-builder extraResources will look', async () => {
      const { getBundledNodeBinaryPath } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      const binaryPath = getBundledNodeBinaryPath(
        '/repo/bundled-node',
        'win32',
        'x64',
      )

      expect(binaryPath).toBe(
        path.join('/repo/bundled-node', 'win', 'x64', 'node.exe'),
      )
    })

    it('stages Linux Node without an exe suffix', async () => {
      const { getBundledNodeBinaryPath } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      const binaryPath = getBundledNodeBinaryPath(
        '/repo/bundled-node',
        'linux',
        'x64',
      )

      expect(binaryPath).toBe(
        path.join('/repo/bundled-node', 'linux', 'x64', 'node'),
      )
    })

    it('places the Windows node.lib where node-gyp expects it', async () => {
      const { getWindowsNodeImportLibraryPath } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      expect(getWindowsNodeImportLibraryPath('C:\\headers\\node-v22.12.0')).toBe(
        path.join('C:\\headers\\node-v22.12.0', 'Release', 'node.lib'),
      )
    })

    it('downloads the Windows node.lib from the standalone Node import-library URL', async () => {
      const { getWindowsNodeImportLibraryDownloadUrl } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      expect(getWindowsNodeImportLibraryDownloadUrl('22.12.0', 'x64')).toBe(
        'https://nodejs.org/dist/v22.12.0/win-x64/node.lib',
      )
    })

    it('stages every compiled native module from node-pty Release output', async () => {
      const { getCompiledNativeModuleFilenames } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      expect(getCompiledNativeModuleFilenames('/release', () => [
        'conpty.node',
        'conpty_console_list.node',
        'conpty.lib',
        'obj',
      ])).toEqual(['conpty.node', 'conpty_console_list.node'])
    })

    it('uses npm_execpath when npm launches the prepare script', async () => {
      const { resolveNpmCli } = await import(
        '../../../scripts/prepare-bundled-node.js'
      )

      expect(resolveNpmCli('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', () => true)).toBe(
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      )
    })
  })
})
