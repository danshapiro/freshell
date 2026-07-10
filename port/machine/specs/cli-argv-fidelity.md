# Spec: CLI argv/env fidelity for coding-CLI terminal launches

**Status:** implementation-ready — **rev 2** (2026-07-10), corrected per adversarial
review. Changes from rev 1: (1) G-C1 relabeled — the live path **always** preallocates
a fresh-claude `--session-id` (`ws-handler.ts:2048-2064`), so the no-session-args
launch is resolver-level only; (2) G-W1 corrected — on a **native-Windows host** the
MCP paths embedded in WSL-branch CLI args are host-native **Windows-form**, not
Linux-form; (3) former U5 (cmd.exe flattening of the claude `--settings` JSON)
reclassified from UNCERTAIN to **BLOCKER B1** — cmd.exe is the *default* shell for
native-Windows CLI launches (`terminal-registry.ts:949-953`); (4) former U4 corrected —
the settings store **does** enforce enums for `sandbox`/`permissionMode`
(`shared/settings.ts:659-669`); (5) added the omitted `gemini`/`kimi` branches of
`generateMcpInjection` (§2.4) — gemini is the **only env-returning branch**;
(6) U3 closed by executed extraction of the bell strings (byte-identical to rev 1's
derivation); (7) dev-mode tsx path corrected to `dist/loader.mjs`.
**Scope:** `claude`, `codex`, `opencode` terminal launches (`terminal.create { mode }`).
**Out of scope:** `gemini`, `kimi` (documented only where their code shares a path),
fresh-agent / SDK launches, the Codex app-server sidecar lifecycle itself
(covered by `port/machine/specs/coding-cli.md`).

Closes the flagged gap in
`crates/freshell-platform/src/spawn.rs:103-111` ("REDUCED FIDELITY"): the Rust port
launches coding CLIs with the **base command only**; the original Node server layers
MCP injection, turn-complete notification args, the OpenCode loopback control
endpoint, resume/model/sandbox/permission args, provider env overrides, and the
full `FRESHELL_*` base env.

All reference citations are against the read-only TypeScript in this worktree:
`server/terminal-registry.ts` (registry + `buildSpawnSpec` + `resolveCodingCliCommand`),
`server/mcp/config-writer.ts` (`generateMcpInjection`), `server/ws-handler.ts`
(`terminal.create` provider-settings assembly), `server/opencode-launch.ts`,
`server/local-port.ts`, `server/coding-cli/codex-managed-config.ts`, and the
extension manifests in `extensions/*/freshell.json`.

---

## 1. Reference argv assembly — the single ordering law

`resolveCodingCliCommand` (`server/terminal-registry.ts:274-375`) returns:

```
args: [...remoteArgs, ...providerArgs, ...baseArgs, ...settingsArgs, ...resumeArgs]
env:  { ...spec.env, ...notification.env, [opencode overrides], [permission env] }
```
(`terminal-registry.ts:369-374`)

Where:

| Segment | Built by | Contents |
|---|---|---|
| `remoteArgs` | `terminal-registry.ts:291-307` | codex-only: `--remote <wsUrl>` + `CODEX_MANAGED_REMOTE_CONFIG_ARGS` |
| `providerArgs` | `providerNotificationArgs` (`terminal-registry.ts:201-241`) | turn-complete notification args + `generateMcpInjection(...).args` |
| `baseArgs` | `spec.args \|\| []` (`terminal-registry.ts:289`) | from the extension manifest `cli.args`; **empty** for claude/codex/opencode (`extensions/*/freshell.json` have no `args` key) |
| `settingsArgs` | `terminal-registry.ts:321-368` | opencode `--hostname/--port`, then model, then sandbox, then permission-mode |
| `resumeArgs` | `terminal-registry.ts:308-320` | `resumeArgs(sessionId)` or `createSessionArgs(sessionId)` |

`command = (process.env[spec.envVar] || spec.defaultCommand)` (`terminal-registry.ts:286`).
`envVar` is `CLAUDE_CMD` / `CODEX_CMD` / `OPENCODE_CMD`
(`extensions/claude-code/freshell.json:9`, `extensions/codex-cli/freshell.json:9`,
`extensions/opencode/freshell.json:9`; fallback seed `terminal-registry.ts:92-126`).
The Rust port already implements this base slice
(`crates/freshell-platform/src/spawn.rs:112-132`).

### 1.1 Inputs to `resolveCodingCliCommand` and where they come from

Called from `buildSpawnSpec` at three sites, with `target` (`'unix' | 'windows'`)
and the **MCP cwd** varying by platform branch:

- WSL-from-native-Windows branch: `resolveCodingCliCommand(mode, resume, 'unix', providerSettings, terminalId, wslMcpCwd, launchIntent)` — `terminal-registry.ts:1165`; args appended after `wsl.exe [-d distro] [--cd <linux cwd>] --exec` (`:1171`).
- Native `cmd` branch: `(..., 'windows', ..., cmdMcpCwd, ...)` — `terminal-registry.ts:1204`; the whole CLI invocation is flattened into ONE string via `buildCmdCommand` (`:1046-1048`, `quoteCmdArg` `:1014-1044`) and passed as `['/K', `${cd}${command}`]` (`:1206-1208`).
- Native `powershell` branch: `(..., 'windows', ..., psMcpCwd, ...)` — `terminal-registry.ts:1237`; flattened via `buildPowerShellCommand` (`:1054-1057`, `quotePowerShellLiteral` `:1050-1052`) into `['-NoLogo','-NoExit','-Command', `${cd}${invocation}`]` (`:1239-1244`).
- Non-Windows tail: `(..., 'unix', ..., unixCwd, ...)` — `terminal-registry.ts:1262`; argv is passed **verbatim** (`{ file: cmd, args, ... }`, `:1263-1265`).

`launchIntent` is `'start'` only for `mode === 'claude' && sessionBindingReason === 'start'`,
else `'resume'` (`terminal-registry.ts:1570-1571`).
`resumeSessionId` is normalized by `normalizeResumeForSpawn` (identity for any
non-empty string, `terminal-registry.ts:382-385`).

`providerSettings` is assembled by `ws-handler.ts` `terminal.create`:
- Loaded from settings: `cfg.settings?.codingCli?.providers?.[mode] || {}` (`ws-handler.ts:2317-2319`; shape `{ model?, sandbox?, permissionMode?, maxTurns?, cwd? }`, `shared/settings.ts:1084`).
- `spawnProviderSettings` (`ws-handler.ts:2461-2493`):
  - **codex**: `permissionMode`/`model`/`sandbox` are **excluded** (`:2464-2465`) — they are routed into the app-server launch plan instead (`planCodexLaunch`, `ws-handler.ts:937-943`); only `codexAppServer: { wsUrl, sidecar, recovery, deferLifecycleUntilPublished: true }` is passed (`:2474-2481`).
  - **claude/opencode**: `permissionMode`, `model`, `sandbox` pass through (`:2466-2470`).
  - **opencode**: plus `opencodeServer: await allocateLocalhostPort()` (`:2471-2473`; `server/local-port.ts:13-41` returns `{ hostname: '127.0.0.1', port }`).

