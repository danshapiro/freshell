import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { supervisorRegistrySecretScan } from '../../../helpers/provider-parity-environment.js'

const owned: string[] = []
afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function registry(files: Record<string, string>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-registry-scan-'))
  owned.push(directory)
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents)
  return directory
}

/** Run the scan as the parity tests run it in the supervisor container. */
function scan(directory: string, markers: string[], preload?: string): number | null {
  const [program, ...args] = supervisorRegistrySecretScan(markers, directory)
  return spawnSync(program, preload ? ['--require', preload, ...args] : args, { encoding: 'utf8' }).status
}

/** Make SQLite's checkpoint race happen: the first read of `name` finds it
  * deleted after the directory listing named it. */
function vanishOnFirstRead(directory: string, name: string): string {
  const preload = path.join(directory, '..', `${path.basename(directory)}-vanish.cjs`)
  owned.push(preload)
  fs.writeFileSync(preload, `const fs=require('fs');const read=fs.readFileSync;let vanished=false;
fs.readFileSync=function(file,...rest){if(!vanished&&String(file).endsWith(${JSON.stringify(`/${name}`)})){vanished=true;fs.rmSync(file);}return read.call(this,file,...rest)}`)
  return preload
}

describe('supervisor registry secret scan', () => {
  it('reports a marker in any registry file and passes a clean registry', () => {
    expect(scan(registry({ 'runtime.sqlite3': 'clean', 'runtime.sqlite3-wal': 'x fixture-secret-byte' }), ['fixture-secret-byte'])).toBe(4)
    expect(scan(registry({ 'runtime.sqlite3': 'nested-secret-byte' }), ['fixture-secret-byte', 'nested-secret-byte'])).toBe(4)
    expect(scan(registry({ 'runtime.sqlite3': 'clean', 'other-file': 'fixture-secret-byte' }), ['fixture-secret-byte'])).toBe(0)
  })

  it('rescans when SQLite removes a -wal or -shm file between listing and reading it', () => {
    for (const name of ['runtime.sqlite3-wal', 'runtime.sqlite3-shm']) {
      const clean = registry({ 'runtime.sqlite3': 'clean', [name]: 'clean' })
      expect(scan(clean, ['fixture-secret-byte'], vanishOnFirstRead(clean, name)), name).toBe(0)
      // The checkpoint moved the marker into the main file: the rescan reads it.
      const moved = registry({ 'runtime.sqlite3': 'x fixture-secret-byte', [name]: 'clean' })
      expect(scan(moved, ['fixture-secret-byte'], vanishOnFirstRead(moved, name)), name).toBe(4)
    }
  })
})
