# Task 10 Review Package — Delete the Legacy Node Backend

Implementation commit under review: `df30b4dd2` (`refactor: delete legacy Node application server`).

Governing brief: `usual-sdd/task-010-brief.md`.
Implementation report: `usual-sdd/task-010-report.md`.

Review the committed diff against its parent for requirements coverage and
regressions. Verify in particular:

- `server/` and every specified Node server test, repair, PTY-proof, and oracle
  path are truly gone, without deleting retained Rust/Electron/shared/CLI/MCP/
  Claude-sidecar behavior or fixtures.
- Root direct dependencies and lockfile no longer own the forbidden Node
  backend set, while required standalone packages remain; package/config/build
  paths do not still compile, import, or launch the deleted server.
- The 346-path / 348-subject disposition ledger is complete and meaningful:
  retained shared subjects are genuinely re-homed; selectors have positive
  receipts; optional T2 rows cannot satisfy required coverage; verifier and
  synthetic tests reject unknown, duplicate, stale, unresolved, zero-selector,
  skipped-required, or vacuous rows.
- Runtime and fresh-agent guards scan existing roots correctly and report
  `manifestDrift=[]`, `legacyDebt=[]`, and `unexpectedNodeBackend=[]`, while
  allowing only the manifest-listed coordinator/fixture/probe listeners.
- Review the implementer's claimed focused, build, Rust transport, and broad
  test receipts. Distinguish pre-existing/unrelated failures from regressions,
  and run targeted checks needed to confirm any concern.

Do not contact, stop, restart, or health-check the live server on port 3001.
Do not edit historical reports/plans solely to remove Node references. Return a
severity-ranked findings report. If findings exist, identify exact files/lines
and required fixes; if none, state PASS/PASS explicitly.
