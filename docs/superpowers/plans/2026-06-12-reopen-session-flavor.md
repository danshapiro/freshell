# Reopen Session Flavor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users right-click a coding-agent pane header or body to reopen the same durable session in the paired CLI/FreshAgent experience, and make closed sessions reopen from the left panel in the flavor last recorded for that session.

**Architecture:** Store session flavor as validated metadata on the provider session id. Public reopen flavors are the CLI session types `claude`, `codex`, and `opencode`, plus the paired FreshAgent session types `freshclaude`, `freshcodex`, and `freshopencode`; hidden types such as `kilroy` remain valid metadata for existing hidden flows but are not exposed as paired reopen targets. Reopen actions resolve a provider-durable `sessionRef` before showing the menu item, block unsafe source states, persist explicit metadata with higher priority than lifecycle materialization tags, terminate the source runtime when switching flavors, then replace the pane with `buildResumeContent`.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, WebSocket client messages, existing FreshAgent registry, Node/Express session metadata store, Vitest, Testing Library, coordinated npm test scripts.

---

## Load-Bearing Results Incorporated

- Confirmed: Freshell already forwards the same provider/session id through CLI and FreshAgent resume paths for Claude, Codex, and OpenCode when the id is provider-durable.
- Falsified: FreshAgent `content.sessionId` is not always durable. FreshAgent reopen and metadata tagging must prefer valid `sessionRef.sessionId` or valid `resumeSessionId`; OpenCode placeholders such as `freshopencode-*` must not be used.
- Falsified: `terminal.detach` leaves the PTY running. CLI-to-FreshAgent reopen must use `terminal.kill` after eligibility checks, not detach.
- Falsified: raw busy state is not enough. Pending approvals/questions and create states need explicit reopen eligibility rules.
- Falsified: fire-and-forget mount tagging can race explicit choices and can refresh the indexer repeatedly. Metadata writes need validation, no-op behavior, and source priority.

## Files And Responsibilities

- Create `shared/session-flavor.ts`: known metadata type allowlist, public reopen type allowlist, CLI/FreshAgent pair mapping, metadata source priority, provider/session id durability checks.
- Create `test/unit/shared/session-flavor.test.ts`: prove metadata allowlist, public pair mapping, source priority, and durable id checks.
- Modify `server/session-metadata-store.ts`: store `sessionTypeSource`, return whether writes changed state, and prevent lifecycle materialization tags from overriding explicit user choices.
- Modify `server/sessions-router.ts`: validate known metadata `sessionType`, accept `sessionTypeSource`, and skip indexer refresh on no-op writes.
- Modify `test/unit/server/session-metadata-store.test.ts`: prove source-priority and no-op write behavior.
- Modify `test/integration/server/session-metadata-api.test.ts`: prove invalid session types are rejected, unchanged writes do not refresh, and materialization cannot override explicit CLI flavor.
- Modify `src/lib/api.ts`: allow callers to pass metadata source.
- Modify `src/lib/session-type-utils.ts`: expose paired reopen labels using the shared pair mapping and existing UI labels/icons.
- Create `src/lib/session-flavor-reopen.ts`: resolve durable pane reopen targets and source eligibility from pane content, tab fallback identity, activity maps, and live FreshAgent/agent-chat state.
- Create `test/unit/client/lib/session-flavor-reopen.test.ts`: prove durable-id resolution and eligibility gating.
- Modify `test/unit/client/lib/session-type-utils.test.ts`: prove paired labels for public types and absence for hidden/unsupported types.
- Modify `src/components/context-menu/context-menu-types.ts`: carry tab/pane/provider/sessionType through FreshAgent targets.
- Modify `src/components/context-menu/context-menu-utils.ts`: parse the new context-menu data attributes.
- Modify `test/unit/client/components/context-menu/context-menu-utils.test.ts`: prove FreshAgent context parsing preserves pane and flavor identity.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: add context data attributes and persist FreshAgent flavor only on durable create/materialization events with source `materialized`.
- Modify `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`: prove context attributes and event-scoped metadata tagging; prove placeholder/internal session ids are not tagged.
- Modify `src/components/context-menu/menu-defs.ts`: add `Reopen as ...` items using pre-resolved `ReopenPaneSessionTarget` objects.
- Modify `test/unit/client/context-menu/menu-defs.test.ts`: prove labels, visibility, disabled/blocked states, and action payloads.
- Modify `src/components/context-menu/ContextMenuProvider.tsx`: select activity/session maps, execute resolved reopen targets, persist explicit metadata, kill the source runtime, replace pane content, and update tab metadata.
- Modify `test/unit/client/components/ContextMenuProvider.test.tsx`: prove terminal-to-FreshAgent and FreshAgent-to-CLI execution, source cleanup, metadata source priority, and no replacement on metadata failure.
- Modify `test/e2e/sidebar-click-opens-pane.test.tsx`: prove left-panel rows with persisted `sessionType` open as FreshAgent after the tab was closed.
- Modify `test/unit/server/coding-cli/session-indexer.test.ts`: prove persisted server metadata assigns validated `sessionType` to indexed sessions for left-panel reopen.
- Do not modify `docs/index.html`: the default mock does not model right-click pane menus or session-history flavor routing.

## Task 1: Add Shared Session Flavor Contracts

**Files:**
- Create: `shared/session-flavor.ts`
- Test: `test/unit/shared/session-flavor.test.ts`

- [ ] **Step 1: Write the failing shared contract tests**

Create `test/unit/shared/session-flavor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  getPairedPublicSessionType,
  isKnownSessionMetadataType,
  isDurableProviderSessionId,
  isPublicSessionType,
  resolveSessionTypeRuntimeProvider,
  shouldApplySessionTypeMetadata,
} from '../../../shared/session-flavor.js'

describe('session flavor shared contract', () => {
  it.each([
    ['claude', 'freshclaude'],
    ['codex', 'freshcodex'],
    ['opencode', 'freshopencode'],
    ['freshclaude', 'claude'],
    ['freshcodex', 'codex'],
    ['freshopencode', 'opencode'],
  ] as const)('pairs %s with %s', (source, target) => {
    expect(getPairedPublicSessionType(source)).toBe(target)
  })

  it('excludes hidden and unknown session types from public metadata', () => {
    expect(isPublicSessionType('freshclaude')).toBe(true)
    expect(isPublicSessionType('kilroy')).toBe(false)
    expect(isPublicSessionType('shell')).toBe(false)
    expect(isPublicSessionType('freshmadeup')).toBe(false)
  })

  it('keeps kilroy as known metadata for existing hidden flows', () => {
    expect(isKnownSessionMetadataType('kilroy')).toBe(true)
    expect(isKnownSessionMetadataType('freshmadeup')).toBe(false)
  })

  it.each([
    ['claude', 'claude'],
    ['freshclaude', 'claude'],
    ['codex', 'codex'],
    ['freshcodex', 'codex'],
    ['opencode', 'opencode'],
    ['freshopencode', 'opencode'],
  ] as const)('resolves %s to runtime provider %s', (sessionType, provider) => {
    expect(resolveSessionTypeRuntimeProvider(sessionType)).toBe(provider)
  })

  it('validates durable provider session ids without accepting known placeholders', () => {
    expect(isDurableProviderSessionId('claude', '550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isDurableProviderSessionId('claude', 'runtime-sdk-session-id')).toBe(false)
    expect(isDurableProviderSessionId('codex', 'codex-thread-1')).toBe(true)
    expect(isDurableProviderSessionId('codex', '')).toBe(false)
    expect(isDurableProviderSessionId('opencode', 'ses_real_1')).toBe(true)
    expect(isDurableProviderSessionId('opencode', 'freshopencode-req-1')).toBe(false)
  })

  it('keeps explicit metadata ahead of later materialization metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'claude', sessionTypeSource: 'explicit' },
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
    )).toBe(false)
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
      { sessionType: 'claude', sessionTypeSource: 'explicit' },
    )).toBe(true)
  })

  it('upgrades same-type materialized metadata to explicit metadata', () => {
    expect(shouldApplySessionTypeMetadata(
      { sessionType: 'freshclaude', sessionTypeSource: 'materialized' },
      { sessionType: 'freshclaude', sessionTypeSource: 'explicit' },
    )).toBe(true)
  })
})
```

