// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'prepare-operator-home.sh')

function fixtureHome(): string {
  // mkdtemp creates the home root itself at 0700 — the exact condition that
  // must be prepared (a 0700 home root blocks the child from reaching even a
  // prepared key). The fixture deliberately does NOT create the mask
  // destinations — the script must.
  const home = mkdtempSync(join(tmpdir(), 'prep-home-'))
  mkdirSync(join(home, '.amplifier'), { recursive: true })
  chmodSync(join(home, '.amplifier'), 0o700)
  writeFileSync(join(home, '.amplifier', 'ms-runpod.key'), 'k')
  chmodSync(join(home, '.amplifier', 'ms-runpod.key'), 0o600)
  mkdirSync(join(home, '.config'), { recursive: true })
  chmodSync(join(home, '.config'), 0o700)
  mkdirSync(join(home, '.local', 'share'), { recursive: true })
  chmodSync(join(home, '.local'), 0o700)
  return home
}

function run(home: string): void {
  execFileSync('bash', [SCRIPT], { env: { ...process.env, FRESHELL_OPERATOR_HOME: home } })
}

describe('prepare-operator-home', () => {
  it('makes the home root and known config roots group-traversable, the amplifier tree group-readable, and creates every mask destination', () => {
    const home = fixtureHome()
    run(home)
    expect(statSync(home).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.local')).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.amplifier')).mode & 0o050).toBe(0o050)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode & 0o040).toBe(0o040)
    expect(statSync(join(home, '.config')).mode & 0o050).toBe(0o050)
    // Review Focus 2: the mask destinations must exist after prep so every
    // later soul mounts the full mask set.
    expect(existsSync(join(home, '.freshell'))).toBe(true)
    expect(existsSync(join(home, '.amplifier', 'onecli'))).toBe(true)
    expect(existsSync(join(home, '.config', 'gcloud'))).toBe(true)
  })

  it('is idempotent, tolerates an empty home, and restores group read after a 0600 rotation', () => {
    const home = fixtureHome()
    run(home)
    const afterFirst = statSync(join(home, '.amplifier', 'ms-runpod.key')).mode
    run(home)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode).toBe(afterFirst)
    // Review Focus 1: Amplifier rotation recreates the key at 0600; the re-run
    // must restore group read.
    writeFileSync(join(home, '.amplifier', 'ms-runpod.key'), 'k2')
    chmodSync(join(home, '.amplifier', 'ms-runpod.key'), 0o600)
    run(home)
    expect(statSync(join(home, '.amplifier', 'ms-runpod.key')).mode & 0o040).toBe(0o040)
    const empty = mkdtempSync(join(tmpdir(), 'prep-empty-'))
    expect(() => run(empty)).not.toThrow()
  })
})
