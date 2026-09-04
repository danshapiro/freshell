// test/unit/electron/profile.test.ts
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  buildPickerEntries,
  configDirForProfile,
  parseProfileArg,
  readProfilesRegistry,
  registryPathForHome,
  resolveBootShape,
  resolveProfileSelection,
  shouldShowProfilePicker,
  stripProfileArgs,
  userDataDirForPicker,
  userDataDirForProfile,
} from '../../../electron/profile.js'

describe('parseProfileArg', () => {
  it('parses --profile=<id>', () => {
    expect(parseProfileArg(['app', '--profile=work'])).toBe('work')
  })
  it('parses --profile <id>', () => {
    expect(parseProfileArg(['app', '--profile', 'work'])).toBe('work')
  })
  it('returns undefined when --profile has a flag-like or missing value', () => {
    expect(parseProfileArg(['app', '--profile', '--other'])).toBeUndefined()
    expect(parseProfileArg(['app', '--profile'])).toBeUndefined()
  })
  it('returns undefined when absent', () => {
    expect(parseProfileArg(['app'])).toBeUndefined()
  })
})

describe('stripProfileArgs', () => {
  it('removes both --profile forms and keeps everything else', () => {
    expect(stripProfileArgs(['--profile=work', '--foo', '--profile', 'home', 'bar']))
      .toEqual(['--foo', 'bar'])
  })
  it('drops a trailing bare --profile', () => {
    expect(stripProfileArgs(['--foo', '--profile'])).toEqual(['--foo'])
  })
  it('keeps a flag that follows bare --profile (no value was consumed)', () => {
    // Mirrors parseProfileArg: `--profile --other` took no value, so --other
    // must survive stripping (it belongs to the relaunched process).
    expect(stripProfileArgs(['--profile', '--other', 'x'])).toEqual(['--other', 'x'])
  })
})

