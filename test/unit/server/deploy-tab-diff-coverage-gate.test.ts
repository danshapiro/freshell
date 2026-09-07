// Pins + extends the coverage guard of scripts/deploy-tab-diff.sh.
//
// WHY THIS EXISTS (2026-07-29 incident): the coverage guard -- "which running
// terminals are covered by NO persisted snapshot pane" -- used to live ONLY in
// `verify`, i.e. AFTER the restart, when the uncovered PTYs are already dead.
// 9 of 28 running terminals were killed that way. This suite (a) pins verify's
// guard byte-exactly so the shared-function refactor cannot drift it, and
// (b) drives the new capture-time gate (exit 4, --allow-uncovered).
//
// Harness idiom (fake `curl` on PATH, exit 99 == network call happened) is
// borrowed from test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts -- the
// established way to test this script hermetically. Everything here is
// self-contained: no server, no real network, mkdtemp + finally cleanup.
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
// Resolve from this file, not cwd: vitest workers do not guarantee repo-root cwd.
const SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../scripts/deploy-tab-diff.sh',
)

async function runScript(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(SCRIPT, args, {
      env: { ...process.env, ...env },
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (err: any) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// --- capture-shaped fixture builders (shape mirrors the script's artifact:
// {capturedAt, url, devices:{id:{deviceId,records}}, terminals:[], bundles}) ---
const term = (
  terminalId: string,
  status: 'running' | 'exited',
  extra: Record<string, unknown> = {},
) => ({ terminalId, status, ...extra })

const pane = (
  paneId: string,
  liveTerminalId: string | null,
  mode = 'shell',
  extra: Record<string, unknown> = {},
) => ({
  paneId,
  kind: 'terminal',
  payload: {
    mode,
    sessionRef: null,
    liveTerminal: liveTerminalId ? { terminalId: liveTerminalId } : null,
    ...extra,
  },
})

const openRecord = (tabKey: string, panes: unknown[]) => ({
  status: 'open',
  tabKey,
  tabName: `Tab ${tabKey}`,
  panes,
})

const captureDoc = (terminals: unknown[], records: unknown[]) => ({
  capturedAt: 1000,
  url: 'http://unused.invalid',
  devices: { 'dev-1': { deviceId: 'dev-1', records } },
  terminals,
  bundles: { 'dev-1': { components: ['g-1'], capturedAt: 10 } },
})

// Fake curl that aborts (exit 99) on ANY invocation: proves the code path
// under test performs zero network I/O.
async function makeAbortCurl(tmp: string) {
  const binDir = path.join(tmp, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  await fs.writeFile(
    path.join(binDir, 'curl'),
    '#!/usr/bin/env bash\necho "NETWORK CALL (curl) during offline verify" >&2\nexit 99\n',
    { mode: 0o755 },
  )
  return binDir
}

describe('deploy-tab-diff verify coverage guard (pinned: decision + output must not change)', () => {
  it('FAILs (exit 1) listing every uncovered running terminal as bare "  - id" lines', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      // term-covered: running + covered by a pane. term-orphan: running,
      // covered by NOTHING. term-done: exited -> must NOT be flagged.
      const doc = captureDoc(
        [
          term('term-covered', 'running'),
          term('term-orphan', 'running'),
          term('term-done', 'exited'),
        ],
        [openRecord('t1', [pane('p1', 'term-covered')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(1)
      expect(r.code).not.toBe(99) // offline mode made zero network calls
      expect(r.out).not.toContain('NETWORK CALL')
      // Byte-exact header (script line "FAIL: ${n} running terminal(s)..."):
      expect(r.out).toContain(
        'FAIL: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      // verify's list is bare ids by contract -- NOT the enriched capture format.
      expect(r.out).toMatch(/^ {2}- term-orphan$/m)
      expect(r.out).not.toMatch(/^ {2}- term-covered$/m)
      expect(r.out).not.toContain('term-done')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('passes the guard and reports OK (exit 0) when every running terminal is covered', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      const doc = captureDoc(
        [term('term-covered', 'running')],
        [openRecord('t1', [pane('p1', 'term-covered')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      // --after = same file: identity diff is trivially clean, so this exits 0
      // only if the coverage guard passed.
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain('OK: every previously-live pane came back with the same session identity.')
      expect(r.out).not.toContain('FAIL')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

// --- capture-side fixtures: a URL-routed fake curl serving canned responses.
// Route on the URL (curl's last argv), not call order: capture fetches the
// index twice (coherence re-check) and identical content keeps it coherent.
async function makeRoutedCurl(
  tmp: string,
  fixtures: { index: unknown; device: unknown; terminals: unknown },
) {
  const binDir = path.join(tmp, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  const indexFile = path.join(tmp, 'fixture-index.json')
  const deviceFile = path.join(tmp, 'fixture-device.json')
  const terminalsFile = path.join(tmp, 'fixture-terminals.json')
  await fs.writeFile(indexFile, JSON.stringify(fixtures.index))
  await fs.writeFile(deviceFile, JSON.stringify(fixtures.device))
  await fs.writeFile(terminalsFile, JSON.stringify(fixtures.terminals))
  await fs.writeFile(
    path.join(binDir, 'curl'),
    '#!/usr/bin/env bash\n' +
    'set -euo pipefail\n' +
    'url="${!#}"\n' +
    'case "$url" in\n' +
    '  */api/tabs-sync/snapshots/dev-1) cat "$FAKE_DEVICE" ;;\n' +
    '  */api/tabs-sync/snapshots) cat "$FAKE_INDEX" ;;\n' +
    '  */api/terminals) cat "$FAKE_TERMINALS" ;;\n' +
    '  *) echo "unexpected URL: $url" >&2; exit 91 ;;\n' +
    'esac\n',
    { mode: 0o755 },
  )
  return {
    binDir,
    env: { FAKE_INDEX: indexFile, FAKE_DEVICE: deviceFile, FAKE_TERMINALS: terminalsFile },
  }
}

const INDEX = {
  devices: [
    {
      deviceId: 'dev-1',
      capturedAt: 20,
      generations: [
        { generation: 1, generationId: 'g-1', clientInstanceId: 'c-1', capturedAt: 10, snapshotRevision: 1 },
      ],
    },
  ],
}

const DEVICE = (records: unknown[]) => ({
  deviceId: 'dev-1',
  deviceLabel: 'Device',
  snapshotRevision: 1,
  capturedAt: 20,
  records,
})

describe('deploy-tab-diff capture coverage gate', () => {
  it('halts with exit 4 on uncovered running terminals, still writes the artifact, and lists them enriched with mode/cwd/title/session', { timeout: 120_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const terminals = [
        term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' }),
        // sessionRef present -> the report must classify it session=claude
        // (session identity survives a restart via manual recovery even though
        // the pane/PTY is lost). /api/terminals emits sessionRef as an OBJECT
        // {provider, sessionId}, omitted entirely for plain shells.
        term('term-orphan', 'running', {
          mode: 'claude',
          title: 'Orphan work',
          cwd: '/home/dan/proj',
          sessionRef: { provider: 'claude', sessionId: 's-orphan' },
        }),
      ]
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals,
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      // DISTINCT exit code: 4 = "capture succeeded but restore would lose
      // terminals" (1 = capture unusable, 2 = usage, 3 = internal-only).
      expect(r.code).toBe(4)
      expect(r.out).toContain(
        'FAIL: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      // Enriched list: id + mode/cwd/title/session pulled from the artifact's
      // own .terminals[] (session=<provider> because sessionRef is present).
      expect(r.out).toContain('  - term-orphan (mode=claude, cwd=/home/dan/proj, title=Orphan work, session=claude)')
      expect(r.out).not.toMatch(/- term-covered/)
      // The artifact WAS written (needed for diagnosis) and messaging says so.
      expect(r.out).toMatch(/WAS written to/)
      expect(r.out).toContain('captured 1 device snapshot(s), 2 running terminal(s)')
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(2)
      expect(Object.keys(artifact.devices)).toEqual(['dev-1'])
      // The override is advertised on the failure path.
      expect(r.out).toContain('--allow-uncovered')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('exits 0 with the normal summary when every running terminal is covered', { timeout: 120_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals: [term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' })],
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain('captured 1 device snapshot(s), 1 running terminal(s)')
      expect(r.out).not.toContain('FAIL')
      expect(r.out).not.toContain('WARNING')
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(1)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('--allow-uncovered downgrades the gap to a WARNING and exits 0', { timeout: 120_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const terminals = [
        term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' }),
        // Deliberately NO sessionRef here: this test exercises the other
        // classifier branch (session=none = unrecoverable outright).
        term('term-orphan', 'running', { mode: 'claude', title: 'Orphan work', cwd: '/home/dan/proj' }),
      ]
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals,
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out, '--allow-uncovered'],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.out).toContain(
        'WARNING: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      expect(r.out).toContain('  - term-orphan (mode=claude, cwd=/home/dan/proj, title=Orphan work, session=none)')
      expect(r.out).not.toContain('FAIL')
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(2)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('deploy-tab-diff --help', () => {
  it('documents the coverage gate: exit 4 and --allow-uncovered', async () => {
    // --help is parsed inside the flag loop, so it needs a leading subcommand.
    const r = await runScript(['capture', '--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('--allow-uncovered')
    expect(r.out).toContain('4 capture coverage gap')
  })
})

// Kata 3gvd pins: the continuity gates the in-TUI resume work (Tasks 1-5)
// relies on must keep failing CLOSED for codex panes — an unresolved coding
// pane is an explicit hard failure, never a recoverable pass.
describe('codex pane identity verdicts (kata 3gvd pins)', () => {
  it('verify FAILs (exit 1) a captured open codex pane with NO sessionRef as NO CAPTURED IDENTITY', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      // A live coding-CLI pane captured WITHOUT a sessionRef is unverifiable
      // by construction: restore can only ever build a blank session for it.
      const doc = captureDoc(
        [term('term-codex', 'running', { mode: 'codex', title: 'Codex work', cwd: '/home/dan/proj' })],
        [openRecord('t1', [pane('p-codex', 'term-codex', 'codex')])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(1)
      expect(r.code).not.toBe(99) // offline mode made zero network calls
      expect(r.out).not.toContain('NETWORK CALL')
      expect(r.out).toContain('================ TAB-DIFF DIVERGENCE (1) ================')
      // The verdict row carries the pane's full identity coordinates.
      expect(r.out).toMatch(
        /NO CAPTURED IDENTITY\tdevice=dev-1\ttab=Tab t1 \(t1\)\tpane=p-codex\tkind=terminal\twas=-:-/,
      )
      // NO-IDENTITY panes are excluded from snapshot remediation: no snapshot
      // can carry an identity that was never captured, so the manual-recovery
      // note is emitted instead of the UI recovery flow.
      expect(r.out).toContain('UNRECOVERABLE FROM SNAPSHOTS')
      expect(r.out).toMatch(/ {2}NO-IDENTITY device=dev-1\ttab=Tab t1 \(t1\)\tpane=p-codex\tmode=codex/)
      // Fail-closed: the unresolved coding pane NEVER passes as recoverable.
      expect(r.out).not.toContain('OK: every previously-live pane came back')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('verify passes (exit 0) when the captured codex pane carried a sessionRef that the after doc reproduces', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const binDir = await makeAbortCurl(tmp)
      const before = path.join(tmp, 'before.json')
      // Treatment/control pair with the previous case — proves the harness
      // distinguishes true fail-closed behavior from a vacuous pass: same
      // shape, but payload.sessionRef {provider: 'codex'} is present in both
      // before and after docs, so the identity diff finds no divergence.
      const doc = captureDoc(
        [term('term-codex', 'running', { mode: 'codex', title: 'Codex work', cwd: '/home/dan/proj' })],
        [openRecord('t1', [
          pane('p-codex', 'term-codex', 'codex', {
            sessionRef: { provider: 'codex', sessionId: 's-codex-1' },
          }),
        ])],
      )
      await fs.writeFile(before, JSON.stringify(doc))
      const r = await runScript(
        ['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', before],
        { PATH: `${binDir}:${process.env.PATH}` },
      )
      expect(r.code).toBe(0)
      expect(r.code).not.toBe(99) // offline mode made zero network calls
      expect(r.out).toContain('OK: every previously-live pane came back with the same session identity.')
      expect(r.out).not.toContain('FAIL')
      expect(r.out).not.toContain('NO CAPTURED IDENTITY')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('capture halts (exit 4) and lists an uncovered running codex terminal enriched with session=none', { timeout: 120_000 }, async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-gate-'))
    try {
      const terminals = [
        term('term-covered', 'running', { mode: 'shell', title: 'Covered', cwd: '/tmp' }),
        // Deliberately NO sessionRef: a codex terminal covered by NO persisted
        // pane is unrecoverable outright — session=none is the operator-
        // visible "never recoverable" signal for exactly that class.
        term('term-codex', 'running', { mode: 'codex', title: 'Codex work', cwd: '/home/dan/proj' }),
      ]
      const { binDir, env } = await makeRoutedCurl(tmp, {
        index: INDEX,
        device: DEVICE([openRecord('t1', [pane('p1', 'term-covered')])]),
        terminals,
      })
      const out = path.join(tmp, 'before.json')
      const r = await runScript(
        ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out],
        { ...env, PATH: `${binDir}:${process.env.PATH}` },
      )
      // 4 = coverage gap (distinct from 1 = capture unusable).
      expect(r.code).toBe(4)
      expect(r.out).toContain(
        'FAIL: 1 running terminal(s) at capture are covered by NO persisted snapshot pane (tabs-sync persistence/coverage gap):',
      )
      // Enriched row: mode/cwd/title pulled from the artifact's own
      // .terminals[]; session=none because no sessionRef was captured.
      expect(r.out).toContain('  - term-codex (mode=codex, cwd=/home/dan/proj, title=Codex work, session=none)')
      expect(r.out).not.toMatch(/- term-covered/)
      // The artifact WAS written (needed for diagnosis) and messaging says so.
      expect(r.out).toMatch(/WAS written to/)
      const artifact = JSON.parse(await fs.readFile(out, 'utf8'))
      expect(artifact.terminals).toHaveLength(2)
      expect(r.out).toContain('--allow-uncovered')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