- [ ] **Step 2: Run the focused shared test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/shared/session-flavor.test.ts --run
```

Expected: FAIL because `shared/session-flavor.ts` does not exist.

- [ ] **Step 3: Implement the shared contract**

Create `shared/session-flavor.ts`:

```ts
import { z } from 'zod'

export const CLI_SESSION_TYPES = ['claude', 'codex', 'opencode'] as const
export const PUBLIC_FRESH_AGENT_SESSION_TYPES = ['freshclaude', 'freshcodex', 'freshopencode'] as const
export const HIDDEN_SESSION_METADATA_TYPES = ['kilroy'] as const
export const PUBLIC_SESSION_TYPES = [
  ...CLI_SESSION_TYPES,
  ...PUBLIC_FRESH_AGENT_SESSION_TYPES,
] as const
export const KNOWN_SESSION_METADATA_TYPES = [
  ...PUBLIC_SESSION_TYPES,
  ...HIDDEN_SESSION_METADATA_TYPES,
] as const
export const SESSION_TYPE_METADATA_SOURCES = ['explicit', 'materialized'] as const

export type CliSessionType = typeof CLI_SESSION_TYPES[number]
export type PublicFreshAgentSessionType = typeof PUBLIC_FRESH_AGENT_SESSION_TYPES[number]
export type PublicSessionType = typeof PUBLIC_SESSION_TYPES[number]
export type KnownSessionMetadataType = typeof KNOWN_SESSION_METADATA_TYPES[number]
export type SessionTypeMetadataSource = typeof SESSION_TYPE_METADATA_SOURCES[number]

export const PublicSessionTypeSchema = z.enum(PUBLIC_SESSION_TYPES)
export const KnownSessionMetadataTypeSchema = z.enum(KNOWN_SESSION_METADATA_TYPES)
export const SessionTypeMetadataSourceSchema = z.enum(SESSION_TYPE_METADATA_SOURCES)

const PUBLIC_SESSION_TYPE_SET = new Set<string>(PUBLIC_SESSION_TYPES)
const KNOWN_SESSION_METADATA_TYPE_SET = new Set<string>(KNOWN_SESSION_METADATA_TYPES)
const CLI_TO_FRESH: Record<CliSessionType, PublicFreshAgentSessionType> = {
  claude: 'freshclaude',
  codex: 'freshcodex',
  opencode: 'freshopencode',
}
const FRESH_TO_CLI: Record<PublicFreshAgentSessionType, CliSessionType> = {
  freshclaude: 'claude',
  freshcodex: 'codex',
  freshopencode: 'opencode',
}

export type SessionFlavorMetadata = {
  sessionType?: string
  sessionTypeSource?: SessionTypeMetadataSource
}

export function isPublicSessionType(value: unknown): value is PublicSessionType {
  return typeof value === 'string' && PUBLIC_SESSION_TYPE_SET.has(value)
}

export function isKnownSessionMetadataType(value: unknown): value is KnownSessionMetadataType {
  return typeof value === 'string' && KNOWN_SESSION_METADATA_TYPE_SET.has(value)
}

export function getPairedPublicSessionType(sessionType: string | undefined): PublicSessionType | undefined {
  if (!sessionType || !isPublicSessionType(sessionType)) return undefined
  if (sessionType in CLI_TO_FRESH) return CLI_TO_FRESH[sessionType as CliSessionType]
  return FRESH_TO_CLI[sessionType as PublicFreshAgentSessionType]
}

export function resolveSessionTypeRuntimeProvider(sessionType: string | undefined): CliSessionType | undefined {
  if (!sessionType || !isPublicSessionType(sessionType)) return undefined
  if (sessionType in CLI_TO_FRESH) return sessionType as CliSessionType
  return FRESH_TO_CLI[sessionType as PublicFreshAgentSessionType]
}

export function isDurableProviderSessionId(provider: string | undefined, sessionId: string | undefined): boolean {
  if (!provider || !sessionId) return false
  if (provider === 'claude') {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
  }
  if (provider === 'opencode') {
    return /^ses_/.test(sessionId)
  }
  if (provider === 'codex') {
    return sessionId.trim().length > 0 && !sessionId.startsWith('freshcodex-')
  }
  return false
}

export function shouldApplySessionTypeMetadata(
  existing: SessionFlavorMetadata | undefined,
  incoming: Required<Pick<SessionFlavorMetadata, 'sessionType' | 'sessionTypeSource'>>,
): boolean {
  if (!existing?.sessionType) return true
  if (existing.sessionType === incoming.sessionType) {
    return existing.sessionTypeSource !== 'explicit' && incoming.sessionTypeSource === 'explicit'
  }
  if (existing.sessionTypeSource === 'explicit' && incoming.sessionTypeSource === 'materialized') {
    return false
  }
  return true
}
```

- [ ] **Step 4: Run the focused shared test and verify it passes**

Run:

```bash
npm run test:vitest -- test/unit/shared/session-flavor.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/session-flavor.ts test/unit/shared/session-flavor.test.ts
git commit -m "feat: define public session flavor contract"
```

## Task 2: Validate And Prioritize Session Metadata On The Server

**Files:**
- Modify: `server/session-metadata-store.ts`
- Modify: `server/sessions-router.ts`
- Test: `test/unit/server/session-metadata-store.test.ts`
- Test: `test/integration/server/session-metadata-api.test.ts`

- [ ] **Step 1: Write failing store tests**

Add these tests to `test/unit/server/session-metadata-store.test.ts`:

```ts
it('does not let materialized metadata override an explicit user flavor', async () => {
  await store.set('claude', 'sess-1', { sessionType: 'claude', sessionTypeSource: 'explicit' })
  const changed = await store.set('claude', 'sess-1', {
    sessionType: 'freshclaude',
    sessionTypeSource: 'materialized',
  })

  expect(changed).toBe(false)
  await expect(store.get('claude', 'sess-1')).resolves.toMatchObject({
    sessionType: 'claude',
    sessionTypeSource: 'explicit',
  })
})

