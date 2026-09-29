# Task 2 fourth review-fix report

## Change

- `approved_tui_source` now canonicalizes the selected filesystem path before
  classifying it against the approved workspace and OpenCode provider roots.
- Durable references retain a clean root-relative symlink route when possible,
  so replacement rereads the selected file. A selection containing `..` uses
  its resolved in-root target; paths resolving outside both approved roots fail.
- Added regressions for a provider-home symlink that retargets to another
  in-home config directory and for an escaping workspace symlink followed by
  `..`.

## Verification

- `cargo test -p freshell-server --features managed-runtime-v1 managed_mcp_capability::tests`
  — 13 passed.
- `cargo test -p freshell-runtime-protocol` — 32 passed.
- `pnpm run typecheck` — passed.
- `cargo fmt --all -- --check` and `git diff --check` — passed.
- The six-case live fixture ran all cases: five passed. The existing test
  `resumed OpenCode child sees refreshed config and keeps provider-owned state`
  timed out waiting for `terminal.attach.ready` after its replacement child had
  resumed. Retrying that case alone reproduced the timeout. This path does not
  exercise the new symlink cases; the separate OpenCode web-restart recovery
  case passed in the full run.

No server was deployed or restarted, and no branch was pushed or PR created.
