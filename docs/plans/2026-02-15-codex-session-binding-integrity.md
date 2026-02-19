# Codex Session Binding Integrity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate Codex pane/session misassignment by making session ownership authoritative on the server and making cross-machine tab rehydration treat session IDs as scoped hints, not portable runtime bindings.

**Architecture:** Introduce a single server-side binding authority that enforces one live terminal owner per `provider+sessionId`, then route both indexer association and `terminal.create` reuse through that authority. Split client tab snapshot semantics into a portable `sessionRef` and a local-runtime `resumeSessionId`, and gate automatic resume on server identity match. This prevents duplicate ownership on one machine and unsafe rebinds across machines.

**Tech Stack:** Node/Express, ws, React 18, Redux Toolkit, Zod, Vitest (server/client/integration), Testing Library/e2e.

---

## Locked Design Decisions

- `resumeSessionId` is local runtime binding state, not globally portable tab state.
- Cross-machine rehydration keeps terminal mode/cwd/title, but does not auto-resume remote machine sessions.
- Server enforces one-owner invariant for `provider+sessionId`; duplicate binding attempts are rejected and logged.
- Association is edge-triggered (new/changed sessions) instead of blindly rebinding on every snapshot.

---

### Task 1: Add Failing Server Tests for Binding Ownership Invariants

**Files:**
- Create: `test/unit/server/session-binding-authority.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`

**Step 1: Write failing unit tests for ownership rules**

```ts
it('rejects binding the same session key to a second terminal', () => {
  const authority = new SessionBindingAuthority()
  authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
  const second = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't2' })
  expect(second.ok).toBe(false)
  expect(second.reason).toBe('session_already_owned')
})

it('is idempotent when binding the same provider/session to the same terminal', () => {
  const authority = new SessionBindingAuthority()
  const first = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
  const second = authority.bind({ provider: 'codex', sessionId: 's1', terminalId: 't1' })
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
})
```

**Step 2: Add failing integration regression for repeated onUpdate snapshots**

```ts
it('does not associate one codex session to multiple unassociated terminals across repeated updates', () => {
  // 3 terminals, same cwd, one codex session in repeated snapshots
  // expect exactly one terminal.session.associated broadcast total
})
```

**Step 3: Add failing WS regression for duplicate owner records**

```ts
it('terminal.create reuses only canonical owner when duplicate resumeSessionId records exist', async () => {
  // seed registry with two running codex terminals carrying same sessionId
  // expect attach to canonical and duplicate is quarantined/unbound
})
```

**Step 4: Run targeted tests and confirm failure**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/unit/server/session-binding-authority.test.ts
npx vitest run --config vitest.server.config.ts test/server/session-association.test.ts
npx vitest run --config vitest.server.config.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
```
Expected: FAIL with missing authority class and failing duplicate-association assertions.

**Step 5: Commit failing tests**

```bash
git add test/unit/server/session-binding-authority.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
git commit -m "test: codex session binding ownership invariants and duplicate-association regressions"
```

---

### Task 2: Implement SessionBindingAuthority and Integrate Terminal Registry APIs

**Files:**
- Create: `server/session-binding-authority.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/unit/server/terminal-registry.findRunningTerminal.test.ts`

**Step 1: Implement minimal authority with explicit result types**

```ts
import { makeSessionKey, type SessionCompositeKey, type CodingCliProviderName } from './coding-cli/types.js'

export class SessionBindingAuthority {
  private bySession = new Map<SessionCompositeKey, string>()
  private byTerminal = new Map<string, SessionCompositeKey>()

  bind(input: { provider: CodingCliProviderName; sessionId: string; terminalId: string }): BindResult {
    const key = makeSessionKey(input.provider, input.sessionId)
    const owner = this.bySession.get(key)
    if (owner && owner !== input.terminalId) return { ok: false as const, reason: 'session_already_owned', owner }
    const existing = this.byTerminal.get(input.terminalId)
    if (existing && existing !== key) return { ok: false as const, reason: 'terminal_already_bound', existing }
    this.bySession.set(key, input.terminalId)
    this.byTerminal.set(input.terminalId, key)
    return { ok: true as const, key }
  }

