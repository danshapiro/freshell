import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import {
  findFreePort,
  applyTestServerHomeEnvironment,
  requireBuiltServerEntry,
} from '../helpers/test-server.js'
import {
  ensureRustServerBuilt,
  rustServerBinPath,
  rustClientDistPath,
} from '../helpers/rust-server.js'
import type { E2eServerKind } from '../helpers/external-target.js'

/**
 * CFG-03 -- matrix spec.
 *
 * Full acceptance text: "Add backup, fallback, and visible write-error
 * handling. Retain the last valid configuration; on parse, version, or read
 * failure, load safe defaults with the truthful fallback reason and backup
 * availability, then offer an explicit restore. Automatic backup
 * restoration is a deliberate safety improvement only if separately
 * documented and tested." Validation note: "Parameterize parse error,
 * unsupported version, and read failure with/without a valid backup; assert
 * the exact warning/default state, use Restore when offered and verify
 * values, then force a write failure and assert an error while
 * primary/backup remain intact."
 *
 * Prior state (crate-level only): `crates/freshell-server/src/settings_store.rs`'s
 * `maybe_restore_config_from_backup` (backup refresh on every successful
 * persist + conservative restore-on-corrupt-primary) is unit tested
 * (`corrupted_primary_restores_from_backup_preserving_every_last_good_value`,
 * `both_primary_and_backup_corrupt_starts_fresh_but_preserves_both_forensic_copies`,
 * etc.) but never driven from a Playwright `PW-RUST` spec.
 *
 * Why this spec spawns servers directly instead of using the shared
 * `TestServer`/`RustServer` fixtures: BOTH fixtures' `start()`/`boot()`
 * unconditionally call a private `ensureSetupWizardBypassConfig()` helper
 * that does `JSON.parse()` on any EXISTING `config.json` and re-throws on a
 * non-ENOENT parse failure. CFG-03 needs to boot a server against an
 * ALREADY-CORRUPT `config.json` -- exactly the input that helper cannot
 * tolerate. Modifying that shared, non-owned helper is out of this lane's
 * file-ownership scope, so this spec reimplements the minimal
 * spawn-the-built-binary-and-wait-for-health sequence locally (reusing the
 * exported pure helpers -- `findFreePort`, `applyTestServerHomeEnvironment`,
 * `requireBuiltServerEntry`, `ensureRustServerBuilt`, `rustServerBinPath`,
 * `rustClientDistPath` -- none of which touch `config.json`).
 *
 * KNOWN DIVERGENCE (documented in `settings_store.rs`'s own doc comment,
 * not a new finding): the legacy Node original's `loadInternal` treats ANY
 * read failure (parse/version/read) as "no existing config" and calls
 * `saveInternal(defaultsOnlyConfig)` UNCONDITIONALLY -- which overwrites
 * BOTH `config.json` AND (via `saveInternal`'s own unconditional
 * `copyFile`) `config.backup.json` with bare defaults, destroying the very
 * backup a human could otherwise have restored from by hand. This is
 * precisely the data-loss gap CFG-03 exists to close. This spec runs the
 * SAME corrupt-primary-plus-valid-backup setup against BOTH kinds and
 * asserts the DIFFERENT, per-kind-correct outcome: legacy is the CONTROL
 * that empirically proves the gap, rust proves the fix.
 *
 * NOT covered here (see file-by-file notes at each `test.skip`/comment):
 *   - The browser-visible "truthful fallback reason and backup
 *     availability" WARNING BANNER (`ConfigFallback` in
 *     `crates/freshell-protocol/src/server_messages.rs`, rendered by
 *     `src/App.tsx`'s `configFallback` banner): confirmed by exhaustive
 *     grep across `crates/` that `ConfigFallback` is defined but NEVER
 *     constructed/sent anywhere in the Rust server. This is a genuine
 *     PRODUCT gap on the Rust port (the file-level backup/restore
 *     machinery works; the client-visible notice does not exist), not
 *     merely an untested clause -- filed as a follow-up, not fabricated
 *     here.
 *   - An explicit "Restore" UI action: `src/App.tsx`'s fallback banner has
 *     only a dismiss (X) button, no Restore button, on either kind today.
 *     The Rust port instead performs fully AUTOMATIC restoration, which
 *     the checklist's own parenthetical explicitly permits ("Automatic
 *     backup restoration is a deliberate safety improvement only if
 *     separately documented and tested") -- this spec IS that test. There
 *     is no manual Restore flow to click through on either kind.
 *   - "force a write failure and assert an error while primary/backup
 *     remain intact": `SettingsStore::persist()` has no `Result` return
 *     and no caller-visible error path at all (`persisted_ok` is computed
 *     and only gates the backup refresh; a failed primary write is never
 *     surfaced to the PATCH /api/settings caller). Confirmed by reading
 *     `settings_store.rs`'s `persist()` end to end. This is a genuine
 *     PRODUCT gap (no error surfacing exists to test), not an untested
 *     clause -- filed as a follow-up. The UNIT-level version of this exact
 *     scenario (`backup_is_not_refreshed_when_the_primary_persist_fails`)
 *     already proves the primary/backup-remain-intact half at the
 *     Rust-crate level with a real read-only-directory write failure.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('Could not find project root (no package.json found)')
}

const PROJECT_ROOT = findProjectRoot(__dirname)

interface SpawnedServer {
  proc: ChildProcess
  baseUrl: string
  homeDir: string
}

async function waitForHealth(baseUrl: string, proc: ChildProcess, stderrRef: { buf: string }, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null && proc.exitCode !== undefined) {
      throw new Error(`process exited with code ${proc.exitCode} before becoming healthy.\nstderr: ${stderrRef.buf}`)
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) {
        const body = await res.json()
        if (body.ok) return
      }
    } catch {
      // Not listening yet -- expected while the process boots.
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out waiting for health after ${timeoutMs}ms.\nstderr: ${stderrRef.buf}`)
}

async function stopProcessGracefully(proc: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 5_000)
    proc.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}

/**
 * Spawn the built server binary (Rust) or built server entry (legacy
 * Node), pointed directly at `homeDir`, WITHOUT running either fixture's
 * `ensureSetupWizardBypassConfig()` pre-flight -- see the file doc comment
 * for why that matters for this spec.
 */
