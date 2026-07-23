import { test, expect } from '../helpers/fixtures.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * CONTINUITY TRIO deliverable 3 acceptance
 * (docs/plans/2026-07-22-continuity-safety-trio.md): the pre/post-restart
 * `scripts/deploy-tab-diff.sh` ritual, end-to-end.
 *
 *   (1) LIVE: capture -> restart -> verify passes when identity survives;
 *       then a provably-removed codex pane makes verify FAIL LOUDLY
 *       (non-zero exit, named tab, MISSING verdict, remediation line), and
 *       EXECUTING the printed `--components` bundle remediation brings the
 *       session back -- proven by the fake-CLI argv `resume <sessionId>` log.
 *   (2) OFFLINE: a deterministic diff-engine run (`verify --before F --after F`)
 *       over synthetic fixtures exercises ALL FOUR verdicts, the
 *       partial-coverage set-difference guard, and the multi-client bundle
 *       remediation -- with a fake `curl` proving verify makes ZERO network
 *       calls in --after mode.
 *
 * Rust-only: legacy has no persisted snapshot generations. Registered ONLY
 * under `rust-chromium`; testIgnore'd via RUST_ONLY_SPECS everywhere else.
 *
 * EPHEMERAL-ONLY SAFETY: the server is constructed DIRECTLY via `new
 * RustServer(...)` -- throwaway binary, ephemeral loopback port, mkdtemp HOME.
 * NEVER `createE2eServerHandle(process.env, ...)`: with FRESHELL_E2E_TARGET_URL
 * set it silently retargets to an already-running (possibly LIVE) server.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')

const run = promisify(execFile)
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

async function installFakeCodexCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  await fs.copyFile(FAKE_CODEX_CLI_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
}

// Fake-CLI argv resume proof (copied from codex-terminal-bounce-rust.spec.ts:75-85).
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] })
}
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

async function connect(page: import('@playwright/test').Page, info: any): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