  ownerForSession(provider: CodingCliProviderName, sessionId: string): string | undefined {
    return this.bySession.get(makeSessionKey(provider, sessionId))
  }

  unbindTerminal(terminalId: string): UnbindResult {
    const key = this.byTerminal.get(terminalId)
    if (!key) return { ok: false, reason: 'not_bound' }
    this.byTerminal.delete(terminalId)
    if (this.bySession.get(key) === terminalId) this.bySession.delete(key)
    return { ok: true, key }
  }
}

export type BindResult =
  | { ok: true; key: SessionCompositeKey }
  | { ok: false; reason: 'session_already_owned'; owner: string }
  | { ok: false; reason: 'terminal_already_bound'; existing: SessionCompositeKey }

export type UnbindResult =
  | { ok: true; key: SessionCompositeKey }
  | { ok: false; reason: 'not_bound' }
```

**Step 2: Replace raw `setResumeSessionId` writes with guarded bind path**

```ts
bindSession(terminalId: string, provider: CodingCliProviderName, sessionId: string): BindSessionResult {
  const term = this.terminals.get(terminalId)
  if (!term) return { ok: false, reason: 'terminal_missing' }
  if (term.mode !== provider) return { ok: false, reason: 'mode_mismatch' }
  const auth = this.bindingAuthority.bind({ provider, sessionId, terminalId })
  if (!auth.ok) return auth
  term.resumeSessionId = sessionId
  return { ok: true, terminalId, sessionId }
}

type BindSessionResult =
  | { ok: true; terminalId: string; sessionId: string }
  | { ok: false; reason: 'terminal_missing' | 'mode_mismatch' }
  | BindResult

// Keep `reason` values disjoint across variants for easy narrowing:
// session_already_owned | terminal_already_bound | terminal_missing | mode_mismatch
```

**Step 3: Add unbind on terminal shutdown/exit**

```ts
private releaseBinding(terminalId: string) {
  this.bindingAuthority.unbindTerminal(terminalId)
  const rec = this.terminals.get(terminalId)
  if (rec) rec.resumeSessionId = undefined
}
```

**Step 4: Run registry-focused tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/unit/server/session-binding-authority.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/terminal-registry.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/session-binding-authority.ts server/terminal-registry.ts test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts
git commit -m "feat: add authoritative provider-session terminal binding with one-owner invariant"
```

---

### Task 3: Refactor onUpdate Association to Use Delta Events + Authority

**Files:**
- Create: `server/session-association-coordinator.ts`
- Modify: `server/index.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/integration/server/claude-session-flow.test.ts`

**Step 1: Add failing coordinator tests (edge-triggered association)**

```ts
it('attempts association only for newly seen or advanced sessions', () => {
  // feed same snapshot 3x; expect one bind attempt
})

it('does not rebind when authority reports existing owner', () => {
  // same session appears with unassociated candidates present
  // expect no additional terminal.session.associated events
})
```

**Step 2: Implement coordinator that tracks last seen session watermark**

```ts
type SessionWatermark = Map<SessionCompositeKey, number> // provider+sessionId -> updatedAt

collectNewOrAdvanced(projects: ProjectGroup[]): CodingCliSession[] {
  // emit only sessions whose updatedAt increased (or unseen)
}

associateSingleSession(session: CodingCliSession): { associated: boolean; terminalId?: string } {
  // single-session entrypoint used by claudeIndexer.onNewSession
}
```

**Step 3: Wire `codingCliIndexer.onUpdate` to coordinator + `registry.bindSession`**

```ts
const candidates = coordinator.collectNewOrAdvanced(projects)
for (const session of candidates) {
  const match = registry.findAssociationCandidate(session.provider, session.cwd)
  if (!match) continue
  const bound = registry.bindSession(match.terminalId, session.provider, session.sessionId)
  if (!bound.ok) continue
  wsHandler.broadcast({ type: 'terminal.session.associated', terminalId: match.terminalId, sessionId: session.sessionId })
}
```

