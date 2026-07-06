# T3 — running the e2e-browser suite against the RUST server

Phase 3.10 broadened `freshell-server` (the Rust port) so the **retained, unchanged
React SPA** loads and runs against it: static `dist/client` serving + the handful
of REST endpoints the SPA fetches on first paint + the auth gate the WS/REST share.
This is the gateway to the oracle's T3 (e2e / visual) tier — the *same*
`test/e2e-browser/` specs and committed visual baselines, pointed at the port via
the `FRESHELL_E2E_TARGET_URL` seam (`test/e2e-browser/helpers/external-target.ts`).

Nothing in `server/` or `shared/` was touched (pristine); every change is additive
port code under `crates/`.

## What was added (additive, port-only)

Serving + boot REST (`crates/freshell-server/src/`):

| Piece | File | Notes |
|---|---|---|
| Static `dist/client` + SPA fallback | `serve_client.rs` (259 LOC) | ports `server/static-client-routes.ts`: real files with matching cache policy (index.html `no-store`; `/assets/*` hashed → `immutable`; else `no-cache`); missing `/assets/*` → 404; every other path → `index.html`. Unmatched `/api/*` → clean `404 {error}` JSON (never the shell). Hand-rolled (no new crate deps). |
| Boot REST surface | `boot.rs` (318 LOC) | `GET /api/bootstrap`, `/api/platform`, `/api/version`, `/api/settings`, `/api/session-directory`, `/api/terminals`, `/api/network/status`, `/api/extensions`; `POST /api/logs/client`, `/api/tabs-sync/client-retire`. Each gated by the `x-auth-token` header or `freshell-auth` cookie (constant-time), mirroring `server/auth.ts#httpAuthMiddleware`; `/api/health` stays unauthenticated. |
| Wiring + platform payload | `main.rs` (+85 LOC) | merges the boot router, mounts the SPA fallback, builds the `{platform,availableClis,hostName,featureFlags}` payload from `freshell-platform` (`/proc/version` → `platform:"wsl"` on this host). Client dir via `FRESHELL_CLIENT_DIR` → compile-time `../../dist/client` → `./dist/client`. |
| **Terminal-output fidelity fix** | `crates/freshell-ws/src/terminal.rs` (+17 LOC) | **PORT_DEFECT** — see below. |

### PORT_DEFECT (fixed in the port): `terminal.output` must echo `attachRequestId`

The oracle's T1 rung proved the Rust terminal byte-stream is byte-identical to the
original over the wire — but only against a raw capture client whose `terminal.attach`
carries **no** `attachRequestId`. The real SPA's attach *does* carry one, and
`TerminalView#isCurrentAttachMessage` **drops every stream frame whose
`attachRequestId` is absent or doesn't match the active attach**. The port was
building `terminal.output` frames with `attachRequestId: None`, so the browser
received the bytes (verified over the wire) but rendered nothing (0 xterm writes).

The original echoes `m.attachRequestId` onto every output frame it streams
(`server/ws-handler.ts`). The port now stamps each replayed + live `terminal.output`
frame with the owning terminal's current `attachRequestId`. This is a port-completeness
fix (making the port match the original), not a change to the reference — `server/`
stays pristine, and T0/T1 stay byte-identical (the T1 capture attach sends no id, so
the stamped field is still absent there).

## How to run

Grade the ORIGINAL (local baseline — spawns its own isolated TestServers):

```
npx playwright test --config port/oracle/t3/playwright.target.config.ts
```

Grade the RUST port — build the client once, boot the server on a loopback port,
point the suite at it:

```
npm run build:client                      # the retained frontend, unchanged
PORT=<free> AUTH_TOKEN=<token> \
  FRESHELL_HOME=<isolated> HOME=<isolated> \
  FRESHELL_CLIENT_DIR=$PWD/dist/client \
  ./target/debug/freshell-server &        # binds 127.0.0.1:<PORT>

FRESHELL_E2E_TARGET_URL=http://127.0.0.1:<PORT> \
FRESHELL_E2E_TARGET_TOKEN=<token> \
FRESHELL_E2E_TARGET_HOME=<isolated> \
  npx playwright test --config port/oracle/t3/playwright.target.config.ts \
    auth.spec terminal-lifecycle.spec screenshot-baselines.spec
```

