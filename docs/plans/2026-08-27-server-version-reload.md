# Server-Build Mismatch Auto-Reload Implementation Plan

> **STATUS: IMPLEMENTED (2026-08-27) — ARCHIVAL DOCUMENT. DO NOT EXECUTE.**
> Every task below is complete: feature commits `f137951d6` (protocol + both
> servers), `2ae0dd136` (client), `f9ac736c8` (e2e + docs), plus gate-driven
> fixes `738e9346d`, `3e5d5de20`, `49f00cfdfd8`. Steps were checked off during
> execution; the durable execution record lives in
> `.git/worktrees/server-version-reload/usual-sdd/progress.md` and
> `/home/dan/code/freshell/.worktrees/.the-usual-logs/server-version-reload/`.
> Two as-built amendments diverge from the original text and are marked
> inline: the lazy `defaultBakePath()` (Step 3h) and the e2e match-path
> assertion (Task 3). A third as-built amendment (delta review round 3) —
> the reload sentinel records the attempted server build id instead of the
> literal `"1"` — is marked inline at the Global Constraints loop-guard
> bullet and the Task 2 listings. The document is retained as the
> authoritative spec of what was built.

> **For agentic workers:** This plan has been fully executed and is retained
> as the authoritative specification of what was built. Do not re-execute it.
> Progress, reviews, and verification evidence: the `usual-sdd` ledger in the
> worktree's git directory and the run logs under
> `/home/dan/code/freshell/.worktrees/.the-usual-logs/server-version-reload/`.
> Track historical progress with the (completed) checkbox steps below.

**Goal:** When a browser tab connects (or reconnects) to a Freshell server built from a different commit than the client bundle it is running, the client detects the mismatch from the WS `ready` frame and reloads itself exactly once — self-healing the "Fresh-agent snapshot response did not match the shared contract" class of stale-client failures without ever reload-looping.

**Architecture:** All three producers stamp the same identity — `git rev-parse HEAD` with literal `"unknown"` fallback — each baked/resolved at the time its ARTIFACT is produced: Rust at compile time (new `crates/freshell-ws/build.rs`, mirroring the existing `freshell-server/build.rs`), Node at `build:server` time (a bake script writes `dist/server/build-id.json`, which the server prefers over a runtime git probe; dev mode via tsx correctly falls back to the runtime probe because it runs current source), client at Vite build time via a `define` constant. The WS `ready` message gains an additive optional `buildId` field (omitted from the wire when the Rust value is `None`, so frozen transcripts stay byte-identical; the Node frame always stamps it, mirroring `bootId`). The client compares its baked `__FRESHELL_BUILD_ID__` against every parsed `ready.buildId`; on mismatch it sets a `sessionStorage` sentinel and calls `location.reload()` exactly once per tab session (the sentinel also self-clears on a subsequent match, re-arming the guard).

**Tech Stack:** Rust (serde/serde_json, tokio, build scripts, existing `freshell-protocol`/`freshell-ws` crates), Node.js/ESM (`node:child_process`, `node:fs`), React 18 + Vite `define` + Zod, Vitest (jsdom client config / node server config), Playwright (rust-chromium project, local lane).

## Global Constraints

- **Worktree discipline:** All work happens in `/home/dan/code/freshell/.worktrees/server-version-reload` on branch `the-usual/server-version-reload`. Never run `node dist/server/index.js`; never touch the live 3001 server or `~/.freshell` state. No deploy/restart is part of this plan.
- **Additive contract only ("bootId doctrine"):** `buildId` is optional everywhere and omitted from the wire when the Rust value is `None`. Old clients must not break; the frozen `port/oracle/fixtures/handshake-transcript.json` must remain byte-valid without regenerating it. The Node ready frame ALWAYS stamps `buildId` (string, `"unknown"` fallback) — mirroring how it always stamps `bootId` — and the Rust handshake stamps `Some(...)` from its crate-baked constant.
- **Build-scoped, not boot-scoped:** build provenance is a compile-time property of the code, so it does NOT ride on `WsState` (whose doc comment scopes it to boot-scoped ids injected by `freshell-server`). `freshell-ws` bakes its own constant via its own `build.rs`; the value equals `freshell-server`'s bake because both crates compile in the same `cargo build` at the same HEAD.
- **Artifact-time semantics everywhere:** each stamp describes the artifact that emits it. Rust bakes at compile; Node's production stamp comes from the `dist/server/build-id.json` written by `build:server` (a stale dist advertises the sha it was BUILT from — never the checkout's current HEAD); tsx dev mode has no bake file next to source and probes runtime HEAD (correct: it runs current source); Vite bakes the client's sha at bundle time.
- **Value semantics on every side:** the value is the full `git rev-parse HEAD` SHA of the repo at build/bake time; when git is unavailable or the output is not 40 lowercase hex chars (Node/Vite enforce the 40-hex check; the Rust scripts accept any successful output), the literal `"unknown"`. Known caveat (accepted, documented): a SHA-256 git checkout would make Rust stamp 64 hex while Node/Vite stamp `"unknown"` — the guard goes inert (no false reloads, no crash); this repo is SHA-1.
- **Client compare rule:** reload iff BOTH ids are present, non-empty, neither is `"unknown"`, and they differ. `"unknown" == "unknown"` is NOT a match-and-clear (it is a no-op) — two unknown builds must never trigger a reload and must never clear an armed sentinel. The compare is direction-free: a NEWER client against an OLDER server also performs one bounded reload per fresh tab session (futile but harmless; shas carry no ordering) — documented, accepted.
- **Loop-guard invariant:** at most ONE code-triggered reload per tab session, per server build identity. The sentinel key is `freshell.server-build-reload` (`sessionStorage`); it records the last attempted SERVER build id and is written BEFORE calling `reload()` — the same id never reloads twice, and a different (corrected) deployment re-arms the guard (deployments change what a reload fetches). If `sessionStorage` cannot be read or written (property access throwing a SecurityError, quota errors, absent API), no reload happens and the suppression failure is logged (fail-safe with observability). A matching `ready` clears the sentinel (self-re-arm). KNOWN LIMIT (accepted, documented): one origin fronted by servers built from DIFFERENT commits could oscillate (mismatch → reload → match clears → mismatch → …); deliberately not hardened with a clears-per-session cap for the single-server self-hosted threat model.
  > As-built amendment (delta review round 3): the sentinel value records the last attempted server build id (originally the literal `"1"`), making the once-guard per (tab session, server build id) — a half-deployed server B no longer suppresses a later corrected deployment C; the match-clears oscillation limit above is unchanged.
- **Client module must not crash under Vitest:** the Vitest client config has no `__FRESHELL_BUILD_ID__` define, so the module must use a `typeof __FRESHELL_BUILD_ID__ === 'undefined'` guard (same precedent as `src/lib/perf-logger.ts:45` with `__PERF_LOGGING__`).
- **NodeNext/ESM:** every relative import in `server/` and `shared/` uses `.js` extensions; client code uses `@/` aliases without extensions.
- **Test coordination:** broad suites go through the repo coordinator (`npm run test:vitest -- run ...`); never raw `npx vitest`. Focused Rust tests use `cargo test -p <crate>` directly. The port-ORACLE suites are NOT covered by `npm run test:port` / `npm run check` — they run only via `npm run test:oracle`.
- **E2E backend rule:** per repo instructions, when `FRESHELL_E2E_BACKEND` is unset the user chooses local vs cloud before e2e runs — surface that question once at execution kickoff, INFORMED that the new spec is cloud-incompatible by construction (the cloud image builds without git metadata, so both stamps are `"unknown"` and the compare is inert there), and record the answer in `run-state.md`. This feature's e2e coverage lane is the LOCAL `rust-chromium` project regardless of the choice; the spec is added to `CLOUD_SKIP_SPECS` with that justification, and if cloud is chosen the PR description documents the skip explicitly so no coverage claim is silent. Never claim a cloud run proves cargo availability: the cloud runtime uses a prebuilt binary and cargo never runs there (`test/e2e-browser/helpers/rust-server.ts:82-90`).
- **Scope boundary:** client-only redeploys (redeploying a new client bundle WITHOUT a server change) are deliberately NOT covered by any auto-trigger — no polling, no `/api/server-info` fallback, no reload loop. The ready-frame compare is the only trigger; a client-only redeploy costs at most one bounded reload per fresh tab session.
- **No unrelated restructuring; comments explain invariants, in the existing voice.**

---

### Task 1: Protocol + both servers stamp `ready.buildId`

