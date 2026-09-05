import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { externalTargetConfigured } from '../helpers/external-target.js'
import {
  captureHostListeningPorts,
  captureResourceSnapshot,
  captureStableBaseline,
  diffSnapshots,
  type ResourceSnapshot,
  type SnapshotDiff,
} from '../helpers/leak-metrics.js'

/**
 * HARNESS-12 — "Add leak and resource measurements. Capture server/Tauri/
 * provider child PIDs, handles, RSS, queue sizes, and listening ports before
 * and after stress scenarios."
 *
 * Playwright validation (checklist text): "A repeated create/send/close/
 * restart loop returns to a bounded resource baseline, leaves no owned
 * process or port behind, and fails with a retained process-tree artifact if
 * the bound is exceeded."
 *
 * What this spec proves on BOTH server kinds (legacy-chromium +
 * rust-chromium matrix projects, routed by the HARNESS-02 `e2eServerKind`
 * fixture):
 *  1. The `leak-metrics` collector (helpers/leak-metrics.ts — logic unit-
 *     tested fixture-driven in leak-metrics.test.ts) captures the OWNED
 *     server's resource reality mid-stress: the REST-created PTY shells show
 *     up as descendant processes with RSS/fd/thread counts, the server's
 *     single LISTEN port is attributed, and per-socket queue bytes are read.
 *  2. A bounded create→send→close×6 loop, followed by a WS `terminal.kill`
 *     per tab (the canonical server-side reap path on both servers —
 *     `DELETE /api/tabs/:id` deliberately only drops layout bookkeeping),
 *     leaves NO process behind that was not already in the steady-state
 *     baseline: no new listening ports, no survivor outside the baseline
 *     live-pid set, no lingering zombie, no fd-handle/process growth, RSS
 *     within a leak-gate bound, and socket queues drained. Every run retains
 *     a process-tree artifact attachment; on bound violation the failure also
 *     lands as `leak-metrics-process-tree.json` in the Playwright output dir.
 *  3. Restart boots back to exactly one listener with no inherited children;
 *     stop leaves no owned process alive and the port freed host-wide.
 *
 * The stress is deliberately small and polite (6 short-lived shells, no
 * soaks) — this is a harness deliverable for the future serial stress
 * project, not the stress project itself.
 *
 * Skipped against an external target (FRESHELL_E2E_TARGET_URL): that handle
 * is not ours (pid -1) and must never be measured or stopped.
 */

test.describe.configure({ mode: 'serial' })

const ITERATIONS = 6

/**
 * Live (non-zombie) processes. Both servers transiently reap children through
 * a brief Z-state window (e.g. the legacy server’s `git rev-parse` probe per
 * tab create — observed as a `git:Z` descendant under load); a zombie holds
 * no RSS/fds and is a reap-latency artifact, not a leak, so growth/settle
 * comparisons run on live processes only. A zombie that NEVER reaps would
 * still fail the final settle poll, so nothing real is masked.
 */
function liveProcesses(snap: ResourceSnapshot): ResourceSnapshot['processes'] {
  return snap.processes.filter((p) => p.state !== 'Z')
}

/** Envelope shared by both servers: `{status:"ok", data:{...}}` (rust ok_json / legacy mirror). */
function unwrapData(body: unknown): any {
  if (body && typeof body === 'object' && 'data' in (body as object)) return (body as any).data
  return body
}

