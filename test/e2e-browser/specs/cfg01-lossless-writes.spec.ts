import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { findFreePort, applyTestServerHomeEnvironment } from '../helpers/test-server.js'
import { ensureRustServerBuilt, rustClientDistPath } from '../helpers/rust-server.js'

/**
 * CFG-01 — rust-only spec: "Make every `config.json` write lossless. Preserve
 * `sessionOverrides`, `terminalOverrides`, `projectColors`, `recentDirectories`,
 * `completedMigrations`, `legacyLocalSettingsSeed`, Codex secrets, and unknown
 * future keys on every writer."
 *
 * Checklist validation (`PW-RUST`): "Seed unique sentinels and parameterize
 * settings save, terminal rename/delete, session mutation, project color,
 * recent-directory update, provider migration, network change, title
 * migration, and startup normalization. After each isolated action/restart,
 * deep-compare the file and allow only that writer's intended paths to
 * differ."
 *
 * Writer inventory (verified exhaustively in
 * crates/freshell-server/src/settings_store.rs; EVERY `config.json` write
 * funnels through `SettingsStore::persist`):
 *   settings save              PATCH /api/settings
 *   terminal rename / delete   PATCH, DELETE /api/terminals/:id
 *   session mutation           PATCH /api/sessions/:id
 *   project color              PUT /api/project-colors
 *   network change             POST /api/network/configure (loopback ->
 *                              configured:true: a real persist with zero
 *                              listener risk on the owned server)
 *   provider migration +
 *   startup normalization      the boot persist in `SettingsStore::load`
 *                              (knownProviders seed + legacy-seed strip)
 *   recent-directory update    NOT a Rust writer (CFG-09 open) — the CFG-01
 *                              obligation for `recentDirectories` is
 *                              PRESERVATION across every writer, asserted
 *                              as a sentinel in every leg below.
 *   title migration            IS a Rust boot writer since the Node-parity
 *                              port: main.rs spawns the one-time
 *                              `run_ai_title_shadow_cleanup`
 *                              (`crates/freshell-server/src/migrations.rs`),
 *                              which appends its `completedMigrations`
 *                              marker whenever the marker is absent — even
 *                              when it clears zero keys, so a clean home
 *                              never re-scans. The seeded config must
 *                              therefore PRESERVE boot 1's real marker
 *                              (same treatment `serverSecrets` already
 *                              gets), or the restart boot re-appends it —
 *                              the exact drift this spec's restart leg
 *                              once reported as a product wedge.
 *
 * Why rust-only (not MATRIX_SPECS): the acceptance is `PW-RUST`, and the
 * Rust writer is a deliberate strict SUPERSET of the frozen legacy store —
 * legacy's `loadInternal` normalization REBUILDS `serverSecrets` down to
 * only `codexDisplayIdSecret` (`server/config-store.ts:348-355`), so the
 * sibling-secret sentinel below would legitimately fail on legacy. Legacy
 * cannot be a parity control for a guarantee it never provided.
 *
 * Why this spec spawns the binary directly (cfg03 precedent): it must seed
 * and diff `config.json` around EXACT boots/restarts and inject sentinel
 * keys between runs — a precision the shared fixtures' pre-flight
 * (`ensureSetupWizardBypassConfig`) rewrites would disturb. No browser page
 * is needed: every CFG-01 writer is a REST/boot surface (checklist §80:
 * `page.request`/raw HTTP inside Playwright ownership counts as the PW-RUST
 * lane).
 *
 * Discovery determinism: the server scans
 * `[home/.freshell/extensions, cwd/.freshell/extensions,
 * FRESHELL_EXTENSIONS_DIR]` for CLI-extension manifests
 * (`crates/freshell-server/src/extensions.rs:358-370`) — with cwd pointed at
 * a neutral empty dir and FRESHELL_EXTENSIONS_DIR at another, the discovered
 * provider set is deterministically EMPTY, so the seeded
 * `knownProviders: []` is exactly stable and boots are no-op writes unless
 * the leg under test says otherwise.
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
const AUTH_TOKEN = 'cfg01-lossless-token-0123456789abcdef'

interface SpawnedServer {
  proc: ChildProcess
  baseUrl: string
  homeDir: string
}

/** Every live child this spec spawned, for failure-path cleanup (a mid-test
 * assertion failure must not orphan a listening server). */