it('returns false when setting unchanged session type metadata', async () => {
  await store.set('claude', 'sess-1', { sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
  const changed = await store.set('claude', 'sess-1', {
    sessionType: 'freshclaude',
    sessionTypeSource: 'materialized',
  })

  expect(changed).toBe(false)
})

it('allows explicit metadata to override materialized metadata', async () => {
  await store.set('claude', 'sess-1', { sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
  const changed = await store.set('claude', 'sess-1', {
    sessionType: 'claude',
    sessionTypeSource: 'explicit',
  })

  expect(changed).toBe(true)
  await expect(store.get('claude', 'sess-1')).resolves.toMatchObject({
    sessionType: 'claude',
    sessionTypeSource: 'explicit',
  })
})

it('continues to store hidden metadata types for existing hidden flows', async () => {
  const changed = await store.set('claude', 'sess-kilroy', { sessionType: 'kilroy' })

  expect(changed).toBe(true)
  await expect(store.get('claude', 'sess-kilroy')).resolves.toMatchObject({
    sessionType: 'kilroy',
  })
})
```

- [ ] **Step 2: Write failing API validation tests**

Add these tests to `test/integration/server/session-metadata-api.test.ts`:

```ts
function createMetadataTestApp() {
  const entries = new Map<string, { derivedTitle?: string; sessionType?: string; sessionTypeSource?: 'explicit' | 'materialized' }>()
  const sessionMetadataStore = {
    get: vi.fn(async (provider: string, sessionId: string) => entries.get(`${provider}:${sessionId}`)),
    set: vi.fn(async (provider: string, sessionId: string, entry: { derivedTitle?: string; sessionType?: string; sessionTypeSource?: 'explicit' | 'materialized' }) => {
      const key = `${provider}:${sessionId}`
      const existing = entries.get(key) ?? {}
      let next = { ...existing, ...entry }
      if (
        existing.sessionTypeSource === 'explicit' &&
        entry.sessionTypeSource === 'materialized' &&
        entry.sessionType &&
        entry.sessionType !== existing.sessionType
      ) {
        next = { ...next, sessionType: existing.sessionType, sessionTypeSource: existing.sessionTypeSource }
      }
      const changed = JSON.stringify(existing) !== JSON.stringify(next)
      if (changed) entries.set(key, next)
      return changed
    }),
  }
  const codingCliIndexer = {
    getProjects: vi.fn().mockReturnValue([]),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
  const app = express()
  app.use(express.json())
  app.use('/api', createSessionsRouter({
    configStore: {
      getSettings: vi.fn(),
      patchSessionOverride: vi.fn(),
      deleteSession: vi.fn(),
    } as any,
    codingCliIndexer,
    codingCliProviders: [],
    perfConfig: { slowSessionRefreshMs: 0 },
    sessionMetadataStore: sessionMetadataStore as any,
    validCliProviders: ['claude', 'codex', 'opencode'],
  }))
  return { app, entries, sessionMetadataStore, codingCliIndexer }
}

it('rejects unknown session metadata types while keeping kilroy compatibility', async () => {
  const { app } = createMetadataTestApp()

  await request(app)
    .post('/api/session-metadata')
    .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'kilroy' })
    .expect(200)

  await request(app)
    .post('/api/session-metadata')
    .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshmadeup' })
    .expect(400)
})

it('skips index refresh when metadata write is unchanged', async () => {
  const { app, codingCliIndexer } = createMetadataTestApp()

  await request(app)
    .post('/api/session-metadata')
    .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
    .expect(200)
  await request(app)
    .post('/api/session-metadata')
    .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
    .expect(200)

  expect(codingCliIndexer.refresh).toHaveBeenCalledTimes(1)
})

it('keeps explicit metadata when a later materialized tag disagrees', async () => {
  const { app, sessionMetadataStore } = createMetadataTestApp()

  await request(app)
    .post('/api/session-metadata')
    .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'claude', sessionTypeSource: 'explicit' })
    .expect(200)
  await request(app)
    .post('/api/session-metadata')
    .send({ provider: 'claude', sessionId: 'sess-1', sessionType: 'freshclaude', sessionTypeSource: 'materialized' })
    .expect(200)

  await expect(sessionMetadataStore.get('claude', 'sess-1')).resolves.toMatchObject({
    sessionType: 'claude',
    sessionTypeSource: 'explicit',
  })
})
```

Keep the existing first test in this file, but update its mock `set` to return `true` after it writes because the router now uses the boolean return value. Do not add `sessionTypeSource` to that source-less request/assertion; the route only forwards a source when the caller supplied one.

- [ ] **Step 3: Run focused server metadata tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts --run
```

Expected: FAIL because source priority, validation, and no-op refresh behavior do not exist.

- [ ] **Step 4: Implement metadata priority and no-op writes**

In `server/session-metadata-store.ts`, import the shared priority helper:

```ts
import {
  shouldApplySessionTypeMetadata,
  type SessionTypeMetadataSource,
} from '../shared/session-flavor.js'
```

Extend `SessionMetadataEntry`:

```ts
export type SessionMetadataEntry = {
  sessionType?: string
  sessionTypeSource?: SessionTypeMetadataSource
  derivedTitle?: string
}
```

Change `set` to return `Promise<boolean>` and apply source priority:

```ts
async set(provider: string, sessionId: string, entry: SessionMetadataEntry): Promise<boolean> {
  return this.writeMutex.acquire(async () => {
    const current = await this.load()
    const sessions = safeRecord<Record<string, SessionMetadataEntry>>()
    for (const [p, pSessions] of Object.entries(current.sessions)) {
      sessions[p] = toSafeRecord(pSessions)
    }
    if (!sessions[provider]) sessions[provider] = safeRecord()

    const existing = sessions[provider][sessionId] ?? {}
    let next: SessionMetadataEntry = { ...existing, ...entry }
    if (entry.sessionType && entry.sessionTypeSource) {
      const source = entry.sessionTypeSource
      const shouldApply = shouldApplySessionTypeMetadata(existing, {
        sessionType: entry.sessionType,
        sessionTypeSource: source,
      })
      next = shouldApply
        ? { ...existing, ...entry, sessionTypeSource: source }
        : {
            ...next,
            sessionType: existing.sessionType,
            sessionTypeSource: existing.sessionTypeSource,
          }
    }

    if (JSON.stringify(existing) === JSON.stringify(next)) return false
    sessions[provider][sessionId] = next
    await this.save({ version: 1, sessions })
    return true
  })
}
```

- [ ] **Step 5: Validate API input and skip no-op refreshes**

In `server/sessions-router.ts`, import schemas:

```ts
import {
  KnownSessionMetadataTypeSchema,
  SessionTypeMetadataSourceSchema,
} from '../shared/session-flavor.js'
```

Update `SessionMetadataPostSchema`:

```ts
const SessionMetadataPostSchema = z.object({
  provider: sessionMetadataProviderSchema,
  sessionId: z.string().min(1),
  sessionType: KnownSessionMetadataTypeSchema,
  sessionTypeSource: SessionTypeMetadataSourceSchema.optional(),
})
```

Update the route:

```ts
const { provider, sessionId, sessionType, sessionTypeSource } = parsed.data
const changed = await deps.sessionMetadataStore.set(provider, sessionId, {
  sessionType,
  ...(sessionTypeSource ? { sessionTypeSource } : {}),
})
if (changed) {
  await codingCliIndexer.refresh()
}
res.json({ ok: true, changed })
```

- [ ] **Step 6: Run focused server metadata tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/session-metadata-store.ts server/sessions-router.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts
git commit -m "feat: validate session flavor metadata"
```

## Task 3: Add Client Flavor Pairing And Durable Reopen Resolution

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/session-type-utils.ts`
- Create: `src/lib/session-flavor-reopen.ts`
- Test: `test/unit/client/lib/session-type-utils.test.ts`
- Test: `test/unit/client/lib/session-flavor-reopen.test.ts`
- Test: `test/unit/client/lib/api.test.ts`

- [ ] **Step 1: Write failing client mapping tests**

Add these tests to `test/unit/client/lib/session-type-utils.test.ts`:

```ts
import { getPairedSessionTypeTarget } from '@/lib/session-type-utils'

describe('getPairedSessionTypeTarget', () => {
  it.each([
    ['claude', 'freshclaude', 'Reopen as freshclaude', 'fresh-agent'],
    ['codex', 'freshcodex', 'Reopen as freshcodex', 'fresh-agent'],
    ['opencode', 'freshopencode', 'Reopen as freshopencode', 'fresh-agent'],
    ['freshclaude', 'claude', 'Reopen as Claude CLI', 'terminal'],
    ['freshcodex', 'codex', 'Reopen as Codex CLI', 'terminal'],
    ['freshopencode', 'opencode', 'Reopen as OpenCode CLI', 'terminal'],
  ] as const)('maps %s to %s', (sourceSessionType, targetSessionType, label, targetKind) => {
    expect(getPairedSessionTypeTarget(sourceSessionType)).toMatchObject({
      targetSessionType,
      label,
      targetKind,
    })
  })

  it('does not expose hidden or unsupported session types', () => {
    expect(getPairedSessionTypeTarget('kilroy')).toBeNull()
    expect(getPairedSessionTypeTarget('shell')).toBeNull()
    expect(getPairedSessionTypeTarget(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Write failing durable reopen resolver tests**

Create `test/unit/client/lib/session-flavor-reopen.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { resolveReopenPaneSessionTarget } from '@/lib/session-flavor-reopen'
import type { PaneContent } from '@/store/paneTypes'

const tab = {
  id: 'tab-1',
  mode: 'shell',
  title: 'Tab',
  status: 'running',
  createdAt: 1,
  createRequestId: 'tab-req',
} as any

describe('resolveReopenPaneSessionTarget', () => {
  it('resolves a Claude CLI pane to freshclaude using canonical sessionRef', () => {
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      terminalId: 'term-1',
      createRequestId: 'req-1',
      status: 'running',
      sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
      initialCwd: '/repo',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: false },
    })).toMatchObject({
      sourceSessionType: 'claude',
      targetSessionType: 'freshclaude',
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      label: 'Reopen as freshclaude',
      disabled: false,
    })
  })

  it('does not use a FreshAgent internal sessionId without a durable sessionRef or resumeSessionId', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'runtime-sdk-session-id',
      createRequestId: 'req-1',
      status: 'idle',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: false },
    })).toBeNull()
  })

  it('rejects FreshOpenCode placeholders and accepts materialized ses ids', () => {
    const placeholder: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
      createRequestId: 'req-1',
      status: 'idle',
    }
    const durable: PaneContent = {
      ...placeholder,
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: placeholder,
      tab,
      activity: { isBusy: false },
    })).toBeNull()
    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: durable,
      tab,
      activity: { isBusy: false },
    })).toMatchObject({ targetSessionType: 'opencode', sessionId: 'ses_real_1' })
  })

  it('disables reopen when the source pane has active work or waiting user decisions', () => {
    const content: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
      createRequestId: 'req-1',
      status: 'running',
    }

    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: true },
    })).toMatchObject({
      disabled: true,
      disabledReason: 'Agent is busy',
    })
    expect(resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content,
      tab,
      activity: { isBusy: false, hasWaitingItems: true },
    })).toMatchObject({
      disabled: true,
      disabledReason: 'Agent is waiting for input',
    })
  })

  it('passes the resolved durable identity in the action payload', () => {
    const target = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
      },
      tab,
      activity: { isBusy: false },
    })

    expect(target).toMatchObject({
      tabId: 'tab-1',
      paneId: 'pane-1',
      provider: 'codex',
      sessionId: 'codex-thread-1',
      targetSessionType: 'freshcodex',
    })
  })

  it('does not use a raw Codex resumeSessionId without durable proof', () => {
    const unproven = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        resumeSessionId: 'codex-thread-1',
      },
      tab,
      activity: { isBusy: false },
    })
    const proven = resolveReopenPaneSessionTarget({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-1',
        status: 'exited',
        resumeSessionId: 'codex-thread-1',
        codexDurability: {
          schemaVersion: 1,
          state: 'durable',
          durableThreadId: 'codex-thread-1',
        },
      },
      tab,
      activity: { isBusy: false },
    })

    expect(unproven).toBeNull()
    expect(proven).toMatchObject({ provider: 'codex', sessionId: 'codex-thread-1' })
  })
})
```

- [ ] **Step 3: Run focused client lib tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/session-flavor-reopen.test.ts --run
```

