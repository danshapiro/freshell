# First-Pass Worktree Triage Table — 2026-08-23

main: origin/main @ 3d739ca4a · 74 worktrees · sorted by date descending.
Status vocabulary: `merged` (ancestor), `in-main*` (not ancestor, but contents landed — squash merge and/or post-merge evolution), `near-landed-residue` (small real diff remains), `plan-only` (only docs/plans touched), `distinct` (clearly separate work).

| worktree | branch | date | ancestor? | status | commits ahead | files Δ | meaningful? | summary |
|---|---|---|---|---|---|---|---|---|
| freshagent-undo-redo | the-usual/freshagent-undo-redo | 2026-08-23 | NO | distinct (+1 real dirty test file) | 17 | 72 | yes | fresh-agent /undo /redo rollback feature |
| reconnect-revive | the-usual/reconnect-revive | 2026-08-23 | NO | in-main* (37 files, only test-fixture strings differ) | 23 | 1 | no | reconnect revives panes on rust server |
| gcloud-robot-conversion | the-usual/gcloud-robot-conversion | 2026-08-23 | YES | merged | 0 | 0 | no | merged: gcloud-robot identity conversion |
| sidebar-pinned-status-sort | the-usual/sidebar-pinned-status-sort | 2026-08-21 | YES | merged | 0 | 0 | no | merged: sidebar pinned-status sorting |
| fix-opencode-model-heuristic-7mtf | fix/opencode-model-heuristic-7mtf | 2026-08-20 | YES | merged | 0 | 0 | no | merged: opencode model heuristic fix |
| slash-command-catalogs | the-usual/slash-command-catalogs | 2026-08-19 | NO | distinct | 13 | 25 | yes | slash command catalog feature |
| kata-sbnj | the-usual/kata-sbnj | 2026-08-17 | NO | plan-only (22.8k-line plan, unexecuted here) | 5 | 1 | no | parallel-safe cloud runner plan |
| release-v0.7.6-rc.1 | release/v0.7.6-rc.1 | 2026-08-17 | NO | distinct (1 commit, release marker) | 1 | 4 | yes | 0.7.6 release candidate version bump |
| v0h9 | v0h9/event-driven-session-index | 2026-08-17 | YES | merged | 0 | 0 | no | merged: event-driven session index |
| fresh-agent-model-selector | fix/e2e-cloud-allow-model-picker-spec | 2026-08-16 | YES | merged | 0 | 0 | no | merged: model picker e2e spec |
| session-directory-identity-collisions | fix/session-directory-identity-collisions | 2026-08-16 | YES | merged | 0 | 0 | no | merged: session identity collision fix |
| 0gdd-handoff | docs/0gdd-handoff | 2026-08-15 | NO | plan-only (handoff doc not in main; +1 untracked lab note) | 1 | 1 | no | 0gdd session-index handoff doc |
| session-delete-404 | the-usual/session-delete-404 | 2026-08-15 | YES | merged | 0 | 0 | no | merged: session delete 404 fix |
| session-directory-lazy-page-prep | the-usual/session-directory-lazy-page-prep | 2026-08-15 | NO | plan-only (plan + handoff docs only) | 12 | 2 | no | session directory lazy page prep plan |
| coding-agent-resource-containment | the-usual/coding-agent-resource-containment | 2026-08-14 | NO | plan-only (3963-line hardened plan; feature absent from main) | 2 | 1 | yes | cgroup-v2 agent resource containment plan |
| session-directory-page-prep | the-usual/session-directory-page-prep | 2026-08-13 | NO | plan-only (10.4k-line plan only) | 5 | 1 | no | session directory page prep plan |
| 0gdd-measurement | investigation/0gdd-measurement | 2026-08-12 | YES | merged BUT dirty: 520+ lines uncommitted rust instrumentation + 2 scripts | 0 | 0 | yes | 0gdd level-1 measurement harness (uncommitted) |
| 0gdd-observer | investigation/0gdd-observer | 2026-08-12 | YES | merged BUT dirty: 180KB untracked observer_0gdd.rs | 0 | 0 | yes | 0gdd fs-event observer program (uncommitted) |
| session-directory-page-bound | the-usual/session-directory-page-bound | 2026-08-12 | NO | plan-only (8.3k-line plan only) | 5 | 1 | no | session directory page-bound plan |
| df1-retro | docs/df1-retrospective | 2026-08-11 | NO | plan-only (103-line retrospective doc not in main) | 1 | 1 | no | df1 campaign retrospective doc |
| codex-sidecar-lifecycle | the-usual/codex-sidecar-lifecycle | 2026-08-11 | YES | merged | 0 | 0 | no | merged: codex sidecar lifecycle |
| df1-gate | df1/integration | 2026-08-11 | YES | merged | 0 | 0 | no | merged: df1 integration gate |
| df1-session-13-first-chat-exclusions | df1/session-13-first-chat-exclusions | 2026-08-10 | YES | merged | 0 | 0 | no | merged: df1 session-13 exclusions |
| rust-port-landing | feat/rust-port-mainline | 2026-08-10 | YES | merged | 0 | 0 | no | merged: rust port mainline landing |
| rust-tauri-port | feat/rust-tauri-port | 2026-08-10 | YES | merged (dirty = untracked plan docs + tmp probe only) | 0 | 0 | no | merged: rust tauri port (superseded) |
| df1-cfg-01-lossless-writes | df1/cfg-01-lossless-writes | 2026-08-10 | YES | merged | 0 | 0 | no | merged: df1 cfg-01 lossless writes |
| df1-fix-h06-a11y | df1/fix-h06-a11y | 2026-08-10 | YES | merged | 0 | 0 | no | merged: df1 H06 a11y fix |
| df1-gate-final | DETACHED | 2026-08-10 | YES | merged (detached) | 0 | 0 | no | merged: df1 final gate checkpoint |
| df1-restore-01-panel-inert | df1/restore-01-panel-inert | 2026-08-10 | YES | merged (dirty = regenerated gate01-baseline.json artifact) | 0 | 0 | no | merged: df1 restore-01 panel inert |
| opencode-auto-titles | opencode-auto-titles | 2026-08-10 | YES | merged | 0 | 0 | no | merged: opencode auto titles |
| sweep-deferrals-deflake | the-usual/sweep-deferrals-deflake | 2026-08-10 | YES | merged | 0 | 0 | no | merged: sweep deferral deflake |
| amplifier-stuck-busy | the-usual/amplifier-stuck-busy | 2026-08-10 | YES | merged | 0 | 0 | no | merged: amplifier stuck-busy fix |
| df1-control | df1/control-plane | 2026-08-09 | NO | distinct (campaign control plane: leases, queue, prompts) | 6 | 9 | yes | df1 massively-parallel campaign control plane |
| naming-persistence-sweep | feat/naming-persistence-sweep | 2026-08-09 | YES | merged | 0 | 0 | no | merged: naming persistence sweep |
| df1-session-09-live-watching | df1/session-09-live-watching | 2026-08-09 | NO | in-main* (feature on main) BUT uncommitted black-box WS acceptance test never landed | 2 | 2 | yes | session live-watching digest sweep + untracked test |
| ws-bootstrap-recovery-flake | the-usual/ws-bootstrap-recovery-flake | 2026-08-09 | NO | near-landed-residue (onceIdle deflake NOT on main; branch reverts own guard) | 14 | 3 | yes | ws-bootstrap flake deflake in tests |
| cloud-run-jobs | the-usual/cloud-run-jobs | 2026-08-09 | NO | distinct (10/13 footprint files differ) | 10 | 10 | yes | e2e Cloud Run jobs backend + Docker |
| df1-harness-12-leak-metrics | df1/harness-12-leak-metrics | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-12 leak metrics |
| df1-harness-14-server-clock | df1/harness-14-server-clock | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-14 server clock |
| df1-cfg-04-browser-seed | df1/cfg-04-browser-seed | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 cfg-04 browser seed |
| df1-cfg-12-settings-split | df1/cfg-12-settings-split | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 cfg-12 settings split |
| df1-diag-01-jsonl-logs | df1/diag-01-jsonl-logs | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 diag-01 jsonl logs |
| df1-ext-01-manifest-schema | df1/ext-01-manifest-schema | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 ext-01 manifest schema |
| df1-fix-split87 | df1/fix-split87-annotation | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 split87 annotation fix |
| df1-gate-01-unchanged-suite-both | df1/gate-01-unchanged-suite-both | 2026-08-09 | YES | merged (dirty = regenerated gate01-baseline.json artifact) | 0 | 0 | no | merged: df1 gate-01 unchanged-suite run |
| df1-harness-03-provider-fixtures | df1/harness-03-provider-fixtures | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-03 provider fixtures |
| df1-harness-04-session-corpus | df1/harness-04-session-corpus | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-04 session corpus |
| df1-harness-05-raw-clients | df1/harness-05-raw-clients | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-05 raw clients |
| df1-harness-06-misc-fixtures | df1/harness-06-misc-fixtures | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-06 misc fixtures |
| df1-harness-11-a11y-gate | df1/harness-11-a11y-gate | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 harness-11 a11y gate |
| df1-session-05-project-colors | df1/session-05-project-colors | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 session-05 project colors |
| df1-session-16-malformed-data | df1/session-16-malformed-data | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 session-16 malformed data |
| df1-term-04-dedupe-create | df1/term-04-dedupe-create | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 term-04 dedupe create |
| df1-auto-01-layout-sync-auth | df1/auto-01-layout-sync-auth | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 auto-01 layout sync auth |
| df1-browser-01-same-origin-proxy | df1/browser-01-same-origin-proxy | 2026-08-09 | YES | merged | 0 | 0 | no | merged: df1 browser-01 same-origin proxy |
| fix-rust-specs-0q8k | the-usual/fix-rust-specs-0q8k | 2026-08-08 | NO | in-main* (all 9 spec registrations present in main's RUST_ONLY_SPECS) | 1 | 1 | no | register 9 rust-only e2e specs |
| playwright-azure-cloud | feat/playwright-azure-cloud | 2026-08-08 | NO | distinct (1 commit, 4 files; rival Azure backend) | 1 | 4 | yes | Azure Playwright cloud testing switch |
| df1-arb | DETACHED | 2026-08-08 | YES | merged (detached) | 0 | 0 | no | merged: df1 arbitration checkpoint |
| pbh2-ro | DETACHED | 2026-08-08 | YES | merged (detached) | 0 | 0 | no | merged: pbh2 read-only checkpoint |
| multirow-last-row-width | fix/multirow-last-row-width | 2026-08-07 | YES | merged | 0 | 0 | no | merged: multirow last-row width fix |
| tab-bar-multirow-sizing | feat/tab-bar-multirow-sizing | 2026-08-07 | YES | merged | 0 | 0 | no | merged: tab bar multirow sizing |
| attention-bell-wrong-signals | fix/attention-bell-wrong-signals | 2026-08-06 | NO | distinct (28 commits; 5 of 17 footprint files differ — partially landed?) | 28 | 5 | yes | attention bell signal fixes (8x PR refs) |
| parity-campaign | parity-campaign-20260805 | 2026-08-06 | NO | distinct (67 files; QA/parity campaign docs+fixes) | 45 | 67 | yes | parity campaign QA system + learnings |
| qa-campaign | qa-campaign-20260806 | 2026-08-06 | NO | distinct (69 files; closed-loop fix campaign) | 57 | 69 | yes | QA closed-loop fix campaign (7/8 landed) |
| remote-access-networking | feat/remote-access-networking | 2026-08-06 | YES | merged | 0 | 0 | no | merged: remote access networking |
| windows-path-files | fix/windows-path-files | 2026-08-04 | YES | merged | 0 | 0 | no | merged: windows path files fix |
| resilience-sprint | feat/resilience-sprint | 2026-08-01 | NO | in-main* (main inlined detached-session.sh with richer comments; only .resilience/ litter dirty) | 1 | 3 | no | rust launcher detached session (setsid) |
| electron-latest | build/electron-latest | 2026-08-01 | YES | merged | 0 | 0 | no | merged: electron latest build |
| deploy-compatibility-rollback | feat/deploy-compatibility-rollback | 2026-07-31 | NO | distinct (72 commits, 81 files) | 72 | 81 | yes | deploy compatibility + rollback system |
| restart-resumable-pane | feat/restart-resumable-pane | 2026-07-31 | NO | distinct (38 commits, 113 files) | 38 | 113 | yes | restart-resumable pane recovery series |
| rest-codex-terminal-identity | fix/rest-terminal-identity-publication | 2026-07-30 | NO | plan-only (handoff + plan docs; feature landed via PR #584) | 6 | 2 | no | unified terminal identity plan docs |
| restart-recovery-hardening | feat/restart-recovery-hardening | 2026-07-29 | NO | distinct + 18 dirty files (3373 uncommitted insertions incl. new codex_exact.rs) | 13 | 73 | yes | scoped recovery hardening + huge uncommitted work |
| resume-button | feat/resume-button | 2026-07-29 | NO | distinct (28/32 footprint files differ — partially landed?) | 16 | 32 | yes | always-visible resume button + resolve API |
| tab-bar-visual-overhaul | feat/tab-bar-visual-overhaul | 2026-07-29 | NO | distinct (15 commits, 23 files) | 15 | 23 | yes | tab bar fixed widths + canonical states |

Legend: `in-main*` = branch not an ancestor of main, but its footprint content is present in main (squash-merge or re-landed), possibly with post-merge evolution; verified by reading the residual diff. `plan-only` = branch commits touch only docs/plans/handoffs.
