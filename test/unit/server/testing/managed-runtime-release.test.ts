import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_MANAGED_PROVIDERS,
  activatePreparedRelease,
  backupRegistry,
  managedWebEnvironment,
  prepareImmutableRelease,
  readCurrentRelease,
  readPreparedRelease,
  releasePaths,
  supervisorArguments,
  validateStaticPreflight,
} from '../../../../scripts/managed-runtime-release.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join('/tmp', 'fmr-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'home')
  fs.mkdirSync(repo)
  fs.mkdirSync(home)
  const binaries = Object.fromEntries(['server', 'supervisor', 'host'].map(name => {
    const file = path.join(root, name)
    fs.writeFileSync(file, `binary-${name}`, { mode: 0o755 })
    return [name, file]
  })) as Record<'server'|'supervisor'|'host', string>
  return { root, repo, home, binaries }
}

describe('managed runtime release layout', () => {
  it('keeps all Unix sockets within the Linux path budget and state outside the checkout', () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    expect(paths.root.startsWith(fx.home)).toBe(true)
    expect(paths.root.startsWith(fx.repo)).toBe(false)
    expect(Buffer.byteLength(paths.controlSocket)).toBeLessThan(104)
    expect(Buffer.byteLength(path.join(paths.runtimeRoot, `incarnation-${'0'.repeat(36)}`, 'host.sock'))).toBeLessThan(104)
  })

  it('copies binaries immutably and reuses only byte-identical release inputs', () => {
    const fx = fixture()
    const input = {
      repoRoot: fx.repo,
      freshellHome: fx.home,
      commit: 'a'.repeat(40),
      imageRef: `sha256:${'b'.repeat(64)}`,
      serverBinary: fx.binaries.server,
      supervisorBinary: fx.binaries.supervisor,
      hostBinary: fx.binaries.host,
    }
    const paths = releasePaths(fx.repo, fx.home)
    const first = prepareImmutableRelease(input)
    const originalHost = fs.readFileSync(first.hostBinary, 'utf8')
    expect(prepareImmutableRelease(input)).toEqual(first)
    expect(fs.existsSync(paths.currentFile)).toBe(false)
    activatePreparedRelease(first, paths)
    expect(readCurrentRelease(paths)).toEqual(first)

    fs.writeFileSync(fx.binaries.host, 'changed-host', { mode: 0o755 })
    const second = prepareImmutableRelease(input)
    expect(second.releaseId).not.toBe(first.releaseId)
    expect(fs.readFileSync(first.hostBinary, 'utf8')).toBe(originalHost)
    expect(readCurrentRelease(paths)).toEqual(first)
    expect(readPreparedRelease(paths, second.releaseId)).toEqual(second)
    activatePreparedRelease(second, paths)
    expect(readCurrentRelease(paths)).toEqual(second)
    for (const file of [second.serverBinary, second.supervisorBinary, second.hostBinary]) {
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(false)
      expect(fs.statSync(file).mode & 0o111).not.toBe(0)
    }
  })



  it('detects mutation of an immutable release binary before activation or use', () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    const release = prepareImmutableRelease({
      repoRoot: fx.repo, freshellHome: fx.home, commit: 'a'.repeat(40),
      imageRef: `sha256:${'b'.repeat(64)}`, serverBinary: fx.binaries.server,
      supervisorBinary: fx.binaries.supervisor, hostBinary: fx.binaries.host,
    })
    fs.writeFileSync(release.hostBinary, 'tampered-host', { mode: 0o755 })
    expect(() => readPreparedRelease(paths, release.releaseId)).toThrow(/digest|immutable/i)
    expect(() => activatePreparedRelease(release, paths)).toThrow(/digest|immutable/i)
    expect(fs.existsSync(paths.currentFile)).toBe(false)
  })


  it('does not change the active pointer when the web environment cannot be written', () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    const release = prepareImmutableRelease({
      repoRoot: fx.repo, freshellHome: fx.home, commit: 'a'.repeat(40),
      imageRef: `sha256:${'b'.repeat(64)}`, serverBinary: fx.binaries.server,
      supervisorBinary: fx.binaries.supervisor, hostBinary: fx.binaries.host,
    })
    fs.mkdirSync(paths.webEnvironmentFile, { recursive: true })
    expect(() => activatePreparedRelease(release, paths)).toThrow()
    expect(fs.existsSync(paths.currentFile)).toBe(false)
  })

  it('creates a consistent private SQLite backup and leaves first installs alone', async () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    expect(await backupRegistry(paths, 'first-install')).toBeNull()
    fs.mkdirSync(paths.registryRoot, { recursive: true })
    const source = path.join(paths.registryRoot, 'runtime.sqlite3')
    const db = new DatabaseSync(source)
    db.exec("CREATE TABLE souls (id TEXT PRIMARY KEY, value TEXT); INSERT INTO souls VALUES ('soul-1', 'durable')")
    const backup = await backupRegistry(paths, 'release-one')
    db.exec("UPDATE souls SET value='changed-after-backup'")
    db.close()
    expect(backup).not.toBeNull()
    expect(fs.statSync(backup!).mode & 0o077).toBe(0)
    const copy = new DatabaseSync(backup!, { readOnly: true })
    expect(copy.prepare('SELECT value FROM souls WHERE id=?').get('soul-1')).toEqual({ value: 'durable' })
    expect(copy.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    copy.close()
  })

  it('rejects symlinked binaries rather than making mutable release identity ambiguous', () => {
    const fx = fixture()
    const link = path.join(fx.root, 'host-link')
    fs.symlinkSync(fx.binaries.host, link)
    expect(() => prepareImmutableRelease({
      repoRoot: fx.repo, freshellHome: fx.home, commit: 'a'.repeat(40),
      imageRef: `sha256:${'b'.repeat(64)}`, serverBinary: fx.binaries.server,
      supervisorBinary: fx.binaries.supervisor, hostBinary: link,
    })).toThrow(/symlink/i)
  })
})

