/**
 * kata b8ke focused round-4 R4-1: the ready frame's zod parser, extracted
 * from App.tsx so the client tests can exercise the PARSER BOUNDARY — the
 * fold tests must drive the exact App path (parse, then fold
 * `parsed.data.runtimeOwners`), never the fold helper with raw objects
 * (zod strips unknown object properties, which silently dropped the
 * b8ke `state`/`reason` replay fields pre-fix: every fenced replay folded
 * as handoff-committed).
 */
import { z } from 'zod'

export const ReadyMessageSchema = z.object({
  type: z.literal('ready'),
  timestamp: z.string(),
  serverInstanceId: z.string().min(1),
  bootId: z.string().min(1).optional(),
  // The server's baked build identity (additive/optional — old servers omit
  // it). Compared in checkServerBuildId below. Plain `z.string()` (NOT
  // min(1)): a present-but-EMPTY buildId must reach the helper and no-op
  // there, never fail the WHOLE ready frame and silently disable restart
  // detection. Only a non-string TYPE can fail the frame, which no real
  // server emits (the helper additionally treats "unknown" as a no-op).
  buildId: z.string().optional(),
  // Server capability ack (present iff our hello opted in). Deliberately a
  // loose record: an unexpected capabilities shape must never fail the WHOLE
  // ready frame and silently disable restart detection.
  capabilities: z.record(z.string(), z.unknown()).optional(),
  freshAgentAttention: z.array(z.object({
    provider: z.string().min(1),
    sessionId: z.string().min(1),
    sessionType: z.string().optional(),
    lastTurnCompleteAt: z.number().finite().optional(),
    lastWaitingAt: z.number().finite().optional(),
    lastQuestionAvailableAt: z.number().finite().optional(),
  })).optional().catch(undefined),
  // kata b8ke: the handshake's runtime-owner replay (additive/optional —
  // old servers omit it). Same ready-frame doctrine: `.catch(undefined)`
  // degrades a malformed replay to "no owners folded" (the reconcile gate
  // stays open; the server-side generation fence is the backstop) instead
  // of failing the WHOLE ready frame.
  //
  // b8ke focused round-4 R4-1/R4-6: `state` and `reason` are DECLARED —
  // the parser must pass the replay's fenced/transition truth through to
  // the fold (pre-fix zod stripped them and every fenced replay folded as
  // handoff-committed). `state` accepts the full additive union
  // ('live' | 'fenced' | 'starting' | 'handoff' | 'stopping') so an
  // in-progress lifecycle replays as what it is, never committed-live.
  runtimeOwners: z.array(z.object({
    provider: z.string().min(1),
    sessionId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    ownerKind: z.enum(['terminal', 'fresh-agent', 'vacant']),
    state: z.enum(['live', 'fenced', 'starting', 'handoff', 'stopping']).optional(),
    reason: z.string().optional(),
    terminalId: z.string().optional(),
    // b8ke focused episode-2 post-cap F5 (wire-additive): the CANONICAL id
    // an ALIASED (re-keyed) key resolved to. The record's ownerKind/state/
    // generation are the CANONICAL record's truth (the server walks the
    // fixpoint), so a cross-device pane holding the PRE-REKEY id folds the
    // authoritative owner state — never a permanent "vacant" — and
    // `aliasOf` carries the navigation to the canonical key.
    aliasOf: z.string().min(1).optional(),
  })).optional().catch(undefined),
})
