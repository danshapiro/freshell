import { describe, it, expect } from 'vitest'
import path from 'path'
import { resolveTemplatePath } from '../../../../electron/daemon/template-path.js'

describe('resolveTemplatePath', () => {
  const moduleDir = '/app/dist/electron/daemon'

  it('resolves from resourcesPath when provided (packaged app)', () => {
    const result = resolveTemplatePath(
      ['windows', 'freshell-task.xml.template'],
      moduleDir,
      '/app/resources',
    )
    expect(result).toBe(path.join('/app/resources', 'installers', 'windows', 'freshell-task.xml.template'))
  })

  it('resolves from moduleDir when resourcesPath is undefined (dev mode)', () => {
    const result = resolveTemplatePath(
      ['windows', 'freshell-task.xml.template'],
      moduleDir,
    )
    expect(result).toBe(path.join(moduleDir, '..', '..', 'installers', 'windows', 'freshell-task.xml.template'))
  })

  it('works for launchd template subpath', () => {
    const result = resolveTemplatePath(
      ['launchd', 'com.freshell.server.plist.template'],
      moduleDir,
      '/app/resources',
    )
    expect(result).toBe(path.join('/app/resources', 'installers', 'launchd', 'com.freshell.server.plist.template'))
  })

  it('works for systemd template subpath', () => {
    const result = resolveTemplatePath(
      ['systemd', 'freshell.service.template'],
      moduleDir,
      '/app/resources',
    )
    expect(result).toBe(path.join('/app/resources', 'installers', 'systemd', 'freshell.service.template'))
  })
})
