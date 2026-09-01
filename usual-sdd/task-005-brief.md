# Task 5 Execution Brief — Retire Dead Contracts and Rebase Active Port Oracles on Rust

Governing plan section: `### Task 5: Retire Dead Contracts and Rebase Active Port Oracles on Rust` in
`/home/dan/code/freshell/.worktrees/retire-node-server-v2/docs/plans/2026-08-26-retire-node-server-v2.md`.

Required outcome:

- Remove the obsolete `codingcli.create/input/kill` and
  `codingcli.created/event/exit/stderr/killed` protocol family from the
  TypeScript/Rust schemas, handlers, inventories, generated schemas, and
  round-trip tests.
- Remove caller-free client viewport/paged-scrollback and paged fresh-agent
  helpers/thunks, plus their tests and the three visible-first harnesses that
  only exercise retired Node routes/replay behavior.
- Rebase active port oracles on owned Rust startup and committed Rust fixtures:
  no Node target, warm proxy, Node build/spawn/copy path, original-side live
  T2 JSON comparison, port-3001 listener inspection, or temporary oracle-local
  Node constructor. Preserve frozen historical fixtures and mutation/nonempty
  capture tests.
- Keep always-running fake/provider-shape Rust checks; keep real-provider T2
  contracts explicitly opt-in, Rust-owned, isolated, positive-event bounded,
  and exact-child-cleaned. Rename the three T2 files to Rust-baseline names,
  delete the obsolete original-side T2 files/config and `test:oracle:t2`.
- Delete Node manifest/batch/handshake/PTY generators and their active
  regeneration claims while retaining their committed outputs as frozen
  provenance. Add an always-running Rust-only oracle boundary test.

Required commands:

1. RED:
   `npm run test:vitest -- run test/unit/client/lib/api.test.ts --config config/vitest/vitest.config.ts`
   `npm run test:vitest -- run test/unit/visible-first/acceptance-contract.test.ts --config config/vitest/vitest.config.ts`
   `npm run test:visible-first:contract`
   `npm run test:vitest -- run test/unit/port --config config/vitest/vitest.port.config.ts`
   `cargo test -p freshell-protocol -p freshell-ws -p freshell-terminal -p freshell-extensions --locked`
   `env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle`
2. GREEN: rerun the same commands after implementation; the visible-first lane
   must execute the two retained acceptance/report tests, schemas must be
   current, and the oracle boundary must reject Node-only paths.
3. Impacted: run every forbidden-pattern scan in Task 5 Step 6, verify
   `npm run contract:generate` is hash-stable, rerun focused client/visible-first/
   port tests, and run the Rust crate tests plus the configured oracle lane.

Execution rules:

- Follow red-green-refactor TDD and keep changes on the current branch.
- Do not contact, stop, restart, or health-check port 3001 or any live server.
- Do not modify historical reports/baselines solely because they mention the
  retired Node implementation.
- Write the implementer report to
  `/home/dan/code/freshell/.worktrees/retire-node-server-v2/usual-sdd/task-005-report.md`.