```ts
// Keep Claude onNewSession path, but route through the same coordinator + authority
claudeIndexer.onNewSession((session) => {
  const result = coordinator.associateSingleSession({
    provider: 'claude',
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
  })
  if (!result?.associated) return
  wsHandler.broadcast({
    type: 'terminal.session.associated',
    terminalId: result.terminalId,
    sessionId: session.sessionId,
  })
})
```

**Step 4: Run association tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/session-association.test.ts
npx vitest run --config vitest.server.config.ts test/integration/server/claude-session-flow.test.ts
```
Expected: PASS with no multi-terminal duplicate associations under repeated updates.

**Step 5: Commit**

```bash
git add server/session-association-coordinator.ts server/index.ts test/server/session-association.test.ts test/integration/server/claude-session-flow.test.ts
git commit -m "refactor: move coding-cli session association to delta-driven coordinator with guarded binding"
```

---

### Task 4: Harden WebSocket Resume Reuse and Duplicate Repair

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`

**Step 1: Add failing tests for canonical-owner reuse and repair signaling**

```ts
it('reuses canonical terminal owner for mode+resumeSessionId', async () => {
  // request terminal.create with existing codex session
  // expect terminal.created.effectiveResumeSessionId and reused terminalId
})

it('emits conflict log + unbinds duplicate records during lookup repair', async () => {
  // seed duplicate resumeSessionId records and assert repair side effects
})
```

**Step 2: Add canonical lookup API in registry**

```ts
getCanonicalRunningTerminalBySession(mode: TerminalMode, sessionId: string) {
  // Pure lookup: authority owner first; no mutation in this method.
}

repairLegacySessionOwners(mode: TerminalMode, sessionId: string) {
  // Legacy = terminal has resumeSessionId set but authority has no owner mapping yet.
  // Choose earliest-created running terminal as owner, bind it.
  // For non-canonical duplicates: set terminal.resumeSessionId = undefined,
  // remove any stale authority mapping, keep process running (no kill), and emit metadata upsert.
  // If no running terminal exists for the legacy set, do nothing and return.
}
```

**Step 3: Use canonical API in `terminal.create` path**

```ts
if (modeSupportsResume(mode) && effectiveResumeSessionId) {
  let existing = this.registry.getCanonicalRunningTerminalBySession(mode, effectiveResumeSessionId)
  if (!existing) {
    this.registry.repairLegacySessionOwners(mode, effectiveResumeSessionId)
    existing = this.registry.getCanonicalRunningTerminalBySession(mode, effectiveResumeSessionId)
  }
  if (existing) { /* attach + early return */ }
}
```

**Step 4: Run WS/server tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
npx vitest run --config vitest.server.config.ts test/server/ws-edge-cases.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts server/terminal-registry.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-edge-cases.test.ts
git commit -m "fix: enforce canonical session owner reuse in terminal.create and repair legacy duplicates"
```

---

### Task 5: Add Server Identity to Tab Registry Records and WS Handshake

**Files:**
- Create: `server/instance-id.ts`
- Modify: `server/index.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/tabs-registry/types.ts`
- Modify: `server/tabs-registry/store.ts`
- Modify: `src/store/tabRegistryTypes.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/store/connectionSlice.ts`
- Modify: `src/App.tsx`
- Modify: `test/server/ws-tabs-registry.test.ts`
- Modify: `test/unit/server/tabs-registry/types.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write failing schema/protocol tests for `serverInstanceId`**

```ts
expect(TabRegistryRecordSchema.parse({
  ...record,
  serverInstanceId: 'srv-abc123',
}).serverInstanceId).toBe('srv-abc123')
```

```ts
expect(ready.serverInstanceId).toBeTypeOf('string')
```

**Step 2: Extend handshake + record schema**

```ts
// index.ts bootstrap
const serverInstanceId = await loadOrCreateServerInstanceId() // persisted under ~/.freshell/instance-id
const wsHandler = new WsHandler(..., tabsStore, serverInstanceId)
```

```ts
// ws hello response
this.send(ws, { type: 'ready', timestamp: nowIso(), serverInstanceId: this.serverInstanceId })
```

