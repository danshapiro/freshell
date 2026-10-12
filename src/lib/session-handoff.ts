import type { AppStore } from '@/store/store'
import { updateTab } from '@/store/tabsSlice'
import { updatePaneContent, setPaneHandoffError } from '@/store/panesSlice'
import { requestSessionHandoff, type SessionHandoffResult } from '@/lib/api'
import { buildResumeContent, buildTerminalAttachContent } from '@/lib/session-type-utils'
import { findPaneContent } from '@/lib/pane-utils'
import { mergeSessionMetadataByKey } from '@/lib/session-metadata'
import { hasWaitingPrompt, resolvePaneActivity } from '@/lib/pane-activity'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import { resolveCanonicalPaneSession, selectSessionRuntimeOwner } from '@/store/selectors/runtimeOwner'
import { resolveReopenPaneSessionTarget, type ReopenPaneSessionTarget } from '@/lib/session-flavor-reopen'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentProviderSettings } from '@/lib/fresh-agent-provider-types'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import type { Tab } from '@/store/types'
import type { PaneContent, TerminalPaneContent, FreshAgentPaneContent } from '@/store/paneTypes'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('SessionHandoff')

/**
 * kata b8ke: how long a user-driven handoff Retry waits before re-invoking
 * the server — a short backoff so a double-click can never tight-loop the
 * coordinator (round-3 review). Not an automatic retry loop: the User
 * Request forbids fixing handoffs with retries; every invocation here is
 * user-initiated.
 */
export const SESSION_HANDOFF_RETRY_BACKOFF_MS = 750

const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_OPENCODE_ACTIVITY_BY_ID = {}
const EMPTY_CLAUDE_ACTIVITY_BY_ID = {}
const EMPTY_AMPLIFIER_ACTIVITY_BY_ID = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}
const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}

/** The pane context a handoff run resolves (mirrors the ContextMenuProvider fold). */
type ReopenPaneContext = {
  tab: Tab
  content: TerminalPaneContent | FreshAgentPaneContent
  target: ReopenPaneSessionTarget
  providerSettings: FreshAgentProviderSettings | undefined
  freshAgentSessions: Record<string, FreshAgentSessionState>
}

function sameReopenTargetIdentity(
  a: ReopenPaneSessionTarget,
  b: ReopenPaneSessionTarget,
): boolean {
  return a.tabId === b.tabId
    && a.paneId === b.paneId
    && a.sourceSessionType === b.sourceSessionType
    && a.targetSessionType === b.targetSessionType
    && a.provider === b.provider
    && a.sessionId === b.sessionId
}

function sameReopenContextIdentity(
  a: ReopenPaneContext,
  b: ReopenPaneContext,
): boolean {
  return sameReopenTargetIdentity(a.target, b.target)
    && a.content.createRequestId === b.content.createRequestId
}

function resolveReopenContext(
  state: ReturnType<AppStore['getState']>,
  tabId: string,
  paneId: string,
  options: { allowRecovery?: boolean } = {},
): ReopenPaneContext | null {
  const tab = state.tabs.tabs.find((item) => item.id === tabId)
  const layout = state.panes.layouts[tabId]
  const content: PaneContent | null = layout ? findPaneContent(layout, paneId) : null
  if (!tab || !content) return null
  // A reopen target only exists for terminal/fresh-agent panes — narrowing
  // here keeps the context's content typed for the createRequestId read.
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return null

  const activity = resolvePaneActivity({
    paneId,
    content,
    tabMode: tab.mode,
    isOnlyPane: layout.type === 'leaf',
    codexActivityByTerminalId: state.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID,
    opencodeActivityByTerminalId: state.opencodeActivity?.byTerminalId ?? EMPTY_OPENCODE_ACTIVITY_BY_ID,
    claudeActivityByTerminalId: state.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID,
    amplifierActivityByTerminalId: state.amplifierActivity?.byTerminalId ?? EMPTY_AMPLIFIER_ACTIVITY_BY_ID,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID,
    freshAgentSessions: state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS,
  })
  let hasWaitingItems = false
  if (content.kind === 'fresh-agent' && content.sessionId) {
    hasWaitingItems = hasWaitingPrompt(
      (state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)[
        makeFreshAgentSessionKey({
          sessionType: content.sessionType,
          provider: content.provider,
          sessionId: content.sessionId,
        })
      ],
    )
  }

  const target = resolveReopenPaneSessionTarget({
    tabId,
    paneId,
    content,
    tab,
    activity: options.allowRecovery
      ? { isBusy: false }
      : {
        isBusy: activity.isBusy,
        ...(hasWaitingItems ? { hasWaitingItems } : {}),
      },
  })
  if (!target) return null
  return {
    tab,
    content,
    // Recovery is a bookkeeping action. It still requires a canonical
    // identity, but it must remain callable while the pane is creating,
    // starting, busy, or waiting so the server can return the typed refusal.
    target: options.allowRecovery
      ? { ...target, disabled: false, disabledReason: undefined }
      : target,
    providerSettings: state.settings.settings.freshAgent?.providers?.[target.targetSessionType],
    freshAgentSessions: state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS,
  }
}