### 1.2 Env assembly (`buildSpawnSpec`, `terminal-registry.ts:1076-1105`)

- Strip from the parent env: `CLAUDECODE, CI, NO_COLOR, FORCE_COLOR, COLOR, PORT, AUTH_TOKEN, ALLOWED_ORIGINS, NODE_ENV, npm_lifecycle_script, OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_PASSWORD` (`:1083-1097`). Already ported: `spawn.rs:165-178` (`STRIP_ENV`).
- Force: `TERM` (fallback `xterm-256color`), `COLORTERM` (fallback `truecolor`), `LANG='en_US.UTF-8'`, `LC_ALL='en_US.UTF-8'` (`:1098-1103`). Already ported: `spawn.rs:759-769`.
- `envOverrides` = `buildTerminalBaseEnv` (`terminal-registry.ts:1529-1542`, applied at `:1569,1579`):
  - `FRESHELL: '1'`
  - `FRESHELL_URL: process.env.FRESHELL_URL || 'http://localhost:<PORT||3001>'`
  - `FRESHELL_TOKEN: process.env.AUTH_TOKEN || ''`
  - `FRESHELL_TERMINAL_ID: <terminalId>`
  - `FRESHELL_TAB_ID` / `FRESHELL_PANE_ID` when `envContext.tabId/paneId` present.
  - **Rust gap:** only `FRESHELL_TERMINAL_ID` is set today (`crates/freshell-ws/src/terminal.rs:312-315`).
- CLI env layered last: `{ ...env, ...cli.env }` (`:1172,1208,1247,1265`). Already ported as a merge point (`spawn.rs:514-517,563-566`).

---

## 2. Per-CLI inventory (every arg + env var the original adds)

### 2.1 `claude`

Order: `[providerArgs..., settingsArgs..., resumeArgs...]` (no remoteArgs, no baseArgs).

1. **Turn-complete notification hook — `--settings <json>`**
   `terminal-registry.ts:216-238`. Always added for `mode === 'claude'` (unconditional).
   `args[0..2] = ['--settings', JSON.stringify(settings)]` where `settings` is
   ```json
   {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"<bellCommand>"}]}]}}
   ```
   `JSON.stringify` is **compact** (no spaces/newlines). `bellCommand` by `target`:
   - `target === 'unix'` (`:219`), runtime string exactly:
     ```
     sh -lc "printf '\a' > /dev/tty 2>/dev/null || true"
     ```
     (source has `printf '\\a'`; template-literal unescape yields a literal
     backslash-`a`, i.e. `\a`, which `printf` renders as BEL).
   - `target === 'windows'` (`:218`), runtime string exactly (one line):
     ```
     powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$bell=[char]7; $ok=$false; try {[System.IO.File]::AppendAllText('\\.\CONOUT$', [string]$bell); $ok=$true} catch {}; if (-not $ok) { try {[Console]::Out.Write($bell); $ok=$true} catch {} }; if (-not $ok) { try {[Console]::Error.Write($bell)} catch {} }"
     ```
     (source `'\\\\.\\CONOUT$'` unescapes to `\\.\CONOUT$` — the Win32 console
     device path). Inside the emitted `--settings` JSON these characters are
     re-escaped by `JSON.stringify`: `\` → `\\` and `"` → `\"`.
2. **MCP config — `--mcp-config <path>`**
   `config-writer.ts:259-262`. Always added (unconditional; there is **no**
   settings gate — `codingCli.mcpServer` exists in settings, `shared/settings.ts:716`,
   but is **never consulted** on this path; verified by grep: no reader in `server/`).
   - File: `path.join(os.tmpdir(), 'freshell-mcp', '<terminalId>.json')`
     (`config-writer.ts:34-40`), written mode `0o600` with
     `JSON.stringify(config, null, 2)` (`:130`) of
     ```json
     {
       "mcpServers": {
         "freshell": {
           "command": "node",
           "args": ["<serverArgs...>"]
         }
       }
     }
     ```
     (`:122-129`).
   - `serverArgs` = `buildMcpServerCommandArgs(platform)` (`:89-107`):
     - `NODE_ENV==='production'` **and** `dist/server/mcp/server.js` exists →
       `['<repoRoot>/dist/server/mcp/server.js']`;
     - else `['--import', require.resolve('tsx'), '<repoRoot>/server/mcp/server.ts']`.
   - win32 branch: when `platform === 'windows'` **and** running inside WSL,
     the returned config path and the paths inside `serverArgs` are converted with
     `wslpath -w` to Windows UNC form (`:57-70, 91-96, 133-136`). On native
     Windows (`isWslEnvironment()` false) paths pass through unchanged.
   - Cleanup on exit / failed spawn: `cleanupMcpConfig(terminalId, mode, mcpCwd)`
     (`terminal-registry.ts:1491,1605`; `config-writer.ts:429-448` unlinks the tmp file).
3. **Resume / create-session (`resumeArgs`)** — added iff `resumeSessionId` truthy
   (`terminal-registry.ts:308-320`):
   - `launchIntent === 'start'` → `createSessionArgs`: `['--session-id', <id>]`
     (`extensions/claude-code/freshell.json:11`; fallback `terminal-registry.ts:98`).
     Condition: `mode==='claude' && sessionBindingReason==='start'` (`:1570-1571`).
   - else → `resumeArgs`: `['--resume', <id>]`
     (`extensions/claude-code/freshell.json:10`; fallback `:97`).
   - **LIVE-PATH LAW (rev 2 correction):** via `ws-handler.ts` `terminal.create`, a
     fresh claude launch **never** arrives here without a session id. When
     `mode==='claude' && restore!==true && !sessionRef && !resumeSessionId`, the
     handler **preallocates** one (`shouldPreallocateFreshClaudeSession` →
     `reserveClaudeFreshSessionId`, `sessionBindingReason='start'`,
     `ws-handler.ts:2048-2064`), so fresh claude always gets
     `['--session-id', <preallocated uuid>]`. A claude launch with **no** session
     args is reachable only for direct/unit callers of `resolveCodingCliCommand`.
     The Rust `handle_create` must reproduce the preallocation, not just the
     resolver conditional.
4. **Permission mode (`settingsArgs`)** — added iff
   `providerSettings.permissionMode && permissionMode !== 'default'`
   (`terminal-registry.ts:351-354`): `['--permission-mode', <mode>]`
   (`extensions/claude-code/freshell.json:12`; fallback `:99`).
   Allowed values from the settings schema: `plan | acceptEdits | bypassPermissions`
   (`ws-handler.ts:684` shows the enum used on the codingcli.create surface; the
   settings store accepts the same names). Default settings seed
   `claude: { permissionMode: 'default' }` (`shared/settings.ts:810-811`) → **no arg**.
5. **Model / sandbox:** claude's manifest has **no** `modelArgs`/`sandboxArgs`
   (`extensions/claude-code/freshell.json`), so `providerSettings.model`/`.sandbox`
   contribute **nothing** to claude argv (`terminal-registry.ts:345-350` are no-ops).