**Files:**
- Modify: `shared/ws-protocol.ts:743-750` (`ReadyMessage` type)
- Modify: `crates/freshell-protocol/src/server_messages.rs:792-806` (`Ready` struct)
- Create: `crates/freshell-ws/build.rs` (crate-local commit bake; adapted from `crates/freshell-server/build.rs`)
- Modify: `crates/freshell-ws/src/lib.rs` (`ready_build_id()` helper + handshake `Ready` literal stamp at :536; wire test in `mod tests` after `handshake_is_ordered_with_shared_bootid` ending :1026)
- Modify: `crates/freshell-protocol/tests/pane_reconcile.rs:52-82` (two `Ready` literals)
- Modify: `package.json` (`build:server` script gains the bake step)
- Create: `scripts/bake-server-build-id.mjs`
- Create: `server/build-id.ts`
- Modify: `server/ws-handler.ts` (import block; field after `:587`; init after `:651`; ready send `:2034-2039`)
- Modify: `port/contract/ws-server-messages.schema.json` (via `npm run contract:generate`)
- Modify: `port/oracle/harness/external-server.ts` (`ensureServerBuilt` stamp-freshness guard)
- Test: `crates/freshell-protocol/tests/roundtrip.rs` (new test after `ready_carries_server_instance_id_and_boot_id`, which ends at line 164)
- Test: `test/server/build-id.test.ts` (new)
- Test: `test/server/ws-handshake-snapshot.test.ts` (new test after the `includes a bootId in the ready message...` test, which ends at line 301)

**Interfaces:**
- Consumes: nothing new — `crates/freshell-server/build.rs` and `diag.rs:124` are untouched (freshell-ws now bakes its own constant; both crates compile at the same HEAD in every workspace build, so the values agree).
- Produces: `freshell_protocol::Ready { build_id: Option<String> }` (serde camelCase → wire key `buildId`, skipped when `None`); `freshell_ws::ready_build_id() -> Option<String>` (the crate-baked sha or `"unknown"`, always `Some` in practice); `server/build-id.ts` exporting `computeBuildId(cwd?: string): string` (pure git probe), `readBakedBuildId(bakePath: string): string | undefined` (pure file read), `resolveServerBuildId(bakePath?: string): string` (bake-wins-else-probe), `serverBuildId(): string` (cached), `_resetServerBuildIdCacheForTests(): void`; `dist/server/build-id.json` (`{"buildId": "<sha|unknown>"}`) written by `build:server`; TS `ReadyMessage.buildId?: string`; regenerated `port/contract/ws-server-messages.schema.json` with an optional `buildId` on `ready` (still `additionalProperties: false`). Task 2's client schema and Task 3's e2e injection consume the wire key `buildId`.

- [x] **Step 1: Write the failing behavioral tests (protocol roundtrip, rust wire, node module, node wire)**

1a. Add to `crates/freshell-protocol/tests/roundtrip.rs` immediately after the `ready_carries_server_instance_id_and_boot_id` test (line 164):

```rust
#[test]
fn ready_carries_build_id_and_omits_it_when_absent() {
    // deliverable: `ready` accepts an additive optional `buildId` (the git
    // commit the server binary was built from) and OMITS it from the wire
    // when absent — frozen-transcript inertness, same rule as `bootId`.
    let with = r#"{"type":"ready","timestamp":"2026-07-05T04:20:52.546Z","serverInstanceId":"srv-abc","buildId":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"}"#;
    match server_roundtrip(with, "ready") {
        ServerMessage::Ready(r) => {
            assert_eq!(
                r.build_id.as_deref(),
                Some("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
            );
        }
        other => panic!("expected Ready, got {other:?}"),
    }

    let without = r#"{"type":"ready","timestamp":"2026-07-05T04:20:52.546Z","serverInstanceId":"srv-abc"}"#;
    let msg: ServerMessage = serde_json::from_str(without).unwrap();
    let reser = serde_json::to_value(&msg).unwrap();
    assert!(
        reser.get("buildId").is_none(),
        "ready must omit buildId when absent: {reser}"
    );
    match msg {
        ServerMessage::Ready(r) => assert_eq!(r.build_id, None),
        other => panic!("expected Ready, got {other:?}"),
    }
}
```

1b. Add to `crates/freshell-ws/src/lib.rs` inside `mod tests`, immediately after `handshake_is_ordered_with_shared_bootid` (line 1026). Deliberately references NO new symbols, so its RED phase compiles and fails on the assertion:

```rust
    /// The handshake `ready` stamps the build identity baked into THIS crate
    /// by its `build.rs` (`FRESHELL_WS_BUILD_COMMIT`, the git commit the
    /// binary was built from) so the browser client can detect a client/
    /// server build mismatch and reload once. Never absent on the wire from
    /// a real server: the baked value is always `Some` (sha or `"unknown"`).
    #[tokio::test]
    async fn handshake_ready_stamps_build_id() {
        let msgs = build_handshake(&state()).await;
        let ready = serde_json::to_value(&msgs[0]).unwrap();
        assert!(
            ready.get("buildId").is_some(),
            "ready must stamp buildId: {ready}"
        );
        let build_id = ready["buildId"].as_str().expect("buildId is a string");
        assert!(!build_id.is_empty(), "buildId must be non-empty: {build_id}");
    }
```

1c. Create `test/server/build-id.test.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetServerBuildIdCacheForTests,
  computeBuildId,
  readBakedBuildId,
  resolveServerBuildId,
  serverBuildId,
} from '../../server/build-id.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

// The module under test imports execFileSync by name; re-import it mocked.
import { execFileSync as mockedExecFileSync } from 'node:child_process'

function tempBakeFile(buildId: string | null): { dir: string; bakePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-bake-'))
  const bakePath = path.join(dir, 'build-id.json')
  if (buildId !== null) {
    fs.writeFileSync(bakePath, JSON.stringify({ buildId }))
  }
  return { dir, bakePath }
}

describe('server build id', () => {
  afterEach(() => {
    _resetServerBuildIdCacheForTests()
    vi.mocked(mockedExecFileSync).mockClear()
  })

  it('computeBuildId returns the current git HEAD sha for the repository', () => {
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
      .toString()
      .trim()
    expect(computeBuildId(REPO_ROOT)).toBe(expected)
  })

  it('computeBuildId falls back to "unknown" outside a git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-no-git-'))
    try {
      expect(computeBuildId(dir)).toBe('unknown')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readBakedBuildId returns the baked value for a well-formed file', () => {
    const { dir, bakePath } = tempBakeFile('b'.repeat(40))
    try {
      expect(readBakedBuildId(bakePath)).toBe('b'.repeat(40))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readBakedBuildId returns undefined for malformed JSON, wrong shapes, or a missing file', () => {
    const { dir, bakePath } = tempBakeFile(null)
    try {
      fs.writeFileSync(bakePath, 'not json {')
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: 42 }))
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: '' }))
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      // Same validation as the writer: only a 40-hex sha or "unknown" is a
      // legitimate stamp; a garbage string must never become authoritative.
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: 'garbage-stamp' }))
      expect(readBakedBuildId(bakePath)).toBeUndefined()
      expect(readBakedBuildId(path.join(dir, 'absent.json'))).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveServerBuildId prefers the bake file over a runtime git probe', () => {
    const { dir, bakePath } = tempBakeFile('c'.repeat(40))
    try {
      expect(resolveServerBuildId(bakePath)).toBe('c'.repeat(40))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveServerBuildId falls back to the runtime git probe when no bake file exists in SOURCE mode', () => {
    const { dir } = tempBakeFile(null)
    try {
      expect(resolveServerBuildId(path.join(dir, 'build-id.json'))).toBe(computeBuildId(REPO_ROOT))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolveServerBuildId fails inert to "unknown" for a compiled artifact without a valid stamp', () => {
    const { dir, bakePath } = tempBakeFile(null)
    try {
      // A compiled artifact (sourceMode: false) must NEVER probe the
      // checkout: a stale dist without its stamp advertises "unknown", not
      // the current HEAD (which would falsely match a current client).
      expect(resolveServerBuildId(path.join(dir, 'build-id.json'), { sourceMode: false })).toBe('unknown')
      fs.writeFileSync(bakePath, 'corrupt {')
      expect(resolveServerBuildId(bakePath, { sourceMode: false })).toBe('unknown')
      fs.writeFileSync(bakePath, JSON.stringify({ buildId: 'garbage-stamp' }))
      expect(resolveServerBuildId(bakePath, { sourceMode: false })).toBe('unknown')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serverBuildId memoizes: the git probe runs once per process', () => {
    _resetServerBuildIdCacheForTests()
    // Source runs (tsx/vitest) have no bake file next to server/build-id.ts,
    // so the first resolution exercises the git probe.
    const first = serverBuildId()
    const callsAfterFirst = vi.mocked(mockedExecFileSync).mock.calls.length
    expect(serverBuildId()).toBe(first)
    expect(vi.mocked(mockedExecFileSync).mock.calls.length).toBe(callsAfterFirst)
    expect(callsAfterFirst).toBeGreaterThan(0)
  })
})
```

