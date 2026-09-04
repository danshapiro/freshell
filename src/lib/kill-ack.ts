import { nanoid } from 'nanoid'
import { createLogger } from './client-logger'
import { markTerminalReleased } from './terminal-release-marks'
import { getWsClient } from './ws-client'
import { collectPaneEntries } from './pane-utils'
import type { PaneNode } from '@/store/paneTypes'

/**
 * Correlated close-acknowledgement waits (focused-episode-6 round 2,
 * Findings 6+7): a close flow must NOT drop the pane (or start the
 * replacement conversation) on a kill the server has not answered. The
 * server now answers terminal kills carrying `requestId` with ONE
 * `terminal.killed{requestId, terminalId, success, error?}` frame once the
 * durable close envelope resolved one way or the other, and fresh-agent
 * kills always answered `freshAgent.killed{..., success}` (the round-1 wire
 * shape); these helpers send the kill and resolve on that frame —
 * `success:false` means the durable close FAILED and the session/terminal
 * was left untouched server-side, so the pane STAYS.
 *
 * Bounded wait: after KILL_ACK_TIMEOUT_MS the wait resolves as a UI failure
 * (`ok:false, timedOut:true`) — the pane stays, the caller logs and shows
 * the pane's existing error surface, and the server close stays
 * authoritative (a late `terminal.killed` can never resurrect the settled
 * wait: it is unsubscribed on settlement).
 *
 * Legacy-server tolerance (`terminal.exit` / `INVALID_TERMINAL_ID` fallbacks
 * on the terminal lane): an older server answers no `terminal.killed`, but
 * its kill still emits the exit broadcast synchronously (or the invalid-id
 * error for an already-gone id) — both satisfy the close intent. Never
 * resolved as failure: the waiter would fail-close every close against a
 * server one version old.
 *
 * Focused-episode-6 round 4 (Finding F7): the exit fallback is DEFERRED by
 * EXIT_FALLBACK_GRACE_MS, never settled on sight. On a persisted-despite-
 * error close a current server broadcasts `terminal.exit` WHILE killing and
 * only afterward sends the correlated `terminal.killed{success:false}` — a
 * fallbacks-of-sight settle would drop the pane and hide the failure the
 * server sent to surface. The grace lets the correlated frame arrive first
 * and decide; on a legacy server no such frame exists, the grace expires,
 * and the exit fallback settles success exactly as before.
 */
const log = createLogger('kill-ack')

/** The bounded close-ack wait — 5s, per the round-2 brief. */
export const KILL_ACK_TIMEOUT_MS = 5_000

/**
 * The exit-fallback deferral (F7): the correlated `terminal.killed` is one
 * send behind the `terminal.exit` broadcast it races; the fallback settles
 * success only once no correlated frame could still legitimately land.
 */
export const EXIT_FALLBACK_GRACE_MS = 250

/**
 * The pane-banner copy for failed closes (the `KILL_FAILED` code is written
 * by BOTH the `freshAgent.killed{success:false}` fold in fresh-agent-ws.ts
 * AND the close flows' timeout arm — the two writers must agree verbatim;
 * the overwrite is idempotent). The timeout variant is client-side only (no
 * server answer ever arrived).
 */
export const KILL_FAILED_MESSAGE =
  'the session close could not be recorded durably; the session may still be running on the server'
export const KILL_ACK_TIMEOUT_MESSAGE =
  'the server did not acknowledge the close in time; the session may still be running on the server'

export type KillAck =
  | { ok: true }
  | { ok: false; error?: string; timedOut?: true }

type FrameVerdict = { ok: boolean; error?: string; grace?: number }

function awaitCloseFrame(
  match: (msg: unknown) => FrameVerdict | null,
  timeoutMs: number,
): Promise<KillAck> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (ack: KillAck) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      unsubscribe()
      resolve(ack)
    }
    unsubscribe = getWsClient().onMessage((msg) => {
      const verdict = match(msg)
      if (verdict === null) return
      if (verdict.grace !== undefined) {
        // F7: a deferred fallback (the legacy exit arm) arms the grace
        // instead of settling — a correlated frame arriving inside the
        // window decides; only an undecided expiry settles the fallback.
        if (graceTimer === undefined) {
          graceTimer = setTimeout(() => finish({ ok: true }), verdict.grace)
        }
        return
      }
      finish(verdict.ok ? { ok: true } : { ok: false, error: verdict.error })
    })
    timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs)
  })
}