6. **Env:** no claude-specific env. `permissionModeEnvVar` is unset for all three
   CLIs (`extensions/*/freshell.json`), so `terminal-registry.ts:355-367` is inert.

**Full claude argv (unix, fresh start via the live path, default permission mode):**
```
[ '--settings', '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh -lc \"printf '\''\\a'\'' > /dev/tty 2>/dev/null || true\""}]}]}}',
  '--mcp-config', '/tmp/freshell-mcp/<terminalId>.json',
  '--session-id', '<server-preallocated uuid>' ]
```
(the `--session-id` pair is always present on the live fresh path — see item 3's
LIVE-PATH LAW; the `--settings` payload above is shown shell-agnostic; the exact JSON
string is specified in §4 test G-C1/G-C3).

### 2.2 `codex`

Order: `[remoteArgs..., providerArgs..., settingsArgs..., resumeArgs...]`.

1. **App-server remote (`remoteArgs`)** — added iff
   `mode==='codex' && providerSettings?.codexAppServer` (`terminal-registry.ts:295-307`):
   - Validation: `wsUrl` must parse as a URL with `protocol==='ws:'` and
     `hostname==='127.0.0.1'`, else throw (`:297-305`).
   - Args: `['--remote', <wsUrl>, '-c', 'features.apps=false']`
     (`:306`; `CODEX_MANAGED_REMOTE_CONFIG_ARGS = ['-c','features.apps=false']`,
     `server/coding-cli/codex-managed-config.ts:1-4`).
   - In the live `ws-handler` path this is **always** present for codex
     (`planCodexLaunch` throws without a planner, `ws-handler.ts:934-935`;
     `codexAppServer` always set, `:2474-2492`). The no-app-server codex branch
     of `resolveCodingCliCommand` exists only for direct/unit callers.
2. **Turn-complete notification (`providerArgs` head)** — always for codex
   (`terminal-registry.ts:209-214`), exactly:
   ```
   '-c', 'tui.notification_method=bel',
   '-c', "tui.notifications=['agent-turn-complete']"
   ```
   (the second value is one argv element containing single quotes and square
   brackets verbatim).