1d. In `test/server/ws-handshake-snapshot.test.ts`, immediately after the `includes a bootId in the ready message that differs from serverInstanceId` test (ends line 301), add:

```typescript
  it('includes a buildId in the ready message, stable across clients in the same process', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await Promise.all([
        new Promise<void>((resolve) => ws1.on('open', () => resolve())),
        new Promise<void>((resolve) => ws2.on('open', () => resolve())),
      ])

      const [ready1, ready2] = await Promise.all([
        waitForReady(ws1, 10_000),
        waitForReady(ws2, 10_000),
      ])

      // Always stamped (bake or runtime probe, "unknown" fallback), stable
      // within the process.
      expect(typeof ready1.buildId).toBe('string')
      expect((ready1.buildId as string).length).toBeGreaterThan(0)
      expect(ready2.buildId).toBe(ready1.buildId)
      // Distinct identity axis: not the boot id, not the instance id.
      expect(ready1.buildId).not.toBe(ready1.bootId)
    } finally {
      await closeWs(ws1)
      await closeWs(ws2)
    }
  })
```

- [x] **Step 2: Run the tests and verify the intended failures**

```bash
cargo test -p freshell-protocol --test roundtrip ready_carries_build_id_and_omits_it_when_absent
cargo test -p freshell-ws handshake_ready_stamps_build_id
npm run test:vitest -- run test/server/build-id.test.ts test/server/ws-handshake-snapshot.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: all FAIL for the missing behavior — the Rust roundtrip test fails to COMPILE (`no field \`build_id\` on struct Ready`); the freshell-ws wire test COMPILES (it references no new symbols) and fails its first assertion (`ready must stamp buildId` — the ready frame carries no `buildId`); `build-id.test.ts` fails to resolve `../../server/build-id.js` (module missing); the new snapshot test fails on `expect(typeof ready1.buildId).toBe('string')`.

- [x] **Step 3: Add the minimal production implementation**

3a. `shared/ws-protocol.ts` — in `ReadyMessage` (lines 743-750), add after `bootId`:

```typescript
export type ReadyMessage = {
  type: 'ready'
  timestamp: string
  serverInstanceId?: string
  bootId?: string
  /** The git commit the server binary was built from ("unknown" fallback).
   *  Additive/optional bootId doctrine: the client bakes its own build id at
   *  Vite build time and reloads once on a mismatch. Omitted from the wire
   *  when the Rust value is None. */
  buildId?: string
  /** Present iff the client's hello opted in via capabilities.paneReconcileV1. */
  capabilities?: ReadyCapabilities
}
```

3b. Regenerate the outbound schema bundle (picks up `buildId` as an optional modeled property on `ready` — keeping `test/unit/port/ws-contract-freeze.test.ts`'s "committed schema deep-equals a fresh regeneration" AND `mutation-validation.test.ts`'s `additional-property` case green, since the schema stays `additionalProperties: false`):

```bash
npm run contract:generate
git diff --stat port/contract/ws-server-messages.schema.json
```

Expected: the regenerated diff adds an optional `buildId` property to the `ready` message schema; inventory/message counts unchanged.

3c. `crates/freshell-protocol/src/server_messages.rs` — in `Ready` (lines 792-806), add after the `server_instance_id` field:

```rust
    /// The git commit this server binary was built from (`"unknown"`
    /// fallback), stamped so the browser client can detect a client/server
    /// build mismatch and reload once. Omitted from the wire entirely when
    /// `None` (frozen-client inertness — same rule as `boot_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
```

3d. Create `crates/freshell-ws/build.rs` — crate-local commit bake, adapted from `crates/freshell-server/build.rs` (which keeps its own, dirty-flag-inclusive copy; the two crates compile in the same `cargo build` at the same HEAD, so the values agree). Keep the module doc short and point at the original for the full rationale:

```rust
//! Compile-time build-provenance stamp for `freshell-ws`: bakes the git
//! commit SHA into `FRESHELL_WS_BUILD_COMMIT` so the WS handshake's `ready`
//! can stamp `ready.buildId` (client-side stale-bundle auto-reload).
//! Build provenance is BUILD-scoped, not boot-scoped, so it deliberately
//! does NOT ride on `WsState` (whose contents are boot-scoped ids/state
//! injected by `freshell-server`). The full worktree-aware rationale for
//! the `rerun-if-changed` set lives in `crates/freshell-server/build.rs` —
//! this copy performs the SAME resolved-HEAD/ref/packed-refs watching so a
//! cached rebuild re-stamps when HEAD moves; both crates compile in the
//! same workspace build, so their baked commits agree. Never fails the
//! build over a missing/unavailable `git` (falls back to `"unknown"`).

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let commit = git_head_commit().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=FRESHELL_WS_BUILD_COMMIT={commit}");
    for path in rerun_paths() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

