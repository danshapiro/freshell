import fsPromises from 'fs/promises'

/**
 * Detect the platform, including WSL detection.
 * Returns 'wsl' if running inside Windows Subsystem for Linux,
 * otherwise returns process.platform (e.g., 'win32', 'darwin', 'linux').
 */
export async function detectPlatform(): Promise<string> {
  if (process.platform !== 'linux') {
    return process.platform
  }

  // Check for WSL by reading /proc/version
  try {
    const procVersion = await fsPromises.readFile('/proc/version', 'utf-8')
    if (procVersion.toLowerCase().includes('microsoft') || procVersion.toLowerCase().includes('wsl')) {
      return 'wsl'
    }
  } catch {
    // /proc/version not readable, not WSL
  }

  return process.platform
}