Pre-seed `<isolated>/.freshell/config.json` with
`{"version":1,"settings":{"network":{"configured":true,"host":"127.0.0.1"}}}`
(what the E2E `TestServer` writes) so the setup wizard is bypassed.

## Result — T3 CORE against the Rust port (this host: chromium-linux, WSL2)

`auth + terminal-lifecycle + screenshot-baselines` → **25 / 25 PASSED**.

| Slice | Result | Proves |
|---|---|---|
| `auth.spec.ts` | **6/6** | SPA loads + renders; correct token → `ready`; wrong/absent → auth modal; `GET /api/settings` 401 unauth; `/api/health` 200 unauth. |
| `terminal-lifecycle.spec.ts` | **13/13** | create → **shell prompt renders** → typing/echo → command output → tab-switch survival → resize → detach-keeps-running → rapid input → Ctrl+L → close-tab-kills → **reconnect after WS drop** → scrollback preserved. |
| `screenshot-baselines.spec.ts` | **6/6 visual MATCH** | default-layout, settings-view, multiple-tabs, auth-modal, sidebar-collapsed, mobile-layout — all match the ORIGINAL's committed `*-chromium-linux.png` (maxDiffPixelRatio 0.05). |

Load ✅ · Auth ✅ · Terminal (create + live output + input + scrollback) ✅ ·
Visual ✅ — the retained UI is indistinguishable from the original through the
auth + first-terminal path against the Rust backend.

## Breadth — what else works vs. needs surface not yet built

Ran the CORE-adjacent, externally-targetable specs that are green against the
original. **PASS = already works against the port; NEEDS-SURFACE = a real finding,
NOT force-greened** (server surface the port hasn't built yet — later steps).

Result: **46 / 51 passed** across 7 files:

| Spec file | Result |
|---|---|
| `pane-system.spec.ts` | **10/10** (splits/resize/focus/zoom/nested layouts) |
| `pane-picker.spec.ts` | **2/2** |
| `sidebar.spec.ts` | **8/8** |
| `settings.spec.ts` | **8/8** |
| `tab-management.spec.ts` | **10/11** |
| `reconnection.spec.ts` | **5/6** |
| `multi-client.spec.ts` | **3/6** |

The 5 NEEDS-SURFACE failures cluster on **two** missing server capabilities (findings,
expected — a fresh socket in the port gets a fresh terminal inventory, and there is no
shared/cross-connection terminal registry or settings fan-out yet):

- **Cross-connection / cross-reload terminal persistence** (4 of the 5):
  - `multi-client › terminal output appears in both clients`
  - `multi-client › reconnecting second viewer keeps page-1 PTY size stable + shared output`
  - `reconnection › terminal output resumes after reconnect`
  - `tab-management › restored top tabs stay hot across page reload …`
  - Root cause: the port streams a terminal only to the connection that created it;
    a new/second socket can't re-attach to an existing PTY. (Single-socket reconnect
    *within* `terminal-lifecycle` passes — it recreates; what's missing is a server-side
    terminal registry that outlives the socket so a *different* socket can re-attach.)
- **Settings broadcast** (1 of the 5): `multi-client › settings change broadcasts to
  other clients` — `PATCH /api/settings` doesn't yet emit `settings.updated` to the
  other WS clients.

Both are legitimate later-step server surface, not regressions.

Larger breadth still entirely out of scope for this step (each needs its own server
surface, and most are already RED against the *original* on this host per the T3
baseline, so they are not CORE gates): full sessions/history, files/editor pane,
network/LAN, fresh-agent threads, tabs-registry sync, restart-recovery.

## Safety

Every server this step spawned was an isolated Rust `freshell-server` on an
ephemeral **127.0.0.1** port with an isolated `$HOME`; all were reaped (0 orphans).
The user's live server on **:3001 (pid 1262455) was never touched**. `server/` +
`shared/` remained byte-pristine throughout. Nothing was committed.
