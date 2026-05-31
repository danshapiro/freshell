import { describe, expect, it, vi } from 'vitest'
import { applyProvisioningFile, parseProvisioning } from '../../../electron/desktop-provisioning.js'

describe('desktop provisioning', () => {
  describe('parseProvisioning', () => {
    it('parses remote url and token from line-based content', () => {
      expect(
        parseProvisioning('FRESHELL_REMOTE_URL=http://10.0.0.5:3001\nFRESHELL_TOKEN=abc123\n'),
      ).toEqual({ remoteUrl: 'http://10.0.0.5:3001', remoteToken: 'abc123' })
    })

    it('preserves tokens containing quotes and backslashes (line form needs no escaping)', () => {
      const result = parseProvisioning('FRESHELL_REMOTE_URL=http://h:3001\r\nFRESHELL_TOKEN=a"b\\c\r\n')
      expect(result.remoteToken).toBe('a"b\\c')
    })

    it('keeps = characters that appear inside the value', () => {
      expect(parseProvisioning('FRESHELL_TOKEN=a=b=c').remoteToken).toBe('a=b=c')
    })

    it('preserves leading/trailing whitespace in the value (raw preservation)', () => {
      expect(parseProvisioning('FRESHELL_TOKEN=  spaced-token  ').remoteToken).toBe('  spaced-token  ')
    })

    it('ignores unrelated or malformed lines', () => {
      expect(parseProvisioning('# comment\nNOPE\nFRESHELL_REMOTE_URL=http://h:3001')).toEqual({
        remoteUrl: 'http://h:3001',
      })
    })
  })

  describe('applyProvisioningFile', () => {
    const provisionPath = '/home/u/.freshell/desktop.provision'

    it('returns false and does nothing when the file is absent', async () => {
      const patchDesktopConfig = vi.fn()
      const deleteFile = vi.fn()
      const applied = await applyProvisioningFile(provisionPath, {
        readFile: () => undefined,
        deleteFile,
        patchDesktopConfig,
      })
      expect(applied).toBe(false)
      expect(patchDesktopConfig).not.toHaveBeenCalled()
      expect(deleteFile).not.toHaveBeenCalled()
    })

    it('patches a remote config and then deletes the provision file', async () => {
      const patchDesktopConfig = vi.fn().mockResolvedValue(undefined)
      const deleteFile = vi.fn()
      const applied = await applyProvisioningFile(provisionPath, {
        readFile: () => 'FRESHELL_REMOTE_URL=http://10.0.0.5:3001\nFRESHELL_TOKEN=a"b\\c\n',
        deleteFile,
        patchDesktopConfig,
      })
      expect(applied).toBe(true)
      expect(patchDesktopConfig).toHaveBeenCalledWith({
        serverMode: 'remote',
        remoteUrl: 'http://10.0.0.5:3001',
        remoteToken: 'a"b\\c',
        setupCompleted: true,
      })
      expect(deleteFile).toHaveBeenCalledWith(provisionPath)
    })

    it('deletes the file even when patching throws (e.g. an invalid URL)', async () => {
      const patchDesktopConfig = vi.fn().mockRejectedValue(new Error('invalid url'))
      const deleteFile = vi.fn()
      const applied = await applyProvisioningFile(provisionPath, {
        readFile: () => 'FRESHELL_REMOTE_URL=not-a-url\nFRESHELL_TOKEN=abc\n',
        deleteFile,
        patchDesktopConfig,
      })
      expect(applied).toBe(true)
      expect(deleteFile).toHaveBeenCalledWith(provisionPath)
    })

    it('does not patch when only one of url/token is present, but still clears the file', async () => {
      const patchDesktopConfig = vi.fn()
      const deleteFile = vi.fn()
      await applyProvisioningFile(provisionPath, {
        readFile: () => 'FRESHELL_REMOTE_URL=http://h:3001\n',
        deleteFile,
        patchDesktopConfig,
      })
      expect(patchDesktopConfig).not.toHaveBeenCalled()
      expect(deleteFile).toHaveBeenCalledWith(provisionPath)
    })

    it('does not throw and best-effort clears the file when reading it fails (locked/dir/perms)', async () => {
      const patchDesktopConfig = vi.fn()
      const deleteFile = vi.fn()
      const applied = await applyProvisioningFile(provisionPath, {
        readFile: () => {
          throw new Error('EISDIR: illegal operation on a directory')
        },
        deleteFile,
        patchDesktopConfig,
      })
      expect(applied).toBe(true)
      expect(patchDesktopConfig).not.toHaveBeenCalled()
      expect(deleteFile).toHaveBeenCalledWith(provisionPath)
    })
  })
})