describe('managed runtime release configuration', () => {
  it('enables the complete implemented provider matrix through normal production routing', () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    expect(DEFAULT_MANAGED_PROVIDERS).toEqual(['shell', 'claude', 'codex', 'opencode', 'amplifier'])
    expect(managedWebEnvironment(paths)).toEqual({
      FRESHELL_MANAGED_RUNTIME_V1: '1',
      FRESHELL_MANAGED_FRESH_AGENT_V1: '1',
      FRESHELL_MANAGED_PROVIDERS: 'shell,claude,codex,opencode,amplifier',
      FRESHELL_RUNTIME_CONTROL_SOCKET: paths.controlSocket,
      FRESHELL_RUNTIME_CONTROL_SECRET_FILE: paths.controlSecret,
    })
  })

  it('builds the exact supervisor command from immutable artifacts and installation state', () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    const release = prepareImmutableRelease({
      repoRoot: fx.repo, freshellHome: fx.home, commit: 'a'.repeat(40),
      imageRef: `sha256:${'b'.repeat(64)}`, serverBinary: fx.binaries.server,
      supervisorBinary: fx.binaries.supervisor, hostBinary: fx.binaries.host,
    })
    expect(supervisorArguments(release, paths, '/run/user/1001/docker.sock')).toEqual([
      'serve', '--registry-root', paths.registryRoot, '--control-socket', paths.controlSocket,
      '--control-secret-file', paths.controlSecret, '--docker-socket', '/run/user/1001/docker.sock',
      '--runtime-root', paths.runtimeRoot, '--host-binary', release.hostBinary,
      '--image-ref', release.imageRef, '--test-run-id', `release-${release.releaseId}`,
    ])
  })

  it('requires Linux, rootless Docker, cgroup v2, the exact image, and every immutable binary', () => {
    const fx = fixture()
    const paths = releasePaths(fx.repo, fx.home)
    const release = prepareImmutableRelease({
      repoRoot: fx.repo, freshellHome: fx.home, commit: 'a'.repeat(40),
      imageRef: `sha256:${'b'.repeat(64)}`, serverBinary: fx.binaries.server,
      supervisorBinary: fx.binaries.supervisor, hostBinary: fx.binaries.host,
    })
    expect(validateStaticPreflight(release, paths, {
      platform: 'linux', cgroupV2: true, dockerRootless: true, dockerImageId: release.imageRef,
    })).toEqual([])
    expect(validateStaticPreflight(release, paths, {
      platform: 'darwin', cgroupV2: false, dockerRootless: false, dockerImageId: `sha256:${'c'.repeat(64)}`,
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/Linux/), expect.stringMatching(/cgroup v2/),
      expect.stringMatching(/rootless Docker/), expect.stringMatching(/image/i),
    ]))
  })
})