const liveChildren = new Set<ChildProcess>()

function trackChild(proc: ChildProcess): void {
  liveChildren.add(proc)
}

async function killChildNow(proc: ChildProcess): Promise<void> {
  liveChildren.delete(proc)
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 2_000)
    proc.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
    proc.kill('SIGKILL')
  })
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
  liveChildren.delete(proc)
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
 * Spawn the built rust binary against `homeDir` with provider discovery
 * pinned to EMPTY (see the file doc comment). `cwd` is deliberately the
 * home itself, never the repo root, so the cwd-relative builtin
 * `extensions/` lookup finds no manifests.
 *
 * PORT-STEAL DEFLAKE (f3wp, mirrors `RustServer.start`): `findFreePort` has a
 * close-then-bind TOCTOU window — another agent's server can steal the port.
 * `/api/health` is unauthenticated and instance-anonymous, so a foreign
 * freshell would answer the health poll while our child lies dead
 * (EADDRINUSE). Retry up to 3 times: on each attempt, after health passes,
 * confirm the responder is OURS via the token-gated `/api/server-info`
 * (`crates/freshell-server/src/diag.rs` — a foreign server rejects this
 * spec's token with 401/403), and retry only bind-race-shaped failures while
 * hard-failing anything else.
 */
async function spawnRustServer(homeDir: string, emptyExtDir: string): Promise<SpawnedServer> {
  const bin = ensureRustServerBuilt(PROJECT_ROOT)
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await findFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const stderrRef = { buf: '' }
    const env = applyTestServerHomeEnvironment({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      FRESHELL_BIND_HOST: '127.0.0.1',
      FRESHELL_CLIENT_DIR: rustClientDistPath(PROJECT_ROOT),
      FRESHELL_EXTENSIONS_DIR: emptyExtDir,
      FRESHELL_DISABLE_WSL_PORT_FORWARD: '1',
      HIDE_STARTUP_TOKEN: 'true',
      AUTH_TOKEN,
    }, homeDir, 'isolated')
    delete (env as Record<string, string | undefined>).VITE_PORT
    const proc = spawn(bin, [], { cwd: homeDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    trackChild(proc)
    let server: SpawnedServer | undefined
    try {
      proc.stderr?.on('data', (chunk: Buffer) => { stderrRef.buf += chunk.toString() })
      proc.stdout?.on('data', () => {})
      await waitForHealth(baseUrl, proc, stderrRef, 30_000)
      // Identity check: a stolen port means the health responder is a FOREIGN
      // server (our child exited with EADDRINUSE—the health poll above passed
      // on the foreign process, since /api/health answers any caller). The
      // token-gated endpoint distinguishes us from it; the explicit AbortSignal
      // timeout keeps a stalling foreign server from hanging the retry loop
      // (Node fetch has no default timeout — kata f3wp).
      const identity = await fetch(`${baseUrl}/api/server-info`, {
        headers: { 'x-auth-token': AUTH_TOKEN },
        signal: AbortSignal.timeout(2_000),
      }).catch((fetchError: unknown) => {
        const name = fetchError instanceof Error ? fetchError.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new Error(
            `bind race: foreign server on port ${port} stalled on the server-info identity check`,
          )
        }
        throw fetchError
      })
      if (!identity.ok) {
        throw new Error(
          `bind race: foreign server answered health on port ${port} (server-info ${identity.status})`,
        )
      }
      server = { proc, baseUrl, homeDir }
      return server
    } catch (error) {
      lastError = error
      // Between attempts: kill ONLY the child (never the home — the next
      // attempt reuses it; that's what makes a mid-test restart meaningful).
      await killChildNow(proc)
      const message = error instanceof Error ? error.message : String(error)
      const bindRace =
        /EADDRINUSE|address (?:already )?in use|bind race/i.test(message)
      if (!bindRace) throw error
    }
  }
  throw lastError
}

// ── Structural deep-compare ────────────────────────────────────────────────
// Diff paths are key ARRAYS (never joined strings): session keys contain
// `:`, project paths contain `/` and `.`, so any string-joined grammar would
// be ambiguous. JSON object key ORDER is ignored on purpose — `persist()`
// re-serializes the typed `settings` tree in struct order, which is a
// legitimate no-op change.

type DiffPath = string[]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function collectDiffPaths(before: unknown, after: unknown, prefix: string[] = []): DiffPath[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    const out: DiffPath[] = []
    for (const key of keys) {
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key)
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key)
      if (!hasBefore || !hasAfter) {
        out.push([...prefix, key])
      } else {
        out.push(...collectDiffPaths(before[key], after[key], [...prefix, key]))
      }
    }
    return out
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix]
}

