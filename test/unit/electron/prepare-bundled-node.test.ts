// Unit tests for the prepare-bundled-node script.
// Tests verify headers validation and node-gyp rebuild flag construction
// using mocked filesystem and child_process.
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
      expect(paths.nativeModulesDir).toContain('bundled-node/native-modules')
      expect(paths.nodePtyTarget).toContain(
        'bundled-node/native-modules/node-pty'
      )
    })
  })
})
