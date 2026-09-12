# Final Full-Suite Gate Fix Package

Current implementation head: `69daee80c54a4e8ddd39dd6c39c012c343a33c15`.
Worktree: `/home/dan/code/freshell/.worktrees/retire-node-server-v2`.
User request: retire the Node application server so Rust is the forward path;
Node-only server features absent from Rust are triaged and important,
untracked ones are filed as Katas; redundant generic security findings are not
added.

## Recorded gate failures

Exact command:

```bash
FRESHELL_TEST_SUMMARY='retire Node server: final Rust-only proof' npm test
```

At `69daee80c`, this produced 474 test files with 471 passing and 3 failing,
5 failures among 5,609 tests:

1. `test/e2e/refresh-context-menu-flow.test.tsx` — the first test expected one
   `/api/proxy/forward` POST during remote-loopback BrowserPane rendering, but
   received zero. Task 3 commit `a97dc0a3d` intentionally removed that
   Node-only TCP-forwarding request and renders Rust's explicit unavailable
   state instead. The test file is unchanged from base and is stale; update
   its assertions/comment to verify the Rust-baseline unavailable message,
   cleared zoom, and zero forwarding POST rather than restoring the removed
   endpoint. Keep the other two refresh tests intact.
2. `test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx` — two
   tests expected `onSend('hello', [])`, but Task 3 commit `a97dc0a3d` changed
   the retained composer contract to `onSend(value)` when attachments were
   removed. The test file is unchanged from base; update both expectations to
   the current one-argument contract. Do not reintroduce attachment behavior or
   weaken the mobile keyboard assertions.
3. The two `test/unit/lib/visible-first-audit-gate.test.ts` stderr-warning
   failures reproduce at the base commit (`6baeb3e2...`) because the child
   process emits Node `UNDICI-EHPA` warnings. Treat them as ledger-recorded
   pre-existing failures; do not change them in this fixer.

Base receipt: `/tmp/freshell-base-ref-test-327700.log`. It also has three
obsolete update-flow warning failures and one FreshAgentView timing failure;
those are not current failures and are not to be changed here.

## Required workflow

- Follow systematic-debugging evidence above and TDD. Make only the two stale
  test-contract updates; do not alter production behavior, runtime guard,
  documentation, or `.kata.toml`.
- Run each focused failing test first/after the minimal change, then the
  relevant combined Vitest selection. Use `npm run test:vitest -- ...`, not raw
  `npx vitest`.
- Commit one focused fix, e.g. `test: align stale client expectations with Rust baseline`,
  and write `usual-sdd/final-gate-fix-report.md` with exact commands/results.
- Never contact, stop, restart, or health-check port 3001. Do not edit the
  progress ledger or review files.