/// `git rev-parse HEAD`, trimmed. `None` on any failure (git not on `PATH`,
/// not inside a git checkout, ...) -- the caller falls back to `"unknown"`.
fn git_head_commit() -> Option<String> {
    let out = Command::new("git").args(["rev-parse", "HEAD"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// The exact paths that change when HEAD moves in THIS checkout, resolved
/// worktree-aware via `git rev-parse --git-path` (see the module doc and
/// `crates/freshell-server/build.rs`'s richer version for why each entry is
/// watched). Skipped resolutions degrade to cargo's default heuristics.
fn rerun_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let git_path = |arg: &str| {
        Command::new("git")
            .args(["rev-parse", "--git-path", arg])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .filter(|p| !p.as_os_str().is_empty())
    };
    if let Some(head) = git_path("HEAD") {
        paths.push(head);
    }
    if let Some(head) = git_path("HEAD") {
        if let Ok(contents) = std::fs::read_to_string(&head) {
            if let Some(ref_name) = contents.strip_prefix("ref: ") {
                if let Some(resolved) = git_path(ref_name.trim()) {
                    paths.push(resolved);
                }
            }
        }
    }
    if let Some(packed) = git_path("packed-refs") {
        if packed.exists() {
            paths.push(packed);
        }
    }
    paths
}
```

3e. `crates/freshell-ws/src/lib.rs` — add the read-back helper near the top of the crate (after the imports, before `WsState`), and stamp it in the handshake:

```rust
/// The git commit THIS binary was built from, baked into this crate at
/// compile time by this crate's `build.rs` (`FRESHELL_WS_BUILD_COMMIT`).
/// Falls back to the literal `"unknown"` when git was unavailable at build
/// time (e.g. a source tarball or the Cloud Run image, which builds without
/// git metadata) -- never a runtime failure. Build provenance is
/// BUILD-scoped, so this deliberately does NOT ride on `WsState`.
pub fn ready_build_id() -> Option<String> {
    Some(option_env!("FRESHELL_WS_BUILD_COMMIT").unwrap_or("unknown").to_string())
}
```

In `build_handshake_with_capabilities`, in the `Ready` literal (line 536), add after `server_instance_id`:

```rust
            build_id: ready_build_id(),
```

3f. Fix the remaining protocol-`Ready` literal sites (exactly two, both tests): in `crates/freshell-protocol/tests/pane_reconcile.rs`, both `freshell_protocol::Ready {` literals (lines 56 and 71) each get:

```rust
        build_id: None,
```

Then enumerate any remaining sites:

```bash
cargo check --workspace --all-targets 2>&1 | rg "missing field \`build_id\`" || echo "no missing-field errors"
```

Expected: `no missing-field errors`. (Only the three sites above construct the protocol `Ready` today; the check catches any straggler — add `build_id: None` there the same way. Note `WsState` is deliberately untouched: ~36 files construct it and none changes.)

3g. Create `scripts/bake-server-build-id.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Bake the build-provenance stamp for the compiled Node server: writes
 * `dist/server/build-id.json` = {"buildId": "<git HEAD sha | 'unknown'>"}.
 *
 * WHY a bake file: the running stamp must describe the BUILT ARTIFACT, not
 * the checkout. `server/build-id.ts` prefers this file (resolved next to
 * its compiled dist/server/build-id.js) and falls back to a runtime
 * `git rev-parse HEAD` probe ONLY when no bake file exists next to it —
 * which is exactly the tsx-from-source dev case, where the runtime probe
 * is correct because dev runs current source. A stale `dist/server`
 * started after HEAD moved therefore advertises the sha it was BUILT from,
 * never a false "current" one.
 *
 * Runs after `tsc` in the `build:server` script. Atomic write (tmp+rename).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outPath = path.join(repoRoot, 'dist', 'server', 'build-id.json')

function computeBuildId() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
const tmpPath = `${outPath}.tmp-${process.pid}`
fs.writeFileSync(tmpPath, `${JSON.stringify({ buildId: computeBuildId() })}\n`)
fs.renameSync(tmpPath, outPath)
console.log(`[bake-server-build-id] wrote ${outPath}`)
```

Update `package.json`'s `build:server` script:

```json
    "build:server": "tsc -p tsconfig.server.json && node scripts/bake-server-build-id.mjs",
```

3h. Create `server/build-id.ts`:

> As-built amendment (delta review round 1): the bake path is resolved lazily — the eager form originally planned crashed module import in non-`file:` loaders (see commit 738e9346d).

```typescript
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA_PATTERN = /^[0-9a-f]{40}$/

// Resolved relative to THIS module: next to the compiled
// dist/server/build-id.js in production (where `build:server`'s bake step
// wrote dist/server/build-id.json), or next to server/build-id.ts in
// tsx-from-source runs (where no bake file exists and the runtime probe is
// correct because dev runs current source).
function defaultBakePath(): string {
  try {
    return fileURLToPath(new URL('build-id.json', import.meta.url))
  } catch {
    // Non-file: import.meta.url (electron-style loaders): a relative path
    // that readFileSync will miss, degrading to the inert "unknown" (compiled)
    // or the runtime git probe (source) — never an import crash.
    return 'build-id.json'
  }
}

/**
 * The git commit the server runs from — the SAME identity the Rust server
 * bakes at compile time (`crates/freshell-ws/build.rs`'s
 * `FRESHELL_WS_BUILD_COMMIT`) and the client bakes at Vite build time
 * (`__FRESHELL_BUILD_ID__`). Falls back to the literal `"unknown"` when git
 * is unavailable or the output is not a full 40-hex sha; the client's
 * compare rule ignores `"unknown"` on both sides, so a git-less deployment
 * never triggers a reload and never clears an armed one.
 */
export function computeBuildId(cwd: string = process.cwd()): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim()
    return SHA_PATTERN.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Read a bake file written by `scripts/bake-server-build-id.mjs`. */
export function readBakedBuildId(bakePath: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(bakePath, 'utf8')) as { buildId?: unknown }
    const value = raw.buildId
    if (typeof value !== 'string') return undefined
    // Same validation as the writer and the git probes: a 40-hex sha or the
    // literal "unknown". Anything else is a malformed stamp — treat as
    // absent, never authoritative (a garbage stamp would cause a needless
    // mismatch reload).
    return value === 'unknown' || SHA_PATTERN.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

// Source runs (tsx dev, vitest) execute THIS .ts module; a compiled
// production artifact executes dist/server/build-id.js. The distinction
// decides what a MISSING bake file means (see resolveServerBuildId).
const SOURCE_MODE = import.meta.url.endsWith('.ts')

/**
 * BAKE-WINS-ELSE-FAIL-INERT: a compiled production artifact describes
 * itself ONLY by its bake file — a stale dist started after HEAD moved
 * advertises the sha it was built from (never a false "current" one), and
 * an artifact whose stamp is missing or malformed fails inert to
 * "unknown" (it must never impersonate the checkout). Source runs have no
 * bake file next to the source module and probe runtime HEAD instead,
 * which is correct because they execute current source.
 */
export function resolveServerBuildId(
  bakePath: string = defaultBakePath(),
  opts?: { sourceMode?: boolean },
): string {
  const sourceMode = opts?.sourceMode ?? SOURCE_MODE
  if (sourceMode) return computeBuildId()
  return readBakedBuildId(bakePath) ?? 'unknown'
}

let cached: string | undefined

/** Per-process cached build id — one resolution per server lifetime. */
export function serverBuildId(): string {
  if (cached === undefined) cached = resolveServerBuildId()
  return cached
}

export function _resetServerBuildIdCacheForTests(): void {
  cached = undefined
}
```

3i. In `server/ws-handler.ts`:
Add the import alongside the other relative imports at the top of the file:

```typescript
import { serverBuildId } from './build-id.js'
```

Add the field after `private readonly bootId: string` (line 587):

```typescript
  private readonly buildId: string
```

Initialize it after `this.bootId = \`boot-${randomUUID()}\`` (line 651):

```typescript
    this.buildId = serverBuildId()
```

Extend the ready send (lines 2034-2039):

```typescript
        this.send(ws, {
          type: 'ready',
          timestamp: nowIso(),
          serverInstanceId: this.serverInstanceId,
          bootId: this.bootId,
          buildId: this.buildId,
        })
```

3j. In `port/oracle/harness/external-server.ts` — the oracle's node target runs the COMPILED `dist/server/index.js`, and `ensureServerBuilt` rebuilds only when the entry is ABSENT. After this feature, a stale pre-existing `dist` carries a stale bake file, and `npm run test:oracle` would compare a stale Node `buildId` against the fresh cargo-built Rust value — a false implementation divergence. Add a stamp-freshness check so a stale node dist rebuilds.

> As-built amendments (delta reviews rounds 1-2): the final predicate is STRICTER than the
> first draft below — with Git HEAD available, ONLY a bake stamp exactly equal to HEAD is
> current; a MISSING, unreadable, mismatched, or `"unknown"` stamp all trigger a rebuild
> (a stampless/raw-`tsc` or git-less-built artifact must never be reused against a fresh
> cargo-built rust binary). Git-unavailable environments keep the legacy reuse behavior.
> Directly tested by `test/unit/port/oracle-harness-freshness.test.ts`.

```typescript
/**
 * Whether the node dist's baked build stamp (written by `build:server`'s
 * `scripts/bake-server-build-id.mjs`) matches the CURRENT checkout HEAD.
 * True when no bake file exists (pre-stamp dist or git-less build — keep
 * the legacy exists-only behavior), when git is unavailable, or when the
 * stamp is unreadable: those cases have no stamp semantics to violate.
 * False only for a REAL staleness — a bake from an earlier HEAD — which
 * must trigger a rebuild so the oracle's node-vs-rust `buildId` comparison
 * compares same-HEAD artifacts, never a stale checkout against a fresh
 * cargo build.
 */
function nodeBuildStampIsCurrent(root: string): boolean {
  const bakePath = path.join(root, 'dist', 'server', 'build-id.json')
  if (!fs.existsSync(bakePath)) return true
  try {
    const baked = (JSON.parse(fs.readFileSync(bakePath, 'utf8')) as { buildId?: unknown }).buildId
    if (typeof baked !== 'string' || baked === 'unknown') return true
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    if (head.status !== 0) return true
    return baked === head.stdout.trim()
  } catch {
    return true
  }
}
```

and change `ensureServerBuilt`'s first guard from

```typescript
  if (fs.existsSync(entry)) return entry
```

to

```typescript
  if (fs.existsSync(entry) && nodeBuildStampIsCurrent(root)) return entry
```

- [x] **Step 4: Run the focused tests**

```bash
cargo test -p freshell-protocol --test roundtrip ready_carries_build_id_and_omits_it_when_absent
cargo test -p freshell-ws handshake_ready_stamps_build_id
npm run test:vitest -- run test/server/build-id.test.ts test/server/ws-handshake-snapshot.test.ts --config config/vitest/vitest.server.config.ts
```

Expected: all PASS.

- [x] **Step 5: Refactor while green**

No refactor needed — the Rust stamp mirrors the adjacent `boot_id` idiom, and the Node stamp mirrors `bootId`'s always-stamped treatment. Do NOT regenerate `port/oracle/fixtures/handshake-transcript.json`: the frozen transcript stays byte-valid because Rust omits `build_id` when deserialized as `None`, and the mutation/oracle suites consume the regenerated SCHEMA (not the live node bytes) for conformance.

- [x] **Step 6: Run impacted-test verification**

This change touches the shared wire protocol, both server implementations, the generated schema, and the `build:server` pipeline, so the impacted set is: both Rust crates' full test trees, the workspace compile, the whole server-config suite (any test asserting handshake/ready shapes), the port contract suites, and the port-ORACLE suites. **`npm run test:port` does NOT run the oracle suites** (`vitest.port.config.ts` excludes `test/unit/port/oracle/**`; they run only via `npm run test:oracle`, which boots real servers — budget several minutes). Notes:

- `t0-equivalence-rust.test.ts` node-vs-rust deep diff compares `ready` frames value-by-value (`buildId` is NOT in the normalization registry, so it is compared RAW): both sides stamp the SAME value — the worktree HEAD sha at build time. The node oracle target runs the COMPILED `dist/server/index.js` (its bake file written by `build:server` at the worktree HEAD), and `ensureServerBuilt`'s new stamp-freshness check (step 3j) rebuilds a stale node dist so a pre-existing stale `dist/` can never false-diverge against the fresh cargo-built rust target (`ensureRustServerBuilt`; both Rust build scripts re-stamp on HEAD moves). With git-less environments both stamps are `"unknown"`. This run is the parity proof.
- `build:server` now emits `dist/server/build-id.json`; confirm with a real build:

```bash
cargo test -p freshell-protocol
cargo test -p freshell-ws
cargo check --workspace --all-targets
npm run build:server
cat dist/server/build-id.json
npm run test:integration
npm run test:port
npm run test:oracle
```

Expected: all PASS, and `dist/server/build-id.json` contains the current worktree HEAD sha.

- [x] **Step 7: Commit the task**

Stage by directory so every compiler-enumerated fix lands in the commit (the worktree starts clean; verify nothing unexpected is staged):

```bash
git status --short
git add shared/ port/contract/ws-server-messages.schema.json port/oracle/harness/external-server.ts server/ scripts/bake-server-build-id.mjs test/server/ crates/ package.json
git status --short
git commit -m "feat(protocol): both servers stamp additive optional ready.buildId (artifact-time bake)"
```

Expected: the first `git status --short` lists exactly the Task 1 files (all under the staged paths); the second shows the staged set; the commit compiles standalone (`cargo check --workspace --all-targets` from a clean checkout of it would pass — every `Ready` literal fix is inside `crates/`).

---

### Task 2: Client compares on `ready` and reloads once (module + Vite define + App wiring)

**Files:**
- Create: `src/lib/server-build-check.ts`
- Modify: `config/vite/vite.config.ts` (git-probe helper near the top-level helpers after line 10; extend the `define` block at lines 58-60)
- Modify: `src/vite-env.d.ts:12` (declare the constant)
- Modify: `src/App.tsx` (import near the other `@/lib` imports; `ReadyMessageSchema` at lines 157-166; call site after the bootId warn block ending at line 1031)
- Test: `test/unit/client/lib/server-build-check.test.ts` (new)
- Test: `test/unit/client/components/App.restart-signals.test.tsx` (new `describe` block at the end of the file, reusing that file's harness helpers)

**Interfaces:**
- Consumes: Task 1's wire contract (`ReadyMessage.buildId?: string`, parsed by `ReadyMessageSchema`).
- Produces: `checkServerBuildId(options?: ServerBuildCheckOptions): void` from `@/lib/server-build-check`, with `ServerBuildCheckOptions { clientBuildId?: string; serverBuildId?: string; reload?: () => void; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }`; `__FRESHELL_BUILD_ID__: string` available client-side at build time. Task 3's e2e exercises the production wiring end to end.

- [x] **Step 1: Write the failing behavioral tests**

1a. Create `test/unit/client/lib/server-build-check.test.ts`:

> As-built amendment (delta review round 3): the sentinel records the attempted server build id (see the Global Constraints loop-guard amendment) — the listing below shows the as-built semantics, including the added re-arm sequence test.

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkServerBuildId } from '@/lib/server-build-check'

const SENTINEL = 'freshell.server-build-reload'

function mapStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  }
}

describe('checkServerBuildId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reloads once, recording the attempted server build id in the sentinel BEFORE the reload fires', () => {
    const storage = mapStorage()
    const reload = vi.fn(() => {
      // Ordering proof: production must persist the sentinel BEFORE
      // calling reload — an implementation that reloads first and arms
      // second would lose the sentinel across the navigation.
      expect(storage._map.get(SENTINEL), 'sentinel must be armed BEFORE reload fires').toBe('b'.repeat(40))
    })
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
  })

  it('never reloads twice for the same server build id: a recorded sentinel suppresses the reload', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, 'b'.repeat(40))
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
  })

  it('re-arms for a DIFFERENT mismatched server build id: B attempts once, repeats of B suppress, C reloads again', () => {
    const storage = mapStorage()
    const reload = vi.fn()
    // Mismatch vs B: reload, sentinel records B.
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
    // Mismatch vs B again (the half-deployed case): the same identity was
    // already attempted — suppressed, no reload.
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
    // A corrected deployment (C): a different server build id re-arms the
    // guard — reloads again, sentinel now records C.
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'c'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(2)
    expect(storage._map.get(SENTINEL)).toBe('c'.repeat(40))
  })

  it('a matching ready clears the recorded sentinel (self-re-arm)', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, 'b'.repeat(40))
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'a'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBeUndefined()
  })

  it('is a no-op when either side is missing, empty, or "unknown"', () => {
    for (const opts of [
      { clientBuildId: 'a'.repeat(40), serverBuildId: undefined },
      { clientBuildId: undefined, serverBuildId: 'b'.repeat(40) },
      { clientBuildId: '', serverBuildId: 'b'.repeat(40) },
      { clientBuildId: 'unknown', serverBuildId: 'b'.repeat(40) },
      { clientBuildId: 'a'.repeat(40), serverBuildId: 'unknown' },
      { clientBuildId: 'unknown', serverBuildId: 'unknown' },
    ] as const) {
      const storage = mapStorage()
      const reload = vi.fn()
      checkServerBuildId({ ...opts, reload, storage })
      expect(reload, JSON.stringify(opts)).not.toHaveBeenCalled()
      expect(storage._map.get(SENTINEL)).toBeUndefined()
    }
  })

  it('a recorded sentinel survives an "unknown"-vs-"unknown" ready (never treated as a match)', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, 'b'.repeat(40))
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'unknown', serverBuildId: 'unknown', reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
  })

  it('does not reload when the sentinel cannot be persisted (fail-safe against reload loops)', () => {
    const reload = vi.fn()
    const storage = {
      getItem: () => { throw new Error('quota') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('quota') },
    }
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not throw or reload when the sessionStorage PROPERTY itself is inaccessible', () => {
    const reload = vi.fn()
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    // Harden contexts throw on PROPERTY ACCESS (SecurityError from a
    // denying getter), not merely on method calls — install a getter that
    // throws so the defaultStorage() fail-safe is actually exercised.
    Object.defineProperty(window, 'sessionStorage', {
      get() { throw new Error('SecurityError: storage denied') },
      configurable: true,
    })
    try {
      expect(() => checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload }))
        .not.toThrow()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original)
    }
  })

  it('falls back to the __FRESHELL_BUILD_ID__ global and window defaults when options are omitted', () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'c'.repeat(40))
    const reload = vi.fn()
    // jsdom 25's Location owns `reload` non-configurably — defineProperty on
    // window.location itself throws. Repo precedent (import-retry.test.ts):
    // replace window-level with a spread copy.
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()

    checkServerBuildId({ serverBuildId: 'd'.repeat(40) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(SENTINEL)).toBe('d'.repeat(40))

    // And with the global absent (Vitest has no define), it is a no-op.
    vi.unstubAllGlobals()
    sessionStorage.removeItem(SENTINEL)
    checkServerBuildId({ serverBuildId: 'd'.repeat(40) })
    expect(reload).toHaveBeenCalledTimes(1)

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })
})
```

1b. In `test/unit/client/components/App.restart-signals.test.tsx`, append a new `describe` block at the end of the file. It reuses that file's existing harness plumbing (`createStore`, `renderApp`, `sendReady`, `wsMocks`, `messageHandler`, `stubAudio`, `terminalRestoreMocks`, `fetchSidebarSessionsSnapshot`, `getTerminalDirectoryPage`, `searchTerminalView`, `apiGet`, `defaultServerSettings`, `defaultSettings` — all defined at the top of that file; mirror the existing describe's beforeEach exactly). Note the jsdom `sessionStorage` here is REAL and persists across the two simulated reboot cycles below — the unit-level proof that a code-armed sentinel survives the reload boundary:

```tsx
describe('App ready buildId → one-shot server-build reload', () => {
  let originalLocation: Location
  let reloadCalls: number
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    stubAudio()
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.onDisconnect.mockReturnValue(() => {})
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    terminalRestoreMocks.addTerminalRestoreRequestId.mockClear()
    terminalRestoreMocks.addTerminalFreshRecoveryRequestId.mockClear()
    messageHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    getTerminalDirectoryPage.mockReset()
    getTerminalDirectoryPage.mockResolvedValue({ items: [], revision: 1, nextCursor: null })
    searchTerminalView.mockReset()
    searchTerminalView.mockResolvedValue({ matches: [] })

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })

    sessionStorage.clear()
    reloadCalls = 0
    // jsdom 25's Location owns `reload` non-configurably — defineProperty on
    // window.location itself throws. Repo precedent (import-retry.test.ts):
    // window-level replacement with save/restore. The reload stub asserts
    // the sentinel is armed AT CALL TIME with the attempted server build id
    // (the ordering proof lives here too, against real jsdom sessionStorage)
    // and counts invocations.
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        reload: () => {
          expect(
            sessionStorage.getItem('freshell.server-build-reload'),
            'sentinel must be armed BEFORE reload fires',
          ).toBe('b'.repeat(40))
          reloadCalls++
        },
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()
  })

  it('mismatched ready buildId triggers exactly one reload, and the sentinel (real sessionStorage, persisting across the simulated reboot) suppresses the next mismatched ready', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    const store = createStore()
    await renderApp(store)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'b'.repeat(40) })
    expect(reloadCalls).toBe(1)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBe('b'.repeat(40))

    // The reload lands: the page reboots in the SAME tab (real jsdom
    // sessionStorage persists), the server is still stale, and the next
    // ready must NOT reload again.
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'b'.repeat(40) })
    expect(reloadCalls).toBe(1)
  })

  it('a matching ready clears the sentinel and re-arms the guard', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    // A sentinel recorded by an earlier mismatched ready (the attempted
    // server build id), as the production code would have persisted it.
    sessionStorage.setItem('freshell.server-build-reload', 'b'.repeat(40))
    const store = createStore()
    await renderApp(store)

    // Server caught up to the client build (the post-reload convergence
    // case): match → sentinel cleared, no reload.
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'a'.repeat(40) })
    expect(reloadCalls).toBe(0)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBeNull()
  })

  it('never reloads on missing or "unknown" buildIds', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    const store = createStore()
    await renderApp(store)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'unknown' })
    expect(reloadCalls).toBe(0)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBeNull()
  })
})
```

- [x] **Step 2: Run the tests and verify the intended failures**

```bash
npm run test:vitest -- run test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
```

Expected: FAIL — `server-build-check.test.ts` cannot resolve `@/lib/server-build-check` (module missing), and the App tests fail because a ready with `buildId` triggers no reload (`expect(reloadCalls).toBe(1)` sees 0).

- [x] **Step 3: Add the minimal production implementation**

3a. Create `src/lib/server-build-check.ts`:

> As-built amendment (delta review round 3): the sentinel records the attempted server build id — see the Global Constraints loop-guard amendment; the listing below is the as-built module.

```typescript
import { createLogger } from '@/lib/client-logger'

