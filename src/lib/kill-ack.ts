import { nanoid } from 'nanoid'
import { createLogger } from './client-logger'
import { markTerminalReleased } from './terminal-release-marks'
import { getWsClient } from './ws-client'

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
 */
const log = createLogger('kill-ack')

/** The bounded close-ack wait — 5s, per the round-2 brief. */
export const KILL_ACK_TIMEOUT_MS = 5_000

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

type FrameVerdict = { ok: boolean; error?: string }

function awaitCloseFrame(
  match: (msg: unknown) => FrameVerdict | null,
  timeoutMs: number,
): Promise<KillAck> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ack: KillAck) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
      resolve(ack)
    }
    unsubscribe = getWsClient().onMessage((msg) => {
      const verdict = match(msg)
      if (verdict === null) return
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
    // Legacy-server fallbacks (see the module doc).
    if (m.type === 'terminal.exit' && m.terminalId === terminalId) return { ok: true }
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
