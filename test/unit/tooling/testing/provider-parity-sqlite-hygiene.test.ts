import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { providerParitySqliteHygieneScript } from '../../../helpers/provider-parity-sqlite-hygiene.js'

const markers = ['nested-secret-byte', 'fixture-secret-byte']
const sidecars = ['runtime.sqlite3-shm', 'runtime.sqlite3-wal', 'runtime.sqlite3-journal']
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-sqlite-hygiene-'))
  directories.push(directory)
  for (const file of ['runtime.sqlite3', ...sidecars]) fs.writeFileSync(path.join(directory, file), 'clean SQLite bytes')
  return directory
}

function inspect(directory: string, disappears?: string) {
  // Delete the actual enumerated file just before the actual filesystem read.
  // Native readFileSync supplies ENOENT; no mock error replaces that operation.
  const deletion = disappears ? `
    const read = require('node:fs').readFileSync;
    require('node:fs').readFileSync = function(file, ...args) {
      if (file === ${JSON.stringify(path.join(directory, disappears))}) require('node:fs').unlinkSync(file);
      return read.call(this, file, ...args);
    };
  ` : ''
  const result = spawnSync(process.execPath, ['-e', deletion + providerParitySqliteHygieneScript(directory, markers)], {
    encoding: 'utf8', timeout: 5000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

describe('provider parity SQLite secret reader', () => {
  it('reads the database when no sidecars remain', () => {
    const directory = fixture()
    for (const file of sidecars) fs.unlinkSync(path.join(directory, file))
    expect(inspect(directory).status).toBe(0)
  })

  it.each(sidecars)('continues when enumerated %s disappears before its read', sidecar => {
    const directory = fixture()
    const result = inspect(directory, sidecar)
    expect(fs.existsSync(path.join(directory, sidecar))).toBe(false)
    expect(result.status, result.stderr).toBe(0)
  })

  it.each(['runtime.sqlite3', ...sidecars])('still detects a secret in present %s', file => {
    const directory = fixture()
    fs.writeFileSync(path.join(directory, file), `before ${markers[0]} after`)
    expect(inspect(directory).status).toBe(4)
  })

  it('still detects the other fixture marker after a different sidecar disappears', () => {
    const directory = fixture()
    fs.writeFileSync(path.join(directory, 'runtime.sqlite3-wal'), markers[1])
    expect(inspect(directory, 'runtime.sqlite3-shm').status).toBe(4)
  })

  it.each(['before enumeration', 'before read'])('fails when the required database disappears %s', when => {
    const directory = fixture()
    if (when === 'before enumeration') fs.unlinkSync(path.join(directory, 'runtime.sqlite3'))
    const result = inspect(directory, when === 'before read' ? 'runtime.sqlite3' : undefined)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ENOENT')
  })

  it('preserves unexpected errors while reading a sidecar', () => {
    const directory = fixture()
    const sidecar = path.join(directory, 'runtime.sqlite3-shm')
    fs.unlinkSync(sidecar)
    fs.mkdirSync(sidecar)
    const result = inspect(directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('EISDIR')
  })

  it('continues checking other present files matching the original database prefix', () => {
    const directory = fixture()
    fs.writeFileSync(path.join(directory, 'runtime.sqlite3-backup'), markers[0])
    expect(inspect(directory).status).toBe(4)
  })

  it('does not hide disappearance of a file outside the known transient sidecars', () => {
    const directory = fixture()
    fs.writeFileSync(path.join(directory, 'runtime.sqlite3-backup'), 'clean backup bytes')
    const result = inspect(directory, 'runtime.sqlite3-backup')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ENOENT')
  })
})