const log = createLogger('ServerBuildCheck')

const SERVER_BUILD_RELOAD_SENTINEL = 'freshell.server-build-reload'

export interface ServerBuildCheckOptions {
  /** The client's own baked build id; defaults to `__FRESHELL_BUILD_ID__`. */
  clientBuildId?: string
  /** The server's `ready.buildId`. */
  serverBuildId?: string
  reload?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

/**
 * The client's Vite-baked build id (`config/vite/vite.config.ts` defines it
 * from `git rev-parse HEAD`). `typeof`-guarded because the Vitest client
 * config has no define for it (same precedent as `__PERF_LOGGING__` in
 * `src/lib/perf-logger.ts`) — an unbaked id means "cannot compare", never
 * "reload".
 */
function resolveClientBuildId(): string | undefined {
  if (typeof __FRESHELL_BUILD_ID__ === 'undefined') return undefined
  const id = __FRESHELL_BUILD_ID__
  return id.length > 0 ? id : undefined
}

/**
 * sessionStorage can throw on PROPERTY ACCESS in hardened contexts (iframe
 * sandboxing, privacy modes) — resolving it must be inside the fail-safe,
 * never a ready-handler crash.
 */
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Compare the server's `ready.buildId` against our own baked build id and
 * reload ONCE on a real mismatch. Invariants:
 * - reload iff BOTH ids are present, non-empty, neither is "unknown", and
 *   they differ ("unknown" == "unknown" is a no-op, never a match-and-clear);
 * - the sessionStorage sentinel records the ATTEMPTED server build id and is
 *   written BEFORE reloading: the same server build id never reloads twice
 *   this tab session (a half-deployed server can never reload-loop), while a
 *   DIFFERENT mismatched id re-arms the guard — a corrected deployment
 *   changes what a reload fetches, so it must stay reachable; any
 *   sessionStorage failure = no reload, logged, fail-safe;
 * - a MATCHING ready clears the sentinel (self-re-arm after convergence).
 * KNOWN LIMITS (accepted for the self-hosted single-server threat model):
 * - the mixed-build-origin oscillation door stays open through match-clears:
 *   one origin fronted by servers built from DIFFERENT commits can oscillate
 *   (mismatch → reload → match clears → mismatch → …). Not hardened with a
 *   clears-per-session cap; revisit only if a split-deploy origin appears.
 * - the compare is direction-free (shas carry no ordering), so a NEWER
 *   client against an OLDER server performs one futile bounded reload per
 *   fresh tab session.
 */
export function checkServerBuildId(options?: ServerBuildCheckOptions): void {
  const clientBuildId = options?.clientBuildId ?? resolveClientBuildId()
  const serverBuildId = options?.serverBuildId
  if (!clientBuildId || !serverBuildId) return
  if (clientBuildId === 'unknown' || serverBuildId === 'unknown') return

  const reload = options?.reload ?? (() => window.location.reload())

  if (clientBuildId === serverBuildId) {
    const storage = options?.storage ?? defaultStorage()
    try {
      storage?.removeItem(SERVER_BUILD_RELOAD_SENTINEL)
    } catch {
      // Ignore sessionStorage access failures (already disarmed-or-armed as
      // found; nothing reloads on the match path either way).
    }
    return
  }

  const storage = options?.storage ?? defaultStorage()
  if (!storage) {
    log.warn(
      `server build ${serverBuildId} differs from client build ${clientBuildId} but `
      + 'sessionStorage is unavailable — suppressing the reload (fail-safe against loops)',
    )
    return
  }
  try {
    if (storage.getItem(SERVER_BUILD_RELOAD_SENTINEL) === serverBuildId) {
      log.warn(
        `server build ${serverBuildId} still differs from client build ${clientBuildId}; `
        + `a reload for build ${serverBuildId} was already attempted this tab session — `
        + 'suppressing further reloads for it',
      )
      return
    }
    storage.setItem(SERVER_BUILD_RELOAD_SENTINEL, serverBuildId)
  } catch (err) {
    log.warn('server-build sentinel persistence failed; suppressing the reload', err)
    return
  }
  log.warn(
    `server build ${serverBuildId} differs from client build ${clientBuildId}; `
    + `reloading once for build ${serverBuildId} to pick up the matching client bundle `
    + '(a different server build id will re-arm this guard)',
  )
  reload()
}
```

3b. In `config/vite/vite.config.ts` — add the import at the top (with the other node imports, after line 5):

```typescript
import { execFileSync } from 'node:child_process'
```

Add the helper after `projectRoot` (line 10):

```typescript
/**
 * The client's build identity: the git commit the bundle was built from,
 * matching the server-side stamps (`crates/freshell-ws/build.rs` /
 * `server/build-id.ts` + `scripts/bake-server-build-id.mjs`). `"unknown"`
 * fallback — the client's compare rule ignores `"unknown"` on both sides.
 */
function computeClientBuildId(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown'
  } catch {
    return 'unknown'
  }
}
```

Extend the existing `define` block (lines 58-60):

```typescript
    define: {
      __PERF_LOGGING__: JSON.stringify(env.PERF_LOGGING || ''),
      __FRESHELL_BUILD_ID__: JSON.stringify(computeClientBuildId()),
    },