3. **MCP config (`providerArgs` tail)** — always (`config-writer.ts:264-275`),
   inline TOML via repeated `-c` (no temp file):
   ```
   '-c', 'mcp_servers.freshell.command="node"',
   '-c', 'mcp_servers.freshell.args=[<tomlArgs>]'
   ```
   where each element of `buildMcpServerCommandArgs(platform)` is
   `tomlEscape`d — wrapped in `"` with `\` → `\\` and `"` → `\"`
   (`config-writer.ts:142-144`) — and joined with `', '` (comma + space, `:267`).
   Example (dev, unix): `mcp_servers.freshell.args=["--import", "/repo/node_modules/tsx/dist/loader.mjs", "/repo/server/mcp/server.ts"]`.
   (rev 2 correction: `require.resolve('tsx')` resolves the package export `"."` →
   `./dist/loader.mjs` — verified against `node_modules/tsx/package.json:28`; the
   reference's own doc comment at cw:84 says `dist/esm/index.mjs`, which is that
   package's `./esm` subpath, **not** what `resolveDependencyPath('tsx')` returns.)
   win32/WSL path conversion identical to §2.1(2).
4. **Model (`settingsArgs`)** — `['--model', <model>]` iff
   `providerSettings.model` truthy (`terminal-registry.ts:340-347`;
   `extensions/codex-cli/freshell.json:11`). **Live path: never** — ws-handler
   strips `model` for codex (`ws-handler.ts:2464-2465`); it reaches the app-server
   thread options instead (`:940`).
5. **Sandbox (`settingsArgs`)** — `['--sandbox', <sandbox>]` iff
   `providerSettings.sandbox` truthy (`terminal-registry.ts:348-350`;
   `extensions/codex-cli/freshell.json:12`). **Live path: never** (stripped,
   `ws-handler.ts:2464-2465`; normalized into the plan at `:941`).
6. **Permission mode** — codex manifest has no `permissionModeArgs`, so no arg
   even if set (also stripped on the live path).
7. **Resume (`resumeArgs`)** — iff `resumeSessionId` truthy:
   `['resume', <sessionId>]` (subcommand-style, **no** `--` prefix;
   `extensions/codex-cli/freshell.json:10`; fallback `terminal-registry.ts:105`).
   `launchIntent` is always `'resume'` for codex (`:1570-1571`), and codex has no
   `createSessionArgs`, so a `'start'` intent with a session id would **throw**
   (`:310-313`) — unreachable on the live path.
8. **Env:** none codex-specific on this path.

**Full codex argv (unix, live path, resume):**
```
[ '--remote', 'ws://127.0.0.1:<port>/<path>', '-c', 'features.apps=false',
  '-c', 'tui.notification_method=bel', '-c', "tui.notifications=['agent-turn-complete']",
  '-c', 'mcp_servers.freshell.command="node"', '-c', 'mcp_servers.freshell.args=[...]',
  'resume', '<sessionId>' ]
```

### 2.3 `opencode`

Order: `[providerArgs..., settingsArgs..., resumeArgs...]`.

1. **MCP config — file merge, NO argv/env** (`config-writer.ts:287-415`):
   - Requires `cwd`; throws if missing (`:288-293`) or nonexistent (`:304-309`).
     The cwd passed is the **host-native mcpCwd** (`terminal-registry.ts:1153,1203,1236,1262`
     via `resolveMcpCwd`/`resolveUnixShellCwd`, `:911-914`).
   - Writes/merges `<cwd>/.opencode/opencode.json` adding
     ```json
     "mcp": { "freshell": { "type": "local", "command": ["node", "<serverArgs...>"] } }
     ```
     (`:381-390`), `JSON.stringify(..., null, 2)`, mode `0o600`; guarded by a
     lock file `.opencode/.freshell-mcp-state.lock` (`:178-229`) and refcounted
     via sidecar `.opencode/.freshell-mcp-state.json` (`:150-241,396-409`);
     pre-existing user-managed `mcp.freshell` entries are left untouched
     (`:368-394`). Cleanup decrements/removes on exit (`:445-512`).
   - Returns `{ args: [], env: {} }` (`:414`) — **zero argv contribution**.
2. **Env override — `GOOGLE_GENERATIVE_AI_API_KEY`** (`terminal-registry.ts:292-294`;
   `opencode-launch.ts:11-18`): if `(GOOGLE_GENERATIVE_AI_API_KEY || GEMINI_API_KEY || GOOGLE_API_KEY)`
   resolves a key **and** `GOOGLE_GENERATIVE_AI_API_KEY` itself is unset, set
   `GOOGLE_GENERATIVE_AI_API_KEY=<resolved>` in the CLI env. Env source is
   `{ ...process.env, ...commandEnv }`.
3. **Loopback control endpoint — `--hostname`/`--port` (`settingsArgs` head)** —
   **mandatory** (`terminal-registry.ts:322-339`): requires
   `providerSettings.opencodeServer` with `hostname === '127.0.0.1'` and an
   integer port in `(0, 65535]`, else **throw**
   (`'OpenCode launch requires an allocated localhost control endpoint.'`).
   Args exactly: `['--hostname', '127.0.0.1', '--port', String(port)]`.
   The port comes from `allocateLocalhostPort()` at create time
   (`ws-handler.ts:2471-2473`; `local-port.ts:13-41` — bind-probe on
   `127.0.0.1:0`, close, return port; callers must tolerate the close/bind race).
4. **Model (`settingsArgs`)** — `['--model', <model>]` (`extensions/opencode/freshell.json:11`)
   with opencode-specific effective-model logic (`terminal-registry.ts:340-347`):
   - resuming (`resumeSessionId` truthy) → **no model arg ever**;
   - fresh: `providerSettings.model` if set, else
     `resolveOpencodeLaunchModel` (`opencode-launch.ts:20-29`) picks by env:
     Google key → `'google/gemini-3-pro-preview'`; else `OPENAI_API_KEY` →
     `'openai/gpt-5'`; else `ANTHROPIC_API_KEY` → `'anthropic/claude-sonnet-4-5'`;
     else no arg.
5. **Sandbox / permission mode** — no `sandboxArgs`/`permissionModeArgs` in the
   opencode manifest → no args regardless of settings.
6. **Resume (`resumeArgs`)** — iff `resumeSessionId`:
   `['--session', <sessionId>]` (`extensions/opencode/freshell.json:10`; fallback
   `terminal-registry.ts:113`). No `createSessionArgs` (same throw note as codex).
7. **Stripped env:** `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`
   (`terminal-registry.ts:1094-1095`) — already in Rust `STRIP_ENV`.

**Full opencode argv (unix, fresh, GEMINI_API_KEY set, no explicit model):**
```
[ '--hostname', '127.0.0.1', '--port', '<port>',
  '--model', 'google/gemini-3-pro-preview' ]
```
plus env `GOOGLE_GENERATIVE_AI_API_KEY=<key>`, plus the `<cwd>/.opencode/opencode.json`
side-effect. Note argv contains **no MCP flags** for opencode.

### 2.4 `gemini` / `kimi` — shared `generateMcpInjection` branches (rev 2 addition)

Gemini remains **out of porting scope** for provider work (STATE.yaml constraint) and
kimi is documented here only because both flow through the same
`generateMcpInjection` switch that the Rust port must reproduce
(`config-writer.ts:277-284`). A Rust `match` that implements only
claude/codex/opencode silently changes behavior for these two shipped extension
panes (`extensions/gemini`, `extensions/kimi`) — this section pins the branches so
the port either implements them or ledgers an explicit deviation.

1. **`gemini`** (`config-writer.ts:277-280`): writes the same tmp JSON config file as
   claude (`writeMcpConfigFile`, §2.1(2) — same path form, mode `0o600`, same
   win32/WSL conversion), but injects it via **env, not argv**:
   ```
   { args: [], env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: <filePath> } }
   ```
   This is the **only branch of `generateMcpInjection` that returns env** — a port
   that models the injection as args-only drops it entirely.
2. **`kimi`** (`config-writer.ts:282-284`): same tmp JSON file, injected via argv:
   ```
   { args: ['--mcp-config-file', <filePath>], env: {} }
   ```
   (Note the flag differs from claude's: `--mcp-config-file` vs `--mcp-config`.)
3. **Cleanup** covers both: the tmp-file unlink path is shared by claude/gemini/kimi
   (`config-writer.ts:429-448`, comment at `:434`).
4. Both modes otherwise follow the generic manifest-driven segments of §1 (their
   `extensions/*/freshell.json` supply any resume/model templates; not inventoried
   here — gemini provider behavior stays out of scope).

### 2.5 Cross-cutting conditions summary

| Item | Condition | Cite |
|---|---|---|
| `--remote <wsUrl>` + `-c features.apps=false` | codex && `providerSettings.codexAppServer` (always on live path) | tr:295-307; ws:2474-2492 |
| codex `-c tui.*` pair | codex, always | tr:209-214 |
| claude `--settings <hook json>` | claude, always; payload varies by `target` | tr:216-238 |
| claude `--mcp-config <path>` | claude, always; path form varies by `target`+WSL | cw:259-262,133-136 |
| codex `-c mcp_servers.*` pair | codex, always | cw:264-275 |
| opencode config-file merge | opencode, always; **throws** without valid existing cwd | cw:287-309 |
| `--hostname/--port` | opencode, always; **throws** without valid loopback endpoint | tr:322-339 |
| `--model` | spec has `modelArgs` && effective model non-empty; opencode: suppressed on resume, env-key default on fresh; codex: stripped on live path | tr:340-347; ol:20-29; ws:2464-2470 |
| `--sandbox` | codex only (manifest), && `providerSettings.sandbox`; stripped on live path | tr:348-350 |
| `--permission-mode` | claude only (manifest), && set && `!== 'default'` | tr:351-354 |
| resume args | `resumeSessionId` truthy; claude start-intent uses `--session-id` | tr:308-320,1570-1571 |
| `GOOGLE_GENERATIVE_AI_API_KEY` | opencode && key resolvable && var unset | tr:292-294; ol:11-18 |
| `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` env | gemini, always (env-only injection) | cw:277-280 |
| `--mcp-config-file <path>` | kimi, always | cw:282-284 |
| `FRESHELL*` base env | all modes (incl. shell) | tr:1529-1542,1569 |

(`tr` = terminal-registry.ts, `cw` = mcp/config-writer.ts, `ws` = ws-handler.ts,
`ol` = opencode-launch.ts.)

### 2.6 Platform / win32 branch notes

- `target` is `'windows'` only on the `cmd`/`powershell` branches
  (`tr:1204,1237`) — which are reachable from **both** a WSL host (interop) and a
  native-Windows host; the WSL-from-Windows branch and the non-Windows tail use
  `'unix'` (`tr:1165,1262`) — i.e. the claude Windows bell command applies **only**
  when the CLI itself runs as a Windows process, and the UNC MCP-path conversion
  applies only when additionally the **server host is WSL**
  (`needsWinPaths = platform==='windows' && isWslEnvironment()`, cw:91).
- **Host-form MCP paths (rev 2 correction):** `generateMcpInjection` resolves
  `repoRoot`/`os.tmpdir()` on the **server host** and converts only under
  `needsWinPaths`. Consequences per host:
  - WSL host + `target='windows'` → Linux tmp file, **UNC-converted** paths (§2.1(2)).
  - Native-Windows host + `target='windows'` → Windows paths, **no conversion**
    (gate false because `isWslEnvironment()` requires `process.platform==='linux'`,
    cw:45-51).
  - **Native-Windows host + WSL branch (`target='unix'`) → Windows-form paths handed
    to a Linux CLI process** (no conversion because `platform!=='windows'`): claude's
    `--mcp-config C:\Users\...\Temp\freshell-mcp\<id>.json` and codex's TOML args
    embed `C:\...` paths that the WSL-side process cannot read as-is. This is
    faithful reference behavior (a latent reference wart); the port must reproduce
    it or ledger a DELIBERATE_FIX — do **not** silently "fix" it. See G-W1.
- On the native `cmd`/`powershell` branches the assembled argv is **flattened into
  a single command string** (`buildCmdCommand`/`buildPowerShellCommand`,
  `tr:1206,1239`). The Rust port's golden tests must therefore compare the
  *pre-flatten* argv (the `CliLaunch.args` layer) plus the existing flattening
  goldens (`spawn.rs` helper tests) rather than re-deriving the full string —
  except where §4 specifies full-string goldens.
- `mcpCwd` (the cwd handed to `generateMcpInjection` and to cleanup) is the
  host-native resolution of the terminal cwd (`tr:911-914,1153,1203,1236,1258-1262`)
  and is recorded on the terminal record (`tr:571,1637`) for exit cleanup (`tr:1491`).

---

## 3. Mapping to the Rust port

### 3.1 `crates/freshell-platform/src/spawn.rs` — the deterministic argv core

Extend the existing pure builders; keep IO (file writes, port allocation) out.

1. **Widen `CliCommandSpec` (`spawn.rs:75-83`)** to carry the manifest arg
   templates, mirroring `CodingCliCommandSpec` (`tr:77-90`) and the manifest
   compilation (`server/index.ts:231-255`):
   ```rust
   pub struct CliCommandSpec {
       pub name: String,
       pub env_var: Option<String>,
       pub default_cmd: String,
       pub base_args: Vec<String>,                    // cli.args
       pub base_env: BTreeMap<String, String>,        // cli.env
       pub resume_args: Option<Vec<String>>,          // "{{sessionId}}" template
       pub create_session_args: Option<Vec<String>>,  // "{{sessionId}}"
       pub model_args: Option<Vec<String>>,           // "{{model}}"
       pub sandbox_args: Option<Vec<String>>,         // "{{sandbox}}"
       pub permission_mode_args: Option<Vec<String>>, // "{{permissionMode}}"
   }
   ```
   Template substitution = plain string replace of the placeholder in each element
   (`index.ts:248-252`). Populate from the extension registry in
   `crates/freshell-server/src/main.rs:129-141` (currently maps only
   name/env_var/default_cmd from `cli_detection_specs()` — extend the registry
   accessor to expose the full `cli` block).
2. **New input struct** mirroring `ProviderSettings` + call-site params:
   ```rust
   pub struct CliLaunchInputs<'a> {
       pub mode: &'a str,
       pub target: ProviderTarget,            // Unix | Windows
       pub terminal_id: &'a str,
       pub mcp_cwd: Option<&'a str>,
       pub resume_session_id: Option<&'a str>,
       pub launch_intent: LaunchIntent,       // Start | Resume
       pub permission_mode: Option<&'a str>,
       pub model: Option<&'a str>,
       pub sandbox: Option<&'a str>,
       pub codex_remote_ws_url: Option<&'a str>,   // codexAppServer.wsUrl
       pub opencode_server: Option<(&'a str, u16)>, // ("127.0.0.1", port)
       pub mcp_injection: McpInjection,       // precomputed by the IO layer (§3.2)
   }
   ```
3. **Extend `resolve_cli_launch` (`spawn.rs:112-132`)** into the full
   `resolveCodingCliCommand` (`tr:274-375`), preserving the exact segment order
   `[remote, provider, base, settings, resume]` and all throw conditions
   (codex non-loopback wsUrl `tr:297-305`; opencode missing/invalid endpoint
   `tr:324-332`; start-intent without `create_session_args` `tr:310-313`).
   Return `Result<Option<CliLaunch>, CliLaunchError>` instead of the current
   infallible `Option` (the reference throws; the ws layer maps errors to an
   `error` frame instead of silently launching a reduced CLI).
   Embed the notification constants:
   - codex: `["-c","tui.notification_method=bel","-c","tui.notifications=['agent-turn-complete']"]` (`tr:211`);
   - claude: `["--settings", <compact JSON per §2.1(1)>]` (`tr:216-238`) —
     build with `serde_json` compact serialization; the bell strings are `const`s
     with unit tests pinning the exact bytes.
   Opencode model default: port `resolveOpencodeLaunchModel` + `getOpencodeEnvOverrides`
   (`ol:1-29`) as pure functions over `&dyn Env` (the env source is
   `parent ∪ commandEnv`, `tr:293,343`).
4. **`build_cli_spawn_spec` / `build_windows_cli_spawn_spec`
   (`spawn.rs:505-527,550-650`)**: no ordering changes needed — they already
   append `launch.args` verbatim and layer `launch.env`; they inherit fidelity
   once `CliLaunch` is complete. Remove/update the "REDUCED FIDELITY" doc comments
   (`spawn.rs:103-111,546-548`).
   ⚠️ The cmd.exe PORT-FIX quoting gate (`spawn.rs:664-699`) must be re-verified
   against the new arg shapes: claude's `--settings` JSON and codex's
   `tui.notifications=['agent-turn-complete']` contain `"`/`'`/`[`/`%`-free but
   space- and quote-bearing content → `cmd_token_is_plain` correctly routes them
   through `quote_cmd_arg`; add goldens (§4 G-W*).

### 3.2 New module: MCP injection IO (`freshell-platform` or a new `freshell-mcp-inject` module)

Port `server/mcp/config-writer.ts` semantics; this is the only file-writing piece:

- `McpInjection { args: Vec<String>, env: BTreeMap<String,String> }` (`cw:247-250`).
- `generate_mcp_injection(mode, terminal_id, cwd, platform) -> Result<McpInjection>`:
  - claude: write `<tmp>/freshell-mcp/<terminalId>.json` (0o600, pretty-2-space
    JSON, `cw:117-137`), return `["--mcp-config", <path>]`.
  - codex: pure — TOML `-c` pair (`cw:264-275`), `toml_escape` per `cw:142-144`.
  - opencode: locked merge of `<cwd>/.opencode/opencode.json` + sidecar refcount
    (`cw:287-415`), return empty args.
  - gemini (rev 2): same tmp file as claude, return
    `env = { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: <path> }`, empty args (`cw:277-280`) —
    the only env-returning branch; do not model the injection as args-only.
  - kimi (rev 2): same tmp file, return `["--mcp-config-file", <path>]` (`cw:282-284`).
- `cleanup_mcp_config(terminal_id, mode, cwd)` (`cw:429-512`), called from the
  terminal registry on exit (`tr:1491`) and on spawn failure (`tr:1605`) — wire
  into `freshell-terminal`'s kill/exit path.
- `build_mcp_server_command_args(platform)` (`cw:89-107`) — see UNCERTAIN U1:
  the Node `tsx`/`dist/server.js` resolution has no Rust equivalent yet.
- WSL→Windows path conversion: reuse
  `freshell_platform::path::convert_windows_path_to_wsl_path`'s inverse — the
  reference shells out to `wslpath -w` (`cw:57-70`); Rust should do the same
  (3s timeout, fall back to the input on failure).

### 3.3 `crates/freshell-ws/src/terminal.rs` — `handle_create` (`:303-384`)

- Parse the additional create-time inputs: `resume_session_id` is **missing** from
  `freshell_protocol::TerminalCreate` (`crates/freshell-protocol/src/client_messages.rs:179-200`
  has `session_ref` but not `resumeSessionId`; the reference schema has both,
  `ws-handler.ts:656-658`). Add `resume_session_id: Option<String>`.
- Load provider settings `codingCli.providers[mode]` from the settings store
  (`ws-handler.ts:2317-2319`; Rust settings live in
  `crates/freshell-protocol/src/settings.rs:122` `coding_cli` +
  `crates/freshell-server/src/settings.rs`).
- opencode: allocate the loopback endpoint (Tokio `TcpListener::bind(("127.0.0.1",0))`,
  then drop — `local-port.ts:13-41`) **before** building the launch; record it on
  the terminal record analog (needed later for control-endpoint clients; the
  allocator seam already exists as `PortAllocator` in
  `crates/freshell-opencode/src/serve.rs` (§`PortAllocator`/`allocateLocalhostPort` port) — reuse it).
- codex: obtain `codex_remote_ws_url` from the `freshell-codex` app-server launch
  plan (`crates/freshell-codex/src/app_server.rs`; reference plan shape
  `launch-planner.ts:48-52` `remote.wsUrl`). Until the Rust codex launch planner
  is wired into terminal.create, gate the `--remote` pair on availability and
  record the deviation (UNCERTAIN U2).
- Compute `mcp_cwd` per branch (`tr:1153,1203,1236,1262`) and call the §3.2
  generator; pass its result into `resolve_cli_launch`'s inputs.
- Base env: extend `overrides` (`terminal.rs:314-315`) with `FRESHELL`,
  `FRESHELL_URL`, `FRESHELL_TOKEN`, `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID`
  (`tr:1529-1542`; `tab_id`/`pane_id` are already on `TerminalCreate`).
- On `CliLaunchError`, reply with an `error` frame (reference: throw →
  `terminal.create failed`, `ws-handler.ts:2605`) instead of falling back to shell.

### 3.4 `crates/freshell-opencode` / `crates/freshell-codex`

- `freshell-opencode`: the serve-manager (`src/serve.rs`) already owns the
  `opencode serve` **fresh-agent** sidecar; the terminal-launch loopback endpoint
  (§2.3(3)) is a different consumer but should share the `PortAllocator` seam.
  No argv changes inside this crate.
- `freshell-codex`: source of `codex_remote_ws_url` (app-server/remote-proxy port,
  `src/app_server.rs`, `src/transport.rs`); terminal.create must consume its plan
  the way `ws-handler.ts:2442-2492` consumes `codexPlan.remote`. No argv assembly
  inside this crate — argv stays in `freshell-platform::spawn`.

---

## 4. Golden argv test cases (Rust `#[test]` goldens)

Conventions for all cases:
- `terminalId = "term1"`, repo root `/repo` (unix) / `C:\repo` (win),
  `os.tmpdir() = /tmp` (unix) / `C:\Users\u\AppData\Local\Temp` (native win).
- Dev-mode MCP server args (`NODE_ENV != 'production'`):
  `MCP_UNIX = ["--import", "/repo/node_modules/tsx/dist/loader.mjs", "/repo/server/mcp/server.ts"]`.
  (rev 2: `dist/loader.mjs`, not `dist/esm/index.mjs` — see §2.2(3). Golden tests
  should inject `build_mcp_server_command_args` as a seam so the tsx resolution
  isn't exercised — see U1 — which also makes this constant's exact value
  non-load-bearing for the goldens.)
- `CLAUDE_SETTINGS_UNIX` = exact compact JSON string:
  ```
  {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh -lc \"printf '\\a' > /dev/tty 2>/dev/null || true\""}]}]}}
  ```
  (i.e. the JSON-encoded form of the §2.1(1) unix bell string: the literal
  backslash-`a` becomes `\\a` in JSON, the inner `"` become `\"`.)
- `CLAUDE_SETTINGS_WIN` = compact JSON of the §2.1(1) windows bell string
  (in JSON: `'\\.\CONOUT$'` appears as `'\\\\.\\CONOUT$'`; every `"` as `\"`).

### G-C1 — claude, linux, fresh, defaults — RESOLVER-LEVEL ONLY (rev 2 relabel)
**⚠️ Not reachable via the live `terminal.create` path.** The ws-handler always
preallocates a session id for fresh claude (§2.1(3) LIVE-PATH LAW,
`ws-handler.ts:2048-2064`), so a claude launch with no session args occurs only for
direct/unit callers of `resolveCodingCliCommand`. Keep this golden strictly as a
resolver-level unit test of the "no resumeSessionId" conditional; **the live
fresh-claude golden is G-C3** (start intent + preallocated `--session-id`). A port
test suite that treats G-C1 as the fresh-launch acceptance golden pins wrong behavior.
Inputs: `mode=claude`, `target=unix`, no resume, `permissionMode='default'`
(settings seed, `shared/settings.ts:810-811`), no model/sandbox.
Expected `CliLaunch.command = "claude"`, args:
```
["--settings", CLAUDE_SETTINGS_UNIX,
 "--mcp-config", "/tmp/freshell-mcp/term1.json"]
```
env: `{}` (beyond base layers). (tr:216-238; cw:259-262)

### G-C2 — claude, linux, resume + permissionMode=plan
Inputs: `resumeSessionId="0f9a3b1c-1111-2222-3333-444455556666"`,
`launchIntent=resume`, `permissionMode="plan"`.
```
["--settings", CLAUDE_SETTINGS_UNIX,
 "--mcp-config", "/tmp/freshell-mcp/term1.json",
 "--permission-mode", "plan",
 "--resume", "0f9a3b1c-1111-2222-3333-444455556666"]
```
(order: providerArgs, settingsArgs, resumeArgs — tr:371)

### G-C3 — claude, linux, start-intent — THE live fresh-claude golden (rev 2 relabel)
This is what every live fresh claude launch produces: the ws-handler preallocates
the id and sets `sessionBindingReason='start'` (`ws-handler.ts:2048-2064`), which
`buildSpawnSpec` maps to `launchIntent='start'` (tr:1570-1571).
Inputs: `launchIntent=start`, `resumeSessionId="0f9a3b1c-1111-2222-3333-444455556666"`.
```
["--settings", CLAUDE_SETTINGS_UNIX,
 "--mcp-config", "/tmp/freshell-mcp/term1.json",
 "--session-id", "0f9a3b1c-1111-2222-3333-444455556666"]
```
(tr:310-314; manifest createSessionArgs; ws:2048-2064)

### G-C4 — claude, native win32 (target=windows), fresh, defaults
Inputs as G-C1 but `target=windows`, native Windows (not WSL → no wslpath
conversion; `cw:133-136` gate false).
`CliLaunch.args`:
```
["--settings", CLAUDE_SETTINGS_WIN,
 "--mcp-config", "C:\\Users\\u\\AppData\\Local\\Temp\\freshell-mcp\\term1.json"]
```
Full flattened powershell branch golden (tr:1237-1244 / spawn.rs:633-649):
program `powershell.exe`, args
`["-NoLogo","-NoExit","-Command", "Set-Location -LiteralPath 'C:\\ws'; & 'claude' '--settings' '<CLAUDE_SETTINGS_WIN with ' doubled per quotePowerShellLiteral>' '--mcp-config' 'C:\\...\\term1.json'"]`.
(BLOCKER B1 — formerly U5 — on the cmd.exe flattening of this payload; note cmd,
not powershell, is the default native-Windows shell, tr:949-953.)

### G-X1 — codex, linux, live path, fresh (no resume)
Inputs: `codex_remote_ws_url="ws://127.0.0.1:45012/codex"`, no model/sandbox
(stripped per ws:2464-2465).
```
["--remote", "ws://127.0.0.1:45012/codex",
 "-c", "features.apps=false",
 "-c", "tui.notification_method=bel",
 "-c", "tui.notifications=['agent-turn-complete']",
 "-c", "mcp_servers.freshell.command=\"node\"",
 "-c", "mcp_servers.freshell.args=[\"--import\", \"/repo/node_modules/tsx/dist/loader.mjs\", \"/repo/server/mcp/server.ts\"]"]
```
(tr:306,211; cw:268-274; join with `", "` — cw:267)

### G-X2 — codex, linux, live path, resume
Inputs: G-X1 + `resumeSessionId="thread-abc123"`.
Expected: G-X1 args + `["resume", "thread-abc123"]` appended last. (tr:308-320,371)

### G-X3 — codex, linux, NO app-server (direct/unit path), model+sandbox set
Inputs: `codex_remote_ws_url=None`, `model="gpt-5.1-codex"`,
`sandbox="workspace-write"`.
```
["-c", "tui.notification_method=bel",
 "-c", "tui.notifications=['agent-turn-complete']",
 "-c", "mcp_servers.freshell.command=\"node\"",
 "-c", "mcp_servers.freshell.args=[\"--import\", \"/repo/node_modules/tsx/dist/loader.mjs\", \"/repo/server/mcp/server.ts\"]",
 "--model", "gpt-5.1-codex",
 "--sandbox", "workspace-write"]
```
(tr:340-350; manifest modelArgs/sandboxArgs — documents the non-live branch)

### G-X4 — codex, win32 target via WSL host (UNC-converted MCP paths)
Inputs: `target=windows`, host is WSL (`isWslEnvironment()` true), wslpath maps
`/repo/...` → `\\wsl.localhost\Ubuntu\repo\...`.
Expected MCP pair (tomlEscape doubles the backslashes):
```
"-c", "mcp_servers.freshell.command=\"node\"",
"-c", "mcp_servers.freshell.args=[\"--import\", \"\\\\wsl.localhost\\Ubuntu\\repo\\node_modules\\tsx\\dist\\loader.mjs\", \"\\\\wsl.localhost\\Ubuntu\\repo\\server\\mcp\\server.ts\"]"
```
(each literal `\` in the UNC path is emitted as `\\` inside the TOML string —
cw:142-144,91-96. Shown here at the Rust-string-literal level of one escape;
the golden must pin exact bytes.)

### G-O1 — opencode, linux, fresh, explicit model
Inputs: `opencode_server=("127.0.0.1", 51234)`, `model="anthropic/claude-sonnet-4-5"`,
cwd `/home/u/proj` (exists).
```
["--hostname", "127.0.0.1", "--port", "51234",
 "--model", "anthropic/claude-sonnet-4-5"]
```
env: `{}` (no Google key in env). Side-effect: `/home/u/proj/.opencode/opencode.json`
contains the `mcp.freshell` entry (§2.3(1)). (tr:333-347; cw:381-390)

### G-O2 — opencode, linux, fresh, no model, `GEMINI_API_KEY=k1`
```
["--hostname", "127.0.0.1", "--port", "51234",
 "--model", "google/gemini-3-pro-preview"]
```
env: `{"GOOGLE_GENERATIVE_AI_API_KEY": "k1"}`. (ol:8,14-16,25; tr:292-294,340-347)

### G-O3 — opencode, linux, resume (model suppressed)
Inputs: `resumeSessionId="ses_abc"`, `model="openai/gpt-5"` set in settings,
`OPENAI_API_KEY` set.
```
["--hostname", "127.0.0.1", "--port", "51234",
 "--session", "ses_abc"]
```
(no `--model`: tr:340-343 forces `effectiveModel=undefined` on resume)

### G-O4 — opencode, error goldens
- No/invalid endpoint (port 0, port 70000, hostname ≠ 127.0.0.1) →
  `Err("OpenCode launch requires an allocated localhost control endpoint.")` (tr:324-332).
- cwd missing → `Err` containing `"cwd is required"` (cw:288-293); cwd nonexistent →
  `Err` containing `"cwd directory does not exist"` (cw:304-309).

### G-W1 — WSL-from-native-Windows wrapper (codex example) — rev 2 CORRECTED
Inputs: native Windows host, cwd `C:\Users\Public\ws`, G-X1-shaped launch.
Program `wsl.exe`, args:
```
["--cd", "/mnt/c/Users/Public/ws", "--exec", "codex", <G-X1 args, but with
 HOST-FORM (Windows) MCP paths — see below>]
```
(tr:1141-1172; spawn.rs:589-614)
**Rev 1 wrongly claimed "MCP paths stay Linux-form."** `target` for the inner CLI is
`'unix'` (tr:1165), so no UNC conversion happens (`needsWinPaths` false, cw:91) —
but the paths are resolved on the **native-Windows server host**
(`findRepoRoot()`/`os.tmpdir()` on win32), so the MCP `-c` args embed
**Windows-form** paths, e.g.
`mcp_servers.freshell.args=["--import", "C:\\repo\\node_modules\\tsx\\dist\\loader.mjs", "C:\\repo\\server\\mcp\\server.ts"]`
(tomlEscape doubles each `\`), NOT G-X1's `/repo/...` bytes. The WSL-side codex
cannot read `C:\...` paths as-is — faithful reference behavior; reproduce it or
ledger a DELIBERATE_FIX (see §2.6). The golden must pin the Windows-form bytes.

### G-W2 — codex wsUrl validation goldens
`wss://127.0.0.1:1/x`, `ws://localhost:1/x`, `not-a-url` → each
`Err("Codex launch requires a valid loopback app-server websocket URL." | "... a loopback app-server websocket URL.")`
per tr:297-305 (invalid parse vs. wrong scheme/host produce the two distinct messages).

### G-G1 — gemini MCP injection (rev 2 addition)
Inputs: `mode=gemini`, `target=unix`, `terminalId=term1`.
`generate_mcp_injection` returns:
```
args: []
env:  {"GEMINI_CLI_SYSTEM_DEFAULTS_PATH": "/tmp/freshell-mcp/term1.json"}
```
and the env pair must survive to the spawned CLI env via the `{...env, ...cli.env}`
merge (tr:1172,1208,1247,1265). (cw:277-280 — the only env-returning branch.)

### G-K1 — kimi MCP injection (rev 2 addition)
Inputs: `mode=kimi`, `target=unix`, `terminalId=term1`.
```
args: ["--mcp-config-file", "/tmp/freshell-mcp/term1.json"]
env:  {}
```
(cw:282-284 — note `--mcp-config-file`, not claude's `--mcp-config`.)

---

## 5. UNCERTAIN / resolved / blocking items (rev 2 status — do not guess in implementation)

- **U1 — What the injected MCP server command should be in the Rust deployment.**
  The reference injects `node` + tsx/dist paths resolved from the **Node repo**
  (`cw:89-107`). The Rust port ships no Node MCP server (no MCP server crate found
  under `crates/`; grep only matches the claude-sidecar SDK and settings field).
  Options: (a) keep spawning the Node server when the repo layout exists,
  (b) ship a Rust MCP server binary and inject its path, (c) omit injection behind
  a flag until one exists. **Decision needed before implementing §3.2's
  `build_mcp_server_command_args`.** The golden tests are written against an
  injected seam so they are valid under any choice.
- **U2 — Codex `--remote` availability in the Rust port.** The live reference
  path unconditionally requires a codex app-server launch plan (`ws:934-935`).
  Whether the Rust `freshell-codex` app-server/remote-proxy is far enough along to
  hand `terminal.create` a loopback `wsUrl` is not verifiable from the crates read
  here (`app_server.rs` exists; its integration with `freshell-ws` does not).
  Until wired, launching codex **without** `--remote ... -c features.apps=false`
  is a real behavioral divergence (Codex TUI runs un-managed; `features.apps`
  stays default) and must be tracked as a deviation, not silently shipped.
- **U3 — RESOLVED (rev 2, executed proof).** The two claude bell strings and the
  compact `--settings` JSON were verified by **executing the reference's own source
  lines**: `terminal-registry.ts:217-219` were extracted verbatim (`sed -n 217,219p`)
  into a Node script, evaluated for both targets, and the resulting `bellCommand` +
  `JSON.stringify(settings)` printed. Results are **byte-identical** to §2.1(1) and
  to the §4 `CLAUDE_SETTINGS_UNIX` constant; the windows payload pins
  `'\\.\CONOUT$'` appearing in JSON as `'\\\\.\\CONOUT$'` (matching the
  `CLAUDE_SETTINGS_WIN` convention). Safe to pin the Rust `const`s to these bytes.
- **U4 — CORRECTED (rev 2): the rev 1 claim was factually wrong.** The settings
  store does **not** accept free strings for everything:
  `createCodingCliProviderConfigPatchSchema` (`shared/settings.ts:659-669`) enforces
  `sandbox: z.enum(CODEX_SANDBOX_VALUES)` and
  `permissionMode: z.enum(CLAUDE_PERMISSION_MODE_VALUES)`; only `model` (and `cwd`)
  are free strings. Invalid enum values are rejected at settings-patch time
  (`shared/settings.ts:1080-1098`), so the spawn layer only ever sees
  `read-only | workspace-write | danger-full-access` and
  `default | plan | acceptEdits | bypassPermissions` — the same value sets as the
  `codingcli.create` zod schema (`ws:684-685`). The Rust settings layer should
  mirror the enums at the settings boundary; the spawn builders may still treat the
  values as opaque strings (they arrive pre-validated).
- **B1 (was U5) — BLOCKER, reclassified (rev 2): cmd.exe flattening of the claude
  `--settings` JSON gates the DEFAULT native-Windows CLI path.** Rev 1 filed this
  as a minor verify-later item; that was a severity misclassification. On native
  Windows, `resolveShell` maps `'system'` → `'cmd'` (`tr:949-953`), and since
  `effectiveShell !== 'system'` there, `windowsMode` is `'cmd'`
  (`tr:1133-1137`) — i.e. **cmd.exe is the default shell for every native-Windows
  CLI launch**, and claude's quote-heavy JSON payload rides through `buildCmdCommand`
  / `quoteCmdArg` (`tr:1206-1208`) plus the Rust PORT-FIX quoting gate
  (`spawn.rs:652-699`), where portable-pty's MSVC-style re-quoting has already
  produced one cmd.exe-unparseable interop bug (see the `build_windows_cli_spawn_spec`
  PORT FIX). **Pre-condition for declaring the native-Windows leg done:** a live
  native-Windows check that a claude pane launched via the default (cmd) branch
  receives the `--settings` JSON intact (hook fires / `claude --settings` parses),
  or an adjudicated deviation routing CLI launches to the powershell branch (whose
  single-quote literals are safe by construction).
- **U6 — `FRESHELL_URL`/`FRESHELL_TOKEN` values in the Rust server.** The
  reference computes them from `process.env.PORT`/`AUTH_TOKEN`
  (`tr:1533-1537`). The Rust server's canonical port/token plumbing lives in
  `freshell-server`; which config values map to these two vars (and whether the
  T1 golden harness must keep excluding them, per `terminal.rs:312-313`) needs a
  decision when wiring §3.3.
- **U7 — `resumeSessionId` vs `session_ref` on the Rust wire.** The Rust
  `TerminalCreate` lacks `resumeSessionId` (`client_messages.rs:179-200`). The
  reference treats `m.resumeSessionId` and `m.sessionRef` as distinct inputs with
  repair/binding logic between them (`ws:1992-2007,2290-2314,2384-2419`). This
  spec only requires the **spawn-time** id (§2 resume args); the full
  binding/repair pipeline remains covered by `specs/coding-cli.md`.

---

## 6. Success criteria

1. `resolve_cli_launch` (extended per §3.1) reproduces every golden in §4
   byte-for-byte (`assert_eq!` on `Vec<String>` argv and `BTreeMap` env).
2. Segment ordering `[remote, provider, base, settings, resume]` is enforced by
   construction and covered by at least one test that sets **all** segments
   (G-X2 + a claude analog).
3. All four throw conditions (§3.1 item 3) return typed errors with messages
   matching the reference strings; `freshell-ws` surfaces them as `error` frames
   and never falls back to a bare-command launch for a **known** CLI mode.
4. MCP side-effects (claude tmp file, opencode config merge/refcount/cleanup)
   are integration-tested with a temp dir; cleanup runs on both exit and failed
   spawn (tr:1491,1605 parity).
5. The `FRESHELL*` base env parity (§1.2) is asserted in a `freshell-ws`
   handle_create test (modulo U6).
6. No changes to `server/`, `shared/`, or `src/`; the "REDUCED FIDELITY" notes in
   `spawn.rs` are updated to point at this spec once implemented.
7. (rev 2) The `generateMcpInjection` port covers **all five** modes (G-G1/G-K1
   included — gemini's env-only injection must survive the env merge), and the
   native-Windows leg is not declared done while BLOCKER B1 (§5) is unresolved.
