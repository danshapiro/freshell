# Extension System Investigation — 2026-03-18

## Context

Matt wanted to understand why the extension system is hard to use, specifically
after struggling with the gf-factory Factory Manager (a Go server extension in
Docker). Investigated all three extension categories hands-on.

## Test Setup

- Built freshell from worktree, ran on port 3344 in production mode (Node 24)
- Created test extensions in `~/.freshell/extensions/`:
  - `hello-server` — minimal Node HTTP server extension
  - `hello-client` — minimal static HTML client extension
- Also tested the existing `freshell-workbench` client extension

## Findings

### Server Extensions: WORK (locally)

Server extensions work correctly on localhost:
- Extension discovered from `~/.freshell/extensions/`
- Process spawned with dynamic port allocation
- `readyPattern` stdout matching works
- Iframe renders at `localhost:{dynamicPort}/` — no auth needed since the
  extension server is separate from freshell

**Docker caveat:** Dynamic ports are NOT exposed by Docker, so server extensions
fail when freshell runs inside a container and the browser is outside. The
`isRemote` proxy forwarding path (`/api/proxy/forward`) exists for this case
but only activates when `!isLoopbackHostname(window.location.hostname)`. In
Docker with port forwarding, the browser sees `localhost` so `isRemote` is
false, but the dynamic port isn't accessible. This is the root cause of the
gf-factory failure.

### Client Extensions: BROKEN — Auth Failure

**Root cause:** `httpAuthMiddleware` (server/auth.ts:36-48) only accepts
`x-auth-token` header. Client extension static files are served via
`/api/extensions/:name/client/*`, which goes through this middleware. Iframes
cannot set custom headers — they can only send cookies.

The client already sets a `freshell-auth` cookie (src/lib/auth.ts:6,14) and
the `local-file-router.ts` already accepts this cookie as an auth alternative.
But `httpAuthMiddleware` does not check cookies.

**Result:** All client extensions show `{"error":"Unauthorized"}` in the iframe.
This affects: `freshell-workbench`, `hello-client`, and any future client
extension.

**Fix:** Add cookie-based auth to `httpAuthMiddleware`, matching the pattern in
`local-file-router.ts`. The cookie `freshell-auth` is already set by the
client and should be accepted as a valid auth method.

### CLI Extensions: WORK

Five built-in CLI extensions (Claude, Codex, OpenCode, Gemini, Kimi) work via
terminal pane integration. These don't use iframes and don't hit the auth issue.

## Extension System Architecture Assessment

### What works well
- Extension discovery (scan dirs, symlinks, Zod validation)
- CLI extensions (well-tested, 5 built-in examples)
- Server extension lifecycle (spawn, readyPattern, port allocation, cleanup)
- Pane picker integration (auto-populated from registry)
- Extension manifest schema is well-designed

### What's broken or incomplete
1. **Client extension auth** — the main bug. Easy fix.
2. **Docker/remote server extensions** — `isRemote` detection doesn't account
   for Docker port forwarding. The proxy path exists but never activates.
3. **No example extensions ship** — synth and dataviz are in `demo-projects/`
   but aren't wired as extensions. No non-CLI extension works out of the box.
4. **Extension-installer skill** has good docs but can't help users past the
   auth bug.
5. **No runtime reload** — extensions only discovered at startup. Would be nice
   to have a "refresh extensions" API/button.

### What's confusing for extension authors
1. The auth failure gives no useful error in the UI — just raw JSON
   `{"error":"Unauthorized"}` displayed in the iframe
2. No way to tell whether an extension was discovered — no logs in production,
   no UI indicator
3. The distinction between server and client extensions is unclear when your
   app has its own server — the docs don't explain when to use which
4. `contentSchema` and URL template interpolation are powerful but undiscoverable
5. The `picker.group` field exists but groups aren't visually separated in the UI

## Proposed Changes (priority order)

### P0: Fix client extension auth
Add cookie auth support to `httpAuthMiddleware`. One-line change following
the `local-file-router.ts` pattern.

### P1: Better error display
When an iframe gets a non-200 response, show an error overlay instead of
rendering raw JSON. The `ExtensionError` component already exists for this.

### P2: Extension discovery feedback
Log discovered extensions at INFO level in production. Add a list of
registered extensions somewhere in the UI (settings page?).

### P3: Ship a working example
Convert `demo-projects/synth` to a client extension with a freshell.json.
This gives users a real reference implementation.

### P4: Docker server extension support
Either:
- Allow server extensions to specify a fixed port (breaking the dynamic pattern)
- Detect Docker environment and always use the proxy forwarding path
- Add a config option to force proxy mode

## Files Examined

- `server/auth.ts` — httpAuthMiddleware (the bug)
- `server/extension-manager.ts` — scan, lifecycle
- `server/extension-routes.ts` — static file serving
- `server/extension-manifest.ts` — Zod schema
- `server/local-file-router.ts` — cookie auth pattern (the fix reference)
- `src/components/panes/ExtensionPane.tsx` — iframe rendering
- `src/components/panes/PanePicker.tsx` — ext: type handling
- `src/components/panes/PaneContainer.tsx` — createContentForType
- `src/lib/api.ts` — x-auth-token header
- `src/lib/auth.ts` — cookie setting
- `shared/extension-types.ts` — client-safe types
- `~/.freshell/extensions/freshell-workbench/freshell.json` — existing extension

## Test artifacts to clean up
- `~/.freshell/extensions/hello-server/` — test extension
- `~/.freshell/extensions/hello-client/` — test extension