/**
 * The correlated terminal close: send `terminal.kill` carrying the
 * pane-minted `requestId` (and the pane's `createRequestId` — the durable
 * envelope's key when the registry can no longer answer, the reaper-race /
 * stale-pane shape) and resolve on the answer. On success the terminal is
 * marked released (the detach middleware skips it — the pane-drop then costs
 * no redundant `terminal.detach`); on failure the mark is NOT made (the pane
 * stays and the registration is exactly as before the close attempt).
 */
export function sendTerminalKillAndAwait(
  terminalId: string,
  opts?: { createRequestId?: string | null; timeoutMs?: number; send?: (msg: unknown) => void },
): Promise<KillAck> {
  const requestId = nanoid()
  const send = opts?.send ?? ((m: unknown) => getWsClient().send(m))
  send({
    type: 'terminal.kill',
    terminalId,
    requestId,
    ...(opts?.createRequestId ? { createRequestId: opts.createRequestId } : {}),
  })
  const wait = awaitCloseFrame((msg) => {
    const m = msg as Record<string, unknown>
    if (m.type === 'terminal.killed' && m.requestId === requestId) {
      return { ok: m.success !== false, error: typeof m.error === 'string' ? m.error : undefined }
    }
    // Legacy-server fallbacks (see the module doc). The exit arm is
    // DEFERRED (F7): on a current server the correlated terminal.killed
    // trails the exit broadcast by one send and must decide instead.
    if (m.type === 'terminal.exit' && m.terminalId === terminalId) {
      return { ok: true, grace: EXIT_FALLBACK_GRACE_MS }
    }
    if (m.type === 'error' && m.code === 'INVALID_TERMINAL_ID' && m.terminalId === terminalId) {
      return { ok: true }
    }
    // Belt: an error frame correlated with this kill is a failure answer.
    if (m.type === 'error' && m.requestId === requestId) {
      return { ok: false, error: typeof m.message === 'string' ? m.message : undefined }
    }
    return null
  }, opts?.timeoutMs ?? KILL_ACK_TIMEOUT_MS)
  return wait.then((ack) => {
    if (ack.ok) {
      markTerminalReleased(terminalId)
    } else {
      log.warn('terminal kill was not acknowledged as a durable close — the pane stays', {
        terminalId,
        ...ack,
      })
    }
    return ack
  })
}

/**
 * The pane-close failure banner copy (delta-r7-round-3, focused-episode-7
 * round 2 Finding F2): written onto the pane whose close the server did not
 * confirm durable (the xterm notice — the terminal pane's ordinary error
 * chrome, mirrored on `writeLocalXtermNotice`'s "[Close failed]"
 * convention). Stays truthful for the NON-retiring pane.close family: the
 * session is EXPECTED to survive; the failure is that the close EVIDENCE is
 * unrecorded, so the pane stays and a later restore-from-server-memory pass
 * may offer it again until the close is confirmed once.
 */
export const PANE_CLOSE_FAILED_MESSAGE =
  'the pane close could not be recorded durably; the pane was left open'
export const PANE_CLOSE_ACK_TIMEOUT_MESSAGE =
  'the server did not acknowledge the pane close in time; the pane was left open'

/** One pane identity inside a batch close (`panes.closed[].panes`). */
export type PaneCloseIdentityInput = { createRequestId: string; terminalId?: string }

/**
 * The whole-tab BATCH close (focused-episode-7 round 3, Finding F1): the
 * gated `closeTab` sends ONE `panes.closed` carrying the tab's full
 * terminal-pane identity set and resolves on the ONE correlated
 * `panes.closed.result{requestId, success, error?}` the server answers once
 * the single batch envelope write resolved — a partial per-pane durable
 * outcome is impossible by construction (the server journals ONE record
 * covering the whole set atomically). Correlation is the close op's own
 * minted `requestId` (terminal.kill's precedent — the batch answers the OP,
 * not a pane). The wait SUBSCRIBES BEFORE THE SEND, so a server answering
 * inline during `send()` still lands. No legacy fallbacks BY DESIGN: v10's
 * strict hello handshake makes a result-less server unreachable in
 * principle.
 */
