import { test, expect } from '../helpers/fixtures.js'

/**
 * HARNESS-02 mutation negative-proof for the owned Rust baseline.
 *
 * It proves a restart replaces the owned process while preserving the
 * installation identifier, then verifies the replacement advertises the
 * Rust runtime through the authenticated server-info endpoint.
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
      throw new Error('Owned Rust E2eServerHandle does not implement restart(); cannot run the bite test')
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

    // --- (3) A same-home restart preserves its installation identity. ---
    expect(instanceIdAfterRestart).toBe(instanceIdBeforeRestart)

    // --- (4) The server-info response must identify the owned Rust binary. ---
    const runtimeInfoAfterRestart = await fetchServerInfo(restartedInfo.baseUrl, restartedInfo.token)
    for (const info of [runtimeInfoBeforeRestart, runtimeInfoAfterRestart]) {
      expect(info.runtime).toBe('rust')
      expect(info.nodeVersion).toBeUndefined()
    }
  })
})
