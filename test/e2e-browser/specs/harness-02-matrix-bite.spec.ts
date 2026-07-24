import { test, expect } from '../helpers/fixtures.js'

/**
 * HARNESS-02 mutation negative-proof (the "bite" test).
 *
 * Proves the Node/Rust project matrix is not silently reusing one
 * implementation for the other.
 *
 * ## History (pre-CFG-07)
 *
 * This bite test originally keyed its node-vs-rust discriminator on
 * `/api/health` `instanceId` across a same-home restart: legacy PERSISTED it
 * (`server/instance-id.ts`), Rust REGENERATED it fresh on every boot (no
 * on-disk persistence) -- a real, already-present behavioral difference.
 *
 * ## CFG-07 changed the ground truth (the conflict this rewiring resolves)
 *
 * CFG-07 (`docs/plans/2026-07-18-wave8-specs.md`, SPEC A) makes the Rust
 * server ALSO persist `serverInstanceId` per home (`crates/freshell-server/src/instance_id.rs`,
 * a port of `server/instance-id.ts`'s `loadOrCreateServerInstanceId`) --
 * matching legacy's stable-installation-identity semantics. Once BOTH
 * implementations persist, `instanceId` stability across a restart is no
 * longer a node-vs-rust discriminator: a mis-wired `rust-chromium` fixture
 * that secretly booted (or reused) a Node server would now ALSO show a
 * stable `instanceId` and incorrectly PASS the old assertion.
 *
 * ## The resolution: split "did a real restart happen" from "which binary is it"
 *
 * 1. **`serverInstanceId` equal + restart genuinely happened** -- now a
 *    CORRECTNESS assertion true on BOTH kinds post-CFG-07 (not a
 *    discriminator): across a same-home restart, `instanceId` is STABLE
 *    (installation identity, CFG-07) while the OS pid changes (a REAL
 *    process restart, not the same process still running).
 * 2. **Which binary actually booted** -- re-keyed to the PERMANENT,
 *    structural node/rust discriminator: `GET /api/server-info` (DIAG-05,
 *    SPEC D, `crates/freshell-server/src/diag.rs`). The Rust port emits
 *    `runtime: "rust"` and NO `nodeVersion`; legacy emits a real
 *    `nodeVersion` string (`server/server-info-router.ts`) and no `runtime`
 *    field at all. Unlike `instanceId` regeneration (an incidental gap
 *    CFG-07 legitimately closes), "has a real Node version string" vs "is
 *    the Rust runtime" can never converge -- this is the discriminator that
 *    actually proves the matrix isn't reusing Node.
 *
 * (A permanent RED demonstration of this property lives in the HARNESS-02
 * implementation report/commit: the `runtime`/`nodeVersion` branch below was
 * temporarily inverted for the 'rust' case, run under
 * `--project=rust-chromium`, and observed to fail with the exact
 * runtime-mismatch assertion error, before being restored to the correct
 * direction captured here.)
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

/** `GET /api/server-info` -- the authenticated DIAG-05 discriminator route. */
async function fetchServerInfo(
  baseUrl: string,
  token: string,
): Promise<{ runtime?: unknown; nodeVersion?: unknown }> {
  const res = await fetch(`${baseUrl}/api/server-info`, {
    headers: { 'x-auth-token': token },
  })
  expect(res.ok).toBe(true)
  return (await res.json()) as { runtime?: unknown; nodeVersion?: unknown }
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
    const runtimeInfoBeforeRestart = await fetchServerInfo(serverInfo.baseUrl, serverInfo.token)

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

    // --- (3) CFG-07 correctness assertion (NOT the discriminator): post
    // CFG-07, `serverInstanceId` is STABLE installation identity across a
    // same-home restart on BOTH implementations. This alone no longer proves
    // which binary is running (that's assertion (4) below) -- it only proves
    // the restart didn't lose the persisted identity.
    expect(instanceIdAfterRestart).toBe(instanceIdBeforeRestart)

    // --- (4) the REAL identity oracle: `GET /api/server-info`'s permanent,
    // structural node/rust discriminator (DIAG-05). This is the mutation
    // negative-proof: a misconfigured rust-chromium fixture that actually
    // boots (or reuses) a Node server would fail HERE, because a real Node
    // process always reports a `nodeVersion` string and never `runtime`,
    // while the Rust binary always reports `runtime: "rust"` and never
    // `nodeVersion` -- a property of the binary itself, unaffected by
    // whether CFG-07 makes `instanceId` stable on both sides.
    const runtimeInfoAfterRestart = await fetchServerInfo(restartedInfo.baseUrl, restartedInfo.token)
    for (const info of [runtimeInfoBeforeRestart, runtimeInfoAfterRestart]) {
      if (e2eServerKind === 'rust') {
        expect(info.runtime).toBe('rust')
        expect(info.nodeVersion).toBeUndefined()
      } else {
        expect(typeof info.nodeVersion).toBe('string')
        expect(info.nodeVersion as string).toMatch(/^v\d+\./)
        expect(info.runtime).toBeUndefined()
      }
    }
  })
})
