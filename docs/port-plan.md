# Port Plan — Amplifier as a Freshell CLI Agent

## Goal & scope

Integrate Microsoft **Amplifier** (`amplifier` CLI) into freshell **exactly the way the
existing CLI agents (codex / claude / gemini) are integrated** — a terminal-mode PTY pane,
session history in the sidebar (with resume), and the freshell orchestration MCP injected
like every other CLI agent.

**In scope (mirror the CLI agents):**
1. Terminal manifest — launch the real `amplifier` REPL in a PTY.
2. `CodingCliProvider` — index/parse Amplifier sessions from disk (history + resume).
3. `generateMcpInjection` — an `amplifier` case so Amplifier loads the freshell MCP.
4. Registration + client icon + default-enable.
5. Tests mirroring `codex`/`claude`, incl. a real `amplifier` launch smoke.

**Explicitly OUT of scope:** the `fresh-agent` rich-chat-pane architecture
(`FreshAgentRuntimeAdapter`, `freshamplifier`, `amplifier-agent`, `amplifier-agent-ts`).
Do **not** touch `server/fresh-agent/**`, `shared/fresh-agent*.ts`, `server/sdk-bridge.ts`,
or the fresh-agent client registry.

**Conventions (must follow):**
- Server is NodeNext ESM: **all relative imports carry `.js`** (e.g. `./types.js`).
- Match the surrounding code style. Keep changes minimal — implement what's specified, nothing more.
- TDD: write the test, run it red, implement, run it green. Verify with real command output.

---

## Ground truth (verified — do not re-derive)

### Amplifier CLI
- Command: `amplifier` (env override `AMPLIFIER_CMD`). Bare `amplifier` = interactive REPL (the fresh launch).
- Resume: `amplifier resume <SESSION_ID>` resumes a session directly (partial id allowed). Confirmed via `amplifier resume --help`.
- Amplifier's REPL does **not** accept `--model`/`--provider`/`--sandbox`/`--permission-mode` as launch flags → the manifest exposes **only** `command` + `envVar` + `resumeArgs` (no `modelArgs`/`supportsModel`/etc.).

### Session store on disk
```
~/.amplifier/projects/<project-slug>/sessions/<session-id>/
    metadata.json            # canonical metadata (small)
    metadata.json.backup
    transcript.jsonl         # role/content messages (CAN BE LARGE — up to tens of MB)
    transcript.jsonl.backup
    events.jsonl
```
- `<project-slug>` = the cwd with `/` replaced by `-` (e.g. `/home/dan/code/freshell` → `-home-dan-code-freshell`). Prefer `metadata.working_dir` over decoding the slug.
- Home dir: `process.env.AMPLIFIER_HOME || path.join(os.homedir(), '.amplifier')`.

**Interactive `metadata.json` shape:**
```json
{
  "session_id": "1d2dea08-9a63-4ecf-bc4b-ee25a852a4d8",
  "created": "2026-07-04T20:29:04.000280+00:00",
  "bundle": "bundle:anchors",
  "model": "claude-opus-4-8",
  "turn_count": 7,
  "working_dir": "/home/dan/code/freshell",
  "name": "Porting freshell to Rust/Tauri",
  "name_generated_at": "2026-07-04T20:37:41Z",
  "description": "Autonomously porting freshell ...",
  "description_updated_at": "2026-07-04T21:31:16Z"
}
```

**Subagent `metadata.json`** additionally has `parent_id`, `trace_id`, `agent_name`, `child_span`.
→ **`isSubagent = metadata.parent_id != null`** (root/interactive sessions have no `parent_id`).
Subagent session dirs are also named `0000...-<hash>_<agent-name>`.

**`transcript.jsonl` line shapes** (JSONL, one object per line):
```json
{"role": "user", "content": "..."}
{"role": "assistant", "content": [{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "..."}]}
{"role": "tool", "name": "read_file", "tool_call_id": "toolu_...", "content": "..."}
```

### MCP — Amplifier-side prerequisites (must document, do not try to “fix”)
Freshell injects MCP idiomatically (that's freshell's job); whether Amplifier honors it depends on
**two** Amplifier-side prerequisites, exactly like needing `codex` installed for the codex integration:

1. **The user's Amplifier bundle must mount `tool-mcp`.** The default bundles (`anchors`/`foundation`)
   do **not**. Supported user-level fix — add to `~/.amplifier/settings.yaml`:
   ```yaml
   modules:
     tools:
     - module: tool-mcp
       source: git+https://github.com/microsoft/amplifier-module-tool-mcp@main
   ```
   (Alternative: `amplifier bundle add git+https://github.com/microsoft/amplifier-module-tool-mcp@main#subdirectory=behaviors/mcp.yaml --app`.)
2. **The `mcp` Python SDK must be installed in Amplifier's venv.** `tool-mcp` imports `mcp` at mount
   time; if it's missing, Amplifier **swallows the mount failure as a silent warning**
   (`amplifier_core/_session_init.py`) — no error, no MCP tools, no server log. This is the failure
   mode that looks identical to "no servers configured". For a uv-tool install of Amplifier, fix with:
   ```bash
   uv tool install "git+https://github.com/microsoft/amplifier@main" --with "mcp>=1.0.0" --force
   ```
   (`--with` is recorded in the uv receipt, so upgrades keep it.)