describe('resolveProfileSelection', () => {
  it('defaults to the default profile, non-explicit', () => {
    expect(resolveProfileSelection(['app'], {})).toEqual({
      selection: { id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' },
    })
  })
  it('argv wins over env', () => {
    const r = resolveProfileSelection(['app', '--profile=work'], { FRESHELL_PROFILE: 'home' })
    expect(r.selection).toEqual({ id: 'work', explicit: true, source: 'argv' })
  })
  it('uses FRESHELL_PROFILE when argv is absent', () => {
    const r = resolveProfileSelection(['app'], { FRESHELL_PROFILE: 'home' })
    expect(r.selection).toEqual({ id: 'home', explicit: true, source: 'env' })
  })
  it('treats empty FRESHELL_PROFILE as absent', () => {
    expect(resolveProfileSelection(['app'], { FRESHELL_PROFILE: '  ' }).selection.id)
      .toBe(DEFAULT_PROFILE_ID)
  })
  it('an explicit "default" suppresses the picker', () => {
    const r = resolveProfileSelection(['app', '--profile=default'], {})
    expect(r.selection).toEqual({ id: 'default', explicit: true, source: 'argv' })
    expect(r.error).toBeUndefined()
  })
  it('invalid ids fall back to default with an error', () => {
    const r = resolveProfileSelection(['app', '--profile=../evil'], {})
    expect(r.selection).toEqual({ id: DEFAULT_PROFILE_ID, explicit: false, source: 'default' })
    expect(r.error).toContain('../evil')
  })
  it('the reserved picker id falls back to default with an error', () => {
    const r = resolveProfileSelection(['app', '--profile=profile-picker'], {})
    expect(r.selection.id).toBe(DEFAULT_PROFILE_ID)
    expect(r.selection.explicit).toBe(false)
    expect(r.error).toContain('profile-picker')
  })
})

describe('path derivation', () => {
  it('default profile keeps ~/.freshell and Electron-default userData', () => {
    expect(configDirForProfile('default', '/home/u')).toBe(path.join('/home/u', '.freshell'))
    expect(userDataDirForProfile('default', 'Freshell', '/app/data')).toBeUndefined()
  })
  it('named profiles get sibling dirs', () => {
    expect(configDirForProfile('work', '/home/u')).toBe(path.join('/home/u', '.freshell-work'))
    expect(userDataDirForProfile('work', 'Freshell', '/app/data'))
      .toBe(path.join('/app/data', 'Freshell-work'))
  })
  it('registry always lives in the default config dir', () => {
    expect(registryPathForHome('/home/u')).toBe(path.join('/home/u', '.freshell', 'profiles.json'))
  })
})

describe('readProfilesRegistry', () => {
  const missing = () => undefined
  const withFile = (content: string) => (_p: string) => content

  it('missing file means no profiles and no error', () => {
    expect(readProfilesRegistry('/x/profiles.json', missing)).toEqual({ profiles: [] })
  })
  it('invalid JSON is reported and ignored', () => {
    const r = readProfilesRegistry('/x/profiles.json', withFile('nope {{{'))
    expect(r.profiles).toEqual([])
    expect(r.error).toContain('not valid JSON')
  })
  it('a reader that throws (unreadable file) is reported and ignored, not fatal', () => {
    const r = readProfilesRegistry('/x/profiles.json', () => { throw new Error('EACCES: permission denied') })
    expect(r.profiles).toEqual([])
    expect(r.error).toContain('could not be read')
    expect(r.error).toContain('EACCES')
  })
  it('schema violations are reported and ignored', () => {
    for (const bad of [
      { profiles: [{ id: 'BAD ID' }] },
      { profiles: [{ id: 'default' }] },
      { profiles: [{ id: 'a' }, { id: 'a' }] },
      { profiles: [] },
    ]) {
      const r = readProfilesRegistry('/x/profiles.json', withFile(JSON.stringify(bad)))
      expect(r.profiles).toEqual([])
      expect(r.error).toBeTruthy()
    }
  })
  it('accepts a valid registry', () => {
    const r = readProfilesRegistry('/x/profiles.json',
      withFile(JSON.stringify({ profiles: [{ id: 'work', label: 'Work' }, { id: 'home' }] })))
    expect(r.error).toBeUndefined()
    expect(r.profiles).toEqual([{ id: 'work', label: 'Work' }, { id: 'home' }])
  })
})

describe('picker predicates', () => {
  const registry = { profiles: [{ id: 'work' as const }] }
  it('shows only when selection is not explicit and registry is non-empty', () => {
    expect(shouldShowProfilePicker({ id: 'default', explicit: false, source: 'default' }, registry)).toBe(true)
    expect(shouldShowProfilePicker({ id: 'work', explicit: true, source: 'argv' }, registry)).toBe(false)
    expect(shouldShowProfilePicker({ id: 'default', explicit: false, source: 'default' }, { profiles: [] })).toBe(false)
  })
  it('buildPickerEntries lists Default first and falls back to the id as label', () => {
    expect(buildPickerEntries({ profiles: [{ id: 'work', label: 'Work' }, { id: 'home' }] }))
      .toEqual([
        { id: 'default', label: 'Default' },
        { id: 'work', label: 'Work' },
        { id: 'home', label: 'home' },
      ])
  })
})

describe('resolveBootShape', () => {
  const REG = { profiles: [{ id: 'work' as const }] }
  const NO_REGISTRY = { profiles: [] as const }
  it('explicit named profile: namespaced userData + namespaced config dir', () => {
    expect(resolveBootShape(['app', '--profile=work'], {}, REG, 'Freshell', '/app/data', '/home/u'))
      .toEqual({
        kind: 'explicit',
        profileId: 'work',
        userDataDir: path.join('/app/data', 'Freshell-work'),
        configDir: path.join('/home/u', '.freshell-work'),
      })
  })
  it('explicit default: untouched userData + default config dir, no picker', () => {
    expect(resolveBootShape(['app', '--profile=default'], {}, REG, 'Freshell', '/app/data', '/home/u'))
      .toEqual({
        kind: 'explicit',
        profileId: 'default',
        userDataDir: undefined,
        configDir: path.join('/home/u', '.freshell'),
      })
  })
  it('flag-less launch with a non-empty registry becomes a picker launcher on its OWN userData', () => {
    const shape = resolveBootShape(['app'], {}, REG, 'Freshell', '/app/data', '/home/u')
    expect(shape).toEqual({
      kind: 'picker',
      profileId: 'default',
      userDataDir: path.join('/app/data', 'Freshell-profile-picker'),
      configDir: path.join('/home/u', '.freshell'),
    })
    // The picker userData must never equal a real profile's dir.
    expect(shape.userDataDir).not.toBe(userDataDirForProfile('work', 'Freshell', '/app/data'))
  })
  it('flag-less launch with an empty registry is the plain default boot', () => {
    expect(resolveBootShape(['app'], {}, NO_REGISTRY, 'Freshell', '/app/data', '/home/u'))
      .toEqual({
        kind: 'default',
        profileId: 'default',
        configDir: path.join('/home/u', '.freshell'),
      })
  })
  it('explicitly requesting the reserved picker id falls back to default with an error', () => {
    const shape = resolveBootShape(['app', '--profile=profile-picker'], {}, REG, 'Freshell', '/app/data', '/home/u')
    expect(shape.kind).toBe('default')
    expect(shape.profileId).toBe('default')
    expect(shape.error).toContain('profile-picker')
  })
  it('an invalid explicit id falls back to default (no picker) with the reason preserved', () => {
    const shape = resolveBootShape(['app', '--profile=../evil'], {}, REG, 'Freshell', '/app/data', '/home/u')
    expect(shape.kind).toBe('default')
    expect(shape.userDataDir).toBeUndefined()
    expect(shape.error).toContain('../evil')
  })
})