function fmt(p: DiffPath): string {
  return p.map((seg) => `[${JSON.stringify(seg)}]`).join('')
}

/** Assert every actual diff path is contained under one of the allowed
 * (prefix) paths — "only that writer's intended paths differ". On failure
 * the unexpected set is named TWICE: in the expect message and on a
 * `[cfg01-lossless]` console line, because cloud runs retain only the line
 * reporter's stdout (no HTML report) and the reporter can abbreviate the
 * Received block. */
function expectDiffWithin(actual: DiffPath[], allowed: DiffPath[], context: string): void {
  const unexpected = actual.filter(
    (p) => !allowed.some((a) => a.length <= p.length && a.every((seg, i) => seg === p[i])),
  )
  if (unexpected.length > 0) {
    console.error(
      `[cfg01-lossless] UNEXPECTED DRIFT (${context}): ${unexpected.map(fmt).join(', ')}` +
        ` — allowed: ${allowed.length > 0 ? allowed.map(fmt).join(', ') : '(none)'}`,
    )
  }
  expect(
    unexpected.map(fmt),
    `${context}: unexpected config.json drift beyond the writer's intended paths` +
      ` (unexpected: ${unexpected.map(fmt).join(', ') || 'none'})`,
  ).toEqual([])
}

const SENTINEL_KEYS = [
  'sessionOverrides',
  'terminalOverrides',
  'projectColors',
  'recentDirectories',
  'completedMigrations',
  'legacyLocalSettingsSeed',
  'serverSecrets',
  'zzCfg01FutureKey',
] as const

/** Assert every CFG-01 sentinel key deep-equals between two snapshots. Keys in
 * `except` are the writer-under-test's own managed map (pinned to its intended
 * paths by `expectDiffWithin` already); for those, assert CONTAINMENT instead:
 * every pre-existing entry must survive bit-for-bit — EXCEPT the entry the
 * writer is deliberately mutating (`mutatingEntries`, e.g. the terminal-delete
 * leg adds `deleted:true` to the entry the rename leg just created), where
 * every pre-existing FIELD of that entry must still survive (additions
 * allowed; field removal/overwrite flagged). A wholesale replace/regression of
 * a managed map therefore fails here even when the allowed-path diff passes. */
function expectSentinelsIntact(
  before: any,
  after: any,
  context: string,
  except: string[] = [],
  mutatingEntries: Array<[string, string]> = [],
): void {
  for (const key of SENTINEL_KEYS) {
    if (except.includes(key)) {
      const b = before?.[key]
      expect(isPlainObject(b), `${context}: sentinel ${key} (pre-write) must be an object`).toBe(true)
      for (const [entryKey, entryValue] of Object.entries(b)) {
        const mutating = mutatingEntries.some(([mk, ek]) => mk === key && ek === entryKey)
        if (mutating && isPlainObject(entryValue)) {
          for (const [field, fieldValue] of Object.entries(entryValue)) {
            const diffs = collectDiffPaths(fieldValue, after?.[key]?.[entryKey]?.[field], [key, entryKey, field])
            expect(
              diffs.map(fmt),
              `${context}: the writer's own mutation must not disturb pre-existing field ${fmt([key, entryKey, field])}`,
            ).toEqual([])
          }
          continue
        }
        const diffs = collectDiffPaths(entryValue, after?.[key]?.[entryKey], [key, entryKey])
        expect(
          diffs.map(fmt),
          `${context}: pre-existing ${key} entry ${JSON.stringify(entryKey)} must survive the writer bit-for-bit`,
        ).toEqual([])
      }
      continue
    }
    const diffs = collectDiffPaths(before?.[key], after?.[key], [key])
    expect(diffs.map(fmt), `${context}: sentinel ${key} must survive bit-for-bit`).toEqual([])
  }
}