Both were satisfied on this machine 2026-07-06; end-to-end verified: env var injected → tool-mcp
config loader reports `servers seen: ['freshell']` → stdio server responds to `initialize`.

`tool-mcp` discovery chain (once mounted): inline `config.servers` / `AMPLIFIER_MCP_CONFIG` /
`./.amplifier/mcp.json` / `~/.amplifier/mcp.json` — sources are **merged** (priority on name
collision: inline > env > project > user). Keep `~/.amplifier/mcp.json` nonexistent to preserve the
"no MCPs outside freshell" property. The config format is the standard
`{ "mcpServers": { "freshell": {...} } }` (same file `writeMcpConfigFile` already writes).
The freshell MCP stdio child inherits `FRESHELL_URL`/`FRESHELL_TOKEN`/`FRESHELL_TAB_ID`/`FRESHELL_PANE_ID`
from the terminal env (`buildTerminalBaseEnv`, `server/terminal-registry.ts`), so no `env` block is needed in the config.

---

## Tasks (bite-sized, TDD)

### Task 1 — Extension manifest
**File (new):** `extensions/amplifier/freshell.json`
```json
{
  "name": "amplifier",
  "version": "1.0.0",
  "label": "Amplifier",
  "description": "Microsoft's Amplifier CLI agent",
  "category": "cli",
  "cli": {
    "command": "amplifier",
    "envVar": "AMPLIFIER_CMD",
    "resumeArgs": ["resume", "{{sessionId}}"]
  },
  "picker": {
    "shortcut": "A",
    "group": "agents"
  }
}
```
**Success:** valid against the manifest schema (`server/extension-manifest.ts`); picker shortcut `A` is unused (claude=`L`, codex=`X`; gemini/kimi/opencode have none). If an existing manifest test enumerates extensions (e.g. a snapshot), update it.

### Task 2 — CodingCliProvider
**File (new):** `server/coding-cli/providers/amplifier.ts` — export `const amplifierProvider: CodingCliProvider`.
Mirror `server/coding-cli/providers/codex.ts` structure. Interface is `server/coding-cli/provider.ts`.

