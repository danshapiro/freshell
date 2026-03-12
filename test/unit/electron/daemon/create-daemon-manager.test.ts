import { describe, it, expect, vi, beforeEach } from 'vitest'

// We need to mock process.platform which is read-only
// Use vi.stubGlobal or Object.defineProperty

describe('createDaemonManager', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns LaunchdDaemonManager on darwin', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const { createDaemonManager } = await import('../../../../electron/daemon/create-daemon-manager.js')
      const manager = await createDaemonManager()
      expect(manager.platform).toBe('darwin')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('returns SystemdDaemonManager on linux', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const { createDaemonManager } = await import('../../../../electron/daemon/create-daemon-manager.js')
      const manager = await createDaemonManager()
      expect(manager.platform).toBe('linux')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('returns WindowsServiceDaemonManager on win32', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const { createDaemonManager } = await import('../../../../electron/daemon/create-daemon-manager.js')
      const manager = await createDaemonManager()
      expect(manager.platform).toBe('win32')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  it('throws for unsupported platform', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
    try {
      const { createDaemonManager } = await import('../../../../electron/daemon/create-daemon-manager.js')
      await expect(createDaemonManager()).rejects.toThrow('Unsupported platform')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})
