import { execFileSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import path from 'path'

const INSTALLER_EXTENSIONS = new Set(['.AppImage', '.deb', '.dmg', '.exe'])

export interface ReleaseAssetDiscoveryOptions {
  exists?: (filePath: string) => boolean
  readDir?: (dirPath: string) => string[]
  stat?: (filePath: string) => { isFile(): boolean }
}

export interface UploadElectronReleaseAssetsOptions extends ReleaseAssetDiscoveryOptions {
  execFile?: typeof execFileSync
  ghBin?: string
}

function log(level: 'info' | 'error', event: string, details: Record<string, unknown>): void {
  const payload = {
    severity: level,
    event,
    ...details,
  }
  const line = JSON.stringify(payload)
  if (level === 'error') {
    console.error(line)
    return
  }
  console.log(line)
}

function installerExtension(fileName: string): string | undefined {
  if (fileName.endsWith('.AppImage')) {
    return '.AppImage'
  }
  const ext = path.extname(fileName)
  return INSTALLER_EXTENSIONS.has(ext) ? ext : undefined
}

export function discoverElectronInstallerAssets(
  releaseDir: string,
  options: ReleaseAssetDiscoveryOptions = {},
): string[] {
  const exists = options.exists ?? existsSync
  const readDir = options.readDir ?? readdirSync
  const stat = options.stat ?? statSync

  if (!exists(releaseDir)) {
    throw new Error(`Electron release directory does not exist: ${releaseDir}`)
  }

  const assets = readDir(releaseDir)
    .filter((entry) => installerExtension(entry))
    .map((entry) => path.join(releaseDir, entry))
    .filter((assetPath) => stat(assetPath).isFile())
    .sort((a, b) => a.localeCompare(b))

  if (assets.length === 0) {
    throw new Error(`No Electron installer assets found in ${releaseDir}`)
  }

  return assets
}

export function uploadElectronReleaseAssets(
  tagName: string,
  releaseDir: string,
  options: UploadElectronReleaseAssetsOptions = {},
): string[] {
  const execFile = options.execFile ?? execFileSync
  const ghBin = options.ghBin ?? 'gh'
  const assets = discoverElectronInstallerAssets(releaseDir, options)

  log('info', 'electron_release_assets_uploading', {
    tagName,
    releaseDir,
    assetCount: assets.length,
    assets: assets.map((asset) => path.basename(asset)),
  })

  execFile(ghBin, ['release', 'upload', tagName, ...assets, '--clobber'], {
    stdio: 'inherit',
  })

  log('info', 'electron_release_assets_uploaded', {
    tagName,
    assetCount: assets.length,
  })

  return assets
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1]
  return Boolean(entryPoint && /upload-electron-release-assets\.(ts|js)$/.test(entryPoint))
}

if (isMainModule()) {
  const tagName = process.argv[2] ?? process.env.GITHUB_REF_NAME
  const releaseDir = path.resolve(process.argv[3] ?? 'release')

  if (!tagName) {
    log('error', 'electron_release_assets_missing_tag', {
      message: 'Pass the release tag as the first argument or set GITHUB_REF_NAME.',
    })
    process.exit(1)
  }

  try {
    uploadElectronReleaseAssets(tagName, releaseDir)
  } catch (error) {
    log('error', 'electron_release_assets_upload_failed', {
      tagName,
      releaseDir,
      message: error instanceof Error ? error.message : String(error),
    })
    process.exit(1)
  }
}