```

3c. In `src/vite-env.d.ts`, add after line 12:

```typescript
declare const __FRESHELL_BUILD_ID__: string
```

3d. In `src/App.tsx`:

Add the import near the other `@/lib` imports (after the `installTestHarness` import at line 35):

```typescript
import { checkServerBuildId } from '@/lib/server-build-check'
```

Extend `ReadyMessageSchema` (lines 157-166), after the `bootId` line:

```typescript
  bootId: z.string().min(1).optional(),
  // The server's baked build identity (additive/optional — old servers omit
  // it). Compared in checkServerBuildId below. Plain `z.string()` (NOT
  // min(1)): a present-but-EMPTY buildId must reach the helper and no-op
  // there, never fail the WHOLE ready frame and silently disable restart
  // detection. Only a non-string TYPE can fail the frame, which no real
  // server emits (the helper additionally treats "unknown" as a no-op).
  buildId: z.string().optional(),
```

Add the call inside the `else` (ready-success) branch, immediately after the `if (!newBootId) { ... }` warn block that ends at line 1031:

```typescript
            // Server-build mismatch detection: the server stamps the git
            // commit it was built from (ready.buildId, additive/optional);
            // we compare it against our own Vite-baked
            // __FRESHELL_BUILD_ID__ and reload ONCE on a mismatch (sentinel
            // loop-guard lives in src/lib/server-build-check.ts).
            checkServerBuildId({ serverBuildId: ready.data.buildId })
