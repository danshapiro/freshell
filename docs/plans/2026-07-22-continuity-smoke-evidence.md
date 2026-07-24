# Continuity smoke — regression-catch evidence (2026-07-22)

Proof that `npm run smoke:continuity` catches the identity-loss category:
run against `136b9e94~1` (real historical bug: codex terminal creates
ignored sessionRef) the codex leg FAILS; at HEAD
(`ae43d730845f03208d67740647d7e81f5dad3d89`) it PASSES.

## Probe findings (Task 6)
- codex resume offline render: RENDERS (grep count 2; needs event_msg records + full session_meta,
  trust config.toml entry, one Enter at the resume-cwd picker); auth file needed: YES (~/.codex/auth.json, read-only copy)
- amplifier resume offline render: RENDERS (grep count 2; real layout projects/<cwd `/`→`-`>/sessions/<uuid>/
  {metadata.json,transcript.jsonl}); downgrade applied: none
- claude --resume offline render: RENDERS (grep count 2; project dir munges BOTH `/` and `.` to `-`;
  user content as string; .claude.json onboarding+trust bypass; ANTHROPIC_API_KEY must be absent);
  downgrade applied: none; auth file needed: NO
- codex leg discriminator: BEHAVIORAL (MARKER render + Redux same-session), NEVER
  the `resume_applied` log field — so the pre-fix failure isolates the resume
  regression from `136b9e94`'s concurrent `terminal.created` logging change.

## FAIL @ 136b9e94~1 (binary override), exit=1
Historical binary (from `/tmp/smoke-pre-fix.binid`):
`/tmp/freshell-pre-136b9e94/target/release/freshell-server` built from
`49e85d3ff989dbacfcccb4c503068b0003d29db4` (= `136b9e94~1`), sha256
`649d601ede2e16f2d7fb80401a264c7b249c90eb9cb6336e8048ea1527c3d9ba` — the
harness confirmed it in-run:
`[rust-server] using FRESHELL_E2E_RUST_SERVER_BIN=/tmp/freshell-pre-136b9e94/target/release/freshell-server sha256=649d601ede2e`.

Built in a detached throwaway worktree (`git worktree add --detach
/tmp/freshell-pre-136b9e94 136b9e94~1` + `cargo build --release -p
freshell-server`), removed after the runs.

Machine-checked failed assertion (from the Playwright JSON report,
`/tmp/smoke-pre-fix.json`): the ONLY error in the report is the codex leg's
BEHAVIORAL MARKER-render failure —
`Error: codex history never rendered (picker never settled?): terminal 052d3dfd9bbf47c29a4bf2f14db00a2b`
— thrown by `settleCodexResumePicker` (continuity-smoke.spec.ts:342), the
60s poll of the server-side scrollback mirror
(`GET /api/terminals/{id}/search`) for the seeded codex MARKER. Controls
(amplifier/claude) and infra (`waitForConnection`/`getWsReadyState`/
`ECONNREFUSED`/launch errors) were machine-checked NOT present among the
failed assertions.

Note vs the plan's expected message: the codex leg fails at the
MARKER-render poll in `settleCodexResumePicker` (which gates on the SAME
scrollback-mirror search as the formal
`initial open: codex MARKER rendered by real CLI` expect) BEFORE the formal
`expectContinuity` assertions are reached — with the pre-fix binary the
codex arm ignores `sessionRef`, spawns plain `codex` (no resume), so
neither the resume-cwd picker nor the seeded MARKER ever renders and the
poll times out. Same behavioral discriminator (MARKER render via
server-side search; never the `resume_applied` log field), earlier
failure point. The controls confirm this is the resume regression, not an
old-binary capability gap: the codex tab was created via the sidebar click
and the amplifier/claude tabs via `POST /api/tabs` all succeeded (visible
in the failure screenshot's tab bar), and no control-leg assertion failed.

```text
Running 1 test using 1 worker

[rust-server] using FRESHELL_E2E_RUST_SERVER_BIN=/tmp/freshell-pre-136b9e94/target/release/freshell-server sha256=649d601ede2e

  1) [continuity-smoke] › test/e2e-browser/specs/continuity-smoke.spec.ts:123:3 › continuity smoke (REAL CLIs) -- pre-deploy gate › three real panes survive server restart + page reload with the same sessions

    Error: codex history never rendered (picker never settled?): terminal 052d3dfd9bbf47c29a4bf2f14db00a2b

      340 |           await page.waitForTimeout(1_000)
      341 |         }
    > 342 |         throw new Error(`codex history never rendered (picker never settled?): ${lastSeen}`)
          |               ^
      343 |       }
        at settleCodexResumePicker (.../test/e2e-browser/specs/continuity-smoke.spec.ts:342:15)
        at .../test/e2e-browser/specs/continuity-smoke.spec.ts:406:7

[e2e-teardown] E2E test suite complete.
  1 failed
    [continuity-smoke] › test/e2e-browser/specs/continuity-smoke.spec.ts:123:3 › continuity smoke (REAL CLIs) -- pre-deploy gate › three real panes survive server restart + page reload with the same sessions
```

Playwright JSON report stats: `"expected": 0, "unexpected": 1` (duration
79.1s). Reproduced twice (two independent override runs failed on the same
codex assertion; the second run's exit code was captured directly as `1` —
the plan's `code=${PIPESTATUS[0]}` after `|| true` clobbers PIPESTATUS, so
the capture was corrected to a plain `$?` with no pipe).

## PASS @ HEAD, exit=0, wall clock 0m43.173s
Same command (`npm run smoke:continuity`), override unset (harness builds
HEAD's `freshell-server` itself). All three legs — including the two
disruptions (server restart without reload; page reload) — passed.

```text
warning: `freshell-server` (bin "freshell-server") generated 3 warnings
    Finished `release` profile [optimized] target(s) in 8.50s
[e2e-teardown] E2E test suite complete.
  1 passed (42.1s)
```
