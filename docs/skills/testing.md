# Testing Skill for Claude Code Session Organizer

> **Quick Start:** Run `npm run test:status` first if you need to see whether a broad repo-supported test run is already active.

## Test Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck:client` | Cheap client-only compile gate; safe while prod is live |
| `npm test` | Coordinated full suite (`vitest run` plus `vitest run --config vitest.server.config.ts`) |
| `npm run test:all` | Alias for the same coordinated full suite |
| `npm run check` | Run `typecheck`, then the coordinated full suite |
| `npm run verify` | Run `build`, then the coordinated full suite |
| `npm run test:unit` | Exact default-config `test/unit` workload |
| `npm run test:client` | Exact default-config `test/unit/client` workload |
| `npm run test:integration` | Exact server-config `test/server` workload |
| `npm run test:server` | Watch-capable server Vitest command; only coordinates explicit broad `--run` |
| `npm run test:coverage` | Exact default-config `vitest run --coverage` workload |
| `npm run test:status` | Show the current holder, latest results, and any matching advisory baseline |
| `npm run test:vitest -- ...` | Repo-owned direct Vitest path for focused passthrough work |

## Coordination Rules

- Broad repo-supported runs wait instead of failing fast when another coordinated run is active.
- `test:unit` is the exact default-config `test/unit` workload.
- `test:integration` is the exact server-config `test/server` workload.
- `test:server` stays watch-capable by default and only coordinates explicit broad `--run`.
- prior successful baselines are advisory only. They never short-circuit an explicitly requested run.
- use `npm run test:vitest -- ...` if you need a repo-owned direct Vitest escape hatch. Raw `npx vitest` is not a supported coordinated path.

## Practical Workflow

1. Run `npm run test:status` if you need to know whether another agent is already holding the coordinated gate.
2. Set `FRESHELL_TEST_SUMMARY="why this run matters"` before broad runs so holder/status output is readable.
3. Use `npm run typecheck:client` when you only need the cheap frontend compile gate.
4. Use the narrowest truthful public command you can.
5. If another holder is active, wait rather than killing a foreign process.

## Focused Examples

```bash
npm run typecheck:client
FRESHELL_TEST_SUMMARY="Verify coordinated full suite" npm test
npm run test:server -- --help
npm run test:server -- --run
npm run test:unit -- test/unit/server/coding-cli/utils.test.ts
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-protocol.test.ts
```