/** Sentinel top-level block injected into a server-written default config.
 * (The codex secret is NOT here: the server's own minted value is preserved
 * from its first write and asserted alongside. `completedMigrations` is
 * likewise a MERGE: the server's real boot-migration markers must survive
 * seeding — erasing them makes the next boot re-run the marker append, a
 * correct idempotent writer the restart leg would misread as drift.) */
function sentinelBlock(existingCompletedMigrations: readonly string[]): Record<string, unknown> {
  return {
    sessionOverrides: {
      'claude:cfg01-sentinel-sess': { summaryOverride: 'CFG-01 sentinel summary', archived: true },
    },
    terminalOverrides: {
      'cfg01-sentinel-term': { titleOverride: 'CFG-01 Sentinel Title' },
    },
    projectColors: { '/cfg01/sentinel-project': '#aa00bb' },
    recentDirectories: ['/cfg01/recent/a', '/cfg01/recent/b', '/cfg01/recent/c'],
    completedMigrations: [...existingCompletedMigrations, 'cfg01-sentinel-migration'],
    legacyLocalSettingsSeed: {
      theme: 'light',
      uiScale: 1.25,
      terminal: { fontSize: 18, fontFamily: 'CFG01 E2E Mono' },
      sidebar: { sortMode: 'project', width: 280, collapsed: true },
      notifications: { soundEnabled: false },
    },
    zzCfg01FutureKey: { nested: { array: [1, 2, { x: 'y' }] }, scalar: 'keep' },
  }
}

async function readConfig(homeDir: string): Promise<any> {
  return JSON.parse(await fsp.readFile(path.join(homeDir, '.freshell', 'config.json'), 'utf8'))
}

/** The marker `crates/freshell-server/src/migrations.rs` appends on every
 * boot where it is absent (Node parity; see the file-header inventory). */
const AI_TITLE_SHADOW_CLEANUP_MARKER = 'ai-title-shadow-cleanup'

/** Snapshot config.json only AFTER the detached boot writers have landed.
 * The boot persist inside `SettingsStore::load` is synchronous before the
 * listener binds, but the one-time `ai-title-shadow-cleanup` migration is
 * `tokio::spawn`'d (`main.rs`) and appends its marker on a fresh/erased
 * home; seeding must not snapshot before that append or it would seed a
 * file the next boot must (correctly) rewrite. Timeout fails LOUDLY with
 * the observed migrations — a stopped boot writer is a bug this spec
 * wants to know about. */
