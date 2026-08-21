// IDLE-GATE SEMANTICS (Lane A) -- rust-only e2e proof of the busy-aware
// truly-idle gate (G1) and queue-empty reason parity (G2).
//
// Every test boots its OWN RustServer (ephemeral port via findFreePort inside
// RustServer.start(), fresh mkdtemp FRESHELL_HOME, random token). NEVER
// touches ports 3001/3002 (the user's live servers).
//
// RED HISTORY: written BEFORE the Rust fix. Pre-fix expected failures:
//   - claude queued test: a terminal.idle fires MID-TURN after the first BEL
//     (G1), and the final reason is 'grace' not 'queue-empty' (G2);
//   - codex + amplifier tests: terminal.idle fires instantly at the drain
//     (grace_ms==0 Default bug) -- the >= GRACE_MS timing assertions trip.
//     NOTE: codex asserts reason 'grace', NOT 'queue-empty' -- the Rust codex
//     tracker never surfaces a Busy phase in the PTY lane, so queue evidence
//     is unreachable for codex until Lane D ports busy-phase entry (plan
//     deviation note 3);
//   - restart + two-server tests are regression guards and may already pass.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import { WsCapture, type WsFrame } from '../helpers/ws-capture.js'

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))
const FAKE_BEL_CLI = path.join(FIXTURES_DIR, 'fake-bel-cli.mjs')
const FAKE_AMPLIFIER_CLI = path.join(FIXTURES_DIR, 'fake-amplifier-activity-cli.mjs')
const GRACE_MS = 2_000

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

function seedProviders(providers: string[]): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        { version: 1, settings: { codingCli: { enabledProviders: providers } } },
        null,
        2,
      ),
    )
  }
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Boot tab shows the pane-type picker: pick the CLI, accept the starting
 * directory, and resolve the new pane's terminalId. */
async function openBootCliPane(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  buttonName: RegExp,
  mode: string,
  cwd: string,
): Promise<string> {
  await page.getByRole('button', { name: buttonName }).click({ timeout: 15_000 })
  const cwdBox = page.getByRole('combobox', { name: /starting directory/i })
  await expect(cwdBox).toBeVisible({ timeout: 10_000 })
  await cwdBox.fill(cwd)
  await cwdBox.press('Enter')
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  await expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId!)
      const leaf = collectLeaves(layout).find(
        (l) => l?.content?.mode === mode && l?.content?.terminalId,
      )
      return leaf?.content?.terminalId ?? null
    }, { timeout: 20_000 })
    .not.toBeNull()
  const layout = await harness.getPaneLayout(tabId!)
  const leaf = collectLeaves(layout).find(
    (l) => l?.content?.mode === mode && l?.content?.terminalId,
  )
  return leaf!.content.terminalId as string
}