Expected: FAIL because the mapping and reopen resolver do not exist.

- [ ] **Step 4: Update the API helper and its exact-body tests**

In `src/lib/api.ts`, update `setSessionMetadata`:

```ts
export async function setSessionMetadata(
  provider: string,
  sessionId: string,
  sessionType: string,
  options: { sessionTypeSource?: 'explicit' | 'materialized' } = {},
): Promise<void> {
  await api.post('/api/session-metadata', {
    provider,
    sessionId,
    sessionType,
    sessionTypeSource: options.sessionTypeSource ?? 'explicit',
  })
}
```

In `test/unit/client/lib/api.test.ts`, update the exact-body test:

```ts
it('POSTs to /api/session-metadata with provider, sessionId, sessionType, and explicit source by default', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: () => Promise.resolve(''),
  })

  await setSessionMetadata('claude', 'sess-abc', 'freshclaude')

  expect(mockFetch).toHaveBeenCalledWith(
    '/api/session-metadata',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        provider: 'claude',
        sessionId: 'sess-abc',
        sessionType: 'freshclaude',
        sessionTypeSource: 'explicit',
      }),
    }),
  )
})
```

Add a materialized-source test:

```ts
it('POSTs materialized session metadata source when requested', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: () => Promise.resolve(''),
  })

  await setSessionMetadata('opencode', 'ses_real_1', 'freshopencode', {
    sessionTypeSource: 'materialized',
  })

  expect(mockFetch).toHaveBeenCalledWith(
    '/api/session-metadata',
    expect.objectContaining({
      body: JSON.stringify({
        provider: 'opencode',
        sessionId: 'ses_real_1',
        sessionType: 'freshopencode',
        sessionTypeSource: 'materialized',
      }),
    }),
  )
})
```

- [ ] **Step 5: Implement paired UI labels**

In `src/lib/session-type-utils.ts`, import shared mapping:

```ts
import {
  getPairedPublicSessionType,
  resolveSessionTypeRuntimeProvider,
  type PublicSessionType,
} from '@shared/session-flavor'
```

Add this exported type and helper above `buildResumeContent`:

```ts
export type PairedSessionTypeTarget = {
  sourceSessionType: PublicSessionType
  targetSessionType: PublicSessionType
  runtimeProvider: CodingCliProviderName
  label: string
  targetKind: 'terminal' | 'fresh-agent'
}

function cliProviderLabel(provider: CodingCliProviderName): string {
  if (provider === 'opencode') return 'OpenCode CLI'
  return `${getProviderLabel(provider)} CLI`
}

export function getPairedSessionTypeTarget(
  sessionType: string | undefined,
): PairedSessionTypeTarget | null {
  const targetSessionType = getPairedPublicSessionType(sessionType)
  if (!targetSessionType || !sessionType) return null
  const runtimeProvider = resolveSessionTypeRuntimeProvider(targetSessionType)
  if (!runtimeProvider) return null
  const targetKind = targetSessionType.startsWith('fresh') ? 'fresh-agent' : 'terminal'
  return {
    sourceSessionType: sessionType as PublicSessionType,
    targetSessionType,
    runtimeProvider,
    targetKind,
    label: targetKind === 'fresh-agent'
      ? `Reopen as ${targetSessionType}`
      : `Reopen as ${cliProviderLabel(runtimeProvider)}`,
  }
}
```

- [ ] **Step 6: Implement the durable reopen resolver**

Create `src/lib/session-flavor-reopen.ts`:

```ts
import type { Tab, CodingCliProviderName } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'
import { getPairedSessionTypeTarget } from '@/lib/session-type-utils'
import { isDurableProviderSessionId, type PublicSessionType } from '@shared/session-flavor'

export type ReopenPaneActivity = {
  isBusy: boolean
  hasWaitingItems?: boolean
}

export type ReopenPaneSessionTarget = {
  tabId: string
  paneId: string
  sourceSessionType: PublicSessionType
  targetSessionType: PublicSessionType
  provider: CodingCliProviderName
  sessionId: string
  cwd?: string
  label: string
  disabled: boolean
  disabledReason?: string
}

function paneSourceSessionType(content: PaneContent): string | undefined {
  if (content.kind === 'terminal') return content.mode !== 'shell' ? content.mode : undefined
  if (content.kind === 'fresh-agent') return content.sessionType
  return undefined
}

function paneCwd(content: PaneContent): string | undefined {
  return 'initialCwd' in content ? content.initialCwd : undefined
}

function validRef(provider: string | undefined, sessionId: string | undefined) {
  if (!provider || !sessionId) return null
  return isDurableProviderSessionId(provider, sessionId)
    ? { provider: provider as CodingCliProviderName, sessionId }
    : null
}

function durableCodexRef(content: PaneContent) {
  if (content.kind !== 'terminal' || content.mode !== 'codex') return null
  const durableThreadId = content.codexDurability?.durableThreadId
  const state = content.codexDurability?.state
  if ((state === 'durable' || state === 'durable_resuming') && durableThreadId) {
    return validRef('codex', durableThreadId)
  }
  return null
}

function durablePaneSessionRef(content: PaneContent, tab?: Tab) {
  if (content.kind === 'terminal') {
    return validRef(content.sessionRef?.provider, content.sessionRef?.sessionId)
      ?? validRef(tab?.sessionRef?.provider, tab?.sessionRef?.sessionId)
      ?? durableCodexRef(content)
      ?? (content.mode === 'codex' || tab?.mode === 'codex'
        ? null
        : validRef(content.mode !== 'shell' ? content.mode : tab?.mode, content.resumeSessionId ?? tab?.resumeSessionId))
  }
  if (content.kind === 'fresh-agent') {
    return validRef(content.sessionRef?.provider, content.sessionRef?.sessionId)
      ?? validRef(content.provider, content.resumeSessionId)
  }
  return null
}

function disabledReason(content: PaneContent, activity: ReopenPaneActivity): string | undefined {
  if (activity.hasWaitingItems) return 'Agent is waiting for input'
  if (activity.isBusy) return 'Agent is busy'
  if (content.kind === 'fresh-agent' && (content.status === 'creating' || content.status === 'starting')) {
    return 'Agent is still starting'
  }
  if (content.kind === 'terminal' && content.status === 'creating') {
    return 'Terminal is still starting'
  }
  return undefined
}

export function resolveReopenPaneSessionTarget(input: {
  tabId: string
  paneId: string
  content: PaneContent | null
  tab?: Tab
  activity: ReopenPaneActivity
}): ReopenPaneSessionTarget | null {
  const { tabId, paneId, content, tab, activity } = input
  if (!content) return null
  const sourceSessionType = paneSourceSessionType(content)
  const paired = getPairedSessionTypeTarget(sourceSessionType)
  if (!paired) return null
  const durableRef = durablePaneSessionRef(content, tab)
  if (!durableRef || durableRef.provider !== paired.runtimeProvider) return null
  const reason = disabledReason(content, activity)
  return {
    tabId,
    paneId,
    sourceSessionType: paired.sourceSessionType,
    targetSessionType: paired.targetSessionType,
    provider: durableRef.provider,
    sessionId: durableRef.sessionId,
    cwd: paneCwd(content),
    label: paired.label,
    disabled: Boolean(reason),
    ...(reason ? { disabledReason: reason } : {}),
  }
}
```