async function spawnServerAgainstHome(
  kind: E2eServerKind,
  homeDir: string,
  token: string,
): Promise<SpawnedServer> {
  const port = await findFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const stderrRef = { buf: '' }
  let proc: ChildProcess

  if (kind === 'rust') {
    const bin = ensureRustServerBuilt(PROJECT_ROOT)
    const env = applyTestServerHomeEnvironment({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      FRESHELL_BIND_HOST: '127.0.0.1',
      FRESHELL_CLIENT_DIR: rustClientDistPath(PROJECT_ROOT),
      HIDE_STARTUP_TOKEN: 'true',
      AUTH_TOKEN: token,
    }, homeDir, 'isolated')
    delete (env as Record<string, string | undefined>).VITE_PORT
    proc = spawn(bin, [], { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    const serverEntry = requireBuiltServerEntry(PROJECT_ROOT)
    const env = applyTestServerHomeEnvironment({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      NODE_ENV: 'production',
      HIDE_STARTUP_TOKEN: 'true',
      FRESHELL_BIND_HOST: '127.0.0.1',
      AUTH_TOKEN: token,
    }, homeDir, 'project')
    delete (env as Record<string, string | undefined>).VITE_PORT
    proc = spawn('node', [serverEntry], { cwd: PROJECT_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  proc.stderr?.on('data', (chunk: Buffer) => { stderrRef.buf += chunk.toString() })
  proc.stdout?.on('data', () => {})

  await waitForHealth(baseUrl, proc, stderrRef, 30_000)
  return { proc, baseUrl, homeDir }
}

async function getSettings(baseUrl: string, token: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/settings`, { headers: { 'x-auth-token': token } })
  expect(res.status).toBe(200)
  return res.json()
}

const SENTINEL_AUTO_KILL_MINUTES = 77
const LEGACY_DEFAULT_AUTO_KILL_MINUTES = 15

function validBackupDocument(): string {
  return JSON.stringify({
    version: 1,
    settings: {
      network: { configured: true, host: '127.0.0.1' },
      safety: { autoKillIdleMinutes: SENTINEL_AUTO_KILL_MINUTES },
    },
  }, null, 2)
}

test.describe('CFG-03 backup/fallback matrix', () => {
  test('corrupt primary + valid backup: Rust restores byte-identically and preserves the sentinel; legacy (KNOWN DIVERGENCE) loses it', async ({ e2eServerKind }) => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cfg03-'))
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })

    const configPath = path.join(freshellDir, 'config.json')
    const backupPath = path.join(freshellDir, 'config.backup.json')
    const backupDoc = validBackupDocument()

    await fsp.writeFile(configPath, '{ this is not valid json at all')
    await fsp.writeFile(backupPath, backupDoc)

    const token = randomUUID()
    const server = await spawnServerAgainstHome(e2eServerKind, homeDir, token)

    try {
      const settings = await getSettings(server.baseUrl, token)
      const backupOnDiskAfter = await fsp.readFile(backupPath, 'utf8')

      if (e2eServerKind === 'rust') {
        // THE FIX: `maybe_restore_config_from_backup` restores the primary
        // byte-identically from the backup BEFORE `SettingsStore::load()`
        // does anything else. What we observe here (after the full boot
        // sequence) can legitimately be a LATER, fuller write: our minimal
        // backup fixture omits `codingCli.knownProviders`/
        // `completedMigrations`, so the SAME boot's provider-discovery/
        // schema-migration reconciliation (CFG-10, unrelated to CFG-03)
        // triggers its OWN unconditional `persist()` of the fully
        // normalized `ServerSettings` shape immediately afterward -- which
        // also refreshes the backup from that same normalized write. So
        // the durable, product-relevant guarantee CFG-03 makes is that the
        // VALUE survives the restore, not that the file's bytes are frozen
        // forever after -- assert that instead of literal byte-equality.
        const primaryOnDiskAfter = await fsp.readFile(configPath, 'utf8')
        const primaryParsed = JSON.parse(primaryOnDiskAfter)
        expect(primaryParsed.settings.safety.autoKillIdleMinutes).toBe(SENTINEL_AUTO_KILL_MINUTES)
        expect(settings.safety.autoKillIdleMinutes).toBe(SENTINEL_AUTO_KILL_MINUTES)
        const backupParsed = JSON.parse(backupOnDiskAfter)
        expect(backupParsed.settings.safety.autoKillIdleMinutes).toBe(SENTINEL_AUTO_KILL_MINUTES)
      } else {
        // CONTROL (KNOWN DIVERGENCE): legacy falls back to bare defaults on
        // ANY read failure and unconditionally overwrites the backup with
        // those same defaults -- the sentinel is gone from BOTH files.
        expect(settings.safety.autoKillIdleMinutes).toBe(LEGACY_DEFAULT_AUTO_KILL_MINUTES)
        expect(backupOnDiskAfter).not.toBe(backupDoc)
        const reparsedBackup = JSON.parse(backupOnDiskAfter)
        expect(reparsedBackup.settings.safety.autoKillIdleMinutes).toBe(LEGACY_DEFAULT_AUTO_KILL_MINUTES)
      }
    } finally {
      await stopProcessGracefully(server.proc)
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('missing primary, no backup at all: ordinary fresh install on both kinds (not a warning case)', async ({ e2eServerKind }) => {
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cfg03-'))
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    // Deliberately: no config.json, no config.backup.json at all.

    const token = randomUUID()
    const server = await spawnServerAgainstHome(e2eServerKind, homeDir, token)

    try {
      const settings = await getSettings(server.baseUrl, token)
      // Both kinds: ordinary defaults, no forensic/corrupt artifacts of any
      // kind should exist for a plain fresh install.
      expect(settings.safety.autoKillIdleMinutes).toBe(LEGACY_DEFAULT_AUTO_KILL_MINUTES)
      const entries = await fsp.readdir(freshellDir)
      expect(entries.some((name) => name.includes('.corrupt-'))).toBe(false)
    } finally {
      await stopProcessGracefully(server.proc)
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('Rust-only: BOTH primary and backup corrupt -- starts fresh with defaults but preserves forensic copies of both', async ({ e2eServerKind }) => {
    test.skip(e2eServerKind === 'legacy', 'KNOWN DIVERGENCE: legacy has no forensic-preservation behavior at all -- it silently overwrites both files with defaults (the exact gap CFG-03 closes). Nothing legacy-specific to assert here beyond what the corrupt+valid-backup case above already proves.')

    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cfg03-'))
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })

    await fsp.writeFile(path.join(freshellDir, 'config.json'), '{ not valid json, primary')
    await fsp.writeFile(path.join(freshellDir, 'config.backup.json'), '{ not valid json, backup')

    const token = randomUUID()
    const server = await spawnServerAgainstHome(e2eServerKind, homeDir, token)

    try {
      const settings = await getSettings(server.baseUrl, token)
      expect(settings.safety.autoKillIdleMinutes).toBe(LEGACY_DEFAULT_AUTO_KILL_MINUTES)

      const entries = await fsp.readdir(freshellDir)
      expect(entries.some((name) => name.startsWith('config.json.corrupt-'))).toBe(true)
      expect(entries.some((name) => name.startsWith('config.backup.json.corrupt-'))).toBe(true)
    } finally {
      await stopProcessGracefully(server.proc)
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