export function sendPanesClosedAndAwait(
  tabId: string,
  panes: PaneCloseIdentityInput[],
  opts?: { timeoutMs?: number; send?: (msg: unknown) => void },
): Promise<KillAck> {
  const requestId = nanoid()
  const send = opts?.send ?? ((m: unknown) => getWsClient().send(m))
  const wait = awaitCloseFrame((msg) => {
    const m = msg as Record<string, unknown>
    if (m.type === 'panes.closed.result' && m.requestId === requestId) {
      return { ok: m.success !== false, error: typeof m.error === 'string' ? m.error : undefined }
    }
    return null
  }, opts?.timeoutMs ?? KILL_ACK_TIMEOUT_MS)
  send({
    type: 'panes.closed',
    requestId,
    tabId,
    panes: panes.map((p) => ({
      createRequestId: p.createRequestId,
      ...(p.terminalId ? { terminalId: p.terminalId } : {}),
    })),
  })
  return wait.then((ack) => {
    if (!ack.ok) {
      log.warn('tab close was not acknowledged as durably recorded — the tab stays', {
        tabId,
        paneCount: panes.length,
        ...ack,
      })
    }
    return ack
  })
}

/**
 * The durable OPEN re-assertion (focused-episode-7 round 3, Finding F2):
 * sent for a pane the client is STILL DISPLAYING after its close evidence
 * failed to confirm (a server-answered failure — nothing durable; or the
 * ambiguous TIMEOUT whose record may have committed durably with the ack
 * lost on the wire). The server consumes the pane's standing
 * `pane-detach[-batch]` close record durably and re-asserts the row's
 * attribution, so recovery re-agrees with the displayed layout.
 *
 * Fire-and-forget BY DESIGN: `getWsClient().send` queues the message until
 * `ready`, so over a socket-down close the replay delivers the close BEFORE
 * this re-assertion on the returned socket (the ordering is the fix, not a
 * race). There is deliberately no result frame: the assert is idempotent (a
 * no-op when nothing stands). The per-ready sweep below is the healing half
 * for every shape that outlives the queue (a page reload drops queued
 * sends): on EVERY ws `ready` the client re-asserts every terminal pane it
 * is displaying, so a standing-but-contradicted close record is consumed on
 * the next connection regardless of how the page got there.
 */
export function sendPaneOpened(
  identity: { createRequestId: string; tabId: string },
  opts?: { send?: (msg: unknown) => void },
): void {
  const send = opts?.send ?? ((m: unknown) => getWsClient().send(m))
  send({
    type: 'pane.opened',
    createRequestId: identity.createRequestId,
    tabId: identity.tabId,
  })
  log.debug('re-asserted an unconfirmed-close pane as open', {
    createRequestId: identity.createRequestId,
    tabId: identity.tabId,
  })
}

/**
 * The per-ready OPEN re-assertion sweep (focused-episode-7 round 3, Finding
 * F2): on every ws `ready` (first connect AND every reconnect), assert every
 * terminal pane the client is displaying — ONE message per pane, keyed by
 * its createRequestId, exactly the close gate's identity criterion. The
 * server consumes any standing detach-family close record for a displayed
 * pane and re-asserts its row attribution: server state re-agrees with the
 * layout the client is displaying, durably. Closed panes are absent from the
 * layouts by then, so a genuine close is never revoked; createRequestIds are
 * never reused, so a re-opened pane asserts only its own new key. Idempotent
 * and fsync-free server-side when nothing stands and attribution is
 * unchanged, so every-viewport reconnect stays cheap.
 */
export function reassertAllOpenTerminalPanes(
  layouts: Record<string, PaneNode | undefined>,
  opts?: { send?: (msg: unknown) => void },
): void {
  let count = 0
  for (const [tabId, root] of Object.entries(layouts)) {
    if (!root) continue
    for (const { content } of collectPaneEntries(root)) {
      if (content.kind !== 'terminal') continue
      const createRequestId = typeof content.createRequestId === 'string' && content.createRequestId
        ? content.createRequestId
        : undefined
      if (!createRequestId) continue
      sendPaneOpened({ createRequestId, tabId }, opts)
      count++
    }
  }
  if (count > 0) {
    log.debug('re-asserted the displayed open panes on ready', { count })
  }
}