- [ ] **Step 7: Run focused client lib tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/session-flavor-reopen.test.ts test/unit/client/lib/api.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/lib/session-type-utils.ts src/lib/session-flavor-reopen.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/session-flavor-reopen.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: resolve durable pane reopen targets"
```

## Task 4: Preserve Pane Identity In Context Targets

**Files:**
- Modify: `src/components/context-menu/context-menu-types.ts`
- Modify: `src/components/context-menu/context-menu-utils.ts`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Test: `test/unit/client/components/context-menu/context-menu-utils.test.ts`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Write failing context target parser tests**

Add these tests to `test/unit/client/components/context-menu/context-menu-utils.test.ts`:

```ts
it('parseContextTarget for FreshAgent preserves pane and session flavor identity', () => {
  const result = parseContextTarget(ContextIds.FreshAgent, {
    tabId: 'tab-1',
    paneId: 'pane-1',
    sessionId: 'thread-1',
    provider: 'claude',
    sessionType: 'freshclaude',
  })

  expect(result).toEqual({
    kind: 'fresh-agent',
    tabId: 'tab-1',
    paneId: 'pane-1',
    sessionId: 'thread-1',
    provider: 'claude',
    sessionType: 'freshclaude',
  })
})

```

- [ ] **Step 2: Run parser tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/context-menu/context-menu-utils.test.ts --run
```

Expected: FAIL because the targets do not carry the new fields.

- [ ] **Step 3: Extend context target types and parsing**

In `src/components/context-menu/context-menu-types.ts`, replace the FreshAgent variant:

```ts
| {
    kind: 'fresh-agent'
    sessionId: string
    tabId?: string
    paneId?: string
    provider?: string
    sessionType?: string
  }
```

In `src/components/context-menu/context-menu-utils.ts`, update the FreshAgent case:

```ts
case ContextIds.FreshAgent:
  return data.sessionId
    ? {
        kind: 'fresh-agent',
        sessionId: data.sessionId,
        tabId: data.tabId,
        paneId: data.paneId,
        provider: data.provider,
        sessionType: data.sessionType,
      }
    : null
```

- [ ] **Step 4: Add FreshAgent body data attributes**

In `src/components/fresh-agent/FreshAgentView.tsx`, update the outer FreshAgent pane `<div>`:

```tsx
<div
  className="fresh-agent-pane relative flex h-full min-h-0 flex-col overflow-hidden"
  data-context="fresh-agent"
  data-tab-id={tabId}
  data-pane-id={paneId}
  data-session-id={paneContent.sessionId}
  data-provider={paneContent.provider}
  data-session-type={paneContent.sessionType}
  style={{ '--fresh-transcript-font-size': `${terminalFontSize}px` } as CSSProperties}
  onPointerUpCapture={handlePanePointerUp}
  onKeyDownCapture={handlePaneKeyDown}
>
```

- [ ] **Step 5: Add a FreshAgent DOM regression test**

Add this test to `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`:

```ts
it('marks the fresh-agent body with pane and session flavor context metadata', async () => {
  const store = createStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: CLAUDE_THREAD_ID,
      createRequestId: 'req-context',
      status: 'idle',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  const root = document.querySelector('.fresh-agent-pane') as HTMLElement
  expect(root.dataset.context).toBe('fresh-agent')
  expect(root.dataset.tabId).toBe('tab-1')
  expect(root.dataset.paneId).toBe('pane-1')
  expect(root.dataset.sessionId).toBe(CLAUDE_THREAD_ID)
  expect(root.dataset.provider).toBe('claude')
  expect(root.dataset.sessionType).toBe('freshclaude')
})
```

- [ ] **Step 6: Run focused tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/context-menu/context-menu-types.ts src/components/context-menu/context-menu-utils.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat: preserve session flavor context metadata"
```

## Task 5: Persist FreshAgent Flavor On Durable Materialization Events

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Write failing event-scoped metadata tests**

Extend the `@/lib/api` mock in `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`:

```ts
const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  post: vi.fn(),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, post: apiMock.post },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    setSessionMetadata: apiMock.setSessionMetadata,
  }
})
```

Reset it in `beforeEach`:

```ts
apiMock.setSessionMetadata.mockReset()
apiMock.setSessionMetadata.mockResolvedValue(undefined)
```

Add these tests:

```ts
it('tags durable FreshAgent created events as materialized metadata', async () => {
  const listeners: Array<(message: any) => void> = []
  wsMock.onMessage.mockImplementation((listener) => {
    listeners.push(listener)
    return () => {}
  })
  const store = createStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshcodex',
      provider: 'codex',
      createRequestId: 'req-created',
      status: 'creating',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  act(() => {
    listeners.forEach((listener) => listener({
      type: 'freshAgent.created',
      requestId: 'req-created',
      sessionId: 'codex-thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      runtimeProvider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
    }))
  })

  await waitFor(() => {
    expect(apiMock.setSessionMetadata).toHaveBeenCalledWith('codex', 'codex-thread-1', 'freshcodex', {
      sessionTypeSource: 'materialized',
    })
  })
})

