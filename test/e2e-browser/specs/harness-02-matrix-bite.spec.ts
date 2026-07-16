import { test, expect } from '../helpers/fixtures.js'

/**
 * HARNESS-02 mutation negative-proof (the "bite" test).
 *
 * Proves the Node/Rust project matrix is not silently reusing one
 * implementation for the other by asserting a REAL, already-present
 * behavioral difference in how each implementation's `/api/health`
 * `instanceId` behaves across a same-home restart:
 *
 * - Legacy (Node) persists `instanceId` to `<home>/.freshell/instance-id`
 *   (`server/instance-id.ts`'s `loadOrCreateServerInstanceId`) -- restarting
 *   the OWNED server on the SAME home therefore returns the SAME instanceId.
 * - Rust regenerates `instanceId` fresh in `main()` on every process boot
 *   (`crates/freshell-server/src/main.rs`: `format!("srv-{}", Uuid::new_v4())`),
 *   with no on-disk persistence -- restarting the OWNED server on the SAME
 *   home therefore returns a DIFFERENT instanceId.
 *
 * The assertion below is keyed to `e2eServerKind` and therefore encodes what
 * each REAL implementation is supposed to do. If `rust-chromium`'s fixture
 * were ever mis-wired to secretly reuse (or accidentally point at) a Node
 * server instead of booting the real Rust binary, the *rust-chromium* branch
 * of this assertion would fail -- a Node server's instanceId does NOT change
 * across a same-home restart -- while `legacy-chromium`, genuinely running
 * Node, would continue to pass. That divergence is exactly what proves the
 * matrix is not "accidentally reusing Node": a bug in the wiring surfaces as
 * a failure confined to the Rust project, never a false pass on both.
 *
 * (A permanent RED demonstration of this property lives in the HARNESS-02
 * implementation report/commit: the branch below was temporarily inverted
 * for the 'rust' case, run under `--project=rust-chromium`, and observed to
 * fail with the exact instanceId-did-not-change assertion error, before
 * being restored to the correct direction captured here.)
 */

async function fetchHealthInstanceId(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/health`)
  expect(res.ok).toBe(true)
  const body = (await res.json()) as { ok?: unknown; instanceId?: unknown }
  expect(body.ok).toBe(true)
  expect(typeof body.instanceId).toBe('string')
  expect((body.instanceId as string).length).toBeGreaterThan(0)
  return body.instanceId as string
}

/** True if `pid` (or its process group, when `pid` is negative) is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

test.describe('HARNESS-02: Node/Rust matrix mutation negative-proof', () => {
  test.setTimeout(90_000)

  test('the fixture-owned server is the one THIS project claims to own, across a restart', async ({
    testServer,
    serverInfo,
    e2eServerKind,
  }) => {
    // --- (0) the fixture's recorded pid is a REAL, currently-alive local
    // process -- not a fabricated/stale record and not an external server
    // this fixture doesn't actually own.
    expect(serverInfo.pid).toBeGreaterThan(0)
    expect(isProcessAlive(serverInfo.pid)).toBe(true)

    // --- (1) the live server answers with a STABLE instanceId while it's
    // the same running process (two independent fetches must agree).
    const instanceIdBeforeRestart = await fetchHealthInstanceId(serverInfo.baseUrl)
    const instanceIdBeforeRestartAgain = await fetchHealthInstanceId(serverInfo.baseUrl)
    expect(instanceIdBeforeRestartAgain).toBe(instanceIdBeforeRestart)

    // --- (2) restart the SAME owned server (same home/port/token) ---
    if (!testServer.restart) {
      throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart(); cannot run the bite test`)
    }
    const priorPid = serverInfo.pid
    const restartedInfo = await testServer.restart()

    // Same home/port -- this is a RESTART, not a new server on a new port.
    expect(restartedInfo.port).toBe(serverInfo.port)
    expect(restartedInfo.homeDir).toBe(serverInfo.homeDir)
    // A genuinely fresh OS process must have a different pid than before.
    expect(restartedInfo.pid).not.toBe(priorPid)
    expect(isProcessAlive(restartedInfo.pid)).toBe(true)

    const instanceIdAfterRestart = await fetchHealthInstanceId(restartedInfo.baseUrl)

    // --- (3) the identity oracle: keyed to what THIS implementation
    // actually, verifiably does. This is the mutation negative-proof: a
    // misconfigured rust-chromium fixture that actually boots (or reuses) a
    // Node server would fail HERE, in the `rust` branch, because a Node
    // server's instanceId does not change across a same-home restart.
    if (e2eServerKind === 'rust') {
      expect(instanceIdAfterRestart).not.toBe(instanceIdBeforeRestart)
    } else {
      expect(instanceIdAfterRestart).toBe(instanceIdBeforeRestart)
    }
  })
})
