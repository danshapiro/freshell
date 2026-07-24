# Task-006 §7.D.4 — per-provider live CLI pane rendering legs (2026-07-13)

Rendering leg of the CLI argv fidelity spec (`port/machine/specs/cli-argv-fidelity.md`
§7.D.4): argv/env equivalence was already live-verified at d60d22fc via /proc
cmdline+environ differential; this leg proves the panes PAINT their real
interactive UI through the SPA, identically launched on the Rust WSL server and
the original.

Harness: `run-matrix-generic.mjs` (same code path both legs), Chromium headless
(playwright), fresh scratch HOME per run, `MATRIX_ONLY=claude,codex,opencode`.
Legs: `MATRIX_MODE=rust MATRIX_PORT=17872` → `t6-wsl-chrome-*`;
`MATRIX_MODE=node MATRIX_PORT=17871` → `t6-orig-chrome-*`.

## Results (harness 3/3 PASS on BOTH legs; vision 6/6 PASS)

| pane | rust 17872 (t6-wsl-chrome-*) | original 17871 (t6-orig-chrome-*) | vision verdict |
|---|---|---|---|
| claude | PASS — first-run onboarding theme picker + code preview (real claude TUI, fresh HOME) | PASS — same onboarding theme picker | PASS / PASS |
| codex | PASS — sign-in menu (ChatGPT / device code / API key), fresh-HOME first-run | PASS — same sign-in menu | PASS / PASS |
| opencode | PASS — opencode TUI: logo, boxed "Ask anything…" input, `Build · GPT-5 OpenAI` status | PASS — same TUI | PASS / PASS (re-drive) |

Vision reviewer: image-vision skill (anthropic backend). Notes:
- First pass gave claude/wsl a rubric-artifact FAIL ("onboarding screen, not the
  TUI") while passing the byte-equivalent original screenshot; re-asked with the
  correct rubric (fresh-HOME first-run onboarding IS the real TUI) → PASS both.
- First-pass opencode screenshots FAILED vision on BOTH legs (stale/blank paint
  at capture instant) while the harness buffer held the full TUI on both; per
  §8.4 discipline the cells were RE-DRIVEN (`MATRIX_ONLY=opencode`), fresh
  screenshots on both legs then PASS. Same failure on both systems, same
  recovery on both systems — no rust/original divergence at any point.
- Codex fresh-dir trust prompt did not appear (sign-in gate first under the
  fresh HOME); the sign-in menu is the documented steady-UI for that state.

Artifacts: `t6-{wsl,orig}-chrome-{claude,codex,opencode,overview}.png` +
`t6-{wsl,orig}-chrome-report.json` (committed alongside this review).

Native-Windows CLI pane rendering is covered separately under BLOCKER B1
(DEV-0007): claude launches and paints its error path via the cmd branch;
the reference cannot launch claude at all there. Windows opencode: absent
(ENV-LIMITED, recorded).
