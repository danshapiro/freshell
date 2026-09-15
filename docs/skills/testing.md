# Testing Skill for Claude Code Session Organizer

> **Quick Start:** Run `npm run test:status` first if you need to see whether a broad repo-supported test run is already active.

## Test Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck:client` | Cheap client-only compile gate; safe while prod is live |
| `npm test` | Coordinated full suite: client Vitest, Rust source-runtime smoke, Cargo tests, and Electron tests |
| `npm run test:all` | Alias for the same coordinated full suite |
| `npm run check` | Typecheck, then the coordinated full suite |
| `npm run verify` | Run `build`, then the coordinated full suite |
| `npm run test:unit` | Exact default-config `test/unit` workload |
| `npm run test:client` | Exact default-config `test/unit/client` workload |
| `npm run test:integration` | Exact Rust workspace integration-test workload |
| `npm run test:server` | Cargo-backed Rust `freshell-server` tests; only coordinates explicit broad `--run` |
| `npm run test:coverage` | Exact default-config `vitest run --coverage` workload |
| `npm run test:status` | Show the current holder, in-flight ungated cloud phases, latest results, and any matching advisory baseline |
| `npm run test:vitest -- ...` | Repo-owned direct Vitest path for focused passthrough work |

## Coordination Rules

- Broad repo-supported runs wait instead of failing fast when another coordinated run is active.
- The gate covers local work only. With `FRESHELL_VITEST_BACKEND=cloud`, the full-suite commands (`npm test`, `test:all`, `check`, `verify`) start the cloud client Vitest phase right away, outside the gate, and take the gate only for typecheck/build, source-runtime, Rust, and Electron. Cloud output is prefixed `[cloud client]`, and `test:status` lists it as an `ungated-run`.
- The run passes only if every phase passes. The first failure on either side stops the other; a gate-wait timeout exits 124, and Ctrl-C/SIGTERM exits 128+signal after stopping every phase's processes.
- Because the cloud phase uploads the worktree while local phases build, local phases may write only paths that git ignores and Cloud Build does not upload (`dist/`, `target/`, `node_modules/`, `test-results/`).
- `test:unit` is the exact default-config `test/unit` workload.
- `test:integration` runs the Rust workspace integration tests.
- `test:server` runs the Cargo-backed Rust `freshell-server` crate. Zero-argument and explicit broad `--run` invocations are coordinated; narrowed Cargo selectors are delegated.
- prior successful baselines are advisory only. They never short-circuit an explicitly requested run.
- use `npm run test:vitest -- ...` if you need a repo-owned direct Vitest escape hatch. Raw `npx vitest` is not a supported coordinated path.

## Practical Workflow

1. Run `npm run test:status` if you need to know whether another agent is already holding the coordinated gate.
2. Set `FRESHELL_TEST_SUMMARY="why this run matters"` before broad runs so holder/status output is readable.
3. Use `npm run typecheck:client` when you only need the cheap frontend compile gate.
4. Use the narrowest truthful public command you can.
5. If another holder is active, wait rather than killing a foreign process.

When production is live from the main checkout, the prebuild guard fails closed
before any artifact writes for `npm test` (through its source-runtime phase),
`npm run check`, `npm run test:source-runtime`, `npm run build`, and
`npm run verify`. Use `npm run typecheck:client` for a no-write check, or run
source-runtime/build verification from a linked worktree such as
`.worktrees/<branch>`. `npm run dev` and `npm run dev:server` create a secure
first-run `.env` token and install the locked Claude sidecar before starting
the Rust server.

## Focused Examples

```bash
npm run typecheck:client
FRESHELL_TEST_SUMMARY="Verify coordinated full suite" npm test
npm run test:server -- --help
npm run test:server -- --run
npm run test:unit -- test/unit/client/store/tabsPersistence.test.ts
npm run test:vitest -- run test/unit/tooling/run-standard-tests.test.ts --config config/vitest/vitest.config.ts
npm run test:source-runtime -- test/integration/tooling/source-runtime-rust.test.ts
```
