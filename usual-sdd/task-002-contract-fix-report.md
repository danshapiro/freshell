# Task 2 contract-fix receipt

## Scope completed

- Centralized the Node CLI and MCP Rust-server capability contract in `tools/node-client-runtime/action-capabilities.ts`.  The checked matrix contains 33 canonical actions and 14 aliases, rejects duplicate/unclassified entries, and is the source for MCP action discovery, help, and parameter validation.
- Rejected Rust-unsupported CLI/MCP invocations before target resolution or HTTP client construction: `run`, `fresh-send`, `attach`, non-OpenCode `new-tab` agents, every fresh-agent `split-pane` option, and invalid `wait-for` conditions.  The CLI now emits JSONL stderr diagnostics (`severity`, `event`, `message`) while keeping command output on stdout.
- Made WSL path conversion fail closed for executable and path-valued arguments and config selectors.  Spawn errors, non-zero exits, timeout, and empty output now surface as injection failures.
- Aligned the Rust MCP bridge receipt with actual Rust list-panes output and made the MCP QA receipt use the documented dual-role Codex fixture/baseline.

## Verification receipts

- `npm run test:vitest -- run test/unit/cli/action-capabilities.test.ts test/unit/mcp/freshell-tool.test.ts --config config/vitest/vitest.config.ts` — 145 passed.
- `npm run test:vitest -- run test/unit/server/mcp/config-writer.test.ts test/unit/server/mcp/config-writer-paths.test.ts --config config/vitest/vitest.server.config.ts` — 65 passed.
- `npm run typecheck:tools && npm run build:tools` — passed.
- `cargo test -p freshell-platform --locked mcp_inject` — 18 passed.
- `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/cli-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts` — 3 passed (31.1s) on owned test ports.

No port 3001 process was contacted, restarted, or health-checked.
