import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

// Repo files are LF, but a Windows checkout may convert them to CRLF.
// Normalize so `\n`-based regex/content assertions are EOL-agnostic.
const readText = (filePath: string): string =>
  readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n')

describe('electron-builder Windows config', () => {
  it('builds the Windows installer without the portable self-extracting target', () => {
    const config = readText(path.join(PROJECT_ROOT, 'config/electron-builder.yml'))

    expect(config).toMatch(/win:\n(?:.*\n)*?  target:\n(?:.*\n)*?    - nsis/)
    expect(config).not.toMatch(/win:\n(?:.*\n)*?  target:\n(?:.*\n)*?    - portable/)
    expect(config).not.toMatch(/^portable:/m)
  })

  it('does not request the portable target from the Windows package script', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['electron:build:win']).toContain('--win nsis')
    expect(packageJson.scripts['electron:build:win']).not.toContain('portable')
  })

  it('does not require publish metadata for local package builds', () => {
    const config = readText(path.join(PROJECT_ROOT, 'config/electron-builder.yml'))

    expect(config).toMatch(/^publish: null$/m)
  })

  it('packages launch chooser assets as extra resources', () => {
    const config = readText(path.join(PROJECT_ROOT, 'config/electron-builder.yml'))

    expect(config).toMatch(
      /extraResources:\n(?:.*\n)*?  - from: dist\/launch-chooser\n    to: launch-chooser/,
    )
  })

  it('sets Linux maintainer metadata required by Debian packaging', () => {
    const config = readText(path.join(PROJECT_ROOT, 'config/electron-builder.yml'))

    expect(config).toMatch(/^linux:\n(?:.*\n)*?  maintainer: Freshell Maintainers <maintainers@freshell\.dev>$/m)
  })

  it('uses a silent-install friendly NSIS flow', () => {
    const config = readText(path.join(PROJECT_ROOT, 'config/electron-builder.yml'))

    expect(config).toMatch(
      /^nsis:\n  oneClick: true\n  runAfterFinish: true\n  include: assets\/electron\/installer\.nsh$/m,
    )
    expect(config).not.toContain('allowToChangeInstallationDirectory')
  })

  it('lets the built-in NSIS completion flow launch the installed app', () => {
    const include = readText(path.join(PROJECT_ROOT, 'assets', 'electron', 'installer.nsh'))

    expect(include).toContain('!macro customInstall')
    expect(include).not.toContain('SetErrorLevel 0')
    expect(include).not.toContain("System::Call 'kernel32::ExitProcess(i 0)'")
  })

  it('quits before installation when Freshell is already running', () => {
    const include = readText(path.join(PROJECT_ROOT, 'assets', 'electron', 'installer.nsh'))

    expect(include).toContain('!macro customInit')
    expect(include).toContain('!macro customCheckAppRunning')
    expect(include).toContain('${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0')
    expect(include).toContain('Quit ${PRODUCT_NAME} before running this installer.')
    expect(include).toContain('SetErrorLevel 1')
    expect(include).not.toContain('taskkill')
  })

  it('provisions remote desktop config from silent installer args without hand-writing JSON', () => {
    const include = readText(path.join(PROJECT_ROOT, 'assets', 'electron', 'installer.nsh'))

    expect(include).toContain('${StdUtils.GetParameter} $0 "FRESHELL_REMOTE_URL" ""')
    expect(include).toContain('${StdUtils.GetParameter} $1 "FRESHELL_TOKEN" ""')
    // Raw values are written to a line-based provision file. NSIS cannot escape
    // JSON, so a token/URL containing a quote or backslash would otherwise
    // corrupt the file; the app serializes a real desktop.json on first launch.
    expect(include).toContain('FileOpen $2 "$PROFILE\\.freshell\\desktop.provision" w')
    expect(include).toContain('FileWrite $2 "FRESHELL_REMOTE_URL=$0')
    expect(include).toContain('FileWrite $2 "FRESHELL_TOKEN=$1')
    // The injection-prone hand-written JSON path must be gone.
    expect(include).not.toContain('desktop.json" w')
    expect(include).not.toContain('$\\"serverMode$\\"')
  })
})
