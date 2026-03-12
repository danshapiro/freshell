import type { DaemonManager } from './daemon-manager.js'

export async function createDaemonManager(resourcesPath?: string): Promise<DaemonManager> {
  switch (process.platform) {
    case 'darwin': {
      const { LaunchdDaemonManager } = await import('./launchd.js')
      return new LaunchdDaemonManager(resourcesPath)
    }
    case 'linux': {
      const { SystemdDaemonManager } = await import('./systemd.js')
      return new SystemdDaemonManager(resourcesPath)
    }
    case 'win32': {
      const { WindowsServiceDaemonManager } = await import('./windows-service.js')
      return new WindowsServiceDaemonManager(resourcesPath)
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