async function tabDiff(args: string[]) {
  try {
    const { stdout } = await run('scripts/deploy-tab-diff.sh', args, { cwd: process.cwd() })
    return { code: 0, out: stdout }
  } catch (err: any) {
    return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// Provably remove the CURRENT codex pane: find the codex tab from Redux (NOT a
// stale pre-restart terminalId) and click its tab-strip close button
// (data-tab-id + role=button name=/close/, exactly as tab-management.spec.ts:61-70).
async function closeCodexTab(page: import('@playwright/test').Page, harness: TestHarness) {
  const before = await harness.getTabCount()
  const st = await harness.getState()
  const codexTab = st.tabs.tabs.find((t: any) => t.mode === 'codex')
  expect(codexTab, 'a codex tab exists to close').toBeTruthy()
  await page.locator(`[data-tab-id="${codexTab.id}"]`).getByRole('button', { name: /close/i }).click()
  await harness.waitForTabCount(before - 1) // proves the pane is gone
}

test.describe('deploy tab-diff ritual (rust only, ephemeral server)', () => {
  test('verify passes when identity survives a restart and fails loudly + remediates when it does not', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust') // rust-only guard (also in every match-all project's testIgnore)
    test.setTimeout(240_000)
    // EPHEMERAL-ONLY: new RustServer(...) directly (never createE2eServerHandle).
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fakecodex-'))
    const argLogPath = path.join(sharedRoot, 'argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const fakeCodexPath = await installFakeCodexCli(path.join(sharedRoot, 'bin'))
    const server = new RustServer({
      // CODEX_CMD + FAKE_CODEX_ARGV_LOG wiring copied from codex-terminal-bounce-rust.spec.ts.
      env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
      setupHome: async (homeDir) => {
        // Config seeding copied from codex-terminal-bounce-rust.spec.ts /
        // snapshot-restore-rust.spec.ts: enabled providers + a real-reader
        // codex session seed (`session_meta` + message records) so
        // `codex resume <SESSION_ID>` targets an existing session.
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: {
            codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
          },
        }, null, 2))

        const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
        await fs.mkdir(codexSessionsDir, { recursive: true })
        const lines = [
          JSON.stringify({
            timestamp: '2026-07-21T08:00:00.000Z',
            type: 'session_meta',
            payload: { id: SESSION_ID, cwd: projectDir },
          }),
          JSON.stringify({
            timestamp: '2026-07-21T08:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'deploy-tab-diff seeded request 1' }],
            },
          }),
          JSON.stringify({
            timestamp: '2026-07-21T08:00:02.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'deploy-tab-diff seeded reply 1' }],
            },
          }),
        ]
        await fs.writeFile(
          path.join(codexSessionsDir, `${SESSION_ID}.jsonl`),
          `${lines.join('\n')}\n`,
        )
      },
    })
    const info = await server.start()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-'))
    const before = path.join(tmpDir, 'before.json')
    const before2 = path.join(tmpDir, 'before2.json')
    const auth = { 'x-auth-token': info.token, 'content-type': 'application/json' }
    const capturedAtOf = async (f: string) => JSON.parse(await fs.readFile(f, 'utf8')).capturedAt
    const codexPaneSession = async (harness: TestHarness) => {
      const st = await harness.getState()
      const tab = st.tabs.tabs.find((t: any) => t.mode === 'codex')
      if (!tab) return null
      return (await harness.getPaneLayout(tab.id))?.content?.sessionRef?.sessionId ?? null
    }
    try {
      const harness = await connect(page, info)
      // one identity pane + one plain pane. Unwrap the {status,data,message} envelope.
      const codex = await (await fetch(`${info.baseUrl}/api/tabs`, { method: 'POST', headers: auth,
        body: JSON.stringify({ mode: 'codex', name: 'work',
          sessionRef: { provider: 'codex', sessionId: SESSION_ID } }) })).json()
      expect(codex.data.terminalId).toBeTruthy()
      await fetch(`${info.baseUrl}/api/tabs`, { method: 'POST', headers: auth,
        body: JSON.stringify({ mode: 'shell', name: 'sh' }) })
      // wait for a persisted generation carrying both tabs (union recordCount)
      await expect(async () => {
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.recordCount >= 2)).toBe(true)
      }).toPass({ timeout: 30_000 })

      // -- CAPTURE --
      expect((await tabDiff(['capture', '--url', info.baseUrl, '--token', info.token, '--out', before])).code).toBe(0)

      // -- HAPPY PATH: restart, wait for WS reconnect (getWsReadyState), respawn + fresh push --
      await server.restart()
      await expect(async () => {
        const ready = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(ready).toBe('ready')
      }).toPass({ timeout: 60_000 })
      const beforeCap = await capturedAtOf(before)
      await expect(async () => {
        expect(await codexPaneSession(harness)).toBe(SESSION_ID) // respawned, same identity (Redux)
        const terms = await (await fetch(`${info.baseUrl}/api/terminals`, { headers: auth })).json()
        expect(terms.some((t: any) => t.mode === 'codex')).toBe(true) // RAW array; codex has no sessionRef here
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.generations[0]?.capturedAt > beforeCap)).toBe(true)
      }).toPass({ timeout: 60_000 })
      const ok = await tabDiff(['verify', '--url', info.baseUrl, '--token', info.token, '--before', before])
      expect(ok.out).toContain('OK: every previously-live pane came back')
      expect(ok.code).toBe(0)

      // -- FAILURE PATH: capture the (good) state, then PROVABLY remove the codex pane --
      expect((await tabDiff(['capture', '--url', info.baseUrl, '--token', info.token, '--out', before2])).code).toBe(0)
      await closeCodexTab(page, harness) // codex tabKey leaves the next push
      const before2Cap = await capturedAtOf(before2)
      await expect(async () => { // wait until the codex-less push lands
        const r = await (await fetch(`${info.baseUrl}/api/tabs-sync/snapshots`, { headers: auth })).json()
        expect(r.devices.some((d: any) => d.generations[0]?.capturedAt > before2Cap)).toBe(true)
      }).toPass({ timeout: 30_000 })

      const tabCountBeforeRemediation = await harness.getTabCount() // codex closed; shell survives
      const bad = await tabDiff(['verify', '--url', info.baseUrl, '--token', info.token, '--before', before2])
      expect(bad.code).not.toBe(0)                         // exits non-zero
      expect(bad.out).toContain('TAB-DIFF DIVERGENCE')     // loud
      expect(bad.out).toMatch(/MISSING/)                   // names the category (closed codex pane)
      expect(bad.out).toContain('tab=work')                // names the diverged tab
      expect(bad.out).toContain('scripts/restore-tabs.sh') // prints the remediation
      // Remediation references the immutable multi-client BUNDLE (--components,
      // stable digests), NEVER a single-client --generation-id (:2621), and is
      // TARGETED (:175): one --pane per diverged pane, so still-healthy panes
      // are never re-restored.
      expect(bad.out).toMatch(/--components [0-9a-f,]+/)
      expect(bad.out).toMatch(/--pane \S+/)
      expect(bad.out).not.toMatch(/--generation-id/)
      expect(bad.out).not.toMatch(/--generation \d/)

      // -- EXECUTE the printed remediation (substituting the real token) and prove
      //    the missing codex session comes back. Only 1 browser connected -> the
      //    restore exactly-one-client gate allows it. --
      const comps = bad.out.match(/--components ([0-9a-f,]+)/)![1]
      const dev = bad.out.match(/--device (\S+)/)![1]
      // The printed pane keys are %q-quoted for the shell; strip backslash
      // escapes when passing them as direct argv entries.
      const paneArgs = [...bad.out.matchAll(/--pane (\S+)/g)]
        .flatMap((m) => ['--pane', m[1].replace(/\\/g, '')])
      expect(paneArgs.length).toBeGreaterThan(0)
      const argvBefore = (await readArgvLog(argLogPath)).length
      const rem = await run('scripts/restore-tabs.sh',
        ['--url', info.baseUrl, '--token', info.token, '--device', dev, '--components', comps, ...paneArgs],
        { cwd: process.cwd() })
      expect(rem.stdout).toContain('failed=0')
      await expect(async () => {
        expect(await codexPaneSession(harness)).toBe(SESSION_ID) // the session identity returned
      }).toPass({ timeout: 20_000 })
      // RESUME PROOF: the remediation re-spawned codex with `resume <sessionId>`
      // (argv-log delta), not plain `codex` -- identity echo alone is insufficient.
      await expect(async () => {
        const entries = (await readArgvLog(argLogPath)).slice(argvBefore)
        expect(entries.some((e) => hasResumePair(e.argv, SESSION_ID)),
          'remediation must exec `codex resume <sessionId>`').toBe(true)
      }).toPass({ timeout: 20_000 })
      // TARGETED (:175): ONLY the missing codex pane was restored -- the
      // surviving shell pane is NOT duplicated and the total tab count is
      // exactly the pre-failure count (codex back, shell untouched).
      await expect(async () => {
        const st = await harness.getState()
        const shellTabs = st.tabs.tabs.filter((t: any) => t.title === 'sh' || t.name === 'sh')
        expect(shellTabs.length, 'surviving shell tab must not be duplicated').toBeLessThanOrEqual(1)
        expect(await harness.getTabCount()).toBe(tabCountBeforeRemediation + 1) // codex back, nothing else
      }).toPass({ timeout: 20_000 })
    } finally {
      await server.stop()
      await fs.rm(tmpDir, { recursive: true, force: true })
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // (2) DETERMINISTIC OFFLINE diff-engine coverage: drive `verify --before F
  // --after F` over synthetic fixtures so ALL FOUR verdicts, the full-set-difference
  // coverage guard, and the multi-client bundle remediation are exercised (the live
  // path can only produce MISSING). With --after supplied verify does ZERO network
  // ops (:2619) -- proven by prepending a fake `curl` that ABORTS if invoked.
  test('verify classifies verdicts, guards partial coverage, remediates via bundle -- fully offline', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-unit-'))
    // A fake `curl` that aborts (exit 99) on ANY invocation -- the offline guard.
    const binDir = path.join(tmp, 'bin'); await fs.mkdir(binDir)
    await fs.writeFile(path.join(binDir, 'curl'),
      '#!/usr/bin/env bash\necho "NETWORK CALL (curl) during offline verify" >&2\nexit 99\n', { mode: 0o755 })
    const runOffline = async (args: string[]) => {
      try {
        const { stdout, stderr } = await run('scripts/deploy-tab-diff.sh', args,
          { cwd: process.cwd(), env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } })
        return { code: 0, out: `${stdout}${stderr}` }
      } catch (err: any) {
        return { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
    }
    const write = async (name: string, doc: unknown) => {
      const p = path.join(tmp, name); await fs.writeFile(p, JSON.stringify(doc)); return p
    }
    const term = (id: string, status: string) => ({ terminalId: id, status })
    const pane = (kind: string, extra: any) => ({ paneId: `p-${kind}`, kind, payload: extra })
    const rec = (tabKey: string, panes: any[]) =>
      ({ tabKey, tabId: tabKey, tabName: tabKey, status: 'open', revision: 1, updatedAt: 1, paneCount: panes.length, panes })
    // `bundles` carries the immutable per-device component ids (two clients here).
    const doc = (capturedAt: number, records: any[], terminals: any[], bundles: any = {}) =>
      ({ capturedAt, url: 'http://unused.invalid', devices: { 'dev-1': { deviceId: 'dev-1', records } }, terminals, bundles })

    const before = await write('before.json', doc(1000, [
      rec('dev-1:codexMiss', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-miss' } })]),
      rec('dev-1:codexRepoint', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-old' } })]),
      rec('dev-1:codexFresh', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-fresh' } })]),
      rec('dev-1:sh', [pane('terminal', { mode: 'shell', liveTerminal: { terminalId: 'T-live' } })]),
    ], [term('T-live', 'running'), term('T-exited', 'exited')],
    { 'dev-1': { components: ['aaaa1111', 'bbbb2222'], capturedAt: 1000 } })) // TWO-client bundle
    const after = await write('after.json', doc(2000, [
      rec('dev-1:codexRepoint', [pane('terminal', { mode: 'codex', sessionRef: { provider: 'codex', sessionId: 'S-new' } })]),
      rec('dev-1:codexFresh', [pane('terminal', { mode: 'codex' })]),
      rec('dev-1:sh', [pane('terminal', { mode: 'shell', liveTerminal: { terminalId: 'T-gone' } })]),
    ], []))
    const d = await runOffline(['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', before, '--after', after])
    expect(d.code).not.toBe(0)
    expect(d.code).not.toBe(99)                       // curl was NEVER called (:2619)
    expect(d.out).not.toContain('NETWORK CALL')
    expect(d.out).toContain('MISSING')
    expect(d.out).toContain('RE-POINTED')
    expect(d.out).toContain('FRESH (identity lost)')
    expect(d.out).toContain('NOT RESPAWNED')
    // Remediation uses the immutable MULTI-CLIENT bundle (BOTH component ids), not
    // a single-client --generation-id (:2621).
    expect(d.out).toMatch(/--components aaaa1111,bbbb2222/)
    expect(d.out).not.toMatch(/--generation-id/)
    // ...and is TARGETED (:175): one --pane per diverged paneKey, so a restore
    // of the whole union (which would duplicate healthy panes) is never printed.
    for (const key of [
      'dev-1:codexMiss#p-terminal',
      'dev-1:codexRepoint#p-terminal',
      'dev-1:codexFresh#p-terminal',
      'dev-1:sh#p-terminal',
    ]) {
      expect(d.out).toContain(`--pane ${key}`)
    }

    // PARTIAL-coverage guard (:2559): TWO running terminals, only ONE covered by a
    // snapshot pane -> still FAILS, LISTING the uncovered one (not a silent OK).
    const beforePartial = await write('partial.json', doc(1000, [
      rec('dev-1:sh', [pane('terminal', { mode: 'shell', liveTerminal: { terminalId: 'T-covered' } })]),
    ], [term('T-covered', 'running'), term('T-uncovered', 'running')]))
    const afterPartial = await write('partialafter.json', doc(2000, [], []))
    const g = await runOffline(['verify', '--url', 'http://unused.invalid', '--token', 't', '--before', beforePartial, '--after', afterPartial])
    expect(g.code).not.toBe(0)
    expect(g.code).not.toBe(99)
    expect(g.out).toMatch(/coverage gap/i)
    expect(g.out).toContain('T-uncovered')            // names the uncovered terminal
    expect(g.out).not.toContain('T-covered')          // the covered one is NOT flagged
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('capture rejects same-digest generation churn and preserves the prior artifact', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tabdiff-coherence-'))
    try {
      const binDir = path.join(tmp, 'bin')
      await fs.mkdir(binDir)
      const counter = path.join(tmp, 'counter')
      const pre = path.join(tmp, 'pre.json')
      const post = path.join(tmp, 'post.json')
      const snapshot = path.join(tmp, 'snapshot.json')
      const terminals = path.join(tmp, 'terminals.json')
      const out = path.join(tmp, 'capture.json')
      const generation = (
        generationIndex: number,
        generationId: string,
        clientInstanceId: string,
        capturedAt: number,
        snapshotRevision: number,
      ) => ({ generation: generationIndex, generationId, clientInstanceId, capturedAt, snapshotRevision })
      await fs.writeFile(pre, JSON.stringify({ devices: [{
        deviceId: 'dev-1',
        generations: [
          generation(0, 'digest-a', 'client-a', 20, 2),
          generation(1, 'digest-b', 'client-b', 10, 1),
        ],
      }] }))
      // The digest multiset is unchanged, but ownership/order metadata changes
      // which file is newest for each client.
      await fs.writeFile(post, JSON.stringify({ devices: [{
        deviceId: 'dev-1',
        generations: [
          generation(0, 'digest-b', 'client-a', 30, 3),
          generation(1, 'digest-a', 'client-b', 20, 2),
        ],
      }] }))
      await fs.writeFile(snapshot, JSON.stringify({
        deviceId: 'dev-1', deviceLabel: 'Device', capturedAt: 20,
        records: [], clientInstanceId: 'client-a', snapshotRevision: 2,
      }))
      await fs.writeFile(terminals, '[]')
      await fs.writeFile(out, 'PRIOR_GOOD_ARTIFACT')
      await fs.writeFile(path.join(binDir, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
n=0
if [[ -f "$FAKE_CURL_COUNTER" ]]; then n=$(<"$FAKE_CURL_COUNTER"); fi
n=$((n + 1))
printf '%s' "$n" > "$FAKE_CURL_COUNTER"
case $(((n - 1) % 4)) in
  0) cat "$FAKE_CURL_PRE" ;;
  1) cat "$FAKE_CURL_SNAPSHOT" ;;
  2) cat "$FAKE_CURL_TERMINALS" ;;
  3) cat "$FAKE_CURL_POST" ;;
esac
`, { mode: 0o755 })

      let result: { code: number, out: string }
      try {
        const { stdout, stderr } = await run(
          'scripts/deploy-tab-diff.sh',
          ['capture', '--url', 'http://unused.invalid', '--token', 't', '--out', out],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH}`,
              FAKE_CURL_COUNTER: counter,
              FAKE_CURL_PRE: pre,
              FAKE_CURL_POST: post,
              FAKE_CURL_SNAPSHOT: snapshot,
              FAKE_CURL_TERMINALS: terminals,
            },
          },
        )
        result = { code: 0, out: `${stdout}${stderr}` }
      } catch (err: any) {
        result = { code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
      expect(result.code).not.toBe(0)
      expect(result.out).toMatch(/generation index changed mid-capture|server too busy/i)
      expect(await fs.readFile(out, 'utf8')).toBe('PRIOR_GOOD_ARTIFACT')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
