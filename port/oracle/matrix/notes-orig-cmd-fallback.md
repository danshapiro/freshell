# Matrix finding: ORIGINAL cmd pane falls back to C:\Windows on a WSL host (deterministic)

**Date:** 2026-07-11 (SurfaceBookPro9, task-005 Chromium matrix)
**Cell:** Chromium × ORIGINAL node server (17871), pane kind `cmd`, workspace cwd
`/mnt/c/Users/Public/freshell-matrix-ws-*` (a valid, existing DrvFs mount path).

## Observation

`sbp9-orig-chrome-report.json` cmd cell = FAIL: "did NOT land in workspace; FELL
BACK to C:\Windows". Rust-WSL (17872) and Rust-Windows (17873) cmd cells = PASS
(prompt in the workspace directory).

## Verification (§8.7 — re-driven, not trusted)

Re-driven 3× against a freshly booted pristine original
(`MATRIX_MODE=node MATRIX_PORT=17871 MATRIX_ONLY=cmd`, harness
`run-matrix-generic.mjs`, identical code path as all legs):

- recheck-orig-cmd-1/2/3-report.json — all 3 FAIL with the identical detail.
- OCR of recheck-orig-cmd-1-cmd.png (tesseract):

```
C:\Windows\System32\cmd.exe
"\\wsl.localhost\Ubuntu\home\dan\code\freshell'
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported. Defaulting to Windows directory.
The filename, directory name, or volume label syntax is incorrect.
C:\Windows>echo freshell-matrix-OK
freshell-matrix-OK
C:\Windows>
```

Two stacked reference failures, exactly as documented at
`crates/freshell-platform/src/spawn.rs:709-730` (`wsl_windows_shell_inherit_cwd`
PORT FIX doc):

1. The reference passes `cwd: undefined` to node-pty on WSL
   (`server/terminal-registry.ts:1186`), so cmd.exe inherits the server's Linux
   cwd as a `\\wsl.localhost\...` UNC path → "UNC paths are not supported.
   Defaulting to Windows directory."
2. The in-command `cd /d "<winCwd>"` (`terminal-registry.ts:1198`) is destroyed
   by WSL-interop argv→cmdline conversion (embedded `"` escaped as `\"`), and
   cmd's builtin `cd` rejects it → "The filename, directory name, or volume
   label syntax is incorrect." — the shell stays in `C:\Windows`.

PowerShell does NOT fail (its `Set-Location -LiteralPath '<path>'` uses single
quotes that survive interop) — matches the matrix (orig powershell PASS).

## Port behavior

The Rust port hands the child a valid `/mnt/<drive>/...` Linux cwd that WSL maps
to the intended Windows directory (no UNC inheritance, no in-command `cd`),
gated on the mount existing (`wsl_windows_shell_inherit_cwd`, spawn.rs:731-739).
Both Rust legs land in the workspace.

## Status

Ledgered as DEV-0005 in port/oracle/DEVIATIONS.md (matrix-cell fingerprint:
cmd-from-WSL-server cwd). The matrix parity table treats this single cell diff
as whitelisted-by-DEV-0005; every other cell must still match exactly.
