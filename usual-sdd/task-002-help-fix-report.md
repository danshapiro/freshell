# Task 2 CLI help fix report

## Scope

- Added the standalone `freshell help` command. It renders stdout-only help from
  `ACTION_CAPABILITIES`, including every supported action's aliases and
  required/optional parameters.
- The renderer filters to supported capabilities, so `run`, `fresh-send`,
  `attach`, fresh-agent split parameters, and unsupported `wait-for` variants
  are not advertised. Rust-supported `capture-pane --J` and `--e` remain
  listed.
- Added a process-level CLI regression test covering successful help output,
  empty stderr, matrix-derived supported surface, and absent unsupported
  actions/variants.

## TDD and verification

- RED: `npm run test:vitest -- run test/unit/cli/action-capabilities.test.ts --config config/vitest/vitest.config.ts` failed as expected because `help` exited 1.
- GREEN: `npm run test:vitest -- run test/unit/cli/action-capabilities.test.ts test/unit/mcp/freshell-tool.test.ts --config config/vitest/vitest.config.ts` — 146 passed.
- `npm run typecheck:tools` — passed.
- `npm run build:tools` — passed.
- `NODE_NO_WARNINGS=1 node dist/tools/freshell-cli/index.js help` — exited 0 with empty stderr; an explicit scan confirmed no unsupported action rows or `--stable`/`--exit` variants in its output.

No Task 3 files were changed. No port 3001 process was contacted, restarted, or health-checked.
