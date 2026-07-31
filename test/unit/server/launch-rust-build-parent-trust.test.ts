import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('launch-rust staging ancestor trust', () => {
  let fixtureRoot: string
  let npmMarker: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'freshell-launch-trust-'))
    npmMarker = path.join(fixtureRoot, 'npm-invoked')

    const fakeBin = path.join(fixtureRoot, 'bin')
    mkdirSync(fakeBin)
    const fakeNpm = path.join(fakeBin, 'npm')
    writeFileSync(fakeNpm, '#!/bin/sh\nprintf "invoked\\n" >> "$FRESHELL_TEST_NPM_MARKER"\nexit 73\n')
    chmodSync(fakeNpm, 0o755)

    const fakeStat = path.join(fakeBin, 'stat')
    writeFileSync(
      fakeStat,
      [
        '#!/bin/sh',
        'if [ "$1" = "-c" ] && [ "$2" = "%u" ] && [ "$4" = "$FRESHELL_TEST_FOREIGN_STAT_PATH" ]; then',
        '  printf "65534\\n"',
        '  exit 0',
        'fi',
        'exec /usr/bin/stat "$@"',
        '',
      ].join('\n'),
    )
    chmodSync(fakeStat, 0o755)
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  function run(buildParent: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const fakeBin = path.join(fixtureRoot, 'bin')
    return spawnSync(
      path.join(process.cwd(), 'scripts/launch-rust.sh'),
      ['--port', '43191', '--restart'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          FRESHELL_DEPLOY_BUILD_PARENT: buildParent,
          FRESHELL_TEST_NPM_MARKER: npmMarker,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          ...extraEnv,
        },
      },
    )
  }

  it('rejects a private build parent beneath a non-sticky other-user-writable ancestor', () => {
    const replaceableAncestor = path.join(fixtureRoot, 'replaceable')
    const buildParent = path.join(replaceableAncestor, 'private-builds')
    mkdirSync(buildParent, { recursive: true, mode: 0o700 })
    chmodSync(replaceableAncestor, 0o777)
    chmodSync(buildParent, 0o700)

    const result = run(buildParent)

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/ancestor.*writable by other users/i)
    expect(existsSync(npmMarker)).toBe(false)
  })

  it('rejects an unsafe existing ancestor before creating a missing custom parent', () => {
    const replaceableAncestor = path.join(fixtureRoot, 'replaceable')
    const buildParent = path.join(replaceableAncestor, 'new', 'private-builds')
    mkdirSync(replaceableAncestor, { mode: 0o777 })
    chmodSync(replaceableAncestor, 0o777)

    const result = run(buildParent)

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/ancestor.*writable by other users/i)
    expect(existsSync(buildParent)).toBe(false)
    expect(existsSync(npmMarker)).toBe(false)
  })

  it('rejects a sticky writable ancestor controlled by another non-root user', () => {
    const foreignStickyAncestor = path.join(fixtureRoot, 'foreign-sticky')
    const buildParent = path.join(foreignStickyAncestor, 'private-builds')
    mkdirSync(buildParent, { recursive: true, mode: 0o700 })
    chmodSync(foreignStickyAncestor, 0o1777)
    chmodSync(buildParent, 0o700)

    const result = run(buildParent, {
      FRESHELL_TEST_FOREIGN_STAT_PATH: foreignStickyAncestor,
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/trusted sticky ownership/i)
    expect(existsSync(npmMarker)).toBe(false)
  })

  it('accepts trusted sticky temp ancestry and preserves a custom private parent', () => {
    const stickyTemp = path.join(fixtureRoot, 'sticky-temp')
    const buildParent = path.join(stickyTemp, 'custom-builds')
    mkdirSync(buildParent, { recursive: true, mode: 0o755 })
    chmodSync(stickyTemp, 0o1777)
    chmodSync(buildParent, 0o755)

    const result = run(buildParent)

    expect(result.status).toBe(73)
    expect(readFileSync(npmMarker, 'utf8')).toBe('invoked\n')
    expect(statSync(buildParent).mode & 0o777).toBe(0o755)
  })
})
