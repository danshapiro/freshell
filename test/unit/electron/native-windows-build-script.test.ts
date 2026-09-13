import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { checkNativeWindowsBuildPlatform } from '../../../scripts/assert-native-windows-build.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

describe('native Windows Electron build guard', () => {
  it('allows native Windows builds', () => {
    expect(checkNativeWindowsBuildPlatform('win32')).toEqual({ ok: true })
  })

  it('blocks non-Windows builds because the Rust server must be built natively', () => {
    expect(checkNativeWindowsBuildPlatform('linux')).toEqual({
      ok: false,
      message: 'electron:build:win must run on native Windows so the Rust server is built for win32.',
    })
  })

  it('builds local Windows artifacts without trying to publish from CI worktrees', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    )

    expect(packageJson.scripts['electron:build:win']).toContain('--publish never')
  })
})
