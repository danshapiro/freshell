# Amplifier Session-Directory Visibility Fixes — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Red-Green-Refactor TDD per AGENTS.md.

**Goal:** Fix why a resumable Amplifier session was hard to find in the freshell sidebar (stale title shadowing + latent recency/pagination gaps).

**Architecture:** Four independent fixes across the session-directory read path: (A) stop a persisted AI title override from shadowing the provider's real name, (B) make Amplifier recency track real transcript activity, (C) let the MCP session tools page past the first 50, (D) let sidebar search page past the first 50.

**Tech Stack:** Node/TS server (NodeNext ESM — relative imports need `.js`), React/Redux client, Vitest.

## Global Constraints

- TDD (Red-Green-Refactor) for every change; watch each test fail first.
- Server ESM: relative imports must include `.js`.
- Do not restart the self-hosted server. Do not open a PR without explicit approval.
- Preserve `titleSource === 'user'` (human renames) as always-authoritative.

---

## File Structure

- `server/coding-cli/providers/amplifier.ts` — Amplifier metadata → ParsedSessionMeta (Fix A titleSource, Fix B activity mtime).
- `server/coding-cli/session-indexer.ts` — `applyOverride` guard (Fix A), change-detection + `lastActivityAt` (Fix B).
- `server/mcp/freshell-tool.ts` — `list-sessions` / `search-sessions` cursor following (Fix C).
- `src/lib/api.ts`, `shared/read-models.ts`, `src/components/Sidebar.tsx`, `src/store/sessionsThunks.ts` — search pagination (Fix D).

---

### Task A: Provider name beats stale auto (ai) title override

**Root cause:** `~/.freshell/config.json` holds `sessionOverrides["amplifier:<id>"] = { titleOverride: "Amplifier bundles", titleSource: "ai" }` (freshell auto-generated). `applyOverride` (session-indexer.ts:210-211) only yields to the provider for `dir`/`first-message` overrides, and Amplifier never marks its title authoritative, so the stale `ai` override wins forever.

**Files:**
- Modify: `server/coding-cli/providers/amplifier.ts:74-92`
- Modify: `server/coding-cli/session-indexer.ts:210-211`
- Test: `test/unit/server/coding-cli/amplifier-provider.test.ts`, `test/unit/server/coding-cli/session-indexer.test.ts`

**Interfaces:**
- Produces: `parseAmplifierMetadata()` now sets `titleSource: 'provider-generated'` when `name` is present.

- [ ] **A1: Failing provider test** — assert `parseAmplifierMetadata({name})` sets `titleSource: 'provider-generated'`, and undefined without a name.
- [ ] **A2: Failing indexer test** — a `titleSource:'ai'` override yields to a `provider-generated` title; a `titleSource:'user'` override still wins.
- [ ] **A3: Run → RED.** `npm run test:vitest -- run test/unit/server/coding-cli/amplifier-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts`
- [ ] **A4: Implement.** amplifier.ts — compute `name` once; `title: name`, `titleSource: name ? 'provider-generated' : undefined`. session-indexer.ts:211 — add `|| ov.titleSource === 'ai'` to the yield list.
- [ ] **A5: Run → GREEN.** Same command.
- [ ] **A6: Commit.**

---

### Task B: Amplifier recency tracks transcript activity

**Root cause:** re-parse gate is `metadata.json` mtime+size (session-indexer.ts:884); a resume appends to `transcript.jsonl`/`events.jsonl` without rewriting `metadata.json`, so the session never re-indexes and `lastActivityAt` (derived only from metadata timestamps, amplifier.ts:75-79) stays frozen.

**Files:**
- Modify: `server/coding-cli/providers/amplifier.ts` (`parseSessionFile` stats sibling `transcript.jsonl`/`events.jsonl`, folds newest mtime into `lastActivityAt`).
- Modify: `server/coding-cli/session-indexer.ts:872-886` (change-detection considers newest sibling mtime for providers exposing it).
- Test: `test/unit/server/coding-cli/amplifier-provider.test.ts`, `test/unit/server/coding-cli/session-indexer.test.ts`

- [ ] **B1: Failing test** — `parseSessionFile` returns `lastActivityAt >=` sibling `transcript.jsonl` mtime when it is newer than metadata timestamps.
- [ ] **B2: Failing test** — indexer re-indexes (updates `lastActivityAt`) when only the sibling transcript grows, metadata.json untouched.
- [ ] **B3: Run → RED.**
- [ ] **B4: Implement.** Provider folds `max(metadata ts, transcript mtime, events mtime)`; indexer change-key includes newest sibling mtime.
- [ ] **B5: Run → GREEN.**
- [ ] **B6: Commit.**

---

### Task C: MCP list/search-sessions page past 50

**Root cause:** `freshell-tool.ts:853-858` issues a single `GET /api/session-directory?priority=visible` (server caps at 50, `MAX_DIRECTORY_PAGE_ITEMS`) and never follows `nextCursor`.

**Files:**
- Modify: `server/mcp/freshell-tool.ts:852-858`
- Test: `test/unit/server/mcp/freshell-tool.test.ts`

- [ ] **C1: Failing test** — with mocked client returning page1 `{items, nextCursor}` then page2 `{items, nextCursor:null}`, `list-sessions` returns the union and follows the cursor (bounded, e.g. ≤4 pages).
- [ ] **C2: Run → RED.**
- [ ] **C3: Implement** cursor-following aggregation helper for `list-sessions` + `search-sessions`.
- [ ] **C4: Run → GREEN.**
- [ ] **C5: Commit.**

---

### Task D: Sidebar search pages past 50

**Root cause:** `searchSessions` (api.ts:580) returns one page and drops `nextCursor`/`hasMore`; server caps `limit` at 50. >50 matches are unreachable.

**Files:**
- Modify: `src/lib/api.ts` (`SearchResponse` carries `nextCursor`/`hasMore`), `src/store/sessionsThunks.ts` + `src/components/Sidebar.tsx` (reuse infinite-scroll append with the active query+cursor).
- Test: `test/e2e/sidebar-search-flow.test.tsx` (or focused unit around the thunk).

- [ ] **D1: Failing test** — search response exposes `nextCursor`; scrolling appends the next search page.
- [ ] **D2: Run → RED.**
- [ ] **D3: Implement** cursor propagation + scroll-append for search.
- [ ] **D4: Run → GREEN.**
- [ ] **D5: Commit.**

---

## Self-Review

- **Spec coverage:** A (stale title, the reported bug), B (recency), C (MCP cap), D (search cap) — all four findings covered.
- **Type consistency:** `titleSource: 'provider-generated'` matches `ParsedSessionTitleSource` (claude already uses it, session-indexer.ts:915); `ov.titleSource === 'ai'` matches `TitleSource`.
- **Risk order:** A (surgical, the real fix) → C (isolated) → B (change-detection subtlety) → D (client wiring).