```ts
serverInstanceId: z.string().min(1)
```

```ts
// Tab registry schema update (server + client mirrored types)
const TabRegistryRecordSchema = z.object({
  // existing fields...
  serverInstanceId: z.string().min(1),
})
```

```ts
const ReadyMessageSchema = z.object({
  type: z.literal('ready'),
  timestamp: z.string(),
  serverInstanceId: z.string().min(1),
})

// App bootstrap ready handler (schema-validated)
if (msg.type === 'ready') {
  const parsed = ReadyMessageSchema.safeParse(msg)
  if (parsed.success) dispatch(setServerInstanceId(parsed.data.serverInstanceId))
}
```

```ts
// connectionSlice.ts
type ConnectionState = { /* existing fields */; serverInstanceId?: string }
const setServerInstanceId = (state, action: PayloadAction<string | undefined>) => {
  state.serverInstanceId = action.payload
}
```

Note:
- Outbound `ready` is currently an untyped server send; `ReadyMessageSchema` is a new client-side validation guard.

**Step 3: Ensure `tabs.sync.push` enforces server instance id**

```ts
await this.tabsRegistryStore.upsert({
  ...record,
  serverInstanceId: this.serverInstanceId,
  deviceId: m.deviceId,
  deviceLabel: m.deviceLabel,
})
```

**Step 4: Run tabs-registry tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/unit/server/tabs-registry/types.test.ts
npx vitest run --config vitest.server.config.ts test/server/ws-tabs-registry.test.ts
npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/instance-id.ts server/index.ts server/ws-handler.ts server/tabs-registry/types.ts server/tabs-registry/store.ts src/store/tabRegistryTypes.ts src/lib/ws-client.ts src/store/connectionSlice.ts src/App.tsx test/server/ws-tabs-registry.test.ts test/unit/server/tabs-registry/types.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat: include server instance identity in tabs sync contract and handshake metadata"
```

---

### Task 6: Split Portable Session Reference from Local Runtime Binding in Client State

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/tabRegistrySync.ts`
- Modify: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Modify: `test/unit/client/lib/session-utils.test.ts`
- Modify: `test/unit/client/components/TabsView.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Add failing client tests for cross-machine rehydrate behavior**

```ts
it('drops resumeSessionId when opening remote tab copy from different serverInstanceId', () => {
  // remote pane payload has resumeSessionId + sessionRef
  // result keeps sessionRef and clears resumeSessionId
})
```

**Step 2: Add `sessionRef` payload model (reusing existing extract helper)**

```ts
type SessionLocator = {
  provider: CodingCliProviderName
  sessionId: string
  serverInstanceId?: string
}
```

Placement:
- Define/export `SessionLocator` in `src/store/paneTypes.ts` so both pane payload typing and `src/lib/session-utils.ts` can share it.

```ts
// snapshot payload
return {
  mode: content.mode,
  sessionRef: content.resumeSessionId ? { provider: content.mode, sessionId: content.resumeSessionId, serverInstanceId } : undefined,
  resumeSessionId: content.resumeSessionId, // local runtime only
}
```

Migration note:
- Keep writing both `sessionRef` and `resumeSessionId` for one compatibility cycle.
- After migration lands and old records age out, remove `resumeSessionId` from registry snapshot payload writes (runtime state still keeps it in live pane content).
- Add a tracking TODO + dated note in `src/lib/tab-registry-snapshot.ts` (`remove after 2026-04-30`) so cleanup is scheduled, not open-ended.

**Step 3: Gate rehydration in `TabsView.sanitizePaneSnapshot`**

```ts
const sameServer = (record.serverInstanceId && record.serverInstanceId === localServerInstanceId)
const safeResumeId = sameServer ? payload.resumeSessionId : undefined
return { kind: 'terminal', mode, shell, resumeSessionId: safeResumeId, sessionRef: payload.sessionRef, initialCwd }
```

```ts
// session-utils integration (avoid split-brain semantics):
// extend existing extractSessionRef; do not introduce a second helper.
function extractSessionRef(content: PaneContent): SessionLocator | undefined {
  if ('sessionRef' in content && content.sessionRef?.provider && content.sessionRef?.sessionId) {
    return content.sessionRef
  }
  // legacy fallback continues to read resumeSessionId
}
```

```ts
// Update callers to tolerate extended shape but keep provider/sessionId contract.
// Existing helpers (findTabIdForSession/findPaneForSession/getSessionsForHello)
// continue reading provider+sessionId only.
```

**Step 4: Update `TerminalView` association mirroring to preserve sessionRef**

```ts
updateContent({
  resumeSessionId: sessionId,
  sessionRef: { provider: mode, sessionId, serverInstanceId: localServerInstanceId },
})
```

**Step 5: Run client tests**

Run:
```bash
npx vitest run test/unit/client/lib/tab-registry-snapshot.test.ts
npx vitest run test/unit/client/lib/session-utils.test.ts
npx vitest run test/unit/client/components/TabsView.test.tsx
npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx
```
Expected: PASS.

**Step 6: Commit**

```bash
git add src/store/paneTypes.ts src/lib/tab-registry-snapshot.ts src/lib/session-utils.ts src/components/TabsView.tsx src/components/TerminalView.tsx src/store/tabRegistrySlice.ts src/store/tabRegistrySync.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/lib/session-utils.test.ts test/unit/client/components/TabsView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "refactor: separate portable session references from local resume bindings for tab rehydration"
```

---

### Task 7: End-to-End Regression Coverage + Observability

**Files:**
- Create: `test/integration/server/codex-session-rebind-regression.test.ts`
- Modify: `test/e2e/tabs-view-flow.test.tsx`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`

