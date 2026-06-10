import { afterEach, describe, expect, it } from 'vitest'
import {
  convertWslDrivePathToWindowsPath,
  resolveLaunchCwd,
} from '../../../server/launch-cwd.js'

const originalPlatform = process.platform
const originalEnv = { ...process.env }

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  })
}

function mockWsl(mountPrefix = '/mnt'): void {
  mockPlatform('linux')
  process.env.WSL_DISTRO_NAME = 'Ubuntu'
  process.env.WSL_WINDOWS_SYS32 = `${mountPrefix}/c/Windows/System32`
}

function mockPlainLinux(): void {
  mockPlatform('linux')
  delete process.env.WSL_DISTRO_NAME
  delete process.env.WSL_INTEROP
  delete process.env.WSLENV
  delete process.env.WSL_WINDOWS_SYS32
}

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  })
  process.env = { ...originalEnv }
})

describe('resolveLaunchCwd', () => {
  it('converts a Windows drive cwd to the equivalent WSL mount for Linux processes in WSL', () => {
    mockWsl()

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`, {
      targetRuntime: 'linux-process',
    })

    expect(result).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
      displayCwd: String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
      launchCwd: '/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck',
      conversion: 'windows-drive-to-wsl-mount',
    })
  })

  it('does not map a Windows drive cwd to a same-named checkout under /home', () => {
    mockWsl()

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`, {
      targetRuntime: 'linux-process',
    })

    expect(result.launchCwd).toBe('/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck')
    expect(result.launchCwd).not.toBe('/home/dan/code/DirectorDeck')
  })

  it('respects a custom WSL drive mount prefix for Linux process cwd conversion', () => {
    mockWsl('/win')

    const result = resolveLaunchCwd(String.raw`D:\work\app`, {
      targetRuntime: 'linux-process',
    })

    expect(result.launchCwd).toBe('/win/d/work/app')
    expect(result.conversion).toBe('windows-drive-to-wsl-mount')
  })

  it('rejects bare Windows drive designators for Linux process targets', () => {
    mockWsl()

    expect(resolveLaunchCwd('C:', { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: 'C:',
      displayCwd: 'C:',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it.each(['foo', './foo', '../foo', '~'])(
    'rejects unresolved relative/native cwd values for Linux process targets: %s',
    (input) => {
      mockWsl()

      expect(resolveLaunchCwd(input, { targetRuntime: 'linux-process' })).toEqual({
        targetRuntime: 'linux-process',
        inputCwd: input,
        displayCwd: input,
        launchCwd: undefined,
        conversion: 'none',
      })
    },
  )

  it('keeps POSIX cwd values unchanged for Linux processes', () => {
    mockWsl()

    const result = resolveLaunchCwd('/home/dan/code/DirectorDeck', {
      targetRuntime: 'linux-process',
    })

    expect(result).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: '/home/dan/code/DirectorDeck',
      displayCwd: '/home/dan/code/DirectorDeck',
      launchCwd: '/home/dan/code/DirectorDeck',
      conversion: 'none',
    })
  })

  it('converts a WSL drive mount cwd to a Windows drive cwd for Windows processes in WSL', () => {
    mockWsl()

    const result = resolveLaunchCwd('/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck', {
      targetRuntime: 'windows-process',
    })

    expect(result).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck',
      displayCwd: '/mnt/d/Users/Dan/GoogleDrivePersonal/code/DirectorDeck',
      launchCwd: String.raw`D:\Users\Dan\GoogleDrivePersonal\code\DirectorDeck`,
      conversion: 'wsl-mount-to-windows-drive',
    })
  })

  it('does not convert WSL-style drive mounts for Windows processes outside WSL', () => {
    mockPlainLinux()

    expect(resolveLaunchCwd('/mnt/d/projects/demo', {
      targetRuntime: 'windows-process',
    })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '/mnt/d/projects/demo',
      displayCwd: '/mnt/d/projects/demo',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('does not use /mnt as a WSL drive fallback when a custom mount prefix is inferred', () => {
    mockWsl('/win')

    expect(resolveLaunchCwd('/mnt/d/projects/demo', {
      targetRuntime: 'windows-process',
    })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '/mnt/d/projects/demo',
      displayCwd: '/mnt/d/projects/demo',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('keeps Windows cwd values unchanged for Windows processes in WSL', () => {
    mockWsl()

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\workspace`, {
      targetRuntime: 'windows-process',
    })

    expect(result.launchCwd).toBe(String.raw`D:\Users\Dan\workspace`)
    expect(result.conversion).toBe('none')
  })

  it('rejects bare Windows drive designators for Windows process targets', () => {
    mockWsl()

    expect(resolveLaunchCwd('D:', { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: 'D:',
      displayCwd: 'D:',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it.each(['foo', './foo', '../foo', '~'])(
    'rejects unresolved relative/native cwd values for Windows process targets: %s',
    (input) => {
      mockPlatform('win32')

      expect(resolveLaunchCwd(input, { targetRuntime: 'windows-process' })).toEqual({
        targetRuntime: 'windows-process',
        inputCwd: input,
        displayCwd: input,
        launchCwd: undefined,
        conversion: 'none',
      })
    },
  )

  it('does not produce a Windows cwd for Linux-only /home paths', () => {
    mockWsl()

    const result = resolveLaunchCwd('/home/dan/code/freshell', {
      targetRuntime: 'windows-process',
    })

    expect(result).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '/home/dan/code/freshell',
      displayCwd: '/home/dan/code/freshell',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('normalizes Windows cwd values for native Windows processes', () => {
    mockPlatform('win32')

    const result = resolveLaunchCwd(String.raw`D:\Users\Dan\workspace\..\\DirectorDeck`, {
      targetRuntime: 'windows-process',
    })

    expect(result.launchCwd).toBe(String.raw`D:\Users\Dan\DirectorDeck`)
    expect(result.conversion).toBe('none')
  })

  it('rejects drive-omitted Windows rooted cwd values for process launch targets', () => {
    const rootedPath = String.raw`\foo`

    mockWsl()
    expect(resolveLaunchCwd(rootedPath, { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: rootedPath,
      displayCwd: rootedPath,
      launchCwd: undefined,
      conversion: 'none',
    })

    mockPlatform('win32')
    expect(resolveLaunchCwd(rootedPath, { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: rootedPath,
      displayCwd: rootedPath,
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('rejects slash-form UNC cwd values for native Windows process targets', () => {
    mockPlatform('win32')

    expect(resolveLaunchCwd('//server/share', { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '//server/share',
      displayCwd: '//server/share',
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('does not convert native Windows drive cwd values for Linux process targets outside WSL', () => {
    mockPlatform('win32')

    const result = resolveLaunchCwd(String.raw`C:\Users\Dan\repo`, {
      targetRuntime: 'linux-process',
    })

    expect(result).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: String.raw`C:\Users\Dan\repo`,
      displayCwd: String.raw`C:\Users\Dan\repo`,
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('rejects explicit Windows UNC cwd values for process launch targets', () => {
    mockWsl()

    const uncPath = String.raw`\\server\share`

    expect(resolveLaunchCwd(uncPath, { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: uncPath,
      displayCwd: uncPath,
      launchCwd: undefined,
      conversion: 'none',
    })
    expect(resolveLaunchCwd(uncPath, { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: uncPath,
      displayCwd: uncPath,
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('rejects WSL UNC cwd values for process launch targets', () => {
    mockWsl()

    const uncPath = String.raw`\\wsl.localhost\Ubuntu\home\dan`

    expect(resolveLaunchCwd(uncPath, { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: uncPath,
      displayCwd: uncPath,
      launchCwd: undefined,
      conversion: 'none',
    })
    expect(resolveLaunchCwd(uncPath, { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: uncPath,
      displayCwd: uncPath,
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it.each([
    '//wsl.localhost/Ubuntu/home/dan',
    '//wsl$/Ubuntu/home/dan',
  ])('rejects slash-form WSL UNC cwd values for process launch targets: %s', (uncPath) => {
    mockWsl()

    expect(resolveLaunchCwd(uncPath, { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: uncPath,
      displayCwd: uncPath,
      launchCwd: undefined,
      conversion: 'none',
    })
    expect(resolveLaunchCwd(uncPath, { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: uncPath,
      displayCwd: uncPath,
      launchCwd: undefined,
      conversion: 'none',
    })
  })

  it('keeps double-slash paths aligned with terminal registry path semantics', () => {
    mockWsl()

    expect(resolveLaunchCwd('//server/share', { targetRuntime: 'linux-process' })).toEqual({
      targetRuntime: 'linux-process',
      inputCwd: '//server/share',
      displayCwd: '//server/share',
      launchCwd: '//server/share',
      conversion: 'none',
    })
    expect(resolveLaunchCwd('//server/share', { targetRuntime: 'windows-process' })).toEqual({
      targetRuntime: 'windows-process',
      inputCwd: '//server/share',
      displayCwd: '//server/share',
      launchCwd: undefined,
      conversion: 'none',
    })
  })
})

describe('convertWslDrivePathToWindowsPath', () => {
  it('converts standard WSL drive mounts to Windows drive paths', () => {
    mockWsl()

    expect(convertWslDrivePathToWindowsPath('/mnt/d/projects/demo')).toBe(String.raw`D:\projects\demo`)
  })

  it('converts custom WSL drive mounts to Windows drive paths', () => {
    mockWsl('/win')

    expect(convertWslDrivePathToWindowsPath('/win/d/projects/demo')).toBe(String.raw`D:\projects\demo`)
  })

  it('does not use /mnt as a fallback when a custom WSL drive mount is inferred', () => {
    mockWsl('/win')

    expect(convertWslDrivePathToWindowsPath('/mnt/d/projects/demo')).toBeUndefined()
  })

  it('uses mount prefix inference aligned with Windows-to-WSL conversion', () => {
    mockPlatform('linux')
    process.env.WSL_DISTRO_NAME = 'Ubuntu'
    process.env.WSL_WINDOWS_SYS32 = '/prefix/x/mount/c/Windows/System32'

    expect(resolveLaunchCwd(String.raw`D:\projects\demo`, {
      targetRuntime: 'linux-process',
    }).launchCwd).toBe('/prefix/x/mount/d/projects/demo')
    expect(convertWslDrivePathToWindowsPath('/prefix/x/mount/d/projects/demo')).toBe(String.raw`D:\projects\demo`)
  })

  it('returns undefined for Linux-only paths', () => {
    mockWsl()

    expect(convertWslDrivePathToWindowsPath('/home/dan/code/freshell')).toBeUndefined()
  })
})
