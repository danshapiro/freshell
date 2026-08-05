# Parity Campaign Results — overnight 2026-08-05 (fable)

**Branch:** `parity-campaign-20260805` (single integration branch, ready for review; NOT pushed, no PR)
**Workers:** opencode CLI + `ms-runpod/moonshotai/Kimi-K3` (≈35 sessions: 18 auditors, ~17 implementers + fix/fresh recovery sessions)
**Verification bar:** every landed item cherry-picked onto this branch and passed targeted `cargo test` / vitest runs centrally; full workspace + npm gates run at campaign end (see GATES section below).

## Landed items (31 checklist items, 31 feature commits)

| Item | Commit | Area |
|------|--------|------|
| SESSION-14 | f38c81f9c | fractional-ms flooring parity, directory projection |
| NET-03 | 97764871e | share-URL truth table + token encoding |
| SESSION-19 | 03e4c5ede | safe bounded search snippets |
| TERM-13 | 45a000817 | scrollback cap eviction/persistence tests |
| FILE-06 | 6f556d566 | sandbox comparison hardening (dot-segments, symlinks) |
| EXT-02 | afa317e36 | extension-scan diagnostics parity |
| AUTO-08 | 6be88cd0f | navigate parity (alias, 400, history rules) |
| SYNC-01 | 95dc360c5 | 400% UI scale input + a11y + persistence (tests) |
| SYNC-03 | e6bea2342 | editor font follows terminal font (tests) |
| SYNC-04 | 9d67b258b | deprecated freshAgent.fontScale removal (tests) |
| EXT-04 | 84e31bdea | extensions patch validation + disabled round-trip |
| TERM-04 | 921e72ec6 | create dedupe two-clients/reconnect tests |
| SESSION-02 | 60f83b512 | createdAtOverride + title suppression overlay |
| SESSION-01 | c376e8d85 | sidebar-click resumable identities (4 providers) |
| DIAG-04 | 830b01f77 | **live perf logging toggle + CPU/RSS process sampler** |
| FILE-01 | b5d2dfcd2 | authenticated /local-file endpoint |
| BROWSER-02 | 9e220a572 | WebSocket-upgrade proxy relay |
| SYNC-02 | eb04653dd | 64px terminal font + live xterm metrics (tests) |
| TERM-09 | 3a7e1f411 | output backpressure: catastrophic monitor can't be starved |
| TERM-05 | be282d324 | shared owner output byte-parity + attach convergence |
| SESSION-07 | cde48e799 | stale-query cancellation + amplifier file-tier search |
| NET-05 | 0c4d8cd36 | POST /api/network/configure-firewall WSL2 repair |
| AUTO-10 | 45affeda3 | wait-for: exit/prompt/stable modes + /re/flags |
| EXT-01 | 84dcbf48d | strict extension manifest schema (zod parity) |
| AUTO-06 | 3e3940e7b | pane rename resolution + ui.command broadcast |
| SESSION-04 | 6757ee326 | provider-aware titles + Gemini AI title path |
| FILE-02 | 4e3fadee8 | Windows drive/UNC targets in /local-file |
| FILE-03 | 87eee486b | \\wsl$ + network-share UNC unaddressable pinning |
| AUTO-05 | (bonus) | pane split/close ops parity slice |
| SESSION-17 | (bonus) | session title sync + PATCH provider lanes |
| NET-09 | (bonus) | network settings persistence + share-URL settings lanes |

Plus docs: AGENTS.md port correction (47f5c68f5), audit ledger (d85561a8c).

## Honest non-landings

- **SYNC-06** — AUDIT_WRONG: worker proved the feature already landed via PR #592; no work needed.
- **SESSION-21** — DROPPED: three sessions (2 resumes) produced zero committed output.
- **AUTO-05** — initially cut at deadline, then SALVAGED in the bonus round (fresh session
  finished the dirty worktree; landed and verified).

## Checkbox policy (IMPORTANT)

NO checklist checkboxes were flipped. The checklist's completion rule requires the item's
Playwright lane(s) to pass; tonight's items landed with unit/integration coverage only.
The audit ledger (`audit/*.yaml`) + this file carry the evidence; a follow-up PW-RUST pass
should flip boxes item-by-item.

## Audit ledger

`docs/plans/parity-ledger/audit/*.yaml` — all 235 items re-verdicted with file:line evidence:
31 DONE / 118 PARTIAL / 58 MISSING / 23 UNCLEAR / 5 HOST-LIMITED as of main@4eecc456c.

## GATES (07:08)

- `cargo test --workspace` (shared warm target): **EXIT 0** — all workspace crates green
  including the 28 landed items (log: /tmp/parity/logs/gate-cargo.log).
- `npm test` (coordinated full suite, campaign worktree): **EXIT 0** — fully green; note the
  pre-existing `api-edge-cases` __proto__ failure seen at baseline did NOT reproduce here
  (log: /tmp/parity/logs/gate-npm.log).

## GATES round 2 (07:56, final branch state with 31 items)

- `cargo test --workspace`: **EXIT 0**
- `npm test` (coordinated full suite): **EXIT 0**
