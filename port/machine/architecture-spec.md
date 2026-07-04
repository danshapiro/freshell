# Target architecture spec (DRAFT — frozen in Phase 2 by systems-design)

Status: DRAFT. This is the seed the `systems-design` pass refines into the
frozen ADR. Decisions here are the committed defaults; the ADR may adjust with
recorded tradeoffs but may not change the WS wire contract.

## Shape

```
Tauri shell (Rust)  ──spawns/embeds──►  freshell-server (Rust binary)
   │  webview                                 │
   └─ React/TS SPA (UNCHANGED) ──WS/HTTP──────┘
                                              └─ headless mode: same binary,
                                                 reachable by browser/phone
```

- One Cargo workspace. The server is a standalone binary so the
  headless/daemon/phone-reachable mode is preserved exactly.
- Frontend retained verbatim; only `electron/preload.ts` IPC → Tauri commands.

## Crate decomposition (maps freshell `server/` → Rust)

| freshell (TS) | Rust crate | Key dep | Risk |
|---------------|-----------|---------|------|
| `ws-handler.ts` + `shared/ws-protocol.ts` | `freshell-protocol` (generated types) + `freshell-ws` | `tokio-tungstenite` | contract fidelity — FROZEN |
| `terminal-registry.ts` (4,933 lines), `terminal-stream/` | `freshell-terminal` | `portable-pty` (wezterm) | **highest** — PTY byte fidelity, scrollback ring buffer, detach/attach |
| REST `/api/*` routers | `freshell-api` | `axum` | medium |
| `coding-cli/`, `fresh-agent/`, codex app-server, `.jsonl`/db parsers | `freshell-harness` | `serde`, `rusqlite`, gRPC/JSON-RPC | **highest** — provider-specific, least-documented, most behavior-sensitive |
| AI SDK / Anthropic / MCP layer | `freshell-llm` | bkrabach `unified-llm` (Rust) | medium |
| network-manager, wsl-port-forward, firewall, elevated-powershell | `freshell-platform` | OS-specific | high — single-host QA limit (WSL2) |
| electron main (tray, hotkey, updater, window-state, single-instance, wizard, launch-chooser) | Tauri app + plugins | `tauri-plugin-*` | medium |

## Frozen interface

`shared/ws-protocol.ts` → language-neutral schema → generated Rust types +
generated (or retained) TS types. Single source of truth for both sides and the
oracle. `WS_PROTOCOL_VERSION` is asserted equal by T0.

## Order of the port (Phase 3)

1. `freshell-protocol` (freeze + codegen) — unblocks the oracle's external-process harness.
2. `freshell-terminal` — the terminal-app core; gate hard on T1 PTY golden bytes.
3. `freshell-api` + `freshell-ws` — bring T0 to green against the port.
4. `freshell-harness` — provider integrations; gate on T2 live-invariant matrix.
5. `freshell-llm`, `freshell-platform`, Tauri shell — remaining surface + T3.

## Open questions for systems-design (Phase 2)

- In-process vs sidecar for the server relative to the Tauri core (default:
  spawned binary, mirrors current Electron→Node design).
- gRPC vs JSON-RPC vs direct for the codex app-server equivalent.
- How much of `WsHandler` DI wiring assumes in-process construction.
- Per-platform PTY behavior parity budget (WSL/PowerShell) under single-host QA.