```

- [x] **Step 4: Run the focused tests**

```bash
npm run test:vitest -- run test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
```

Expected: PASS.

- [x] **Step 5: Refactor while green**

Verify the Vite define actually bakes the sha into the bundle (explicit pass/fail so automation cannot swallow a failed match through a pipe):

```bash
npm run build:client
rg -q "$(git rev-parse HEAD)" dist/client/assets/*.js && echo "BAKE OK: sha present in bundle" || { echo "BAKE MISSING: sha absent from bundle"; exit 1; }
```

Expected: `BAKE OK: sha present in bundle` — the command exits 0. A missing bake prints `BAKE MISSING` and exits NONZERO (the failure branch must not mask the failure behind a successful `echo`). (`npm run build:client` from this worktree writes the worktree's own `dist/client` — the main-checkout `npm run build` production-server guard does not apply here.)

- [x] **Step 6: Run impacted-test verification**

`ReadyMessageSchema` and App's ready handling are shared client-critical paths and the define constant touches the whole client build; the impacted set is the client unit suite plus typecheck and lint:

```bash
npm run typecheck:client
npm run lint
npm run test:vitest -- run test/unit/client
```

Expected: all PASS.

- [x] **Step 7: Commit the task**

```bash
git add src/lib/server-build-check.ts config/vite/vite.config.ts src/vite-env.d.ts src/App.tsx test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
git commit -m "feat(client): reload once when ready.buildId differs from the baked build id"
```

---

### Task 3: E2E proof (rust-chromium, local lane) + docs

**Files:**
- Create: `test/e2e-browser/specs/server-build-mismatch-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to `RUST_ONLY_SPECS`, whose `/create-protection-isolation-rust\.spec\.ts$/,` entry is at line 204; add the spec to the `rust-chromium` project's `testMatch`, whose `/codex-terminal-bounce-rust\.spec\.ts$/,` entry is at line 371)
- Modify: `test/e2e-browser/playwright.cloud.config.ts` (add the spec to `CLOUD_SKIP_SPECS` with justification)
- Modify: `AGENTS.md` (one-line note under "Key Architectural Patterns → WebSocket Protocol")

**Interfaces:**
- Consumes: Tasks 1-2 (both servers stamp `ready.buildId`; the client compares and reloads once; `TestHarness.receiveWsMessage` → `ws.receiveMessageForTest` → `handleIncomingMessage` feeds an injected frame through the real App ready handler — verified at `src/lib/ws-client.ts:917-919`).
- Produces: the user-outcome proof on the LOCAL lane — a stale client against a newer server reboots itself exactly once and converges to a healthy ready connection; sessionStorage persistence across a REAL navigation; repeat mismatches suppressed by the sentinel.

- [x] **Step 1: Write the failing behavioral test**

Create `test/e2e-browser/specs/server-build-mismatch-rust.spec.ts`:

> As-built amendment (delta review round 3): the seeded sentinel value is `MISMATCHED_BUILD_ID` (the attempted server build id the injected mismatch presents), not the literal `"1"` — see the Global Constraints loop-guard amendment. (The listing below otherwise reflects the original text; the as-built spec's match-path assertion and init-script persistence read are the amendment declared in the banner.)

```typescript
/**
 * Server-build mismatch auto-reload (the-usual/server-version-reload).
 *
 * The user story: a tab running a client bundle built at commit A connects
 * to a server built at commit B; the server's `ready.buildId` differs from
 * the client's baked `__FRESHELL_BUILD_ID__`; the client reloads EXACTLY
 * ONCE (sentinel `freshell.server-build-reload` in sessionStorage, which
 * records the attempted server build id) and
 * converges to a healthy ready connection. A repeat mismatched ready must
 * NOT reload again — a half-deployed server can never reload-loop.
 *
 * COVERAGE BOUNDARY (read before judging): what e2e proves here is
 * (1) the full production compare-and-reload pipeline through the REAL App
 * ready handler (mismatch injected via the test harness — a REAL server
 * stamps its own sha, which may or may not equal this worktree's client
 * bake, so the injection makes the compare deterministic either way),
 * (2) sessionStorage persistence across a REAL navigation, and (3)
 * suppression of a repeat mismatch. The "code armed the sentinel BEFORE
 * reloading" ORDER is proven by the unit suite (App.restart-signals: real
 * jsdom sessionStorage persisting across the simulated reboot). Observing
 * the code-armed sentinel surviving a REAL navigation e2e is not
 * deterministic here: after any reload the boot's REAL ready either matches
 * (same-HEAD artifacts → legitimately clears the sentinel) or mismatches
 * (stale-bake environments → keeps it), so the post-reload sentinel state
 * is environment-dependent — hence the persistence test reads at commit
 * time and the suppression test seeds its state AFTER the boot settles.
 * Seeding is state setup, the same practice as seeding localStorage in
 * other suites; the PERSISTENCE and SUPPRESSION behavior exercised is
 * entirely production code.
 *
 * Rust-only: registers under `rust-chromium` + RUST_ONLY_SPECS (owns a
 * RustServer directly, the e2eServerKind seam not used). CLOUD-SKIPPED with
 * justification (see playwright.cloud.config.ts): the Cloud Run image
 * builds WITHOUT git metadata, so both the Rust bake and the Vite define
 * are "unknown" there and the compare is inert BY DESIGN — this spec can
 * only pass on a lane where at least the client bake is a real sha.
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const MISMATCHED_BUILD_ID = 'f'.repeat(40)
const SENTINEL = 'freshell.server-build-reload'

test.describe('server build mismatch reload (rust)', () => {
  let server: RustServer | undefined
  let info: TestServerInfo

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    server = new RustServer()
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop().catch(() => {})
  })

  test('mismatched ready buildId reloads exactly once and converges', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Start counting AFTER the boot-time compare so the real ready's own
    // match/mismatch outcome (both artifacts usually share this worktree's
    // HEAD) cannot pollute the count; also re-clear the sentinel so the
    // injected mismatch is the one that arms it.
    await page.evaluate((key) => sessionStorage.removeItem(key), SENTINEL)
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })

    // Injected mismatch → exactly one reload, and the page reboots into a
    // healthy ready connection (convergence).
    await harness.receiveWsMessage({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-build-mismatch-probe',
      bootId: 'boot-build-mismatch-probe',
      buildId: MISMATCHED_BUILD_ID,
    })
    await expect.poll(() => navigations, { timeout: 20_000 }).toBe(1)
    const rebooted = new TestHarness(page)
    await rebooted.waitForHarness()
    await rebooted.waitForConnection()

    await context.close()
  })

  test('sentinel persists across a real navigation', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Seed the state the production code would have armed on a previous
    // mismatched ready in this tab (see the coverage boundary above): the
    // sentinel records the attempted server build id, which here is the id
    // a mismatched ready would have presented.
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [SENTINEL, MISMATCHED_BUILD_ID])

    // A REAL navigation: sessionStorage must survive it (per-tab, per-origin
    // storage) — read at commit time, BEFORE the rebooted app's real ready
    // can legitimately match-and-clear it (same-HEAD artifacts match).
    await page.reload({ waitUntil: 'commit' })
    const persisted = await page.evaluate((key) => sessionStorage.getItem(key), SENTINEL)
    expect(persisted, 'sentinel must survive a real navigation').toBe(MISMATCHED_BUILD_ID)

    await context.close()
  })

  test('a seeded sentinel suppresses a repeat mismatch (no reload)', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Seed AFTER the boot settles (the boot's real ready may legitimately
    // match-and-clear an earlier sentinel; seeding here is the setup for
    // the suppression proof — the arming ORDER is unit-proven, the
    // navigation persistence is proven by the previous test). The value is
    // MISMATCHED_BUILD_ID: the attempted server build id the injected
    // mismatch below will present, so the production suppression branch
    // (same id already attempted) is the one exercised.
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [SENTINEL, MISMATCHED_BUILD_ID])
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })

    await harness.receiveWsMessage({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-build-mismatch-probe',
      bootId: 'boot-build-mismatch-probe',
      buildId: MISMATCHED_BUILD_ID,
    })
    await page.waitForTimeout(3_000)
    expect(navigations, 'persisted sentinel must suppress the repeat mismatch').toBe(0)

    await context.close()
  })
})
```

Register the spec in `test/e2e-browser/playwright.config.ts`:

In `RUST_ONLY_SPECS`, after the `/create-protection-isolation-rust\.spec\.ts$/,` entry:

```typescript
  // Server-build mismatch auto-reload: injects a mismatched ready.buildId
  // through the test harness and proves ONE sentinel-guarded reload.
  // Rust-only: owns a RustServer directly (see the spec header).
  /server-build-mismatch-rust\.spec\.ts$/,
```

In the `rust-chromium` project's `testMatch` array, after the `/codex-terminal-bounce-rust\.spec\.ts$/,` entry:

```typescript
        // Server-build mismatch auto-reload (the-usual/server-version-reload):
        // mismatched ready.buildId → one reload, sentinel suppresses repeats.
        /server-build-mismatch-rust\.spec\.ts$/,
```

In `CLOUD_SKIP_SPECS` (the filename-string skip list in `playwright.cloud.config.ts` — entries are converted to `**/${s}` globs, so this MUST be a plain filename string, not a regex), add with justification:

```typescript
  // Server-build mismatch reload: the Cloud Run image builds WITHOUT git
  // metadata (.dockerignore drops .git), so the Rust bake and the Vite
  // define are both "unknown" there and the client's compare is inert BY
  // DESIGN — a mismatched ready can never trigger a reload on that lane.
  // Coverage lives on the local rust-chromium project.
  'server-build-mismatch-rust.spec.ts',