Implement:
- `name: 'amplifier'`, `displayName: 'Amplifier'`, `homeDir = process.env.AMPLIFIER_HOME || path.join(os.homedir(), '.amplifier')`.
- `getSessionGlob()` → `path.join(homeDir, 'projects', '**', 'sessions', '**', 'metadata.json')` (glob **metadata.json**, NOT transcript — transcripts can be tens of MB).
- `getSessionRoots()` → `[path.join(homeDir, 'projects')]`; `getSessionWatchBases?()` → `[path.join(homeDir, 'projects')]`.
- `listSessionFiles()` → recursively find `**/sessions/**/metadata.json` under the projects dir (reuse the repo's jsonl/file-walk helper if one exists, else `fs` walk). Exclude `*.backup`.
- `parseSessionFile(content, filePath)` → `ParsedSessionMeta`:
  - Parse `content` as JSON (the metadata.json).
  - `sessionId ← session_id`; `cwd ← working_dir`; `title ← name`; `summary ← description`;
    `createdAt ← Date.parse(created)`; `lastActivityAt ← max(parse(description_updated_at | name_generated_at | created))`;
    `messageCount ← turn_count`; `isSubagent ← parent_id != null`.
  - `firstUserMessage`: **best-effort, bounded** — read only the first ~64KB of the sibling
    `transcript.jsonl` (`path.join(path.dirname(filePath), 'transcript.jsonl')`), take the first
    `{"role":"user"}` line, use its `content` (string) truncated to a sane length. On any error or
    large/missing file, skip (leave undefined). **Never read the whole transcript.**
- `resolveProjectPath(filePath, meta)` → `meta.cwd ? resolveGitRepoRoot(meta.cwd) : 'unknown'` (use the same git-root helper codex uses).
- `extractSessionId(filePath, meta?)` → `meta?.sessionId || <basename of the session dir>` (the dir name is the id).
- `getCommand()` → `process.env.AMPLIFIER_CMD || 'amplifier'`.
- `getResumeArgs(sessionId)` → `['resume', sessionId]`.
- `getStreamArgs(options)` → return a reasonable default (`['run', '--output-format', 'json', options.prompt]`) — unused because streaming is off.
- `parseEvent(line)` → parse a `transcript.jsonl` line into `NormalizedEvent[]`:
  - `{role:'user'}` → `message.user`; `{role:'assistant'}` → `reasoning` for `thinking` blocks + `message.assistant` for `text` blocks; `{role:'tool'}` → `tool.result`. Unknown/blank → `[]`. Keep it small and total.
- `supportsLiveStreaming()` → `false`. `supportsSessionResume()` → `true`.

**Test (new):** `test/unit/server/coding-cli/amplifier-provider.test.ts` (mirror `codex-provider.test.ts`). Cover:
- `parseSessionFile` maps interactive metadata → correct `ParsedSessionMeta` (title, cwd, createdAt, messageCount).
- `parseSessionFile` sets `isSubagent: true` when `parent_id` present.
- `extractSessionId` returns the `session_id`.
- `getResumeArgs('abc')` deep-equals `['resume', 'abc']`.
- `getSessionGlob()` ends with `projects/**/sessions/**/metadata.json`.
- `parseEvent` maps a user line and an assistant text line correctly; returns `[]` for blank.
- `supportsLiveStreaming()===false`, `supportsSessionResume()===true`.

**Fixtures (new):** `test/fixtures/coding-cli/amplifier/interactive.metadata.json`, `subagent.metadata.json`, `transcript.jsonl` (a few sanitized lines). Mirror `test/fixtures/coding-cli/codex/`.

### Task 3 — Register the provider
**File:** `server/index.ts`
- Add import near line 26–28: `import { amplifierProvider } from './coding-cli/providers/amplifier.js'`.
- Line 201: `const codingCliProviders = [claudeProvider, codexProvider, opencodeProvider, amplifierProvider]`.
- Nothing else here (indexer + session manager both consume this one array).

### Task 4 — MCP injection
**File:** `server/mcp/config-writer.ts` — add a case to `generateMcpInjection`'s `switch(mode)` (after `kimi`, before `opencode`):
```ts
case 'amplifier': {
  // Amplifier reads MCP config from $AMPLIFIER_MCP_CONFIG (tool-mcp discovery chain).
  // Standard { mcpServers: { freshell: { command, args } } } — same file the others use.
  const filePath = writeMcpConfigFile(terminalId, platform)
  return { args: [], env: { AMPLIFIER_MCP_CONFIG: filePath } }
}
```
Cleanup already handled: `cleanupMcpConfig` unlinks the tmp file for all file-based modes.

**Test:** extend `test/unit/server/mcp/config-writer.test.ts`:
- `generateMcpInjection('amplifier', 'term-x')` returns `args: []` and `env.AMPLIFIER_MCP_CONFIG` = an existing file path whose JSON parses to `{ mcpServers: { freshell: { command: 'node', args: [...] } } }`.

### Task 5 — Client icon
**File:** `src/components/icons/provider-icons.tsx`
- Add `export function AmplifierIcon(props: IconProps) { ... }` (a simple SVG mark; match the shape/size of the other provider icons).
- Register in `PROVIDER_ICONS` (line ~139): add `amplifier: AmplifierIcon`.

### Task 6 — Default-enable in the picker
**File:** `shared/settings.ts`
- If `DEFAULT_ENABLED_CLI_PROVIDERS` (used at ~line 808) is a static list, add `'amplifier'`.
- If `CliProviderNameSchema` (used at ~lines 713/758) is a **closed `z.enum`**, add `'amplifier'` to it. If it's an open `z.string()`, no change. **Verify which and act accordingly.**
- Likewise verify `CodingCliProviderSchema` in `shared/ws-protocol.ts` (~line 45): if open string, no edit; if enum, add `'amplifier'`. (Also confirm `migrateLegacyDefaultEnabledProviders` in `server/index.ts` auto-enables newly discovered CLIs — if so, Task 6 may be a no-op beyond types.)

### Task 7 — Docs
**File:** `README.md` (the CLI-agents / env-var section, near `CODEX_CMD`/`CLAUDE_CMD`)
- Add an `AMPLIFIER_CMD` row.
- Add a short note: *"Amplifier loads the freshell MCP only if its bundle mounts `tool-mcp` (the default `anchors` bundle does not). Add `tool-mcp` to your Amplifier bundle to enable orchestration."*

---

## Verification (the gate — must show real output)

Run from the repo root and paste results:
1. `npm run typecheck` — **0 errors** (client + server; catches ESM `.js` + any enum edits).
2. `npx vitest run test/unit/server/coding-cli/amplifier-provider.test.ts test/unit/server/mcp/config-writer.test.ts` — **all green**.
3. `npm run test:unit` — no regressions in the coding-cli / mcp suites.
4. `npm run lint` — clean (client icon).
5. **Real Amplifier launch smoke** (satisfies "actually launch amplifier"):
   - Always: `amplifier --version` exits 0 (proves the binary launches).
   - Gated on a provider key being present in the env: `amplifier run --output-format json "say OK"` returns a JSON envelope with `status: "success"`. If no key, skip with a clear message (do not fail).
   - Put this in `test/integration/real/` mirroring `coding-cli-session-contract.test.ts` (gated behind the same real-test opt-in), OR a `scripts/` smoke — match the existing real-test convention.

**Definition of done:** Tasks 1–7 implemented; steps 1–4 green with pasted output; step 5 launches the real `amplifier`. Report any gap instead of guessing.

## Known limitations (carry into the PR description)
- MCP loading requires the user's Amplifier bundle to mount `tool-mcp` (default `anchors` does not). Injection is present and correct; activation is an Amplifier-side prerequisite.
- No live-streaming provider path (`supportsLiveStreaming=false`) — history + resume only, like gemini/kimi.
- No model/sandbox/permission launch flags (Amplifier's REPL doesn't accept them).