/**
 * The correlated durable-pane-close (delta-r7-round-3, focused-episode-7
 * round 2 Finding F2): send `pane.closed` and resolve on the ONE
 * `pane.closed.result{createRequestId, success, error?}` the server answers
 * once the journal write resolved. Correlation is the pane's own
 * createRequestId (the close is keyed by it end to end — no separate
 * request id). The wait SUBSCRIBES BEFORE THE SEND, so a test double or a
 * server answering inline during `send()` still lands.
 *
 * No legacy fallbacks BY DESIGN (Finding F4 / WS_PROTOCOL_VERSION 9): a
 * server that never learned this frame silently drops unknown typed
 * messages, and the strict hello handshake makes that server unreachable
 * for this client — an unanswered wait is always a REAL unconfirmed close
 * (disconnect, half-open socket), settling as `timedOut` at the bounded
 * KILL_ACK_TIMEOUT_MS with the pane kept. `markTerminalReleased` is NOT
 * involved (the pane-close journal is non-retiring; the detach loop owns
 * the subscription release).
 */
export function sendPaneClosedAndAwait(
  identity: { createRequestId: string; terminalId?: string },
  opts?: { timeoutMs?: number; send?: (msg: unknown) => void },
): Promise<KillAck> {
  const send = opts?.send ?? ((m: unknown) => getWsClient().send(m))
  const wait = awaitCloseFrame((msg) => {
    const m = msg as Record<string, unknown>
    if (m.type === 'pane.closed.result' && m.createRequestId === identity.createRequestId) {
      return { ok: m.success !== false, error: typeof m.error === 'string' ? m.error : undefined }
    }
    return null
  }, opts?.timeoutMs ?? KILL_ACK_TIMEOUT_MS)
  send({
    type: 'pane.closed',
    createRequestId: identity.createRequestId,
    ...(identity.terminalId ? { terminalId: identity.terminalId } : {}),
  })
  return wait.then((ack) => {
    if (!ack.ok) {
      log.warn('pane close was not acknowledged as durably recorded — the pane stays', {
        createRequestId: identity.createRequestId,
        ...ack,
      })
    }
    return ack
  })
}

/** The fresh-agent close request (the `freshAgent.kill` payload minus its type). */
export interface FreshAgentKillRequest {
  sessionId: string
  sessionType: string
  provider: string
  cwd?: string
}

/**
 * The fresh-agent close await — the killed answer (top-level or
 * event-wrapped) matched on `(sessionId, provider)`; `success:false`
 * resolves as a failure. Match breadth note: `freshAgent.killed` is a
 * broadcast (every client sees every close), so a waiter also resolves on a
 * close another device landed for the same session — correct: the close
 * intent is satisfied either way.
 */
export function sendFreshAgentKillAndAwait(
  req: FreshAgentKillRequest,
  opts?: { timeoutMs?: number; send?: (msg: unknown) => void },
): Promise<KillAck> {
  const send = opts?.send ?? ((m: unknown) => getWsClient().send(m))
  send({
    type: 'freshAgent.kill',
    sessionId: req.sessionId,
    sessionType: req.sessionType,
    provider: req.provider,
    ...(req.cwd ? { cwd: req.cwd } : {}),
  })
  return awaitCloseFrame((msg) => {
    const m = msg as Record<string, unknown>
    if (m.type === 'freshAgent.killed' && m.sessionId === req.sessionId && m.provider === req.provider) {
      return { ok: m.success !== false }
    }
    if (m.type === 'freshAgent.event' && m.sessionId === req.sessionId && m.provider === req.provider) {
      const event = m.event as Record<string, unknown> | undefined
      if (event?.type === 'freshAgent.killed') {
        return { ok: event.success !== false }
      }
    }
    return null
  }, opts?.timeoutMs ?? KILL_ACK_TIMEOUT_MS).then((ack) => {
    if (!ack.ok) {
      log.warn('fresh-agent kill was not acknowledged as a durable close — the pane stays', {
        sessionId: req.sessionId,
        provider: req.provider,
        ...ack,
      })
    }
    return ack
  })
}
