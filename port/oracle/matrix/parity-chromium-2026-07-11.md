# Chromium × {original, rust-WSL, rust-Windows} matrix — per-cell parity (§7.E)

**Host:** SurfaceBookPro9 (WSL2), 2026-07-11. Harnesses: `run-matrix-generic.mjs`
(node/rust WSL legs, one shared code path) + `run-matrix-win-generic.mjs` (native-Windows
leg). Reports: `sbp9-{orig,wsl,win}-chrome-report.json`. Every screenshot vision-reviewed
(`vision-review-chrome-2026-07-11.md`); md5-distinct within each batch.

| Pane kind | ORIGINAL 17871 (node, WSL) | Rust-WSL 17872 | Rust-Win 17873 | Parity verdict |
|---|---|---|---|---|
| CMD | **FAIL** — fell back to `C:\Windows` (3/3 re-drives; `notes-orig-cmd-fallback.md`) | PASS (workspace cwd) | PASS (workspace cwd) | **DEV-0005** (adjudicated DELIBERATE_FIX; WSL-host cmd cell whitelisted; 17873 = MATCH, no tolerance) |
| PowerShell | PASS (workspace cwd) | PASS | PASS | MATCH |
| WSL/bash | PASS (workspace cwd, uname) | PASS | PASS | MATCH |
| Editor (Monaco) | PASS | PASS | PASS | MATCH |
| Browser (example.com) | PASS | PASS | PASS | MATCH |
| Claude CLI | PASS (steady UI) | PASS | PASS | MATCH |
| Codex CLI | PASS (steady UI: sign-in chooser) | PASS | PASS | MATCH |
| OpenCode | PASS (steady UI) | PASS | **ENV-LIMITED** — opencode absent on Windows (`"$WIN_WHERE" opencode` not found; phase0 probe, commit 8735bfce) | ENV-LIMITED (proof committed) |

**Bar:** rust per-cell results MATCH the original's per-cell results, with exactly two
whitelisted exceptions: (1) the WSL-host cmd cell (DEV-0005, adversarially adjudicated,
port objectively fixes an original defect — see `port/oracle/DEVIATIONS.md`); (2) the
Windows-native opencode cell (ENV-LIMITED with committed probe proof).

Notes:
- `sbp9-orig-chrome-browser.png` and `sbp9-wsl-chrome-browser.png` are byte-identical
  (md5 62841f15…): both legs render the identical SPA browser pane over example.com at
  the same viewport; captured at distinct times (14:43:10 vs 14:45:27), intra-batch
  md5-distinctness holds for all batches. Flagged for honesty, not a defect.
- Original leg cmd-cell FAIL evidence: `recheck-orig-cmd-{1,2,3}-report.json` +
  `recheck-orig-cmd-1-cmd.png` (OCR transcript in `notes-orig-cmd-fallback.md`).