it('tags durable FreshAgent materialization events and ignores placeholders', async () => {
  const listeners: Array<(message: any) => void> = []
  wsMock.onMessage.mockImplementation((listener) => {
    listeners.push(listener)
    return () => {}
  })
  const store = createStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'freshopencode-req-provisional',
      createRequestId: 'req-provisional',
      status: 'connected',
    },
  }))

  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )

  act(() => {
    listeners.forEach((listener) => listener({
      type: 'freshAgent.session.materialized',
      previousSessionId: 'freshopencode-req-provisional',
      sessionId: 'freshopencode-req-still-placeholder',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-still-placeholder' },
    }))
  })
  expect(apiMock.setSessionMetadata).not.toHaveBeenCalled()

  act(() => {
    listeners.forEach((listener) => listener({
      type: 'freshAgent.session.materialized',
      previousSessionId: 'freshopencode-req-still-placeholder',
      sessionId: 'ses_real_1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    }))
  })

  await waitFor(() => {
    expect(apiMock.setSessionMetadata).toHaveBeenCalledWith('opencode', 'ses_real_1', 'freshopencode', {
      sessionTypeSource: 'materialized',
    })
  })
})
```

- [ ] **Step 2: Run focused FreshAgent tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: FAIL because event-scoped metadata tagging does not exist.

- [ ] **Step 3: Implement event-scoped materialization tagging**

In `src/components/fresh-agent/FreshAgentView.tsx`, import:

```ts
import { createLogger } from '@/lib/client-logger'
import { getFreshAgentThreadSnapshot, setSessionMetadata } from '@/lib/api'
import { isDurableProviderSessionId } from '@shared/session-flavor'
```

Add a module logger if the file does not already have one:

```ts
const log = createLogger('FreshAgentView')
```

Add a helper near `getCreatedResumeSessionId`:

```ts
function persistDurableFreshAgentFlavor(message: {
  provider: string
  sessionType: string
  sessionRef?: { provider: string; sessionId: string }
}) {
  const provider = message.sessionRef?.provider ?? message.provider
  const sessionId = message.sessionRef?.sessionId
  if (!isDurableProviderSessionId(provider, sessionId)) return
  setSessionMetadata(provider, sessionId, message.sessionType, {
    sessionTypeSource: 'materialized',
  }).catch((err) => {
    log.warn({
      event: 'fresh_agent_session_metadata_tag_failed',
      provider,
      sessionId,
      sessionType: message.sessionType,
      err,
    })
  })
}
```

Call it inside the existing `freshAgent.created` branch after `current` is read:

```ts
persistDurableFreshAgentFlavor(message)
```

Call it inside the existing `freshAgent.session.materialized` branch after `sessionRef` is computed:

```ts
persistDurableFreshAgentFlavor({
  provider: message.provider,
  sessionType: message.sessionType,
  sessionRef,
})
```

Do not add a mount/update `useEffect` that calls `setSessionMetadata`; lifecycle tagging must happen only on durable create/materialization events.

- [ ] **Step 4: Run focused FreshAgent tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat: tag materialized fresh agent sessions"
```

## Task 6: Add Reopen-As Menu Items With Eligibility

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`

- [ ] **Step 1: Write failing menu-builder tests**

Update `createActions()` in `test/unit/client/context-menu/menu-defs.test.ts`:

```ts
reopenPaneAsSessionTarget: vi.fn(),
```

Add these tests:

```ts
describe('buildMenuItems - reopen as paired session flavor', () => {
  it('adds Reopen as freshclaude to a Claude CLI terminal body menu with a durable target payload', () => {
    const actions = createActions()
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
              createRequestId: 'req-1',
              status: 'running',
            },
          },
        },
      }),
    )

    const item = getTerminalItem(items, 'reopen-pane-as-session-type')
    expect(item.label).toBe('Reopen as freshclaude')
    item.onSelect()
    expect(actions.reopenPaneAsSessionTarget).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-1',
      paneId: 'pane-1',
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      targetSessionType: 'freshclaude',
    }))
  })

  it('adds Reopen as Claude CLI to a FreshClaude body menu', () => {
    const actions = createActions()
    const items = buildMenuItems(
      {
        kind: 'fresh-agent',
        tabId: 'tab-1',
        paneId: 'pane-1',
        sessionId: 'runtime-sdk-session-id',
        provider: 'claude',
        sessionType: 'freshclaude',
      },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'runtime-sdk-session-id',
              sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
              createRequestId: 'req-1',
              status: 'idle',
            },
          },
        },
      }),
    )

    const item = items.find((candidate) => candidate.type === 'item' && candidate.id === 'reopen-pane-as-session-type')
    expect(item?.type).toBe('item')
    if (!item || item.type !== 'item') throw new Error('missing reopen item')
    expect(item.label).toBe('Reopen as Claude CLI')
    item.onSelect()
    expect(actions.reopenPaneAsSessionTarget).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      targetSessionType: 'claude',
    }))
  })

  it('does not add a FreshAgent reopen item for non-durable placeholder ids', () => {
    const actions = createActions()
    const items = buildMenuItems(
      { kind: 'fresh-agent', tabId: 'tab-1', paneId: 'pane-1', sessionId: 'freshopencode-req-1', provider: 'opencode', sessionType: 'freshopencode' },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshopencode',
              provider: 'opencode',
              sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
              createRequestId: 'req-1',
              status: 'idle',
            },
          },
        },
      }),
    )

    expect(items.some((item) => item.type === 'item' && item.id === 'reopen-pane-as-session-type')).toBe(false)
  })

  it('disables reopen while the source agent is busy', () => {
    const actions = createActions()
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'codex',
              sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
              terminalId: 'term-1',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
        },
        reopenActivityByPaneId: {
          'pane-1': { isBusy: true },
        },
      }),
    )

    const item = getTerminalItem(items, 'reopen-pane-as-session-type')
    expect(item.disabled).toBe(true)
    expect(item.label).toBe('Reopen as freshcodex')
  })

  it('disables reopen while the source agent has pending prompts', () => {
    const actions = createActions()
    const items = buildMenuItems(
      { kind: 'fresh-agent', tabId: 'tab-1', paneId: 'pane-1', sessionId: 'runtime-sdk-session-id', provider: 'claude', sessionType: 'freshclaude' },
      makeCtx(actions, {
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'runtime-sdk-session-id',
              sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
              createRequestId: 'req-1',
              status: 'idle',
            },
          },
        },
        reopenActivityByPaneId: {
          'pane-1': { isBusy: false, hasWaitingItems: true },
        },
      }),
    )

    const item = getTerminalItem(items, 'reopen-pane-as-session-type')
    expect(item.disabled).toBe(true)
    expect(item.label).toBe('Reopen as Claude CLI')
  })
})
```

- [ ] **Step 2: Run the focused menu test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/context-menu/menu-defs.test.ts --run
```

Expected: FAIL because menu item/action support does not exist.

- [ ] **Step 3: Add action typing and build from resolved targets**

In `src/components/context-menu/menu-defs.ts`, import:

```ts
import {
  resolveReopenPaneSessionTarget,
  type ReopenPaneActivity,
  type ReopenPaneSessionTarget,
} from '@/lib/session-flavor-reopen'
```

Update `MenuActions`:

```ts
reopenPaneAsSessionTarget: (target: ReopenPaneSessionTarget) => void | Promise<void>
```

Update `MenuBuildContext`:

```ts
reopenActivityByPaneId?: Record<string, ReopenPaneActivity>
```

Add this helper:

```ts
function buildReopenPaneAsItem(
  tabId: string | undefined,
  paneId: string | undefined,
  content: PaneContent | null,
  tab: Tab | undefined,
  ctx: MenuBuildContext,
): MenuItem[] {
  if (!tabId || !paneId || !content) return []
  const target = resolveReopenPaneSessionTarget({
    tabId,
    paneId,
    content,
    tab,
    activity: ctx.reopenActivityByPaneId?.[paneId] ?? { isBusy: false },
  })
  if (!target) return []
  return [{
    type: 'item',
    id: 'reopen-pane-as-session-type',
    label: target.label,
    disabled: target.disabled,
    onSelect: () => {
      if (target.disabled) return
      return ctx.actions.reopenPaneAsSessionTarget(target)
    },
  }]
}
```

Use this helper in the `pane` and `terminal` branches after copy-resume items and before refresh/session metadata sections. In the combined `agent-chat`/`fresh-agent` branch, call it only inside a `target.kind === 'fresh-agent'` narrow so `target.tabId` and `target.paneId` are available; place the item near the other FreshAgent-specific session actions.

- [ ] **Step 4: Run the focused menu test and verify it passes**

Run:

```bash
npm run test:vitest -- test/unit/client/context-menu/menu-defs.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts
git commit -m "feat: add eligible reopen-as menu items"
```

## Task 7: Execute Reopen-As Pane Replacement Safely

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

- [ ] **Step 1: Write failing provider interaction tests**

Update the API mock in `test/unit/client/components/ContextMenuProvider.test.tsx` so `setSessionMetadata` can be asserted:

```ts
const apiMocks = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: apiMocks.post,
    patch: apiMocks.patch,
    put: apiMocks.put,
    delete: apiMocks.delete,
  },
  setSessionMetadata: apiMocks.setSessionMetadata,
}))
```

Use `initLayout` to seed these test panes. `updatePaneContent` is a no-op until a layout exists for the tab.
If the test file does not already import it, add `initLayout` from `@/store/panesSlice`.

Add a CLI-to-FreshAgent test:

```ts
it('kills a Claude CLI pane, persists explicit freshclaude flavor, and replaces it with FreshAgent content', async () => {
  const user = userEvent.setup()
  apiMocks.setSessionMetadata.mockClear()
  wsMocks.send.mockClear()
  const store = createTestStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      terminalId: 'term-1',
      createRequestId: 'req-1',
      status: 'running',
      sessionRef: { provider: 'claude', sessionId: VALID_SESSION_ID },
      initialCwd: '/repo',
    },
  }))

  render(
    <Provider store={store}>
      <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
        <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
          Terminal body
        </div>
      </ContextMenuProvider>
    </Provider>,
  )

  await user.pointer({ target: screen.getByText('Terminal body'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Reopen as freshclaude' }))

  await waitFor(() => {
    expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith('claude', VALID_SESSION_ID, 'freshclaude', {
      sessionTypeSource: 'explicit',
    })
  })
  expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
  expect(store.getState().panes.layouts['tab-1']).toMatchObject({
    type: 'leaf',
    content: {
      kind: 'fresh-agent',
      provider: 'claude',
      sessionType: 'freshclaude',
      resumeSessionId: VALID_SESSION_ID,
      sessionRef: { provider: 'claude', sessionId: VALID_SESSION_ID },
      initialCwd: '/repo',
    },
  })
})
```

Add a FreshAgent-to-CLI test:

```ts
it('kills a freshclaude pane and persists explicit Claude CLI flavor before replacing it with terminal content', async () => {
  const user = userEvent.setup()
  apiMocks.setSessionMetadata.mockClear()
  wsMocks.send.mockClear()
  const store = createTestStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'runtime-sdk-session-id',
      sessionRef: { provider: 'claude', sessionId: VALID_SESSION_ID },
      createRequestId: 'req-fresh',
      status: 'idle',
      initialCwd: '/repo',
    },
  }))

  render(
    <Provider store={store}>
      <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
        <div data-context={ContextIds.FreshAgent} data-tab-id="tab-1" data-pane-id="pane-1" data-session-id="runtime-sdk-session-id" data-provider="claude" data-session-type="freshclaude">
          Fresh body
        </div>
      </ContextMenuProvider>
    </Provider>,
  )

  await user.pointer({ target: screen.getByText('Fresh body'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Reopen as Claude CLI' }))

  await waitFor(() => {
    expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith('claude', VALID_SESSION_ID, 'claude', {
      sessionTypeSource: 'explicit',
    })
  })
  expect(wsMocks.send).toHaveBeenCalledWith({
    type: 'freshAgent.kill',
    sessionId: 'runtime-sdk-session-id',
    sessionType: 'freshclaude',
    provider: 'claude',
  })
  expect(store.getState().panes.layouts['tab-1']).toMatchObject({
    type: 'leaf',
    content: {
      kind: 'terminal',
      mode: 'claude',
      sessionRef: { provider: 'claude', sessionId: VALID_SESSION_ID },
      initialCwd: '/repo',
    },
  })
})
```

Add a failure test:

```ts
it('keeps the source pane when explicit metadata persistence fails', async () => {
  const user = userEvent.setup()
  apiMocks.setSessionMetadata.mockRejectedValueOnce(new Error('metadata unavailable'))
  wsMocks.send.mockClear()
  const store = createTestStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      terminalId: 'term-1',
      createRequestId: 'req-1',
      status: 'running',
      sessionRef: { provider: 'claude', sessionId: VALID_SESSION_ID },
    },
  }))

  render(
    <Provider store={store}>
      <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
        <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
          Terminal body
        </div>
      </ContextMenuProvider>
    </Provider>,
  )

  await user.pointer({ target: screen.getByText('Terminal body'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Reopen as freshclaude' }))

  await waitFor(() => expect(apiMocks.setSessionMetadata).toHaveBeenCalled())
  expect(wsMocks.send).not.toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
  expect(store.getState().panes.layouts['tab-1']).toMatchObject({
    type: 'leaf',
    content: { kind: 'terminal', mode: 'claude', terminalId: 'term-1' },
  })
})
```

- [ ] **Step 2: Run focused provider tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/ContextMenuProvider.test.tsx --run
```

Expected: FAIL because provider action execution is missing.

- [ ] **Step 3: Pass reopen eligibility state into menu building**

In `src/components/context-menu/ContextMenuProvider.tsx`, add imports matching the real pane utility and FreshAgent key APIs:

```ts
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { collectPaneEntries, findPaneContent } from '@/lib/pane-utils'
import { resolvePaneActivity } from '@/lib/pane-activity'
import {
  resolveReopenPaneSessionTarget,
  type ReopenPaneActivity,
  type ReopenPaneSessionTarget,
} from '@/lib/session-flavor-reopen'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
```

Define the same empty selector fallbacks used by `PaneContainer` near the top of the module:

```ts
const EMPTY_AGENT_CHAT_SESSIONS: Record<string, ChatSessionState> = {}
const EMPTY_FRESH_AGENT_SESSIONS: Record<string, FreshAgentSessionState> = {}
const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_CLAUDE_ACTIVITY_BY_ID = {}
const EMPTY_OPENCODE_ACTIVITY_BY_ID = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}
```

Then add selectors matching `PaneContainer`:

```ts
const agentChatSessions = useAppSelector((s) => s.agentChat?.sessions ?? EMPTY_AGENT_CHAT_SESSIONS)
const freshAgentSessions = useAppSelector((s) => s.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS)
const codexActivityByTerminalId = useAppSelector((s) => s.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID)
const claudeActivityByTerminalId = useAppSelector((s) => s.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID)
const opencodeActivityByTerminalId = useAppSelector((s) => s.opencodeActivity?.byTerminalId ?? EMPTY_OPENCODE_ACTIVITY_BY_ID)
const paneRuntimeActivityByPaneId = useAppSelector((s) => s.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID)
```

Use `collectPaneEntries` and `resolvePaneActivity` to build:

```ts
const reopenActivityByPaneId = useMemo(() => {
  const result: Record<string, ReopenPaneActivity> = {}
  for (const tab of tabsState.tabs) {
    const layout = panes[tab.id]
    if (!layout) continue
    const entries = collectPaneEntries(layout)
    for (const entry of entries) {
      const activity = resolvePaneActivity({
        paneId: entry.paneId,
        content: entry.content,
        tabMode: tab.mode,
        isOnlyPane: entries.length === 1,
        codexActivityByTerminalId,
        opencodeActivityByTerminalId,
        claudeActivityByTerminalId,
        paneRuntimeActivityByPaneId,
        agentChatSessions,
        freshAgentSessions,
      })
      const freshSession = entry.content.kind === 'fresh-agent' && entry.content.sessionId
        ? freshAgentSessions[makeFreshAgentSessionKey({
            sessionType: entry.content.sessionType,
            provider: entry.content.provider,
            sessionId: entry.content.sessionId,
          })]
        : undefined
      const chatSession = entry.content.kind === 'agent-chat' && entry.content.sessionId
        ? agentChatSessions[entry.content.sessionId]
        : undefined
      result[entry.paneId] = {
        isBusy: activity.isBusy,
        hasWaitingItems: Boolean(
          freshSession && (Object.keys(freshSession.pendingPermissions ?? {}).length > 0 || Object.keys(freshSession.pendingQuestions ?? {}).length > 0)
        ) || Boolean(
          chatSession && (Object.keys(chatSession.pendingPermissions ?? {}).length > 0 || Object.keys(chatSession.pendingQuestions ?? {}).length > 0)
        ),
      }
    }
  }
  return result
}, [
  agentChatSessions,
  claudeActivityByTerminalId,
  codexActivityByTerminalId,
  freshAgentSessions,
  opencodeActivityByTerminalId,
  paneRuntimeActivityByPaneId,
  panes,
  tabsState.tabs,
])
```

Pass `reopenActivityByPaneId` into `buildMenuItems`.

- [ ] **Step 4: Implement explicit reopen execution**

Import:

```ts
import { createLogger } from '@/lib/client-logger'
import { buildResumeContent } from '@/lib/session-type-utils'
import { setSessionMetadata } from '@/lib/api'
import { updatePaneContent } from '@/store/panesSlice'
```

Add a module logger if the file does not already have one:

```ts
const log = createLogger('ContextMenuProvider')
```

Add:

```ts
const reopenPaneAsSessionTargetAction = useCallback(async (target: ReopenPaneSessionTarget) => {
  const layout = panes[target.tabId]
  if (!layout) return
  const content = findPaneContent(layout, target.paneId)
  const tab = tabsState.tabs.find((candidate) => candidate.id === target.tabId)
  const currentTarget = resolveReopenPaneSessionTarget({
    tabId: target.tabId,
    paneId: target.paneId,
    content,
    tab,
    activity: reopenActivityByPaneId[target.paneId] ?? { isBusy: false },
  })
  if (!currentTarget || currentTarget.disabled) return
  if (
    currentTarget.provider !== target.provider ||
    currentTarget.sessionId !== target.sessionId ||
    currentTarget.targetSessionType !== target.targetSessionType
  ) return

  try {
    await setSessionMetadata(target.provider, target.sessionId, target.targetSessionType, {
      sessionTypeSource: 'explicit',
    })
  } catch (err) {
    log.warn({
      event: 'reopen_session_flavor_metadata_persist_failed',
      provider: target.provider,
      sessionId: target.sessionId,
      targetSessionType: target.targetSessionType,
      err,
    })
    return
  }

  if (content?.kind === 'terminal' && content.terminalId) {
    ws.send({ type: 'terminal.kill', terminalId: content.terminalId })
  }
  if (content?.kind === 'fresh-agent' && content.sessionId) {
    ws.send({
      type: 'freshAgent.kill',
      sessionId: content.sessionId,
      sessionType: content.sessionType,
      provider: content.provider,
    })
  }

  const providerSettings = appSettings.agentChat?.providers?.[target.targetSessionType]
  dispatch(updatePaneContent({
    tabId: target.tabId,
    paneId: target.paneId,
    content: buildResumeContent({
      sessionType: target.targetSessionType,
      sessionId: target.sessionId,
      cwd: target.cwd,
      agentChatProviderSettings: providerSettings,
    }),
  }))

  dispatch(updateTab({
    id: target.tabId,
    updates: {
      sessionMetadataByKey: mergeSessionMetadataByKey(
        tab?.sessionMetadataByKey,
        target.provider,
        target.sessionId,
        { sessionType: target.targetSessionType },
      ),
    },
  }))
}, [appSettings.agentChat?.providers, dispatch, panes, reopenActivityByPaneId, tabsState.tabs, ws])
```

Wire the action into `buildMenuItems`:

```ts
reopenPaneAsSessionTarget: reopenPaneAsSessionTargetAction,
```

- [ ] **Step 5: Run focused provider tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/ContextMenuProvider.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "feat: reopen panes as paired session flavor"
```