async function readConfigAfterBootWrites(homeDir: string, timeoutMs = 10_000): Promise<any> {
  const start = Date.now()
  let last: any
  for (;;) {
    last = await readConfig(homeDir)
    const done = last?.completedMigrations
    if (Array.isArray(done) && done.includes(AI_TITLE_SHADOW_CLEANUP_MARKER)) return last
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for the ai-title-shadow-cleanup boot marker; completedMigrations=${JSON.stringify(done)}`,
      )
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function writeConfig(homeDir: string, doc: unknown): Promise<void> {
  await fsp.writeFile(path.join(homeDir, '.freshell', 'config.json'), JSON.stringify(doc, null, 2))
}

async function api(baseUrl: string, method: string, route: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'x-auth-token': AUTH_TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

test.describe('CFG-01 lossless config.json writes (rust)', () => {
  // Serial by construction: each step mutates the one owned server's file.
  test.describe.configure({ mode: 'serial' })

  // Failure-path cleanup: on a mid-test assertion failure, stop whatever the
  // test left running (success paths already call stopProcessGracefully, which
  // untracks; this only fires for strays).
  test.afterEach(async () => {
    for (const proc of [...liveChildren]) {
      await killChildNow(proc)
    }
  })

  test('every REST writer preserves all sentinels; restart writes nothing', async () => {
    test.setTimeout(120_000)
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cfg01-'))
    const emptyExtDir = path.join(homeDir, 'no-extensions')
    await fsp.mkdir(emptyExtDir, { recursive: true })

    // ── Boot 1 (fresh install): the startup-normalization first write lands.
    let server = await spawnRustServer(homeDir, emptyExtDir)
    const afterFirstWrite = await readConfigAfterBootWrites(homeDir)
    expect(afterFirstWrite.version).toBe(1)
    expect(afterFirstWrite.settings?.codingCli?.knownProviders).toEqual([])

    // ── Inject the sentinel block (stands in for keys written by writers
    // that don't exist in Rust: recent-directory MRU (CFG-09) and future
    // tools — title migration is intentionally absent: it IS a Rust boot
    // writer, so sentinelBlock preserves its marker; see the file-header
    // inventory). The running server must copy them forward from disk on
    // every subsequent persist.
    const seeded = { ...afterFirstWrite, ...sentinelBlock(afterFirstWrite.completedMigrations ?? []) }
    // Keep the server's own minted codex secret; add an unknown sibling.
    seeded.serverSecrets = {
      ...(afterFirstWrite.serverSecrets ?? {}),
      futureSiblingSecret: 'cfg01-sibling-secret-sentinel',
    }
    await writeConfig(homeDir, seeded)

    // ── Restart leg: a fully-normalized config boots to a NO-OP — the file
    // after boot 2 must be byte-for-byte semantically identical (knownProviders
    // present, stored seed canonical, no stray local keys).
    await stopProcessGracefully(server.proc)
    server = await spawnRustServer(homeDir, emptyExtDir)
    const afterRestart = await readConfig(homeDir)
    expectDiffWithin(
      collectDiffPaths(seeded, afterRestart),
      [],
      'normalized boot with sentinels present',
    )
    expectSentinelsIntact(seeded, afterRestart, 'restart')

    // ── Writer legs: after each action, only that writer's intended paths
    // may differ, and every sentinel key must be intact.
    const cases: Array<{
      name: string
      run: () => Promise<void>
      allowed: DiffPath[]
      /** Sentinel-map entry this writer intentionally mutates (in-run). */
      mutates?: [string, string]
    }> = [
      {
        name: 'settings save (PATCH /api/settings)',
        run: async () => {
          const res = await api(server.baseUrl, 'PATCH', '/api/settings', { safety: { autoKillIdleMinutes: 91 } })
          expect(res.status).toBe(200)
        },
        allowed: [['settings', 'safety', 'autoKillIdleMinutes']],
      },
      {
        name: 'terminal rename (PATCH /api/terminals/:id)',
        run: async () => {
          const res = await api(server.baseUrl, 'PATCH', '/api/terminals/cfg01-term-rename', { titleOverride: 'Renamed By CFG-01' })
          expect(res.status).toBe(200)
        },
        allowed: [['terminalOverrides', 'cfg01-term-rename']],
      },
      {
        name: 'terminal delete (DELETE /api/terminals/:id)',
        run: async () => {
          const res = await api(server.baseUrl, 'DELETE', '/api/terminals/cfg01-term-rename')
          expect(res.status).toBe(200)
        },
        allowed: [['terminalOverrides', 'cfg01-term-rename', 'deleted']],
        mutates: ['terminalOverrides', 'cfg01-term-rename'],
      },
      {
        name: 'session mutation (PATCH /api/sessions/:id)',
        run: async () => {
          const res = await api(
            server.baseUrl,
            'PATCH',
            `/api/sessions/${encodeURIComponent('claude:cfg01-sess-1')}`,
            { titleOverride: 'CFG-01 Session Title', archived: true },
          )
          expect(res.status).toBe(200)
        },
        allowed: [['sessionOverrides', 'claude:cfg01-sess-1']],
      },
      {
        name: 'project color (PUT /api/project-colors)',
        run: async () => {
          const res = await api(server.baseUrl, 'PUT', '/api/project-colors', { projectPath: '/cfg01/new-project', color: '#123abc' })
          expect(res.status).toBe(200)
        },
        allowed: [['projectColors', '/cfg01/new-project']],
      },
      {
        name: 'network change (POST /api/network/configure, loopback persisted configured:true)',
        run: async () => {
          const res = await api(server.baseUrl, 'POST', '/api/network/configure', { host: '127.0.0.1', configured: true })
          expect(res.status).toBe(200)
        },
        allowed: [['settings', 'network']],
      },
    ]

    let before = afterRestart
    for (const c of cases) {
      await c.run()
      const after = await readConfig(homeDir)
      expectDiffWithin(collectDiffPaths(before, after), c.allowed, c.name)
      // The writer's own managed key is pinned by `allowed` (diffWithin) and by
      // entry-containment (survival of every pre-existing entry) — exclude it
      // from the strict bit-for-bit sentinel check only.
      const targetedSentinels = SENTINEL_KEYS.filter((k) => c.allowed.some((a) => a[0] === k))
      expectSentinelsIntact(before, after, c.name, [...targetedSentinels], c.mutates ? [c.mutates] : [])
      before = after
    }

    // ── Cumulative guarantee: against the post-restart snapshot, the ONLY
    // drift in the whole file is the union of the writers' intended paths.
    expectDiffWithin(
      collectDiffPaths(afterRestart, before),
      [
        ['settings', 'safety', 'autoKillIdleMinutes'],
        ['settings', 'network'],
        ['terminalOverrides', 'cfg01-term-rename'],
        ['sessionOverrides', 'claude:cfg01-sess-1'],
        ['projectColors', '/cfg01/new-project'],
      ],
      'cumulative',
    )
    expectSentinelsIntact(
      afterRestart,
      before,
      'cumulative',
      ['terminalOverrides', 'sessionOverrides', 'projectColors'],
    )
    // The server's own minted codex secret survived every writer.
    expect(before.serverSecrets?.codexDisplayIdSecret).toBe(
      afterFirstWrite.serverSecrets?.codexDisplayIdSecret,
    )

    await stopProcessGracefully(server.proc)
  })

  test('boot writers (provider-seed + legacy-seed strip) preserve all sentinels', async () => {
    test.setTimeout(120_000)
    const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-e2e-cfg01-boot-'))
    const emptyExtDir = path.join(homeDir, 'no-extensions')
    await fsp.mkdir(emptyExtDir, { recursive: true })

    // Boot 1: fresh install produces the canonical default file.
    let server = await spawnRustServer(homeDir, emptyExtDir)
    const firstWrite = await readConfigAfterBootWrites(homeDir)
    await stopProcessGracefully(server.proc)

    // Corrupt the normalization inputs the way a legacy/pre-split config does:
    // knownProviders REMOVED (provider-seed trigger) + stray browser-local keys
    // INSIDE settings (seed-strip trigger) + the full sentinel block.
    const regressed: any = {
      ...firstWrite,
      ...sentinelBlock(firstWrite.completedMigrations ?? []),
      settings: {
        ...firstWrite.settings,
        theme: 'dark',
        uiScale: 1.5,
        codingCli: (() => {
          const cc = { ...(firstWrite.settings?.codingCli ?? {}) }
          delete cc.knownProviders
          return cc
        })(),
      },
    }
    delete regressed.legacyLocalSettingsSeed // extraction must CREATE it
    regressed.serverSecrets = {
      ...(firstWrite.serverSecrets ?? {}),
      futureSiblingSecret: 'cfg01-sibling-secret-sentinel',
    }
    await writeConfig(homeDir, regressed)

    // Boot 2 IS the writer under test: one normalization persist must land
    // the seeded knownProviders + the extracted seed, strip the strays, and
    // lose nothing else.
    server = await spawnRustServer(homeDir, emptyExtDir)
    const afterBoot = await readConfig(homeDir)
    await stopProcessGracefully(server.proc)

    expectDiffWithin(
      collectDiffPaths(regressed, afterBoot),
      [
        ['settings', 'codingCli', 'knownProviders'],
        ['settings', 'theme'],
        ['settings', 'uiScale'],
        ['legacyLocalSettingsSeed'],
      ],
      'provider-seed + seed-strip boot persist',
    )
    expect(afterBoot.settings?.codingCli?.knownProviders).toEqual([])
    expect(afterBoot.settings?.theme).toBeUndefined()
    expect(afterBoot.settings?.uiScale).toBeUndefined()
    expect(afterBoot.legacyLocalSettingsSeed?.theme).toBe('dark')
    expect(afterBoot.legacyLocalSettingsSeed?.uiScale).toBe(1.5)
    expectSentinelsIntact(
      { ...regressed, legacyLocalSettingsSeed: afterBoot.legacyLocalSettingsSeed },
      afterBoot,
      'boot normalization persist',
    )
    expect(afterBoot.serverSecrets?.codexDisplayIdSecret).toBe(
      firstWrite.serverSecrets?.codexDisplayIdSecret,
    )
  })
})
