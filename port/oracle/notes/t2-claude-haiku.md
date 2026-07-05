# T2 claude/Haiku — DEV-0002: uncaught chokidar crash on first freshclaude turn

Status: **candidate deviation, worked around at the harness/env layer (zero source
mutation), pending antagonist adjudication.** Analogous to DEV-0001 (opencode).

## TL;DR

- Driving one real Claude **Haiku** turn through the pristine freshell server in an
  **isolated HOME** crashes the **whole freshell process** ~1.5 s into the turn.
- Root cause is an **UNCAUGHT exception** in `chokidar` (the file watcher) inside the
  coding‑CLI **session‑indexer**, triggered the instant the turn creates the
  `~/.claude/projects` directory:

  ```
  TypeError: Cannot read properties of undefined (reading 'on')
      at NodeFsHandler._handleRead   (node_modules/chokidar/lib/nodefs-handler.js:472:5)
      at NodeFsHandler._handleDir     (…/nodefs-handler.js:563:18)
      at NodeFsHandler._addToNodeFs   (…/nodefs-handler.js:617:27)
    Emitted 'error' event on FSWatcher instance …
  Node.js v22.21.1   ← process exits
  ```

- It is **not** on `freshAgent.turn.complete` or the model — the crash aborts the turn
  before any assistant reply. Captured transcript has only the `system/init` line
  (`msgs=0`), so **no Haiku inference completes** on a crashed attempt.

## Why it happens (pinned in `server/coding-cli/session-indexer.ts`)

- The claude provider's session root is `<HOME>/.claude/projects` (`getSessionRoots()`,
  glob `…/projects/**/*.jsonl`).
- In the oracle's isolated HOME we seed **only** `~/.claude/.credentials.json` (all the
  CLI needs to auth), so at boot `~/.claude` **exists** but `~/.claude/projects` **does
  not**.
- `reconfigureWatchers()` → `startRootWatcher()` therefore can't use the (absent) root,
  so it walks up to the nearest existing ancestor — **`~/.claude`** — and starts a
  `chokidar.watch(['~/.claude'], { depth: 1 })` "late‑root" watcher to notice the root
  appearing.
- When the first turn creates `~/.claude/projects`, chokidar's `_addToNodeFs` →
  `_handleDir` → `_handleRead` dereferences an `undefined` readdirp stream and **throws
  on the `FSWatcher` 'error' path, which is uncaught** → the process dies.
- codex/opencode do **not** crash here because their roots' ancestors (`~/.codex`,
  `~/.local/share/opencode`) don't exist at boot either, so their late‑root watchers are
  **skipped** ("no safe existing ancestor"). Only claude has an existing ancestor
  (`~/.claude`, created by seeding creds), so only claude arms the crashing watcher.

## Proven deterministically, with **zero model cost**

`port/oracle/` scratch repro (boot the isolated server, then *simulate* the turn's
filesystem writes — `mkdir ~/.claude/projects`, `…/<hash>/`, write `<uuid>.jsonl`):

| Pre-create at boot                     | Server survives the fs activity? |
|----------------------------------------|----------------------------------|
| `.credentials.json` only               | **NO — crashes** the instant `projects` is created |
| + `mkdir ~/.claude/projects`           | **YES** |
| + `mkdir ~/.claude/projects/<hash>`    | YES |

So pre-creating **`~/.claude/projects`** is the minimal, sufficient fix.

## Fix (harness/env only — NOT a source patch)

`seedClaudeCredsIntoHome()` now `mkdir -p`s `<HOME>/.claude/projects` alongside the
credential copy, so the isolated HOME matches **every real freshclaude user's** HOME
(which always already has `~/.claude/projects`). This removes the late‑root watcher's
crash trigger without touching `server/` — exactly the DEV‑0001 pattern.

## What the Rust port QA must reproduce / carry forward

1. **The completion edge:** claude/kilroy complete a turn via the discrete
   `freshAgent.turn.complete` wire event, emitted only on the Claude SDK `result` with
   `subtype === 'success'` (`server/sdk-bridge.ts` → `sdk.turn.complete` →
   `server/fresh-agent/sdk-events.ts`).
2. **Identity:** placeholder = SDK bridge **bare nanoid** (not `freshclaude-…`); durable
   = canonical **Claude session UUID** (from `session.init` `cliSessionId` and the
   persisted `<uuid>.jsonl` filename). No `freshAgent.session.materialized` is emitted
   for claude on send (its adapter `send()` returns void).
3. **Persistence:** `<HOME>/.claude/projects/<cwd-hash>/<uuid>.jsonl` (JSONL transcript),
   in the **isolated** HOME only.
4. **Env parity / robustness:** run against a HOME where `~/.claude/projects` exists, OR
   fix the uncaught session‑indexer watcher error natively. A real user hitting a fresh
   Claude‑Code install (no `projects` dir yet) would trip this same crash — so the
   **native port SHOULD guard the watcher** (this is the recommended `DELIBERATE_FIX` for
   the port, to be adjudicated by the antagonist, never self‑approved by the implementer).