## Task 8: Prove Left-Panel Reopen Uses Persisted Flavor

**Files:**
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

- [ ] **Step 1: Add the server metadata indexing regression**

Add this test to the existing session-indexer metadata section in `test/unit/server/coding-cli/session-indexer.test.ts`:

```ts
it('applies persisted sessionType metadata to indexed sessions for left-panel reopen', async () => {
  const sessionId = 'session-with-explicit-type'
  const fileA = path.join(tempDir, `${sessionId}.jsonl`)
  await fsp.writeFile(fileA, JSON.stringify({
    cwd: '/repo',
    title: 'Durable session',
  }) + '\n')

  const provider = makeProvider([fileA])
  const metadataStore = mockMetadataStore({
    [makeSessionKey('claude', sessionId)]: {
      sessionType: 'freshclaude',
      sessionTypeSource: 'explicit',
    },
  })
  const indexer = new CodingCliSessionIndexer([provider], {}, metadataStore)

  await indexer.refresh()

  const session = indexer.getProjects()[0]?.sessions[0]
  expect(session).toMatchObject({
    provider: 'claude',
    sessionId,
    sessionType: 'freshclaude',
  })
})
```

Use the `makeProvider`, `mockMetadataStore`, `makeSessionKey`, `tempDir`, `path`, and `fsp` names already present in that `describe('sessionType merge from metadata store', ...)` block. Extend the local `mockMetadataStore` entry type to include `sessionTypeSource?: 'explicit' | 'materialized'`.

- [ ] **Step 2: Add the end-user left-panel reopen regression**

Add this test to `test/e2e/sidebar-click-opens-pane.test.tsx`:

```tsx
it('opens a closed persisted freshclaude session from the left panel as FreshAgent', async () => {
  const targetId = sessionId('persisted-freshclaude')
  const projects: ProjectGroup[] = [
    {
      projectPath: '/repo',
      sessions: [
        {
          sessionId: targetId,
          projectPath: '/repo',
          lastActivityAt: Date.now(),
          title: 'FreshClaude task',
          cwd: '/repo',
          provider: 'claude',
          sessionType: 'freshclaude',
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [{ id: 'tab-1', mode: 'shell' }],
    activeTabId: 'tab-1',
    sessionOpenMode: 'split',
  })

  renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('FreshClaude task').closest('button')
  fireEvent.click(sessionButton!)

  const layout = store.getState().panes.layouts['tab-1']
  expect(layout.type).toBe('split')
  if (layout.type === 'split') {
    const sessionPane = layout.children.find((child: any) =>
      child.type === 'leaf' &&
      child.content.kind === 'fresh-agent' &&
      child.content.sessionType === 'freshclaude' &&
      child.content.sessionRef?.provider === 'claude' &&
      child.content.sessionRef?.sessionId === targetId
    )
    expect(sessionPane).toBeDefined()
    expect(sessionPane!.content).toMatchObject({
      provider: 'claude',
      resumeSessionId: targetId,
      sessionRef: { provider: 'claude', sessionId: targetId },
    })
  }
})
```

- [ ] **Step 3: Run focused left-panel tests**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/session-indexer.test.ts test/e2e/sidebar-click-opens-pane.test.tsx --run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/unit/server/coding-cli/session-indexer.test.ts test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test: cover persisted flavor left-panel reopen"
```

## Task 9: Final Verification

**Files:**
- Verify all files changed by Tasks 1-8.

- [ ] **Step 1: Run focused client, shared, and server tests together**

Run:

```bash
npm run test:vitest -- test/unit/shared/session-flavor.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/session-flavor-reopen.test.ts test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/e2e/sidebar-click-opens-pane.test.tsx --run
```

Expected: PASS.

- [ ] **Step 2: Run the coordinated full check**

Run:

```bash
FRESHELL_TEST_SUMMARY="verify reopen session flavor implementation" npm run check
```

Expected: PASS for typecheck and the coordinated test suite.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff origin/main...HEAD -- shared/session-flavor.ts server/session-metadata-store.ts server/sessions-router.ts src/lib/api.ts src/lib/session-type-utils.ts src/lib/session-flavor-reopen.ts src/components/context-menu/context-menu-types.ts src/components/context-menu/context-menu-utils.ts src/components/context-menu/menu-defs.ts src/components/context-menu/ContextMenuProvider.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/shared/session-flavor.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/session-flavor-reopen.test.ts test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: the diff only contains session-flavor reopen behavior, metadata validation/priority, and tests.

- [ ] **Step 4: Commit verification cleanup**

If focused or full verification required small fixes, commit them:

```bash
git add shared server src test
git commit -m "fix: stabilize session flavor reopen flow"
```

If no fixes were required, do not create an empty commit.

## Self-Review

**Spec coverage:** The right-click body/header requirement is covered by Tasks 4, 6, and 7: pane headers use `target.kind === "pane"`, terminal bodies use `target.kind === "terminal"`, and FreshAgent bodies use the expanded `fresh-agent` target. The “prior sessions were CLI or FreshAgent” requirement is covered by Tasks 2, 5, 7, and 8 through validated metadata persistence, materialization tagging, explicit reopen writes, server indexing, and left-panel reopen tests. The “agents that offer both” scope is covered by Tasks 1 and 3 with public pairings for Claude, Codex, and OpenCode; hidden `kilroy` remains accepted metadata for existing flows but is not exposed as a paired reopen target.

**Placeholder scan:** This plan contains concrete file paths, helper names, code snippets, commands, and expected results. It avoids open-ended implementation instructions and intentionally leaves `docs/index.html` unchanged because the static mock does not represent this interaction.

**Type consistency:** The plan consistently uses `PublicSessionType` for public reopen flavor, `KnownSessionMetadataType` for server-accepted metadata, `provider` for runtime owner, provider-durable `sessionRef.sessionId` or validated `resumeSessionId` for reopen identity, `sessionTypeSource: "explicit"` for user choices, and `sessionTypeSource: "materialized"` for FreshAgent lifecycle tagging.
