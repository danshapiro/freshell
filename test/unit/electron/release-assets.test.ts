import { describe, expect, it, vi } from 'vitest'
import path from 'path'
import {
  discoverElectronInstallerAssets,
  uploadElectronReleaseAssets,
} from '../../../scripts/upload-electron-release-assets.js'

const fileStat = { isFile: () => true }
const directoryStat = { isFile: () => false }

describe('Electron release asset upload', () => {
  it('selects only installer files from the Electron release directory', () => {
    const releaseDir = path.join('/tmp', 'freshell-release')

    const assets = discoverElectronInstallerAssets(releaseDir, {
      exists: () => true,
      readDir: () => [
        'Freshell Setup 0.7.5.exe',
        'Freshell-0.7.5.dmg',
        'Freshell-0.7.5.dmg.blockmap',
        'Freshell-0.7.5.AppImage',
        'freshell_0.7.5_amd64.deb',
        'latest.yml',
        'mac',
      ],
      stat: (assetPath) => path.basename(assetPath) === 'mac' ? directoryStat : fileStat,
    })

    expect(assets).toEqual([
      path.join(releaseDir, 'Freshell Setup 0.7.5.exe'),
      path.join(releaseDir, 'freshell_0.7.5_amd64.deb'),
      path.join(releaseDir, 'Freshell-0.7.5.AppImage'),
      path.join(releaseDir, 'Freshell-0.7.5.dmg'),
    ])
  })

  it('fails fast when a build produced no installer files', () => {
    expect(() =>
      discoverElectronInstallerAssets('/tmp/empty-release', {
        exists: () => true,
        readDir: () => ['builder-effective-config.yaml', 'linux-unpacked'],
        stat: () => fileStat,
      }),
    ).toThrow(/No Electron installer assets found/)
  })

  it('uploads installers with separate arguments so paths with spaces are safe', () => {
    const execFile = vi.fn()
    const releaseDir = path.join('/tmp', 'freshell-release')

    const assets = uploadElectronReleaseAssets('v0.7.5', releaseDir, {
      execFile: execFile as unknown as typeof import('child_process').execFileSync,
      ghBin: 'gh',
      exists: () => true,
      readDir: () => ['Freshell Setup 0.7.5.exe', 'Freshell-0.7.5.dmg'],
      stat: () => fileStat,
    })

    expect(assets).toEqual([
      path.join(releaseDir, 'Freshell Setup 0.7.5.exe'),
      path.join(releaseDir, 'Freshell-0.7.5.dmg'),
    ])
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      [
        'release',
        'upload',
        'v0.7.5',
        path.join(releaseDir, 'Freshell Setup 0.7.5.exe'),
        path.join(releaseDir, 'Freshell-0.7.5.dmg'),
        '--clobber',
      ],
      { stdio: 'inherit' },
    )
  })
})