/**
 * kata b8ke: the ONE atomic reopen handoff runner. The server enters
 * Handoff (generation+1) under the coordinator lease, stops the prior
 * runtime, awaits its confirmed reap, starts the target, and commits +
 * broadcasts the new owner — the client sends ONE awaited request keyed on
 * the pane's durable sessionRef (content.sessionId is NOT required) and
 * converts locally only on success. Failure keeps the pane and folds the
 * typed error for the banner + Retry surface.
 *
 * `expected` (the clicked menu target) guards against the pane changing
 * identity mid-flight — the same guard the pre-b8ke flow had.
 */
async function runPaneSessionHandoffInternal(
  appStore: AppStore,
  options: {
    tabId: string
    paneId: string
    expected?: ReopenPaneSessionTarget
    action?: 'switch' | 'clear-stale-bookkeeping' | 'stop-and-reopen'
  },
  allowRecovery = false,
): Promise<boolean> {
  const { tabId, paneId, expected } = options
  const action = options.action ?? 'switch'

  const current = resolveReopenContext(appStore.getState(), tabId, paneId, { allowRecovery })
  if (!current || (!allowRecovery && current.target.disabled)) return false
  if (expected && !sameReopenTargetIdentity(current.target, expected)) return false

  // b8ke delta round-3 F3: the durable metadata write belongs to the
  // ATOMIC transition — it happens AFTER the server commits the new
  // owner, never before the request. Pre-d3 the client flipped the
  // durable flavor first and every failure path (a pane race, a request
  // throw, REAP_TIMEOUT / TARGET_SPAWN_FAILED / STALE_GENERATION / the
  // typed fence refusals) returned WITHOUT restoring it — cross-device
  // and history restoration identified a session as terminal CLI while
  // its live owner was still the Fresh Agent, or vice versa. On failure
  // the durable flavor now still identifies the live owner by
  // construction (nothing was written).
  const latest = resolveReopenContext(appStore.getState(), tabId, paneId, { allowRecovery })
  if (!latest || (!allowRecovery && latest.target.disabled)) return false
  if (expected && !sameReopenTargetIdentity(latest.target, expected)) return false

  // b8ke ext F1: the pane's CANONICAL key — the stored rekey alias chain
  // resolved to the fixpoint. A pane holding the pre-rekey sessionRef
  // navigates to the canonical durable id: the server typed-refuses the
  // superseded aliased key (REKEYED_ALIAS_KEY), and the local fold must
  // never write the old key back (pre-ext the request AND the fold both
  // carried the superseded id, re-anchoring the pane on it).
  const canonicalPaneKey = resolveCanonicalPaneSession(appStore.getState(), latest.content)
  const canonicalSessionId = canonicalPaneKey?.provider === latest.target.provider
    ? canonicalPaneKey.sessionId
    : latest.target.sessionId

  const resolvedCwd = latest.target.cwd ?? getFreshOpenCodeRouteCwd(
    latest.content,
    {
      freshAgentSessions: latest.freshAgentSessions,
      sessionId: canonicalSessionId,
    },
  )

  // The observed (epoch, generation) fence pair is read at SEND time — a
  // retry after a stale-generation failure always carries the refreshed
  // pair from the runtime-owner record, never the stale one (round-2).
  // b8ke ext F1: the record is the CANONICAL key's (the alias chain
  // resolves to it).
  const ownerRecord = selectSessionRuntimeOwner(
    appStore.getState(),
    latest.target.provider,
    canonicalSessionId,
  )

  let handoff: SessionHandoffResult
  try {
    handoff = await requestSessionHandoff({
      provider: latest.target.provider,
      // b8ke ext F1: the request rides the pane's CANONICAL key.
      sessionId: canonicalSessionId,
      targetKind: latest.target.targetKind,
      ...(latest.target.targetKind === 'fresh-agent'
        ? { sessionType: latest.target.targetSessionType }
        : { mode: latest.target.runtimeProvider }),
      tabId,
      paneId,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
      ...(ownerRecord
        ? { observedEpoch: ownerRecord.epoch, observedGeneration: ownerRecord.generation }
        : {}),
      deviceId: appStore.getState().tabRegistry?.deviceId,
      action,
    })
  } catch (err) {
    const currentAfterFailure = resolveReopenContext(
      appStore.getState(),
      tabId,
      paneId,
      { allowRecovery },
    )
    if (!currentAfterFailure || !sameReopenContextIdentity(currentAfterFailure, latest)) {
      log.info({
        event: 'session_handoff_failure_ignored_pane_changed',
        provider: latest.target.provider,
        sessionId: latest.target.sessionId,
        tabId,
        paneId,
      })
      return false
    }
    log.warn({
      event: 'session_handoff_request_failed',
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      targetKind: latest.target.targetKind,
      tabId,
      paneId,
      err,
    })
    appStore.dispatch(setPaneHandoffError({
      tabId,
      paneId,
      error: {
        code: 'HANDOFF_REQUEST_FAILED',
        message: 'The reopen could not reach the server. Try again.',
        retryable: true,
        generation: 0,
      },
    }))
    return false
  }

  // A delayed response belongs only to the identity captured before the
  // request. This guard covers clear-only results and typed failures too;
  // neither may overwrite a pane that was replaced while the request was in
  // flight.
  const postResponse = resolveReopenContext(
    appStore.getState(),
    tabId,
    paneId,
    { allowRecovery },
  )
  if (!postResponse || !sameReopenContextIdentity(postResponse, latest)) {
    log.info({
      event: 'session_handoff_response_ignored_pane_changed',
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      tabId,
      paneId,
    })
    return false
  }

  // b8ke focused round-4 R4-4 + ext r12 F1: the acknowledged
  // PlatformLimited force-clear's TYPED answer — the fence cleared, NO
  // handoff ran, no owner is committed. The clear STOPS AT THE CLEAR:
  // acknowledgment covers clearing the fence, NOT starting a writer over
  // the acknowledged-risk tree (on non-Linux the Claude descendant reaper
  // is a no-op, so a surviving provider CLI may still be writing the
  // session — an automatic retry would start the new owner over it). The
  // server never auto-re-enters handoff from the force-release path and
  // the clear response carries no retry instruction; the cleared banner
  // surfaces the state with an EXPLICIT user action to re-initiate the
  // handoff (which then goes through the coordinator fresh, as any new
  // request would — the prior is Vacant).
  if (handoff.ok === true && 'cleared' in handoff) {
    log.info({
      event: 'session_handoff_platform_limited_force_cleared',
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      tabId,
      paneId,
      generation: handoff.generation,
      // b8ke ext r28 F2: the reason-typed cleared label rides the log.
      cleared: handoff.cleared,
    })
    const clearedMessage = handoff.shutdownConfirmed
      ? 'Stale bookkeeping cleared and writer shutdown confirmed. Stop and reopen when ready.'
      : 'Stale bookkeeping cleared. Writer shutdown is unconfirmed; starting a replacement remains blocked.'
    appStore.dispatch(setPaneHandoffError({
      tabId,
      paneId,
      error: {
        code: 'HANDOFF_FORCE_CLEARED',
        message: clearedMessage,
        retryable: true,
        generation: handoff.generation,
      },
    }))
    return false
  }

  // The clear-only contract is immutable at both boundaries: a malformed or
  // incompatible server response must never be folded as a new owner.
  if (action === 'clear-stale-bookkeeping' && handoff.ok && 'owner' in handoff) {
    appStore.dispatch(setPaneHandoffError({
      tabId,
      paneId,
      error: {
        code: 'HANDOFF_REQUEST_FAILED',
        message: 'The server returned an invalid clear-only response. No reopen was started.',
        retryable: true,
        generation: 0,
      },
    }))
    return false
  }

  if (!handoff.ok) {
    appStore.dispatch(setPaneHandoffError({
      tabId,
      paneId,
      error: {
        code: handoff.error.code,
        message: handoff.error.message,
        retryable: handoff.error.retryable,
        generation: handoff.error.ownerGeneration ?? 0,
      },
    }))
    return false
  }

  // F3's preserved pane-race guard (the pre-d3 shape raced the metadata
  // write; the atomic home races the REQUEST): re-resolve after the
  // response and before the local fold. The SERVER handoff committed —
  // nothing undoes that — but a pane that changed identity mid-request
  // is NEVER clobbered by the fold (it moved on; the owner broadcasts
  // converge every surface).
  if (
    (expected && !sameReopenTargetIdentity(postResponse.target, expected))
    || !sameReopenContextIdentity(postResponse, latest)
  ) {
    log.info({
      event: 'session_handoff_pane_changed_mid_request',
      provider: latest.target.provider,
      sessionId: latest.target.sessionId,
      tabId,
      paneId,
    })
    // The durable flavor write happened SERVER-SIDE inside the handoff
    // commit (e3r1 F4) — nothing for the client to write here.
    return true
  }

  // b8ke ext F1: the fold records the CANONICAL id — the fresh-agent
  // arm writes the server-answered canonical owner sessionId; the
  // terminal arm writes the pane's resolved canonical key (pre-ext both
  // wrote latest.target.sessionId — the pane's possibly-superseded id).
  const committedSessionId = handoff.owner.kind === 'fresh-agent'
    ? handoff.owner.sessionId
    : canonicalSessionId
  appStore.dispatch(updatePaneContent({
    tabId,
    paneId,
    content: handoff.owner.kind === 'terminal'
      ? buildTerminalAttachContent({
        createRequestId: latest.content.createRequestId,
        mode: handoff.owner.mode,
        provider: latest.target.provider,
        sessionId: committedSessionId,
        terminalId: handoff.owner.terminalId,
        cwd: resolvedCwd,
      })
      : buildResumeContent({
        sessionType: handoff.owner.sessionType,
        sessionId: committedSessionId,
        cwd: resolvedCwd,
        ...(latest.content.kind === 'fresh-agent' && latest.content.checkpointWorkspace
          ? { checkpointWorkspace: latest.content.checkpointWorkspace }
          : {}),
        freshAgentProviderSettings: latest.providerSettings,
      }),
  }))

  const sessionMetadataByKey = mergeSessionMetadataByKey(
    latest.tab.sessionMetadataByKey,
    latest.target.provider,
    committedSessionId,
    { sessionType: latest.target.metadataSessionType },
  )
  if (sessionMetadataByKey !== latest.tab.sessionMetadataByKey) {
    appStore.dispatch(updateTab({
      id: latest.tab.id,
      updates: { sessionMetadataByKey },
    }))
  }
  // b8ke e3r1 F4: the durable flavor write is SERVER-ATOMIC — the
  // handoff commit records the target's flavor inside the server's
  // transition (single-server-ordered; cross-device out-of-order
  // delivery is impossible by construction). The client's separate
  // unversioned POST is GONE (pre-e3r1: two devices could deliver the
  // metadata POSTs out of order and an earlier generation's flavor
  // overwrote the later owner; failure was log-only success).
  return true
}

/** Run the ordinary mode switch. Busy/starting/waiting gates remain in force. */
export async function runPaneSessionHandoff(
  appStore: AppStore,
  options: {
    tabId: string
    paneId: string
    expected?: ReopenPaneSessionTarget
    action?: 'switch' | 'stop-and-reopen'
  },
): Promise<boolean> {
  return runPaneSessionHandoffInternal(appStore, options)
}

/**
 * Repair stale ownership bookkeeping without stopping or starting anything.
 * Recovery deliberately resolves identity independently of activity so the
 * user can get a typed server result from a starting or busy pane.
 */
export async function runPaneSessionRecovery(
  appStore: AppStore,
  options: { tabId: string; paneId: string; action: 'clear-stale-bookkeeping' },
): Promise<boolean> {
  return runPaneSessionHandoffInternal(appStore, options, true)
}