async function createShellTab(
  baseUrl: string,
  token: string,
): Promise<{ tabId: string; paneId: string; terminalId: string }> {
  const res = await fetch(`${baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ mode: 'shell', cwd: os.tmpdir() }),
  })
  if (!res.ok) throw new Error(`POST /api/tabs failed: ${res.status} ${await res.text()}`)
  const data = unwrapData(await res.json())
  if (!data.tabId || !data.paneId || !data.terminalId) {
    throw new Error(`POST /api/tabs response missing fields: ${JSON.stringify(data)}`)
  }
  return { tabId: data.tabId, paneId: data.paneId, terminalId: data.terminalId }
}

async function sendKeys(baseUrl: string, token: string, paneId: string, data: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/panes/${encodeURIComponent(paneId)}/send-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) throw new Error(`send-keys failed: ${res.status} ${await res.text()}`)
}

async function waitForPattern(
  baseUrl: string,
  token: string,
  paneId: string,
  pattern: string,
  timeoutSeconds = 15,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/panes/${encodeURIComponent(paneId)}/wait-for?pattern=${encodeURIComponent(pattern)}&T=${timeoutSeconds}`,
    { headers: { 'x-auth-token': token } },
  )
  if (!res.ok) throw new Error(`wait-for failed: ${res.status} ${await res.text()}`)
  const body = unwrapData(await res.json())
  if (!body.matched) throw new Error(`wait-for did not match /${pattern}/ within ${timeoutSeconds}s`)
}

async function deleteTab(baseUrl: string, token: string, tabId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tabs/${encodeURIComponent(tabId)}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': token },
  })
  if (!res.ok) throw new Error(`DELETE /api/tabs/${tabId} failed: ${res.status} ${await res.text()}`)
}

/**
 * The canonical server-side PTY reap path on BOTH servers: a raw WS client
 * sends `hello`, ATTACHES to the terminal (uniform `terminal.attach.ready`
 * ack — legacy server/terminal-stream/broker.ts:505; rust
 * crates/freshell-ws/src/terminal.rs attach flow), then `terminal.kill`
 * (legacy ws-handler.ts:3073 → registry.killAndWait; rust terminal.rs:4482 —
 * SIGKILL + reap) and waits for the `terminal.exit` edge. The attach step is
 * not optional on legacy: its registry only `safeSend`s `terminal.exit` to
 * clients in `record.clients` (terminal-registry.ts:1542), so an unattached
 * observer would wait forever for a frame that never comes.
 */