```

In `AGENTS.md`, under "Key Architectural Patterns", append to the **WebSocket Protocol** paragraph:

```
The `ready` frame carries an optional additive `buildId` (the server's artifact-time-baked git commit, `"unknown"` fallback): the client bakes its own at Vite build time (`__FRESHELL_BUILD_ID__`) and, on a mismatch, reloads exactly once per tab session (sessionStorage sentinel `freshell.server-build-reload` records the last attempted server build id; the same id never reloads twice, a different (corrected) deployment re-arms the guard), self-healing stale-client contract errors; `"unknown"` on either side never triggers or clears the guard (`src/lib/server-build-check.ts`). The once-guard is per server identity: an origin fronted by mixed-build servers could oscillate, and a newer client against an older server costs one futile bounded reload per fresh tab session (both accepted for the single-server self-hosted model).
```

- [x] **Step 2: Run the test and verify it passes, then RED-VERIFY it exercises the feature**

Build the client fresh first so the served bundle provably contains the feature (the red-verification's validity depends on it):

```bash
npm run build:client
```

With Tasks 1-2 landed the behavior exists, so the fresh test should be green — but a green-only run is not sufficient proof. First run it green:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
```

Expected: PASS.

Then prove it fails for the right reason: temporarily comment out the `checkServerBuildId(...)` call in `src/App.tsx`, rebuild the client, and re-run:

```bash
npm run build:client
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
```

Expected: FAIL — test 1's `expect.poll` times out with `navigations` stuck at 0 (no reload happens without the compare). Tests 2 and 3 still pass with the compare disabled (their sentinels are seeded state), which is exactly why the unit suite owns the arming-order proof — record all three observations.

Restore the call and rebuild:

```bash
npm run build:client
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
```

Expected: PASS. (Record all three runs in the task review — the red-verification is mandatory.)

- [x] **Step 3: No production implementation step**

Tasks 1-2 implemented the behavior; this task only proves it end to end.

- [x] **Step 4: Run the focused test**

Same command as Step 2's final run. Expected: PASS.

- [x] **Step 5: Refactor while green**

No refactor needed. Confirm the registration mechanics: excluded from the match-all `chromium` project by the `RUST_ONLY_SPECS` entry (`testIgnore: RUST_ONLY_SPECS` at `playwright.config.ts:330`), included in `rust-chromium`'s `testMatch`, and skipped on the cloud lane by the `CLOUD_SKIP_SPECS` entry with its justification comment.

- [x] **Step 6: Run impacted-test verification**

Playwright registration changed (a new rust-only spec) and AGENTS.md was touched; the impacted set is the rust-chromium self-test that boots a real Rust server through its own fixture (proving the registration change disturbed nothing — note `continuity-smoke.spec.ts` runs ONLY under its own conditional `continuity-smoke` project, NOT under `rust-chromium`, so it must not be used as the neighbor here) plus the two unit files most adjacent to the feature:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/harness-01-rust-server.spec.ts test/e2e-browser/specs/server-build-mismatch-rust.spec.ts
npm run test:vitest -- run test/unit/client/lib/server-build-check.test.ts test/unit/client/components/App.restart-signals.test.tsx
```

Expected: all PASS. Backend note: the repo rule about the configured `FRESHELL_E2E_BACKEND` is honored at execution kickoff — the user chooses local vs cloud once, INFORMED that this spec is cloud-incompatible by construction (the cloud image builds without git metadata, so both stamps are `"unknown"` and the compare is inert there). Regardless of the choice, this spec's coverage lane is the LOCAL rust-chromium project and it is CLOUD_SKIP'd with that justification (`playwright.cloud.config.ts`); if the user chooses cloud, the PR description documents the skip explicitly so no coverage claim is silent. No cloud claim is made about cargo (the cloud runtime uses a prebuilt binary; cargo never runs there per `rust-server.ts:82-90`).

- [x] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/server-build-mismatch-rust.spec.ts test/e2e-browser/playwright.config.ts test/e2e-browser/playwright.cloud.config.ts AGENTS.md
git commit -m "test(e2e): rust spec proves one-shot sentinel-guarded reload on ready.buildId mismatch"
```

---

## Post-execution verification (after Task 3)

Run the coordinated full suite once, from the worktree, plus the oracle suites (which `npm run check` deliberately does NOT cover — they live outside the coordinator):

```bash
npm run check
npm run test:oracle
```

Expected: typecheck + full default + server suites PASS, and the oracle suites (t0-equivalence, handshake-determinism, external-handshake, mutation-validation) PASS — `npm run test:oracle` boots real servers and cargo-builds the workspace, so budget several minutes. Also confirm the Task 3 e2e runs were recorded on the user-chosen backend (this spec's lane is local rust-chromium; cloud is skipped with justification).

**User-outcome recap (maps every requirement to its proof):**

| Requirement | Production behavior | Proof |
| --- | --- | --- |
| Server stamps build identity in `ready` | Rust `freshell-ws/build.rs` bake → `Ready.build_id` (`Some`, sha/`"unknown"`); Node bake-file-or-probe → `buildId`; schema regenerated | roundtrip + wire tests; `test:port` + `test:oracle` (oracle node dist rebuilds when its stamp is stale); Node snapshot test |
| Identity = artifact-time git HEAD, `"unknown"` fallback, everywhere | `crates/freshell-ws/build.rs`; `dist/server/build-id.json` written by `build:server` — compiled artifacts fail inert to `"unknown"` without a valid stamp (never a checkout probe); `computeClientBuildId()` | `build-id.test.ts` (bake precedence, source-vs-compiled split, garbage-stamp rejection); bundle-bake check (Task 2 Step 5); `cat dist/server/build-id.json` (Task 1 Step 6) |
| Client compares on every `ready` | `ReadyMessageSchema.buildId` → `checkServerBuildId` in App's ready handler | App.restart-signals describe block |
| Mismatch → reload exactly once | sentinel set before `reload()`; armed sentinel suppresses | unit matrix (real jsdom sessionStorage across the simulated reboot); e2e navigation count === 1 |
| Sentinel survives a REAL navigation; repeat mismatches suppressed | sessionStorage per-tab persistence; suppression branch | e2e test 2 (commit-time persistence read + suppression); unit matrix |
| Never reload-loops (incl. storage failure, repeated mismatches) | fail-safe catch + property-access guard + logged suppression; `"unknown"` no-op | unit cases (throwing storage, undefined sessionStorage, unknown-vs-unknown); e2e repeat-injection step |
| Match clears the sentinel (self-re-arm) | removeItem on equal ids | unit cases; App re-arm test |
| Old servers/forks unaffected (additive contract) | optional field, omitted when `None`; schema stays `additionalProperties: false` | frozen transcript roundtrip; contract-freeze + mutation suites |
| Real-world convergence | reloaded page reconnects and reaches ready | e2e test 1 `waitForConnection` after reload |
