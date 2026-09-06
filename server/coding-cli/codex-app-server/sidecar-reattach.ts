import { logger } from '../../logger.js'
import {
  classifyOwnedProcessGroup,
  DEFAULT_TERMINATE_GRACE_MS,
  teardownOwnedProcessGroup,
  type CodexSurvivorAttachErrorCode,
  type HeldCodexSidecarOwnership,
} from './runtime.js'

// Restore-time sidecar reattach (kata 4g2a): the boot reaper's owner-dead branch offers verified
// survivors to this reconciler instead of killing them, so a restored resume-keyed codex pane can
// claim its surviving app-server sidecar. Unclaimed survivors are swept through the hourly
// maintenance tick once the grace window expires; in-flight claims are never swept.
//
// Import direction: this module imports from runtime.ts — runtime.ts NEVER imports this module
// (its CodexSidecarHoldSink is declared structurally with the literal verdict union).

export const CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS = 30 * 60 * 1000

export type CodexSidecarReconcilerLogger = {
  info: (fields: Record<string, unknown>, message: string) => void
  warn: (fields: Record<string, unknown>, message: string) => void
}

// Parses FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS: absent → default; '0' (or any non-negative safe
// integer) honored literally; anything else → default plus a warn (a mistyped value must never
// disable the safety net, and must never crash boot either). Digit strings too long for a safe
// integer parse to Infinity (or lose precision), which would make hasExpired() permanently false
// and silently disable the sweep — they fall back like any other invalid value.
export function resolveCodexSidecarReapGraceMs(
  raw: string | undefined,
  log: { warn: (fields: Record<string, unknown>, message: string) => void } = logger,
): number {
  if (raw === undefined) return CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  log.warn({ raw }, 'Invalid FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS; falling back to the default sidecar reap grace')
  return CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS
}

export type CodexSidecarHoldVerdict = 'held' | 'removed-unowned' | 'kept-unproven'

function isClaimableSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && sessionId.length > 0
}

export class CodexSidecarReconciler {
  private readonly reapGraceMs: number
  private readonly nowFn: () => number
  private readonly log: CodexSidecarReconcilerLogger
  private readonly bootedAtMs: number
  /** Verified survivors the boot reaper held for restore claims, keyed by ownershipId. */
  private readonly held = new Map<string, HeldCodexSidecarOwnership>()
  /** Claim index: codex thread id → held ownershipIds, sorted newest-updatedAt-first. */
  private readonly bySession = new Map<string, string[]>()
  /** Claims handed to an attacher but not yet settled or dropped: never swept mid-attach. */
  private readonly inFlightClaims = new Set<string>()

  constructor(options: {
    reapGraceMs?: number
    nowFn?: () => number
    log?: CodexSidecarReconcilerLogger
  } = {}) {
    this.reapGraceMs = options.reapGraceMs ?? CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS
    this.nowFn = options.nowFn ?? Date.now
    this.log = options.log ?? logger.child({ component: 'codex-sidecar-reconciler' })
    this.bootedAtMs = this.nowFn()
  }

  /**
   * Boot-pass entry: a fresh ownership classification decides the record's fate. Verified-owned
   * survivors are held claimable; anything else delegates to the same conservative
   * teardownOwnedProcessGroup the reaper uses today (gone/foreign unlink without signaling;
   * self/indeterminate refuse and keep the file).
   */
  async hold(ownership: HeldCodexSidecarOwnership): Promise<CodexSidecarHoldVerdict> {
    const { metadata } = ownership
    const status = await classifyOwnedProcessGroup(metadata)
    if (status !== 'owned') {
      const removed = await teardownOwnedProcessGroup(ownership, DEFAULT_TERMINATE_GRACE_MS)
      return removed ? 'removed-unowned' : 'kept-unproven'
    }

    this.held.set(metadata.ownershipId, ownership)
    const sessionId = metadata.sessionId
    if (isClaimableSessionId(sessionId)) {
      // Re-holding an already-indexed record must not append a duplicate: the held map dedupes by
      // key, this array does not (a duplicate would offer the same record to a second claim).
      const ids = this.bySession.get(sessionId) ?? []
      if (!ids.includes(metadata.ownershipId)) ids.push(metadata.ownershipId)
      // Newest-updatedAt-first so a restore claims the freshest record for its thread.
      ids.sort((a, b) => {
        const updatedAtA = this.held.get(a)?.metadata.updatedAt ?? ''
        const updatedAtB = this.held.get(b)?.metadata.updatedAt ?? ''
        if (updatedAtA === updatedAtB) return a.localeCompare(b)
        return updatedAtA < updatedAtB ? 1 : -1
      })
      this.bySession.set(sessionId, ids)
    }
    this.log.info(
      { ownershipId: metadata.ownershipId, sessionId: sessionId ?? null, wsUrl: metadata.wsUrl },
      'Held a verified surviving Codex app-server sidecar for restore claims',
    )
    return 'held'
  }

