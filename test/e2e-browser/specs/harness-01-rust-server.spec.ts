import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'

/**
 * HARNESS-01 self-test.
 *
 * Proves the owned Rust-server fixture end to end:
 *   1. Boots the real `freshell-server` binary, drives the actual browser UI
 *      through a shell pane, and confirms real PTY output round-trips.
 *   2. Spawns an unrelated sentinel process OUTSIDE the fixture's process
 *      group before teardown.
 *   3. restart()s the SAME owned server against the SAME isolated home/port/
 *      token and proves the reconnected client is functionally alive (a
 *      fresh command still executes) -- not just stale DOM content.
 *   4. Captures the REAL PTY shell child PID(s) (via `server.ownedChildPids()`)
 *      while the post-restart server is confirmed alive, then stop()s the
 *      fixture and proves: the server PID is dead; its OWN process-group
 *      leader is dead (`kill(-pid, ...)`, which reaches same-group
 *      descendants only -- NOT the PTY shell, which `setsid()`s into its own
 *      session/group, see `rust-server.ts`'s class doc comment); EACH
 *      captured PTY child PID is individually dead (the assertion that
 *      actually proves Rust-side reaping, since it is untouched by
 *      group-kill and would catch a regression in the server's graceful
 *      SIGTERM shutdown / `PtyTerminal` `Drop`-kill path); the port is
 *      freed; and the unrelated sentinel is still alive.
 *   5. Proves the REAL `os.homedir()/.freshell` was never created or modified.
 */

async function selectFirstShellFromPicker(page: import('@playwright/test').Page): Promise<void> {
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return

  await page.waitForTimeout(500)
  const xtermVisibleAfterWait = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisibleAfterWait) return

  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      await button.click({ timeout: 5000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      return
    } catch {
      continue
    }
  }

  throw new Error(`No shell option was visible in the pane picker. Checked: ${shellNames.join(', ')}`)
}

/** True if a new listener can bind the port (i.e. the OS has released it). */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
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

test.describe('HARNESS-01: owned Rust-server fixture', () => {
  test.setTimeout(180_000)

  test('boots, survives restart, and reaps only its own process group', async ({ page }) => {
    const realFreshellDir = path.join(os.homedir(), '.freshell')
    const realFreshellStatBefore = fs.existsSync(realFreshellDir)
      ? fs.statSync(realFreshellDir)
      : null

    const server = new RustServer({ verbose: false })
    const info = await server.start()

    // The fixture must never bind the user's real port.
    expect(info.port).not.toBe(3001)

    let sentinel: ChildProcess | null = null

    try {
      // --- (1) drive the real UI through a shell pane and prove real PTY I/O ---
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)

      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectFirstShellFromPicker(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const marker1 = `HARNESS01-MARKER-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker1}`)
      await terminal.waitForOutput(marker1, { timeout: 20_000 })

      // --- (2) spawn a sentinel OUTSIDE this fixture's process group ---
      sentinel = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
      sentinel.unref()
      const sentinelPid = sentinel.pid
      if (!sentinelPid) throw new Error('sentinel failed to spawn (no pid)')
      expect(isProcessAlive(sentinelPid)).toBe(true)

      // --- (3) restart the SAME owned server against the SAME home/port/token ---
      const priorPort = info.port
      const priorPid = info.pid
      await server.restart()
      expect(server.info.port).toBe(priorPort)
      expect(server.info.homeDir).toBe(info.homeDir)
      // A genuinely fresh OS process must have a different pid than before.
      expect(server.info.pid).not.toBe(priorPid)

      await expect(async () => {
        const status = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 30_000 })

      // Prove the reconnected terminal is FUNCTIONALLY alive (not just
      // showing stale pre-restart DOM content): a brand-new command must
      // still execute correctly after the client recreates/reattaches.
      const marker2 = `HARNESS01-POST-RESTART-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker2}`)
      await terminal.waitForOutput(marker2, { timeout: 20_000 })

      const xtermText = await page.locator('.xterm').first().textContent()
      expect(xtermText).not.toContain('[Error]')

      // --- capture the REAL PTY shell child PID(s) BEFORE stop() ---
      // `kill(-pid, ...)` cannot reach these (PTY shells `setsid()` into
      // their OWN session/group -- see `rust-server.ts`'s class doc
      // comment), so this is the only assertion below that actually proves
      // Rust-side child reaping and would catch a regression in it.
      const childPidsBeforeStop = server.ownedChildPids()
      // Non-empty, or the "each child is dead" assertion below would be
      // vacuously true even if reaping were completely broken.
      expect(childPidsBeforeStop.length).toBeGreaterThan(0)

      // --- (4) stop() and prove full process-group reap + port release ---
      const finalPid = server.info.pid
      await server.stop()

      expect(isProcessAlive(finalPid)).toBe(false)
      // Negative pid confirms the server's OWN process-group leader is dead.
      // This does NOT cover the PTY shell child -- it lives in a SEPARATE
      // session/group it created for itself, invisible to `kill(-pid, ...)`.
      expect(isProcessAlive(-finalPid)).toBe(false)
      // The PTY child reap proof: each PID captured above (real descendants
      // of the server, confirmed non-empty above) must now be dead. This is
      // reaped by the Rust server's OWN graceful SIGTERM shutdown (`Drop`
      // kill by exact PID), backstopped by the fixture's post-signal sweep
      // for the SIGKILL-escalation edge case -- either way, if Rust-side
      // child reaping regresses, this loop is what catches it.
      for (const childPid of childPidsBeforeStop) {
        expect(isProcessAlive(childPid)).toBe(false)
      }
      await expect(async () => {
        expect(await isPortFree(priorPort)).toBe(true)
      }).toPass({ timeout: 10_000 })

      // The unrelated sentinel must have survived the fixture's teardown --
      // proof that stop() reaped only its OWN process group.
      expect(isProcessAlive(sentinelPid)).toBe(true)
    } finally {
      if (sentinel?.pid && isProcessAlive(sentinel.pid)) {
        try {
          process.kill(sentinel.pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      await server.stop().catch(() => {})
    }

    // --- (5) prove the REAL ~/.freshell was never created or modified ---
    const realFreshellStatAfter = fs.existsSync(realFreshellDir)
      ? fs.statSync(realFreshellDir)
      : null

    if (realFreshellStatBefore === null) {
      expect(realFreshellStatAfter).toBeNull()
    } else {
      expect(realFreshellStatAfter).not.toBeNull()
      expect(realFreshellStatAfter!.mtimeMs).toBe(realFreshellStatBefore.mtimeMs)
    }
  })
})
