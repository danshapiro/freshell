# §3 Validation Results — Codex Log-Dampening Candidates (FINAL: 0a DROPPED)

**Date:** 2026-07-06 (evening/night)
**Protocol:** plan v2.1 §3, prune-immune **incremental insert attribution** — poll
`max(id)` every 1 s on a `mode=ro` connection; accumulate new rows/`estimated_bytes`
for the test process's `process_uuid` (`pid:<rustpid>:%`) as they appear, counting
inserts before the per-process ~1,000-row prune can delete them.
**Workload:** hand-spawned idle codex TUI (codex-cli 0.142.5), cwd=$HOME, real pty
(`script -qec`), ~200–240 s windows, same machine/evening. (Screening-length windows;
the full 15-min freshell-pane-pair run is moot given the magnitude of the failures.)

## Results

| Window | Invocation | Rows | Bytes | Dur | Bytes/s | vs control |
|---|---|---|---|---|---|---|
| control | `codex` | 27,875 | 4,271,823 | 239 s | 17,874 | — |
| composite env | `RUST_LOG=codex_cli=info,codex_core=info,codex_login=info,log=off codex` | 22,086 | 3,487,579 | 238 s | 14,654 | **−18%** |
| feedback off | `codex -c feedback.enabled=false` | 15,978 | 2,663,386 | 199 s | 13,384 | **−25%** |
| env fully off | `RUST_LOG=off codex` | 16,630 | 2,751,392 | 199 s | 13,827 | **−23%** |
| snapshot off | `codex -c features.shell_snapshot=false` | 20,027 | 3,202,531 | 199 s | 16,093 | **−10%** |

Pass bar: **≥90% reduction**. Best candidate: −25%. **All candidates FAIL.**

## Interpretation

- `RUST_LOG=off` silences the *entire* env-filter layer, yet the sink still wrote
  ~14 KB/s. Conclusion: **codex's SQLite feedback sink does not consult the
  `RUST_LOG` env filter.** It is an always-on flight recorder (the
  `bounded_feedback_logs` design) with its own hardcoded TRACE-level capture.
  The 10–25% deltas are window variance and partial upstream effects, not gating.
- `feedback.enabled=false` gates feedback *upload* ("sending feedback is disabled by
  configuration"), not capture.
- `features.shell_snapshot=false` did not stop the `shell_snapshot` TRACE spam
  observed in surviving rows.
- Supporting evidence from round 1: rows tagged `TRACE|log|shell_snapshot…`
  persisted through an explicit `log=off` directive.
- `codex features list`: `sqlite` is stage **removed** (always-on, cannot be
  disabled); `shell_snapshot` stable/true; `runtime_metrics` under-development/false.

## Decision (plan §3, candidate 3 — the drop path)

**Stage 0a is DROPPED.** No freshell-side spawn-env/config knob can dampen the sink.
Protection reduces to:
- **0b** (lossless cleanup, maintenance window) — clears the accumulated WAL;
- **1c observability** (shipped): boot + hourly `codex-log-db:` line, warn at
  WAL > 500 MB / holder threshold — recurrence is now *detectable*, not silent;
- **1a/1c lifecycle hardening** (shipped) — orphan accumulation and boot fragility
  fixed;
- **Stage 2** (shared app-server, holders → 1) becomes the load-bearing fix for WAL
  growth and should be scheduled;
- **Upstream issue** (below).

Expected recurrence cadence without Stage 2: WAL re-approaches the multi-GB cliff in
days-to-weeks of heavy use (~22 MB/min measured across the live pane population;
~1 MB/min per idle TUI). The 500 MB warn threshold gives weeks of margin.

## Draft upstream issue (file against openai/codex)

**Title:** SQLite feedback log sink is unbounded and cannot be disabled; multi-GB WAL
wedges new launches under multi-process use

**Body sketch:**
- `~/.codex/logs_2.sqlite` receives always-on TRACE capture (dominated by
  inotify/`shell_snapshot` events, ~1 MB/min per idle TUI; 22 MB/min across ~20
  processes). Not gated by `RUST_LOG` (measured: `RUST_LOG=off` −23%), nor
  `feedback.enabled=false` (−25%), nor `features.shell_snapshot=false` (−10%).
- With N long-lived codex processes (host apps that keep app-server/resume sessions
  open), no truncating checkpoint window ever occurs; the WAL grew to 5 GB in ~10
  days; new `codex` launches then block in `futex_wait_queue` opening the DB —
  "codex won't launch."
- Asks: (1) bound the WAL (`journal_size_limit` + `wal_autocheckpoint` + periodic
  passive checkpoints from the writer); (2) don't persist inotify/shell_snapshot
  events at TRACE by default; (3) a documented knob to disable/level the feedback
  capture; (4) lazy/incremental thread-inventory scan (`codex doctor` currently
  reads all rollout files synchronously).
- Evidence: measurement tables above; lifetime insert high-water ~6.4B rows;
  per-process ~1,000-row prune bound (table stays small — the WAL is the casualty).
