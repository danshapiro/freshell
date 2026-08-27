/**
 * TERM-04 — deduplicate `terminal.create` by `createRequestId`.
 * (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, P0 terminal section)
 *
 * Checklist validation (verbatim): "Intercept/delay the first `terminal.created`,
 * force reconnect, and issue the same create request from two pages; assert one
 * PTY PID, one terminal ID, one pane owner, and one fixture launch record."
 *
 * The dedupe is a SERVER-side contract with byte-identical semantics on both
 * `createdTerminalByRequestId` settled cache :575/:891-936 + per-connection
 * `REPAIR_PENDING_SENTINEL` :2329-:2704 + create lock :2218; rust answer:
 * `crates/freshell-ws/src/create_dedupe.rs` + the dispatch arm at
 * `crates/freshell-ws/src/terminal.rs:564-624`). This spec therefore runs in
 *
 * Fixture launcher: HARNESS-03's `fake-claude.mjs` wired in via the
 * established `CLAUDE_CMD` server-env seam (same pattern as
 * one JSONL row to `FRESHELL_FAKE_LEDGER` — "one fixture launch record" is
 * `rows === 1`, and the row's `pid` is THE PTY PID.
 *
 * Three legs, one describe, one server per test:
 *   A. delayed/lost first `terminal.created` + forced reconnect of the asker:
 *      raw client aborts before reading the reply; a new connection resends
 *      the IDENTICAL frame → answered once, one launch, one terminal.
 *   B. two clients issue the same create concurrently → both answered with
 *      the SAME terminalId (settled-replay or in-flight waiter — either
 *      window satisfies the contract), one launch, one terminal.
 *   C. two real pages: page A owns a picker-created claude pane; after a
 *      forced browser WS disconnect/reconnect the pane re-attaches to the
 *      SAME terminal without a second launch; a second page then issues the
 *      same createRequestId through its real WS connection → still one
 *      launch, one terminal, one pane owner.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { test } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { RawWsClient, rawHttpRequest } from '../helpers/raw-clients.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { PROVIDER_FIXTURE_DIR, childPidsOf } from '../helpers/provider-fixture-launcher.js'

type LedgerRow = { t: number; pid: number; provider: string; argv: string[]; cwd: string }

/** Install the executable shim the servers spawn as the "claude" binary. */
async function installFakeClaudeCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const shim = path.join(binDir, 'fake-claude-shim.sh')
  const target = path.join(PROVIDER_FIXTURE_DIR, 'fake-claude.mjs')
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec node ${JSON.stringify(target)} "$@"\n`,
    'utf8',
  )
  await fs.chmod(shim, 0o755)
  return shim
}

async function readLedger(ledgerPath: string): Promise<LedgerRow[]> {
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerRow)
  } catch {
    return [] // not yet written
  }
}

async function waitForLedgerRows(ledgerPath: string, count: number, timeoutMs = 15_000): Promise<LedgerRow[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await readLedger(ledgerPath)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) {
      throw new Error(`ledger never reached ${count} rows (saw ${rows.length})`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Running-terminal inventory via the shared REST surface (x-auth-token authed). */
async function runningTerminalIds(info: E2eServerInfo): Promise<string[]> {
  const res = await rawHttpRequest(info.baseUrl, {
    path: '/api/terminals',
    headers: { 'x-auth-token': info.token },
  })
  expect(res.status, `/api/terminals status ${res.status}: ${res.body.toString('utf8').slice(0, 400)}`).toBe(200)
  const rows = res.json() as Array<{ terminalId?: string; status?: string }>
  expect(Array.isArray(rows)).toBe(true)
  return rows.filter((r) => r.status === 'running').map((r) => String(r.terminalId))
}

function findTerminalLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'terminal') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findTerminalLeaf(child)
      if (found) return found
    }
  }
  return null
}

/** The plain create frame — byte-identical on every send, exactly what the
 * frozen client mints and resends (TerminalView.tsx); mode claude rides the
 * same dispatch arm as shell and reaches the fake CLI on the Rust server. */
function plainCreateFrame(requestId: string, cwd: string) {
  return { type: 'terminal.create', requestId, mode: 'claude', shell: 'system', cwd }
}

test.describe('TERM-04 terminal.create requestId dedupe', () => {
  test.setTimeout(120_000)

  let root: string
  let ledgerPath: string
  let cwdDir: string
  let server: E2eServerHandle | undefined
  let info: E2eServerInfo

  test.beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-term04-'))
    ledgerPath = path.join(root, 'ledger.jsonl')
    cwdDir = path.join(root, 'cwd')
    await fs.mkdir(cwdDir, { recursive: true })
    const fakeClaude = await installFakeClaudeCli(path.join(root, 'bin'))
    server = await createE2eServerHandle(process.env, {
      construct: {
        env: {
          CLAUDE_CMD: fakeClaude,
          FRESHELL_FAKE_LEDGER: ledgerPath,
          // One scripted rule answers the leg-C post-reconnect marker
          // round-trip; every other stdin line gets the canned busy→BEL turn.
          FRESHELL_FAKE_PROGRAM: JSON.stringify({
            rules: [
              { on: 'stdin:^term04-ping$', emit: [{ kind: 'marker', data: { text: 'term04-pong-marker' } }] },
            ],
          }),
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(
            path.join(freshellDir, 'config.json'),
            JSON.stringify(
              { version: 1, settings: { codingCli: { enabledProviders: ['claude'] } } },
              null,
              2,
            ),
          )
        },
      },
    })
    info = await server.start()
  })

  test.afterEach(async () => {
    await server?.stop()
    server = undefined
    await fs.rm(root, { recursive: true, force: true })
  })

  test('A: lost first terminal.created, reconnect resends the same create — one launch, one terminal', async () => {
    const requestId = `term04-a-${Date.now()}`

    // Intercept/delay the first terminal.created: the asking connection
    // vanishes before the reply can be consumed (abrupt socket destroy —
    // the reply is lost no matter which side of settle it lands on).
    const asking = await RawWsClient.connect(info.wsUrl)
    asking.hello(info.token)
    await asking.nextJsonMessage('ready', 10_000)
    asking.sendJson(plainCreateFrame(requestId, cwdDir))
    // Prove the first create WAS processed server-side (spawn begun) before
    // the connection dies — otherwise the resend below would be a fresh
    // create and the test would pass without exercising dedupe at all.
    await waitForLedgerRows(ledgerPath, 1)
    // NOW kill the asker. Because the ledger row only exists after the child
    // booted — strictly after the server settled the create and pushed
    // terminal.created — the reply deterministically lands in the dead
    // socket's receive buffer: the settled-entry/lost-reply shape (the
    // checklist's "intercept/delay the first terminal.created, force
    // reconnect" leg). The in-flight/waiter window of the same contract is
    // pinned separately by restore_spawn_gate.rs
    // (resend_on_new_connection_never_swallowed_while_inflight) and the unit
    // waiter tests.
    asking.abort()
    await asking.dispose()

    // Forced reconnect of the asker: a fresh connection resends the
    // IDENTICAL frame (the frozen client's inFlightCreates redrive).
    const reconnected = await RawWsClient.connect(info.wsUrl)
    reconnected.hello(info.token)
    await reconnected.nextJsonMessage('ready', 10_000)
    reconnected.sendJson(plainCreateFrame(requestId, cwdDir))
    const created = await reconnected.nextJsonMessage<any>('terminal.created', 15_000)

    expect(created.requestId).toBe(requestId)
    expect(typeof created.terminalId).toBe('string')
    expect(created.terminalId.length).toBeGreaterThan(0)

    // One fixture launch record — whose pid is a REAL child process of the
    // server under test (the checklist's "one PTY PID": one launch, owned by
    // this server, nothing else spawned).
    const rows = await waitForLedgerRows(ledgerPath, 1)
    expect(rows).toHaveLength(1)
    // Linux-hosted, but keep the assert honest off-Linux ([] there).
    if (process.platform === 'linux') {
      expect(childPidsOf(info.pid)).toContain(rows[0].pid)
    }

    // One terminal ID in the server inventory, and it is the replied one.
    // The inventory poll gives a wrongful second spawn a real window to
    // surface (a Proceed-resend creates a second running row); the ledger
    // re-check afterwards then closes the child-boot lag (a duplicate's
    // ledger row lands tens of ms after its spawn, strictly before this
    // point is reached).
    await expect
      .poll(() => runningTerminalIds(info), { timeout: 10_000 })
      .toEqual([created.terminalId])
    expect(await readLedger(ledgerPath)).toHaveLength(1)

    await reconnected.dispose()
  })

  test('B: two clients issue the same create concurrently — both answered, one PTY', async () => {
    const requestId = `term04-b-${Date.now()}`

    // Sequential connect+hello+ready per client: RawWsClient.nextJsonMessage
    // deliberately matches only frames received AFTER the call (HARNESS-05's
    // R2 anti-stale rule), so interleaving hello/ready across the two clients
    // would permanently miss the first client's ready frame.
    const c1 = await RawWsClient.connect(info.wsUrl)
    c1.hello(info.token)
    await c1.nextJsonMessage('ready', 10_000)
    const c2 = await RawWsClient.connect(info.wsUrl)
    c2.hello(info.token)
    await c2.nextJsonMessage('ready', 10_000)

    // Back-to-back: deliberately unawaited pair — whichever window the first
    // create is in (in-flight waiter vs settled replay), the contract is
    // "both answered with the same terminalId, one spawn". The reply waiters
    // attach in the same synchronous block as the sends (no event-loop yield
    // between, so no reply frame can be missed under the R2 rule).
    c1.sendJson(plainCreateFrame(requestId, cwdDir))
    const created1 = c1.nextJsonMessage<any>('terminal.created', 15_000)
    c2.sendJson(plainCreateFrame(requestId, cwdDir))
    const created2 = c2.nextJsonMessage<any>('terminal.created', 15_000)
    const [r1, r2] = await Promise.all([created1, created2])
    expect(r1.requestId).toBe(requestId)
    expect(r2.requestId).toBe(requestId)
    expect(r2.terminalId).toBe(r1.terminalId)

    const rows = await waitForLedgerRows(ledgerPath, 1)
    expect(rows).toHaveLength(1)
    // Linux-hosted, but keep the assert honest off-Linux ([] there).
    if (process.platform === 'linux') {
      expect(childPidsOf(info.pid)).toContain(rows[0].pid)
    }

    await expect
      .poll(() => runningTerminalIds(info), { timeout: 10_000 })
      .toEqual([r1.terminalId])
    // Same lag-closing re-check as leg A (see its comment).
    expect(await readLedger(ledgerPath)).toHaveLength(1)

    await c1.dispose()
    await c2.dispose()
  })

  test('C: two pages — pane owner survives forced reconnect; a second page re-issuing the create spawns nothing', async ({ browser }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    const harnessA = new TestHarness(pageA)
    await pageA.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    await harnessA.waitForHarness()
    await harnessA.waitForConnection()

    // Page A creates the pane through the real picker (mints createRequestId K).
    await pageA.getByRole('button', { name: /^Claude CLI$/i }).click({ timeout: 15_000 })
    const cwdBox = pageA.getByRole('combobox', { name: /starting directory for claude cli/i })
    await expect(cwdBox).toBeVisible({ timeout: 10_000 })
    await cwdBox.fill(cwdDir)
    await cwdBox.press('Enter')

    // Pane bound: poll the Redux layout for the terminalId the create
    // settled into (TerminalView folds terminal.created into pane content).
    await expect
      .poll(async () => {
        const tabId = await harnessA.getActiveTabId()
        if (!tabId) return null
        const leaf = findTerminalLeaf(await harnessA.getPaneLayout(tabId))
        return leaf?.content?.terminalId ?? null
      }, { timeout: 20_000 })
      .not.toBeNull()

    const tabIdA = (await harnessA.getActiveTabId())!
    const leafA = findTerminalLeaf(await harnessA.getPaneLayout(tabIdA))
    const requestId: string = leafA.content.createRequestId
    const terminalId: string = leafA.content.terminalId
    expect(typeof requestId).toBe('string')
    expect(requestId.length).toBeGreaterThan(0)
    expect(typeof terminalId).toBe('string')

    const launched = await waitForLedgerRows(ledgerPath, 1)
    expect(launched).toHaveLength(1)

    // Forced reconnect of the whole page (browser-level WS drop; the frozen
    // client re-handshakes and re-attaches/re-drives with the same keys).
    await harnessA.forceDisconnect()
    await harnessA.waitForConnection()

    // Prove REATTACH, not local-state retention: the pane layout kept
    // terminalId client-side even while disconnected, so asserting the id
    // alone would be vacuous. A marker round-trip through the real xterm
    // (typed by the page, answered by the fake CLI's program rule) only
    // succeeds if the pane re-attached to the SAME live PTY.
    await expect
      .poll(async () => {
        const leaf = findTerminalLeaf(await harnessA.getPaneLayout(tabIdA))
        return leaf?.content?.terminalId ?? null
      }, { timeout: 20_000 })
      .toBe(terminalId)
    const termA = new TerminalHelper(pageA)
    await termA.executeCommand('term04-ping')
    await termA.waitForOutput('term04-pong-marker', { timeout: 15_000, terminalId })
    expect(await readLedger(ledgerPath)).toHaveLength(1)

    // Second real page: issue the SAME create request over its own real WS
    // connection (sendWsMessage goes out the app's live socket). Both
    // directions are OBSERVED, never assumed:
    //  - delivery: ws-client.fire `outboundMessageObserver` only from
    //    `sendNow` (ws-client.ts:784-787) — i.e. only for frames that really
    //    hit the socket, never for reconcile-held or pre-ready-queued ones;
    //  - the server's answer: Playwright's own WS tap on page B sees the
    //    `terminal.created` frame the dedupe guard replays/forwards.
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    const harnessB = new TestHarness(pageB)
    // Attach the tap BEFORE navigation creates the socket. (The tap binds
    // page B's boot-time socket only; leg C performs no reconnect on page B,
    // so no later socket needs observing.)
    const wsEventPromise = pageB.waitForEvent('websocket', { timeout: 15_000 })
    await pageB.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const pageBWs = await wsEventPromise
    const receivedByB: any[] = []
    pageBWs.on('framereceived', ({ payload }) => {
      try {
        receivedByB.push(JSON.parse(String(payload)))
      } catch {
        // non-JSON frame — irrelevant to this contract
      }
    })
    await harnessB.waitForHarness()
    await harnessB.waitForConnection()
    const duplicateFrame = plainCreateFrame(requestId, cwdDir)
    await pageB.evaluate((frame) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage(frame)
    }, duplicateFrame)

    // Proof page B's app actually TRANSMITTED the duplicate (sent_messages are
    // recorded only from the real socket send path).
    await expect
      .poll(async () => pageB.evaluate((rid) =>
        (window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() as any[] | undefined)
          ?.some((m) => m?.type === 'terminal.create' && m?.requestId === rid) ?? false,
      requestId), { timeout: 10_000 })
      .toBe(true)

    // Proof the server ANSWERED page B — with the SAME terminalId (settled
    // replay; the in-flight waiter shape is covered by test B). This ordered
    // pair (duplicate out, replayed answer back, same id) IS the dedupe edge
    // the "two pages" phrase of the checklist names.
    await expect
      .poll(() => receivedByB.find(
        (f) => f?.type === 'terminal.created' && f?.requestId === requestId,
      )?.terminalId ?? null, { timeout: 15_000 })
      .toBe(terminalId)

    // The checklist invariants, AFTER the answered duplicate. No timing
    // window is load-bearing: the reply poll above already excludes a
    // wrongful second spawn (a Proceed would answer page B with a DIFFERENT
    // terminalId long before these lines run), so the ledger/inventory/owner
    // reads below are confirming state, not racing it.
    expect(await readLedger(ledgerPath)).toHaveLength(1)
    expect(await runningTerminalIds(info)).toEqual([terminalId])
    const leafAfter = findTerminalLeaf(await harnessA.getPaneLayout(tabIdA))
    expect(leafAfter.content.terminalId).toBe(terminalId)
    expect(leafAfter.content.createRequestId).toBe(requestId)
    // One pane owner, BOTH halves: page B's own pane tree must not have
    // adopted the terminal either (the checklist's "one pane owner").
    const pageBOwnersT: boolean = await pageB.evaluate((tid) => {
      const st = window.__FRESHELL_TEST_HARNESS__?.getState()
      const layouts = st?.panes?.layouts ?? {}
      const stack: any[] = Object.values(layouts)
      while (stack.length) {
        const node = stack.pop()
        if (!node) continue
        if (node.type === 'leaf' && node.content?.terminalId === tid) return true
        for (const child of node.children ?? []) stack.push(child)
      }
      return false
    }, terminalId)
    expect(pageBOwnersT).toBe(false)
    // Page B stays healthy (its unicast reply must not wedge its app).
    expect(await harnessB.getConnectionStatus()).toBe('ready')

    await contextB.close()
    await contextA.close()
  })
})