async function typePrompt(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').first().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const idleFor = (terminalId: string) => (f: WsFrame) =>
  f.type === 'terminal.idle' && f.terminalId === terminalId
const turnCompleteFor = (terminalId: string) => (f: WsFrame) =>
  f.type === 'terminal.turn.complete' && f.terminalId === terminalId

test.describe('idle-gate semantics (rust)', () => {
  test.setTimeout(300_000)

  test('claude: queued submit BEFORE the BEL never fires idle mid-turn; drain emits one queue-empty idle', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-claude-'))
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude },
        setupHome: seedProviders(['claude']),
      })
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)

        // Turn 1 is SLOW (6000ms). The second submit lands ~immediately, so
        // its 700ms BEL arrives FIRST, completing one queued turn while the
        // slow turn is still running (in_flight >= 2 -> phase stays Busy).
        await typePrompt(page, 'first slow prompt')
        await typePrompt(page, 'second prompt')

        // BEL #1 (~0.7s): one turn.complete, tracker still Busy.
        await capture.waitFor(turnCompleteFor(terminalId), 15_000, 'turn.complete #1')
        // G1 PROBE: sit well past the grace window mid-turn -- NO idle allowed.
        await page.waitForTimeout(GRACE_MS + 1_500)
        expect(capture.count(idleFor(terminalId))).toBe(0)

        // BEL #2 (~6s): the queue drains.
        await capture.waitFor(
          (f) => turnCompleteFor(terminalId)(f) && capture.count(turnCompleteFor(terminalId)) >= 2,
          15_000,
          'turn.complete #2',
        )
        expect(capture.count(idleFor(terminalId))).toBe(0)

        // G2: the deferred-arm emission carries reason 'queue-empty'.
        const idle = await capture.waitFor(idleFor(terminalId), GRACE_MS + 4_000, 'terminal.idle')
        expect(idle.reason).toBe('queue-empty')

        await page.waitForTimeout(1_500)
        expect(capture.count(idleFor(terminalId))).toBe(1)
        expect(capture.count(turnCompleteFor(terminalId))).toBe(2)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('codex: queued submit never fires idle mid-turn; drain emits one grace idle after the full grace window', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-codex-'))
    try {
      // Dual-role: the Rust codex terminal lane boots a 'codex app-server'
      // sidecar first; a terminal-only fake dies on it (PTY_SPAWN_FAILED).
      const fakeCodex = await installDualRoleCodexCli(path.join(sharedRoot, 'bin'), FAKE_BEL_CLI)
      const server = new RustServer({
        env: { CODEX_CMD: fakeCodex },
        setupHome: seedProviders(['codex']),
      })
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Codex CLI/i, 'codex', sharedRoot)

        // Slow turn 1 + immediate queued turn 2 (its BEL arrives first and is
        // consumed at the turn clear). NOTE (deviation note 3): the Rust codex
        // tracker never surfaces a Busy phase in the PTY lane -- the re-arm is
        // publicly silent (pending->pending suppressed), so NO queue evidence
        // accrues and the drain reason is 'grace', not 'queue-empty' (that
        // stays unreachable for codex until Lane D ports busy-phase entry).
        await typePrompt(page, 'first slow prompt')
        await typePrompt(page, 'second prompt')

        // Codex emits its single completion only when the queue drains (~6s).
        const tc = await capture.waitFor(turnCompleteFor(terminalId), 20_000, 'turn.complete')
        // G1: nothing fired mid-turn before the drain.
        expect(capture.count(idleFor(terminalId))).toBe(0)

        const idle = await capture.waitFor(idleFor(terminalId), GRACE_MS + 4_000, 'terminal.idle')
        expect(idle.reason).toBe('grace')
        expect(idle.at).toBeGreaterThanOrEqual(tc.at)
        // Grace-window respect (the RED assertion pre-fix): kills the
        // grace_ms==0 Default bug on the codex lane.
        expect(idle.at - tc.at).toBeGreaterThanOrEqual(GRACE_MS)

        await page.waitForTimeout(1_500)
        expect(capture.count(idleFor(terminalId))).toBe(1)
        expect(capture.count(turnCompleteFor(terminalId))).toBe(1)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('amplifier: overlapping prompts emit exactly one grace idle, never inside the grace window', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-amp-'))
    try {
      const fakeAmp = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      const server = new RustServer({
        env: { AMPLIFIER_CMD: fakeAmp, FAKE_AMPLIFIER_TURN_MS: '3000' },
        setupHome: seedProviders(['amplifier']),
      })
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Amplifier/i, 'amplifier', sharedRoot)

        // prompt:complete #1 lands at ~3.0s, #2 at ~3.8s (the second events
        // append EXTENDS the armed window -- still one emission, after grace).
        await typePrompt(page, 'first prompt')
        await page.waitForTimeout(800)
        await typePrompt(page, 'second prompt')

        const tc = await capture.waitFor(turnCompleteFor(terminalId), 20_000, 'turn.complete')
        expect(capture.count(idleFor(terminalId))).toBe(0)

        const idle = await capture.waitFor(idleFor(terminalId), GRACE_MS + 6_000, 'terminal.idle')
        expect(idle.reason).toBe('grace')
        // Grace-window respect: kills the grace_ms==0 Default bug.
        expect(idle.at - tc.at).toBeGreaterThanOrEqual(GRACE_MS)

        await page.waitForTimeout(1_500)
        expect(capture.count(idleFor(terminalId))).toBe(1)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('restart mid-busy: no spurious idle or chime edge after an abrupt SIGKILL + reboot', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-restart-'))
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude },
        setupHome: seedProviders(['claude']),
      })
      const info = await server.start()
      let capture: WsCapture | null = null
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)

        // Start a SLOW turn (6000ms) and kill the server mid-turn.
        await typePrompt(page, 'a slow prompt')
        await page.waitForTimeout(1_000) // provably mid-turn (BEL at ~6s)
        await server.restartAbrupt()

        // The live client reconnects on its own (no page.reload()).
        await expect(async () => {
          const status = await page.evaluate(
            () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
          )
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        // Fresh wire capture against the reborn server (same port/token).
        capture = new WsCapture(info.wsUrl, info.token)
        await capture.ready()

        // Observation window > grace + fake turn remainder: NOTHING may fire
        // for the killed-mid-turn terminal -- no idle, no completion.
        await page.waitForTimeout(8_000)
        expect(capture.count(idleFor(terminalId))).toBe(0)
        expect(capture.count(turnCompleteFor(terminalId))).toBe(0)

        // Client-side: no chime edge was folded in either.
        const state = await harness.getState()
        expect(state?.turnCompletion?.seq ?? 0).toBe(0)
      } finally {
        capture?.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('two concurrent servers keep independent idle/status streams', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-twoserver-'))
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
      const mkServer = () =>
        new RustServer({ env: { CLAUDE_CMD: fakeClaude }, setupHome: seedProviders(['claude']) })
      const serverA = mkServer()
      const serverB = mkServer()
      const infoA = await serverA.start()
      const infoB = await serverB.start()
      expect(infoA.port).not.toBe(infoB.port)
      const captureA = new WsCapture(infoA.wsUrl, infoA.token)
      const captureB = new WsCapture(infoB.wsUrl, infoB.token)
      try {
        await captureA.ready()
        await captureB.ready()
        const anyIdle = (f: WsFrame) => f.type === 'terminal.idle'
        const anyTurn = (f: WsFrame) => f.type === 'terminal.turn.complete'

        // Full turn + idle cycle on A only.
        await page.goto(`${infoA.baseUrl}/?token=${infoA.token}&e2e=1`)
        let harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const termA = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)
        await typePrompt(page, 'hello from A')
        const idleA = await captureA.waitFor(idleFor(termA), 20_000, 'A terminal.idle')
        expect(idleA.terminalId).toBe(termA)
        // B saw NOTHING.
        expect(captureB.count(anyIdle)).toBe(0)
        expect(captureB.count(anyTurn)).toBe(0)

        // Now a cycle on B; A's stream must not grow.
        const idleCountA = captureA.count(anyIdle)
        await page.goto(`${infoB.baseUrl}/?token=${infoB.token}&e2e=1`)
        harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const termB = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)
        await typePrompt(page, 'hello from B')
        const idleB = await captureB.waitFor(idleFor(termB), 20_000, 'B terminal.idle')
        expect(idleB.terminalId).toBe(termB)
        expect(captureA.count(anyIdle)).toBe(idleCountA)
      } finally {
        captureA.close()
        captureB.close()
        await serverA.stop().catch(() => {})
        await serverB.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