async function killTerminalViaWs(wsUrl: string, token: string, terminalId: string): Promise<void> {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no terminal.exit for ${terminalId} within 15s`)), 15_000)
      let attached = false
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: 8, token }))
      })
      ws.on('message', (raw) => {
        let frame: any
        try {
          frame = JSON.parse(String(raw))
        } catch {
          return
        }
        if (frame.type === 'ready' && !attached) {
          // Client-shaped attach (src/components/terminal-view-utils.ts
          // buildTerminalAttachMessage): legacy schema-validates intent/cols/
          // rows, and the same shape is accepted by the rust attach flow.
          ws.send(JSON.stringify({
            type: 'terminal.attach',
            terminalId,
            intent: 'viewport_hydrate',
            cols: 80,
            rows: 24,
            sinceSeq: 0,
            attachRequestId: `harness12-kill-${terminalId}`,
            priority: 'background',
          }))
        }
        if (frame.type === 'terminal.attach.ready' && frame.terminalId === terminalId) {
          attached = true
          ws.send(JSON.stringify({ type: 'terminal.kill', terminalId }))
        }
        if (frame.type === 'terminal.exit' && frame.terminalId === terminalId) {
          clearTimeout(timer)
          resolve()
        }
        if (frame.type === 'error') {
          clearTimeout(timer)
          reject(new Error(`WS kill failed for ${terminalId}: ${JSON.stringify(frame)}`))
        }
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  } finally {
    try { ws.close() } catch { /* already closed */ }
  }
}

async function attachArtifact(
  testInfo: import('@playwright/test').TestInfo,
  name: string,
  before: ResourceSnapshot | null,
  after: ResourceSnapshot,
  diff: SnapshotDiff | null,
): Promise<void> {
  const body = JSON.stringify({ before, after, diff }, null, 2)
  await testInfo.attach(name, { body, contentType: 'application/json' })
}

test.describe('HARNESS-12 leak/resource measurements', () => {
  test('create/send/close loop returns to a bounded resource baseline', async ({ testServer, serverInfo }, testInfo) => {
    test.skip(externalTargetConfigured(), 'leak metrics require an owned server pid (external target is not ours)')
    const { baseUrl, token, wsUrl, port } = serverInfo
    const pid = testServer.info.pid
    expect(pid).toBeGreaterThan(0)

    // Baseline must be the server's STEADY STATE, captured at a fixed point
    // of the live-pid set — NOT the first moment no zombie exists. Gate B003
    // (2026-08-09) proved the zombies==0-only gate unsound on the plain
    // chromium project: the legacy server's WSL2 startup children
    // (`ipconfig.exe` from bootstrap.ts LAN-IP detection, awaited pre-listen;
    // `netsh.exe` from firewall.ts detectFirewall via the fire-and-forget
    // startup getStatus() banner — measured alive in S-state at ~0.8-1.0s
    // post-spawn, straddling the health-ok line) can still be RUNNING at
    // capture time. Frozen into `before`, the transient then exits and the
    // settle poll demands a population the steady state never reaches again
    // (observed: "expected 2 live processes, got 1", 15s timeout). Under
    // gate-time host load the race landed red 3/3; idle hosts green it.
    // captureStableBaseline (unit-pinned in leak-metrics.test.ts) rides out
    // BOTH live transients and zombie reap windows.
    let before: ResourceSnapshot
    try {
      before = await captureStableBaseline([pid])
    } catch (baselineError) {
      // Retained process-tree artifact on baseline-drain failure too — the
      // drain error message names the still-changing live set, and this pins
      // the full tree at the moment of giving up.
      const failureSnap = captureResourceSnapshot([pid])
      await attachArtifact(testInfo, 'leak-metrics-baseline-failure', null, failureSnap, null)
      const artifactPath = testInfo.outputPath('leak-metrics-process-tree.json')
      await fs.mkdir(path.dirname(artifactPath), { recursive: true })
      await fs.writeFile(
        artifactPath,
        JSON.stringify({ phase: 'baseline', error: String(baselineError), onFailure: failureSnap }, null, 2),
      )
      throw baselineError
    }

    // Exactly one listener: the server's own port. No pre-existing extras.
    expect(before.listeningPorts).toEqual([port])
    expect(liveProcesses(before).length).toBeGreaterThanOrEqual(1)

    let maxLiveObserved = liveProcesses(before).length
    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const marker = `H12-${i}`
        const created = await createShellTab(baseUrl, token)

        // The measurement must SEE the provider/PTY child mid-stress on both
        // server kinds (live ppid descendant of the owned server pid).
        const during = await expect
          .poll(
            () => liveProcesses(captureResourceSnapshot([pid])).length,
            { timeout: 10_000, intervals: [100, 250, 500] },
          )
          .toBeGreaterThan(liveProcesses(before).length)
          .then(() => captureResourceSnapshot([pid]))
        maxLiveObserved = Math.max(maxLiveObserved, liveProcesses(during).length)
        expect(during.listeningPorts).toEqual([port])
        const shellChild = liveProcesses(during).find((p) => p.ppid === pid && p.pid !== pid)
        expect(shellChild, 'PTY shell child of the server must be visible').toBeDefined()
        expect(shellChild!.rssBytes ?? 0).toBeGreaterThan(0)

        await sendKeys(baseUrl, token, created.paneId, `echo ${marker}\n`)
        await waitForPattern(baseUrl, token, created.paneId, marker)
        await killTerminalViaWs(wsUrl, token, created.terminalId)
        await deleteTab(baseUrl, token, created.tabId)
      }

      // Settle — the exact checklist semantics ("leaves no owned process
      // behind"): every still-live pid must ALREADY be in the baseline's
      // fixed-point population (any loop-era process — PTY shell, git probe —
      // that survives is a stray and fails), and no zombie is left lingering.
      // Strict subset, not equality: a BASELINE pid MAY drain out during the
      // loop — a baseline extra exiting is cleanup, not a leak; leak growth
      // is gated by the stray set here and the diff bounds below. Strays are
      // reported with comm:pid(ppid) so a future red is self-diagnosing.
      const baselineLivePids = new Set(liveProcesses(before).map((p) => p.pid))
      await expect
        .poll(
          () => {
            const s = captureResourceSnapshot([pid])
            const live = liveProcesses(s)
            return {
              strays: live
                .filter((p) => !baselineLivePids.has(p.pid))
                .map((p) => `${p.comm}:${p.pid}(ppid ${p.ppid})`),
              zombies: s.processes.length - live.length,
            }
          },
          { timeout: 15_000, intervals: [250, 500] },
        )
        .toEqual({ strays: [], zombies: 0 })
    } catch (loopError) {
      // Retained process-tree artifact on ANY mid-loop failure (checklist:
      // "fails with a retained process-tree artifact if the bound is
      // exceeded" — extended to every failure, not just the final diff).
      const failureSnap = captureResourceSnapshot([pid])
      await attachArtifact(testInfo, 'leak-metrics-loop-failure', before, failureSnap, null)
      const artifactPath = testInfo.outputPath('leak-metrics-process-tree.json')
      await fs.mkdir(path.dirname(artifactPath), { recursive: true })
      await fs.writeFile(
        artifactPath,
        JSON.stringify({ loopIterations: ITERATIONS, maxLiveObserved, before, onFailure: failureSnap, error: String(loopError) }, null, 2),
      )
      throw loopError
    }

    const after = captureResourceSnapshot([pid])
    const diff = diffSnapshots(before, after)
    await attachArtifact(testInfo, 'leak-metrics-snapshots', before, after, diff)

    if (diff.failures.length > 0) {
      // Retained process-tree artifact on bound violation (checklist text).
      const artifactPath = testInfo.outputPath('leak-metrics-process-tree.json')
      await fs.mkdir(path.dirname(artifactPath), { recursive: true })
      await fs.writeFile(
        artifactPath,
        JSON.stringify({ loopIterations: ITERATIONS, maxLiveObserved, before, after, diff }, null, 2),
      )
    }

    expect(diff.failures, `resource bound exceeded (see attached artifacts): ${diff.failures.join('; ')}`).toEqual([])
  })

  test('restart boots back to exactly one listener with no inherited children', async ({ testServer }) => {
    test.skip(externalTargetConfigured(), 'leak metrics require an owned server (external target is not ours)')
    if (typeof testServer.restart !== 'function') {
      test.skip(true, 'server handle has no restart()')
      return
    }

    await testServer.restart()
    const fresh = testServer.info
    expect(fresh.pid).toBeGreaterThan(0)

    // No PTYs existed before this restart (previous test killed them all), so
    // the new boot settles to exactly one LIVE process (zombie reap windows
    // tolerated by the poll) and exactly one listener.
    await expect
      .poll(
        () => {
          const s = captureResourceSnapshot([fresh.pid])
          return { live: liveProcesses(s).length, zombies: s.processes.length - liveProcesses(s).length }
        },
        { timeout: 15_000, intervals: [100, 250] },
      )
      .toEqual({ live: 1, zombies: 0 })
    const snap = captureResourceSnapshot([fresh.pid])
    expect(snap.listeningPorts).toEqual([fresh.port])
  })

  test('stop leaves no owned process behind and frees the listening port', async ({ testServer }, testInfo) => {
    test.skip(externalTargetConfigured(), 'leak metrics require an owned server (external target is not ours)')
    const pid = testServer.info.pid
    const port = testServer.info.port
    const beforeStop = captureResourceSnapshot([pid])

    await testServer.stop()

    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        },
        { timeout: 10_000, intervals: [100, 250] },
      )
      .toBe(false)
    // The port is gone host-wide (nobody — not just our pid — still LISTENs on it).
    expect(captureHostListeningPorts()).not.toContain(port)

    await attachArtifact(testInfo, 'leak-metrics-stop-snapshot', beforeStop, {
      capturedAt: new Date().toISOString(),
      rootPids: [pid],
      processCount: 0,
      totalRssBytes: 0,
      totalFdCount: 0,
      totalThreads: 0,
      totalSocketQueue: { rxBytes: 0, txBytes: 0 },
      listeningPorts: [],
      processes: [],
    }, null)
    // The worker fixture's own teardown calls stop() a second time — both
    // owned fixtures tolerate that (verified by inspection in the HARNESS-12
    // plan, assumption 5).
  })
})