**Step 1: Add failing integration test for “refresh + repeated updates + multi-pane”**

```ts
it('keeps codex sessions bound to original panes after reconnect and repeated index updates', async () => {
  // simulate three codex panes, reconnect, and repeated onUpdate snapshots
  // assert each pane keeps distinct terminalId/session mapping
})
```

**Step 2: Add failing e2e test for remote tab copy behavior**

```ts
it('opens remote tab copy without auto-resuming foreign machine codex sessions', async () => {
  // open copy from remote record, confirm created pane has:
  //   resumeSessionId === undefined
  //   sessionRef.provider/sessionRef.sessionId preserved for explicit user-driven resume
})
```

**Step 3: Add structured logs/metrics for bind conflicts**

```ts
log.warn({ provider, sessionId, ownerTerminalId, attemptedTerminalId }, 'session_bind_conflict')
log.info({ provider, sessionId, repairedTerminalId }, 'session_bind_repair_applied')
```

**Step 4: Run integration/e2e targets**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/integration/server/codex-session-rebind-regression.test.ts
npx vitest run test/e2e/tabs-view-flow.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/codex-session-rebind-regression.test.ts test/e2e/tabs-view-flow.test.tsx server/index.ts server/terminal-registry.ts
git commit -m "test: add codex misassignment regressions and tabs cross-machine resume safety coverage"
```

---

### Task 8: Full Verification + Documentation Update

**Files:**
- Modify: `docs/index.html`
- Modify: `docs/plans/2026-02-15-codex-session-binding-integrity.md` (mark implementation notes if needed)

**Step 1: Update docs mock for rehydration behavior**

```html
<p class="text-sm">
  Remote tab copies preserve layout, mode, and working directory, but auto-resume only occurs when the tab snapshot originated from this same Freshell server instance.
</p>
```

**Step 2: Run full quality gate**

Run:
```bash
npm run lint
npm test
npm run verify
```
Expected: PASS (or documented pre-existing failures).

**Step 3: Final integration sanity run**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-tabs-registry.test.ts
```
Expected: PASS.

**Step 4: Final commit**

```bash
git add docs/index.html docs/plans/2026-02-15-codex-session-binding-integrity.md
git commit -m "docs: document server-scoped resume semantics for cross-device tab rehydration"
```

**Step 5: Merge readiness checklist**

Run:
```bash
git status --short
git log --oneline --decorate -n 10
```
Expected: clean branch with task-by-task commits ready for review/merge.