  /**
   * One-shot claim for a restore-class plan: pops the newest still-held entry for the session
   * (stale index entries whose record left `held` are skipped and dropped) and marks it in-flight
   * so the sweep can never reap it mid-attach.
   */
  claimForSession(sessionId: string): HeldCodexSidecarOwnership | null {
    const ids = this.bySession.get(sessionId)
    if (!ids) return null
    while (ids.length > 0) {
      const ownershipId = ids.shift()!
      const ownership = this.held.get(ownershipId)
      if (!ownership) continue
      this.inFlightClaims.add(ownershipId)
      if (ids.length === 0) this.bySession.delete(sessionId)
      return ownership
    }
    this.bySession.delete(sessionId)
    return null
  }

  /** Attach succeeded: the survivor now belongs to the new server, fully un-managed here. */
  dropClaim(ownershipId: string): void {
    this.held.delete(ownershipId)
    this.inFlightClaims.delete(ownershipId)
    // The claim was already consumed out of bySession at claimForSession time.
  }

  /**
   * Attach failed with a coded survivor error (kata 4g2a da92 parity):
   * - `not_writer`: the sidecar may write another thread — keep it alive and held (its claim is
   *   consumed; it never re-enters this session index).
   * - `identity`/`unreachable`: reap the verified-but-unusable survivor through the same
   *   conservative ownership-gated teardown the reaper uses, then drop the claim. A teardown
   *   refusal (self/indeterminate) keeps the file for the hourly reaper to retry from disk.
   *
   * Never throws (review F2): teardownOwnedProcessGroup contractually returns false on refusals
   * but can still throw on internal errors. Propagating that throw would strand the candidate in
   * inFlightClaims (permanently sweep-protected) and substitute the original attach error at the
   * claim loop, so a thrown teardown is warn-logged and still ends with dropClaim bookkeeping.
   */
  async settleFailedClaim(
    ownership: HeldCodexSidecarOwnership,
    code: CodexSurvivorAttachErrorCode,
  ): Promise<void> {
    if (code === 'codex_survivor_not_writer') {
      this.inFlightClaims.delete(ownership.metadata.ownershipId)
      return
    }
    try {
      const removed = await teardownOwnedProcessGroup(ownership, DEFAULT_TERMINATE_GRACE_MS)
      if (!removed) {
        this.log.warn(
          { ownershipId: ownership.metadata.ownershipId, code, metadataPath: ownership.metadataPath },
          'Failed-claim survivor teardown was refused; the hourly reaper will retry the record from disk',
        )
      }
    } catch (error) {
      this.log.warn(
        { err: error, ownershipId: ownership.metadata.ownershipId, code, metadataPath: ownership.metadataPath },
        'Failed-claim survivor teardown threw; dropping the claim and leaving the record for the hourly reaper',
      )
    }
    this.dropClaim(ownership.metadata.ownershipId)
  }

  /**
   * The sweeper's bookkeeping: drop ids another actor (the hourly reaper) removed from disk so a
   * reaped id never lingers in any map (otherwise the sweep would stay "due" over ghosts).
   */
  forget(ownershipIds: string[]): void {
    if (ownershipIds.length === 0) return
    const dropped = new Set(ownershipIds)
    for (const ownershipId of ownershipIds) {
      this.held.delete(ownershipId)
      this.inFlightClaims.delete(ownershipId)
    }
    for (const [sessionId, ids] of this.bySession) {
      const kept = ids.filter((ownershipId) => !dropped.has(ownershipId))
      if (kept.length === 0) this.bySession.delete(sessionId)
      else if (kept.length !== ids.length) this.bySession.set(sessionId, kept)
    }
  }

  hasExpired(nowMs?: number): boolean {
    const now = nowMs ?? this.nowFn()
    return now - this.bootedAtMs >= this.reapGraceMs
  }

  /**
   * Ids the reaper must skip right now: before grace expiry every held id plus every in-flight
   * claim; after expiry only in-flight claims (an in-flight attach must never be swept out from
   * under the attacher).
   */
  sweepProtectionSet(nowMs?: number): Set<string> {
    if (this.hasExpired(nowMs)) {
      return new Set(this.inFlightClaims)
    }
    return new Set([...this.held.keys(), ...this.inFlightClaims])
  }

  snapshot(): {
    held: number
    claimableSessions: number
    inFlightClaims: number
    bootedAtIso: string
    reapGraceMs: number
  } {
    return {
      held: this.held.size,
      claimableSessions: this.bySession.size,
      inFlightClaims: this.inFlightClaims.size,
      bootedAtIso: new Date(this.bootedAtMs).toISOString(),
      reapGraceMs: this.reapGraceMs,
    }
  }
}
