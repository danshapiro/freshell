# Codex Pane Lifecycle Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell treats each coding-agent pane as one unit — its screen (the agent TUI in the PTY), its agent main process (for Codex, the native `codex app-server` started by the Node `codex` launcher), and everything that process started — tracked by the existing per-conversation owner registry, so that killing a pane leaves no agent process behind and releases the conversation lock before the kill is reported done, killing and immediately reopening a Codex conversation never produces "This conversation is open in another app", every way back into a conversation goes through that registry, and all eighteen defects in the agreed design are fixed: (1) "free" is published before Codex exits; (2) the launcher is force-killed first, orphaning the app-server; (3) sidecar stops run through one shared queue; (4) entry points back into a conversation don't wait for the old Codex to exit; (5) Shift-X skips panes that are still starting; (6) "terminal not found" counts as a successful kill; (7) the sidecar record tracks only one conversation id and isn't updated on fork; (8) another device can re-create a killed conversation; (9) a server restart or crash mid-stop leaves the record "active" and offers a dying app-server for reuse, and a Shift-X racing a graceful shutdown becomes "keep for reuse"; (10) MCP/CLI kill-tab and kill-pane only close, and respawn-pane leaves the old terminal running; (11) the Codex activity tracker ignores helper threads; (12) on macOS and Windows the sidecar is orphaned on every close; (13) other coding-agent panes (for example Claude Code, whose shell commands run in separate sessions) leak processes the same way; (14) three inconsistent idle-cleanup rules; (15) app-server death is only logged; (16) no stop logging and log retention of only about 12 hours; (17) unrealistic test fakes and Codex browser specs skipped on the cloud runner; (18) missing README coverage and accessibility gaps.

### Explicit constraints
- Use the existing owner registry in `crates/freshell-ownership` (Live / Stopping / Vacant) as the unit's Running / Stopping / Gone states; do not build a second state machine.
- Gone means the screen and the agent main process are confirmed dead and the conversation lock is released; it does not wait for every descendant. Leftover descendants are force-killed right after Gone and any survivors are logged.
- `terminal.exit`, `terminals.changed`, and Vacant are published only at Gone.
- Stopping is saved in the persisted record before any signal is sent; on server boot a Stopping unit has its stop finished and is never offered for reuse.
- The sidecar record tracks every thread its app-server holds (root, helper agents, forks, earlier conversations opened in that pane), found from the OS lock table or by asking the app-server which threads it has loaded.
- Each unit is stopped independently, not through one shared stop queue.
- Shift-X ("kill it now"; kill-then-immediately-reopen is a core workflow): send SIGINT to the agent main process, SIGKILL whatever is left (including the launcher) after 1 second, then kill all remaining descendants — including jobs the agent deliberately detached (dev servers, `nohup`, `setsid`) — found through OS containment, not a process-tree walk.
- Shift-X acknowledges only at Gone, and the tab closes only after that acknowledgement.
- Shift-X also applies to panes that are still starting, and cancels the start.
- "Not found" counts as kill success only when the registry confirms Gone; a second kill waits for the first; Shift-X on a unit that is already Stopping escalates straight to force.
- If Gone is not confirmed within 5 seconds, the tab stays open showing "Stopping…" until it is confirmed.
- A plain close (no Shift) leaves the unit running; reopening (Shift+Alt+T or the sidebar) reattaches to it; reopening never kills.
- Replace the three idle-cleanup rules (the "Auto-kill idle (minutes)" setting, the hidden 24-hour agent-pane cap, and the one-time 30-minute post-boot sweep) with one rule based on real idleness, keeping 24 hours for agent panes.
- Idle is determined by asking the agent directly: every loaded thread, including helper threads, idle across a quiet window, nothing queued, and no automatically continuing goal. A pane waiting for the user's approval or input is not idle and cleanup leaves it alone.
- Cleanup sends a polite stop; if the unit is not Gone within a few seconds it is force-killed and a warning is logged. There is no "finishing up" waiting screen and no one-hour backstop.
- Every way back into a conversation goes through the registry and waits for Gone: auto-resume, the "Agent appears stuck" Restart, the exit banner's Relaunch/Reopen, a sidebar click, the Resume dialog, switching a pane between terminal Codex and freshcodex, MCP `respawn-pane`, and other devices.
- If the conversation is already held by a live Freshell pane, as its main conversation or as an extra thread, reopening jumps to that pane with no prompt and no new UI.
- If the conversation is held by something outside Freshell (a shell `codex`, Codex's own daemon or desktop app, `codex exec`), Freshell does not wait forever and reports who holds it (process id and command).
- An app-server that dies mid-reply is a crash: bell, highlight, and auto-resume as today, with auto-resume waiting for Gone. App-server death must be detected, not only logged.
- If only the screen crashes and the agent is fine, start a new screen and reattach it to the running agent.
- If the agent exits on its own, the whole unit ends and nothing is left behind.
- A kill on one device shows the pane as plain "Stopped" on other devices using the existing stopped presentation, with no new wording and no automatic re-create; killed units are remembered so late-arriving or offline devices show Stopped instead of re-creating the conversation.
- Running sidecars still survive a server restart and are reclaimed as today; Stopping units stay Stopping across a restart and their stop is finished on boot; a kill always beats the keep-on-restart rule.
- MCP/CLI `kill-tab` and `kill-pane` behave like Shift-X; add separate close commands for detaching; `respawn-pane` goes through the registry.
- Contain each coding-agent pane's whole process set with the OS: a cgroup per pane on Linux, a Job Object per pane on Windows, and the best available equivalent on macOS. The Windows desktop app and macOS are in scope.
- Containment is built once, generically, for every coding-agent pane (Claude Code, Codex, OpenCode, Gemini, Kimi, and the rest); Codex is done first.
- Keep new UI minimal: add only a sidebar marker for agents running in the background and stopping, a right-click "Close and stop agent" on tabs and panes as the keyboard- and screen-reader-accessible equivalent of Shift-X, and a screen-reader label on the tab X; "Stopping…" appears in the tab only in the rare unconfirmed case; invent no other UI.
- Shift-X and cleanup stops are silent; restarted panes must not produce a "went idle" or "turn complete" highlight; a crash mid-reply still rings as today and is never routed through the silent kill path.
- Structured JSONL logging with severity, keyed by conversation, terminal, and owner: stop requested (reason; graceful or force), signal sent, Gone (duration, lock released), escalation (warn), unconfirmed (error), time spent waiting before a start, and an error whenever "already has an active writer" / "open in another app" occurs. Fix log retention to cover at least the cleanup window and reduce the HTTP request-line noise.
- Remove overbuilding: once containment and confirmed kills are in place, remove owner-registry blocking machinery that exists only because Freshell could not confirm a process died (for example "platform-limited" fences and buttons like "Force clear the platform-limited fence"). Build no plug-in framework for other providers' login restarts.
- README covers Shift+click and the right-click equivalent to kill, that a plain close keeps the agent running and reopen reattaches, and how to stop a background agent; update `docs/index.html` only for the sidebar marker, if it is significant.
- Tests: realistic fakes (a Node launcher in front of a separate main process; SIGTERM finishes the reply before exiting; SIGINT stops at once; a helper in its own process group and a shell command in its own session; a detached job; the flock-based "already has an active writer" refusal); Rust integration tests for Shift-X mid-turn, kill during start, double kill, kill vs auto-resume race, restart during Stopping, fork then restart and restore, extra-thread holder reopen, outside holder reported, unconfirmed kill keeps the record and logs an error, one test per entry point including `kill-pane`/`kill-tab`/`respawn-pane`, cleanup idleness (helpers, queued messages, goals; waiting-on-approval not idle), and sidecars still surviving a server restart; client unit tests (not-found is not success, Shift-X targets starting panes, other devices show Stopped and don't re-create, kills and restarts stay silent); browser e2e (kill mid-turn then immediate reopen with no "open in another app", plain close then reopen reattaches, right-click "Close and stop agent", sidebar marker) passing on the configured cloud e2e backend, with the "Requires codex binary" cloud skip removed for fake-based specs; an opt-in real-Codex contract test that SIGINT/SIGKILL releases the lock and resume works; and a Windows desktop app smoke test that kill-then-reopen works.
- Do not restart, signal, or modify Codex's own managed daemon (`codex app-server --managed-daemon`).
- No polling: new waiting and detection use OS or process events, not periodic checks.
- Never restart the live self-hosted Freshell server on port 3001 without the user's explicit "APPROVED"; do not kill or signal processes this work did not start, and verify process ids first.
- Never copy `~/.codex/auth.json` and never log tokens.
- Work in a dedicated `.worktrees/<slug>` worktree; never dirty `main`; use pnpm; do not create a PR or merge without the user's explicit approval.

### Accepted tradeoffs and residuals
- Shift-X is forceful: a turn killed by SIGKILL may show as "interrupted" when the conversation is resumed.
- Gone does not wait for every descendant; descendants that survive the follow-up kill are only logged.
- Freshell does not restart or repair Codex's own managed daemon after a login switch; that is left to upstream (openai/codex#22419).
- Automatic restart of Codex panes when the Codex login changes is deferred to a separate later build that reuses this work's registry and kill paths.
- A comment on openai/codex#22419 is deferred and will not be posted until the user approves its text.

**Goal:** Every coding-agent pane becomes one OS-contained unit whose Running / Stopping / Gone state is the owner registry's Live / Stopping / Vacant, so Shift-X (and every other stop) confirms the agent and its conversation lock are gone before anything reports success, every path back into a conversation waits for that, and nothing the pane started is left running.

**Architecture:** A new leaf crate `freshell-containment` gives every coding-agent pane a contained process set (a systemd transient scope slice per pane on Linux, a Job Object per pane on Windows, an environment-tagged process set on macOS and on Linux hosts without a user systemd manager), an event-driven per-process exit watch (`ProcWatch`: pidfd / kqueue / process handle), one stop sequence (SIGINT main → 1 s → kill the whole unit → confirm screen, main and lock gone → sweep and log survivors), and OS lock-holder and listening-socket lookups. The owner registry gains event-driven waiting (wakers, no polling), unit-scoped stop/commit, extra-thread holds and a boot seed for persisted Stopping units; the WebSocket layer gets one unit lifecycle module that owns kill, crash, screen-respawn and cleanup decisions and publishes `terminal.exit` / `terminals.changed` / Vacant only at Gone; the Codex sidecar record (v2) persists Stopping, the unit id, the native main process and every held thread. The client sends kills by terminal id or create-request id, acknowledges only at Gone, shows "Stopping…" in the rare unconfirmed case, and shows the existing "stopped" presentation on other devices.

**Tech Stack:** Rust 1.96 (tokio 1.52, libc 0.2.186, windows-sys 0.59 for Windows only, tracing), systemd 255 user manager (`systemd-run --user --scope`, `busctl`), cgroup v2 (`cgroup.kill`, `cgroup.events`, `cgroup.freeze`), Linux pidfd, macOS kqueue + `lsof`, Windows Job Objects / Restart Manager / IP Helper; React 18 + Redux Toolkit + Vitest; Playwright (cloud e2e backend); Node fakes in `test/fixtures/coding-cli/codex-app-server/`.

## Global Constraints

- Everything in the `## User Request` block above is binding; this section restates the project-wide mechanics every task must honor.
- Work only in `/home/dan/code/freshell/.worktrees/codex-pane-lifecycle/` on branch `the-usual/codex-pane-lifecycle`. Never touch the main checkout. Never push to `origin/main`, never open a PR, never merge. Pushing the feature branch is allowed only where a task says so (to dispatch `electron-build.yml` / `rust-tests.yml` with `workflow_dispatch`).
- Commit identity is preconfigured (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`). Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- pnpm 10.34.5 only (`pnpm install --frozen-lockfile`, `pnpm run <script> <args>` with no `--`). Never `npm ci`/`npm install` in this tree.
- Rust toolchain 1.96.0. A new workspace crate or dependency edge needs one unlocked build (`cargo build -p <crate>`) to update `Cargo.lock`; review the lock diff (only expected packages), then all later commands use `--locked`. Commit `Cargo.lock` in the same task.
- `crates/freshell-codex` integration tests compile only with `--features real-transport`; never run `cargo test -p freshell-codex --test <file>` without it (it silently runs 0 tests).
- TypeScript tooling and Electron are NodeNext/ESM: relative imports carry `.js` extensions.
- Process safety: tests and tools signal only processes they spawned, identified by pid **and** start time. Never select processes by command name for killing. The single argv inspection allowed is the Codex managed-daemon *exclusion* (argv contains both `app-server` and `--managed-daemon`), which can only spare a process, never target one.
- Never start, stop, restart or signal the live server on port 3001 or `freshell-rust.service`; never edit `~/.config/systemd/user/freshell-rust.service`. Manual worktree servers use a unique port, an isolated `HOME`/`FRESHELL_HOME`/`CODEX_HOME`, a throwaway `AUTH_TOKEN`, and a recorded pid that is verified with `ps -fp` before it is stopped.
- Never read, copy or log `~/.codex/auth.json`; never log tokens (the JSONL writer already scrubs secrets — do not add fields that carry tokens).
- No polling in new code: waiting uses registry wakers, pidfd/kqueue/handle waits, inotify on `cgroup.events`, Job Object completion ports, tokio timers armed for a deadline, or protocol notifications. One-shot reads (`/proc/locks`, a member snapshot at kill time, a lock check at Gone) are allowed; loops that re-check on an interval are not. Existing interval tasks this plan does not touch stay as they are.
- New structured logs use the `event=` field style (target `freshell_unit` for unit lifecycle events), plain values (no `?`-formatted `Option`s), and always carry the keys that exist for the unit: `unit_id`, `provider`, `session_id` (conversation), `terminal_id`, `operation_id` (owner operation).
- Accessibility: every new interactive element is a semantic element with an accessible name; e2e selectors use roles/names (`pnpm run test:e2e:a11y-gate` stays green).
- Cloud e2e/vitest runs need a committed, clean worktree (a dirty tree forces a ~13 minute cold image rebuild). `FRESHELL_E2E_BACKEND=cloud` and `FRESHELL_VITEST_BACKEND=cloud` are already exported on this host; export `GCLOUD_ROBOT_REQUIRE=1` for every cloud lane. Never fall back to the local e2e backend without the user's approval.
- Broad gates: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY="codex-pane-lifecycle: <purpose>" pnpm run check` from the worktree; wait for the shared coordinator if another agent holds it.
- Reference, do not repeat: the repo's testing workflow is documented in `AGENTS.md` (Test Coordination, Destructive Test Sandbox) and `docs/development/test-sandbox.md`; the Windows build flow in `docs/development/windows-electron-build.md`.

---

## Load-bearing assumptions (Stage 2 validates these before execution)

Each assumption names the experiment that confirms it and the task that depends on it. If one fails, the dependent task's design note says what changes.

- **A1 — `systemd-run --user --scope` places and preserves the pid.** On garageserver (systemd 255, linger on, `user@1000.service` `Delegate=yes`), `systemd-run --user --scope --quiet --collect --slice=freshell-agents-u<id>.slice --unit=freshell-u<id>-<role>-<n>.scope -- <cmd>` run (a) from a process inside `freshell-rust.service` and (b) from a process in a root-owned SSH `session-N.scope` (a worktree server started by `scripts/launch-rust.sh`) moves itself into `.../user@1000.service/freshell.slice/freshell-agents.slice/freshell-agents-u<id>.slice/freshell-u<id>-<role>-<n>.scope`, then `exec`s `<cmd>` with the same pid, keeps a PTY session/controlling terminal set up by portable-pty's `pre_exec`, adds at most ~100 ms per spawn, implicitly creates the slice, and garbage-collects scope and slice after they empty. Experiment: run `systemd-run --user --scope ... -- sh -c 'echo $$; cat /proc/self/cgroup; tty; sleep 30'` under `script -qc` from both contexts; compare pids and cgroup paths; time it. Depends: Task 5.
- **A2 — `cgroup.kill`, `cgroup.freeze`, `cgroup.events` work on the user-manager slice.** Writing `1` to `<slice>/cgroup.kill` kills every member of every scope in the slice, including `setsid`/`nohup` jobs; `<slice>/cgroup.freeze` freezes/thaws; `inotify` `IN_MODIFY` on `<slice>/cgroup.events` fires on `populated 1→0` and `frozen 0→1`; the dir is writable by `dan`; zombies do not keep `populated 1`. Experiment: a scratch slice with three scopes, one `setsid` child and one `nohup` grandchild; inotify watcher in Python (`inotify_simple` not needed — use `inotifywait` if installed, else a 20-line ctypes script). Depends: Task 5.
- **A3 — Moving a managed-daemon-shaped process out of a pane slice.** `busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' freshell-spared-<pid>.scope fail 2 PIDs au 1 <pid> CollectMode s inactive-or-failed 0` moves a frozen member of a pane slice into a new scope outside the slice, and the moved process survives a subsequent `cgroup.kill` of the slice. Experiment with `perl -e 'sleep 600' app-server --managed-daemon` started inside a scratch scope. Depends: Task 5.
- **A4 — pidfd semantics.** `pidfd_open` on a non-child pid becomes readable exactly when that process exits (also when it is a not-yet-reaped zombie), `poll(pidfd, 0)` reports it without blocking, and by the time it is readable the process's `flock` locks are released (kernel `exit_files` precedes `exit_notify`). Experiment: Python `os.pidfd_open` + `select.poll` on a grandchild holding `fcntl.flock`; read `/proc/locks` the instant the pidfd fires. Depends: Tasks 2, 4, 10.
- **A5 — Realistic fake lock via util-linux `flock(1)` on an inherited fd.** A Node process that opens a lock file and runs `flock -x -n 3` with that fd mapped to fd 3 keeps an exclusive `flock` on its own open file description after `flock(1)` exits; a second process's `flock -x -n` on the same path fails (exit 1); the lock disappears from `/proc/locks` (by inode) exactly when the Node process exits or is SIGKILLed; the pid column shows the exited `flock(1)` pid. `/usr/bin/flock` and `perl` exist on garageserver, `ubuntu-latest`, the Docker sandbox image (`node:22-trixie`) and the cloud image (`node:22-bookworm`). Experiment: 15-line Node script. Depends: Tasks 1, 32.
- **A6 — Codex 0.162 protocol shapes** (verified 2026-10-09 from `codex app-server generate-ts --experimental`, notes in `<logs_dir>/reports/plan-extra-codex-protocol.md`): `thread/loaded/list`, `thread/read` (status `idle|active{activeFlags}|notLoaded|systemError`), experimental `thread/queue/list`, `thread/goal/get` (status `active|paused|blocked|usageLimited|budgetLimited|complete`), notifications `thread/queue/changed`, `thread/goal/updated`, `thread/status/changed`. Freshell's client already initializes with `experimentalApi: true`. Remaining check: a real app-server answers `thread/queue/list` for a loaded idle thread with `{data: []}`. Depends: Task 22.
- **A7 — Windows placement.** A self-placing shim (`freshell-server.exe __unit-exec --job Local\freshell-unit-<id> -- <cmd...>`) that calls `AssignProcessToJobObject(OpenJobObjectW(name), GetCurrentProcess())` before `CreateProcessW`-ing `<cmd>` works under ConPTY (the child inherits the pseudoconsole) and under tokio piped stdio; the server started by Electron (libuv global job with `SILENT_BREAKAWAY_OK`) and by the GitHub `windows-2022` runner can assign its children to per-unit jobs (nested jobs, Windows 8+); `TerminateJobObject` kills `node.exe` + `codex.exe` + their children; `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` arrives on the completion port; a `LockFileEx` lock is released by the time the process handle is signaled. Experiment: the Task 6 test suite on the `windows-2022` runner via `gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle`. Depends: Tasks 6, 34.
- **A8 — macOS degraded backend.** `kqueue` `EVFILT_PROC`/`NOTE_EXIT` fires for a same-uid non-child pid; `sysctl KERN_PROCARGS2` returns the environment of same-uid processes (so `FRESHELL_UNIT_ID` tags are readable); `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` names the listening pid; `lsof -Fpc <file>` names processes holding the lock file open. Experiment: Task 7 test suite on `macos-latest` via `electron-build.yml` dispatch. Depends: Tasks 7.
- **A9 — GitHub `ubuntu-latest` user manager.** After `sudo loginctl enable-linger "$USER"` and `XDG_RUNTIME_DIR=/run/user/$(id -u)`, `systemctl --user is-system-running --wait` succeeds and `systemd-run --user --scope` works for the runner user. Experiment: dispatch `rust-tests.yml` on the pushed branch after Task 5. If it fails, `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT` is left unset on CI (CI then proves the degraded backend, and the systemd backend is proven on garageserver with the variable set), recorded as a residual in the run state. Depends: Task 5.
- **A10 — Real Codex thread lock without auth.** A real `codex app-server --listen ws://127.0.0.1:<port>` with an isolated, unauthenticated `CODEX_HOME` accepts `initialize` + `thread/start` and creates `$CODEX_HOME/thread-writer-locks/<id>.lock` held by the native process (so the contract test never needs `~/.codex`). If `thread/start` needs auth, the contract test reads the user's existing `CODEX_HOME` path from `FRESHELL_REAL_CODEX_HOME` (never copying `auth.json`) and archives the thread it created at the end. Depends: Task 33.
- **A11 — The 13-second hold (design §1.3) is an extra-thread hold.** The 2026-10-08 `01a10459` refusal that cleared "within about a minute" matches Codex's ~60 s unload of an unsubscribed extra thread in another live app-server (design fact 3.5). No separate fix is planned: per-thread registry tracking, jump-to-holder, the outside-holder report and the `unit.writer_conflict` error log (which names the holder pid) cover and diagnose it. Not an execution blocker; Stage 2 only confirms nothing in the logs contradicts it.

## Decisions (made here, within the User Request)

1. **Reopen of a conversation held as an extra thread (coordinator note 1, design §8.1).** Reopening jumps to the live pane whose unit holds the thread, even when that pane displays a different conversation; no prompt, no new UI, and nothing is released or killed. Rationale: the User Request says reopening jumps to the holding pane "as its main conversation or as an extra thread" with no prompt and no new UI, and that reopening never kills; releasing an idle extra in place would need Codex to unload it (≈60 s after `thread/unsubscribe`, design fact 3.5), which either stalls the reopen or requires killing the holder. If the holder unit has no pane on this device (it was plain-closed), the reopening pane attaches to the holder's terminal (the normal reattach). Tested in Task 13 (server answer) and Task 26 (client jump).
2. **Signalling the native process (design §8.2).** Freshell keeps spawning `CODEX_CMD` (users run wrappers such as `~/.local/bin/codex` → `node …/codex.js`, or `codex.cmd` on Windows), discovers the native app-server as the process that owns the app-server's listening socket, and signals it directly through its pidfd/handle. It never relies on `codex.js` forwarding (which forwards only the first signal and orphans the native on SIGKILL). Escalation kills the whole unit, which includes the launcher. If discovery fails, the launcher is the main process and a warning is logged.
3. **`kill_verified_sidecar_tree` (design §8.3).** Replaced, not reused: reattached sidecars are stopped through their reopened containment unit; the tree walk, its 50 ms polling loops and the `/proc` tag reaper (`reap_owned_codex_sidecars`) are deleted (the tag scan survives only as the degraded backend's member finder, generalized to `FRESHELL_UNIT_ID` plus the legacy `FRESHELL_CODEX_SIDECAR_ID` for v1 records).
4. **macOS containment (design §8.4).** Environment tag `FRESHELL_UNIT_ID` + process-tree enumeration (`libproc`) + a stop-the-world `SIGSTOP` sweep then `SIGKILL`, with kqueue `NOTE_EXIT` for confirmed exit. Reported as the `macos-tag` backend (degraded: no `wait_empty`, same Gone semantics).
5. **Managed runtime (design §8.5).** Out of scope for the new containment: managed-runtime panes (shell and opencode in Docker souls) are already contained by their container and keep `managed_stop`; production Codex panes are not managed (`managed_enabled: false`). No code changes to `freshell-session-host` beyond compiling against changed signatures.
6. **Plain shell panes under the single cleanup rule (coordinator note 6).** One rule for every terminal pane: a pane with no attached viewer that has been really idle for 24 hours is politely stopped. "Really idle" is asked from the agent for coding-agent panes and, for plain shells, means the shell is at its prompt (the PTY's foreground process group is the shell itself) with no screen activity. The "Auto-kill idle (minutes)" setting is removed, so detached shells now live up to 24 hours idle instead of 15 minutes.
7. **`docs/index.html` (coordinator note 6).** Only the sidebar marker is added (it is a new, always-visible sidebar element, so it is significant). The mock's "Auto-kill idle (minutes)" slider row is left untouched because the User Request limits `docs/index.html` edits to the sidebar marker; the final report lists it as a stale mock row.
8. **REST/MCP/CLI kill when Gone is not confirmed within 5 s (coordinator note 6).** `POST /api/panes/{id}/kill` and `POST /api/tabs/{id}/kill` wait up to 5 s: on Gone they close the pane/tab and answer `200 {"ok":true,"status":"stopped"}`; otherwise they answer `202 {"ok":false,"status":"stopping"}`, leave the tab open (clients show "Stopping…"), and close it automatically when Gone is confirmed. MCP/CLI print the status.
9. **`respawn-pane` when another live pane holds the conversation (coordinator note 6).** It stops the target pane's own unit first (waiting for Gone), then claims the conversation through the registry; if a different live pane holds it, it is not killed (reopening never kills) and the route keeps today's typed 409 refusal (`RESTORE_UNAVAILABLE`, "still running on the server") with an added `holderPaneId`/`liveTerminalId`, so `mcp-bridge-rust.spec.ts:540-575` stays valid.
10. **Killed-unit memory for late/offline devices.** A durable `StoppedPaneRecord` (pane ledger, keyed by terminal id and create-request id, kept 30 days) is written at Gone of every requested stop. Attach to an unknown terminal answers `INVALID_TERMINAL_ID` with `terminalStopped: true`; reconcile answers the new verdict `stopped`; both fold to the existing "session was stopped — reopen it to resume this conversation" bar. Devices offline longer than 30 days fall back to today's behavior (recorded residual).
11. **Windows soft interrupt.** Windows has no SIGINT for a console-less sidecar; Shift-X there writes Ctrl+C (ETX) into the unit's PTY screen when it has one, and otherwise proceeds straight to `TerminateJobObject` (logged as `signal: "none"`, `reason: "windows-no-console"`). Windows keeps "sidecars are not retained across a server restart" (`KILL_ON_JOB_CLOSE`), as today.
12. **`kill_all` timing.** The 1 s is the maximum grace for the main process after SIGINT; the rest of the unit is killed as soon as the main process exits or the second elapses, whichever is first (no idle waiting once the main process is gone).
13. **Codex TUI exits.** A Codex screen that exits with code 0 while the app-server lives is the user quitting Codex: the whole unit ends. A non-zero screen exit with the app-server alive is a screen-only crash: the screen is restarted in the same terminal row (same terminal id) against the running app-server, capped by the existing respawn liveness window.
14. **Fresh-agent pane X.** A plain pane-header X on a fresh-agent pane now detaches (like every plain close); Shift+click on the pane X and the right-click item stop the agent. This makes "plain close leaves the unit running" true for every pane type.
15. **freshopencode.** freshopencode panes share one `opencode serve` daemon by design; that daemon runs as one contained unit (its whole process tree is killed and confirmed on discard, crash and shutdown), and per-pane containment does not apply to it: stopping a freshopencode pane ends its session, never the shared daemon. Terminal-mode OpenCode panes are ordinary per-pane units.
16. **Retention.** Log retention is fixed by moving successful HTTP request lines to DEBUG (96.6% of today's volume); the existing 3 × 10 MiB rotation then holds about two weeks, well over the 24-hour cleanup window, so rotation sizes are not changed.
17. **Sidebar "stopping" signal.** A live `session.runtimeOwner{transition:"stopping"}` frame is broadcast when a stop begins (it is not one of the Gone-only publications); the sidebar marker and the reconnect replay both use the owner record, so no new list endpoint field is needed.
18. **Realistic fake's lock.** The fake native takes a real `flock(2)` on its own open file description through util-linux `flock -x -n` on an inherited fd (A5) instead of a Rust or Python helper: it keeps all of the existing Node fake's protocol behaviors in one process, the lock lives and dies with the native exactly like Codex's `O_CLOEXEC` `File::try_lock`, and the only difference (the `/proc/locks` pid column names the exited `flock(1)`) is irrelevant because Freshell identifies its own holders by unit membership and checks release by inode. Outside-holder tests use `flock -x <file> <cmd>` (whose pid IS the holder).
19. **Linux backends.** Two only: systemd transient scopes (full, kernel-tracked) and the tag backend (degraded). No raw-cgroupfs backend is built: no supported host offers a writable delegated cgroup without also offering a user manager (the Docker sandbox and Cloud Run mount cgroupfs read-only; garageserver and, per A9, CI have a user manager), so it would be unused code.

## Defect and constraint traceability

| Item | Fixed by (task) | Proven by (test) |
|---|---|---|
| (1) "free" published before Codex exits | 11, 12, 13 | `unit_kill.rs::shift_x_mid_turn_publishes_exit_and_vacant_only_after_gone` |
| (2) launcher force-killed first | 4, 10 | `launch_lifecycle.rs::force_stop_signals_native_first_and_kills_launcher_last` |
| (3) one shared stop queue | 10 | `launch_lifecycle.rs::units_stop_independently` |
| (4) entry points don't wait | 8, 15, 17, 19, 20 | `unit_entry_points.rs` (create, restore, stuck restart, auto-resume, attach), `session_handoff/tests.rs::handoff_from_a_codex_terminal_unit_waits_for_gone`, `codex.rs::a_fresh_codex_create_during_a_recovery_stop_waits_and_succeeds`, `automation_unit_kill.rs::respawn_pane_…`, `unit_stopped_memory.rs` (other devices) |
| (5) Shift-X skips starting panes | 12, 13, 25 | `unit_kill.rs::kill_during_start_cancels_the_start`; `closeAndStopThunks.test.ts` |
| (6) "not found" = success | 13, 25 | `unit_kill.rs::an_unknown_terminal_is_success_only_because…`, `unit_lifecycle` lib test; `kill-ack.test.ts` |
| (7) record tracks one thread, fork not tracked | 9, 14, 19 | `unit_threads.rs`, `codex_fork_rebind.rs::fork_rebind_keeps_both_threads…`, `restart_during_stopping.rs` |
| (8) another device re-creates a killed conversation | 18, 27 | `unit_stopped_memory.rs`; `TerminalView.stopped.test.tsx`, `pane-reconcile.test.ts` |
| (9) restart mid-stop / Shift-X racing shutdown | 9, 10, 19 | `restart_during_stopping.rs` (crash mid-stop, kill racing graceful shutdown); `launch_lifecycle.rs::kill_beats_shutdown_retention` |
| (10) automation kill only closes; respawn leaves old running | 20 | `automation_unit_kill.rs`; `freshell-tool.test.ts`; `commands.test.ts` |
| (11) activity ignores helper threads | 21 | `freshell-activity` codex tests |
| (12) macOS/Windows orphan the sidecar | 6, 7, 10, 23, 34 | `windows_job.rs` / `macos.rs` / conformance on runners; `agent-unit-kill-reopen.test.ts` |
| (13) other agents leak | 23 | `unit_other_agents.rs` |
| (14) three cleanup rules | 22 | `unit_idle_cleanup.rs`, `idle_probe.rs`, settings PATCH test |
| (15) app-server death only logged | 17 | `unit_crash.rs::app_server_death_mid_reply_is_a_crash…` |
| (16) no stop logging; short retention | 2, 4, 16, 30 | `unconfirmed.rs`, `unit_outside_holder.rs`, `unit_log_schema.rs`, `logging.rs` retention test |
| (17) unrealistic fakes; cloud-skipped Codex specs | 1, 32 | `realistic_fake.rs`; cloud e2e run |
| (18) README and accessibility gaps | 25, 26, 29, 31 | `TabItem.test.tsx`, `menu-defs.test.ts`, `ContextMenuProvider.test.tsx`, `SidebarItem.agent-state.test.tsx`, a11y gate |
| Registry is the state machine (no second one) | 8, 24 | `unit_scope_tests.rs` |
| Persisted Stopping before any signal; finished on boot | 10, 19 | `force_stop_signals_native_first…` (record snapshot at signal = `stopping`); `restart_during_stopping.rs` |
| Every held thread tracked | 14 | `unit_threads.rs` |
| Shift-X sequence (SIGINT, 1 s, kill all incl. detached) | 4, 5, 6, 7, 10 | `conformance.rs`, `launch_lifecycle.rs`, `unit_kill.rs` |
| Ack only at Gone; tab closes after; Stopping… after 5 s | 13, 25 | `unit_kill.rs`, `unit_kill_unconfirmed.rs`, `closeAndStopThunks.test.ts` |
| Second kill waits; Shift-X on Stopping escalates | 4, 13 | `conformance.rs::a_second_force_stop_joins…`, `force_on_a_graceful_stop_escalates…`; `unit_kill.rs::a_second_kill_joins…` |
| Plain close keeps running; reopen reattaches | 20, 25, 32 | `automation_unit_kill.rs::close_pane_detaches…`; `PaneContainer.test.tsx`; e2e plain-close spec |
| Extra-thread holder reopen jumps (decision 1) | 14, 27 | `unit_threads.rs::reopen_of_an_extra_thread…`; `reopen-jump.test.ts` |
| Outside holder reported (pid + command) | 3, 16, 27 | `locks_listener.rs`, `unit_outside_holder.rs`, `TerminalView.stopped.test.tsx` |
| Crash rings + auto-resume after Gone; screen-only restart; self-exit ends unit | 17, 23 | `unit_crash.rs`, `unit_other_agents.rs::an_agent_exiting_on_its_own…` |
| Running sidecars survive restart | 19 | `restart_during_stopping.rs::running_sidecars_survive_a_restart…` |
| Containment on every OS, generic for every agent | 2–7, 23 | conformance suites, `unit_other_agents.rs` |
| Minimal UI only | 25, 26, 29 | client tests listed above; no other UI is added by any task |
| Silent kills/cleanup; restarts don't highlight; crashes ring | 13, 17, 22, 25 | `unit_crash.rs` (screen restart emits no idle/exit; crash emits idle), `turnCompletionAttention.test.ts` |
| Structured logging keyed by conversation/terminal/owner | 2, 4, 15, 16, 30 | `unit_log_schema.rs` |
| Overbuilding removed | 24, 28 | `unit_scope_tests.rs::an_unconfirmed_stop_stays_stopping_until_gone`, handoff tests, banner/selector tests |
| Managed daemon never signalled | 4, 5, 6 | `conformance.rs::the_codex_managed_daemon_is_never_signalled`, `windows_job.rs` |
| No polling in new waits/detection | 2, 4, 5, 6, 8, 12, 15, 22 | each wait is proven event-driven by a test that observes it waking on the event (`wait_settled_wakes_on_the_gone_commit_without_polling`, `exited_fires_for_a_non_child…`, `wait_start_cancelled` wake test, `unit_entry_points.rs`) |
| README / docs/index.html | 28, 29, 31 | Task 31 Step 4/6 checks; Task 29 marker |
| Real-Codex contract | 33 | `test/integration/real/codex-lock-release.test.ts` |
| Windows desktop app smoke | 34 | `test/integration/electron/agent-unit-kill-reopen.test.ts` on `windows-2022` (+ DANDESKTOP when reachable) |

## File map (responsibilities)

New crate `crates/freshell-containment/` (leaf: `libc`, `tokio`, `tracing`, `serde`, `serde_json`, `uuid`; `windows-sys` on Windows only):
- `Cargo.toml` — crate manifest; `[[bin]] freshell-unit-exec` (test shim binary, `src/bin/freshell-unit-exec.rs`).
- `src/lib.rs` — module wiring and re-exports.
- `src/unit_id.rs` — `UnitId` (dash-free `u` + 32 hex), `UNIT_ENV = "FRESHELL_UNIT_ID"`.
- `src/process.rs` — `ProcIdentity`, `identity(pid)`, `is_codex_managed_daemon(argv)`, per-OS process facts (start time, argv, environ, children).
- `src/proc_watch.rs` — `ProcWatch` (event-driven exit + identity-pinned signals) per OS.
- `src/backend/mod.rs` — internal `Backend` trait, `BackendKind`, `Capability`.
- `src/backend/systemd.rs` — Linux systemd transient-scope backend (slice per unit, `cgroup.kill`, `cgroup.events`, `cgroup.freeze`, managed-daemon spare).
- `src/backend/tag.rs` — Unix tag backend (Linux `/proc` and macOS `libproc`/`sysctl`), stop-the-world sweep.
- `src/backend/windows_job.rs` — Windows Job Object backend + completion port.
- `src/exec_shim.rs` — `unit_exec_main` (Windows self-placement; elsewhere a plain exec used only by tests).
- `src/containment.rs` — `Containment` (backend selection, `create_unit`, `reopen_unit`, `adopt_legacy`, `surviving_units`, global handle).
- `src/unit.rs` — `AgentUnit`, `MemberRole`, `Placement`, `StopRequest`, `StopMode`, `StopReason`, `StopHandle`, `StopReport`, the single stop sequence.
- `src/directory.rs` — `UnitDirectory` (unit id ↔ terminal id / create-request id, start cancellation, register hook).
- `src/locks.rs` — `LockHolder`, `lock_holders(paths)`, `codex_thread_lock_path`.
- `src/listener.rs` — `listening_socket_owner(port, candidates)`.
- `src/events.rs` — `UnitLogKeys` and every `freshell_unit` JSONL event.
- `src/testing.rs` — env-gated test hook (`FRESHELL_TEST_HOOKS=1` + `FRESHELL_TEST_UNIT_GONE_DELAY_MS`).
- `tests/conformance.rs`, `tests/support/mod.rs` — backend conformance suite run against the selected backend and the tag backend.

Existing files (one responsibility each, listed by owning task):
- `crates/freshell-ownership/src/lib.rs` — waker-based `wait_settled`, `AlreadyStopping`, unit-scoped stop/commit, extra-thread holds, boot seed (Task 8); Fenced removal (Task 24).
- `crates/freshell-codex/src/sidecar_store.rs` — record v2 (Task 9).
- `crates/freshell-codex/src/launch_lifecycle.rs` — sidecar spawned into the unit, main discovery, per-unit stop, retention vs kill (Task 10); held threads (Task 14).
- `crates/freshell-codex/src/sidecar_reconcile.rs`, `runtime_select.rs`, `transport.rs` — reattach through units, claim by any held thread (Tasks 9, 10, 19); `sidecar_sweep.rs` deleted (Task 22); tag reaper deleted (Task 23).
- `crates/freshell-codex/src/idle_probe.rs` (new) — direct Codex idleness query (Task 22).
- `crates/freshell-terminal/src/registry.rs` — unit rows, ending intent, `complete_unit_end`, `replace_screen`, screen-exit hook (Task 11), `respawn_spec` (Task 17), idle-rule reads and sweep removal (Task 22).
- `crates/freshell-ws/src/unit_lifecycle.rs` (new) — kill/crash/respawn orchestration and Gone publishing (Tasks 12, 13, 17, 19, 29); `unit_threads.rs` (Task 14), `unit_holders.rs` (Task 16), `unit_cleanup.rs` (Task 22), `unit_stopper.rs` (Task 20).
- `crates/freshell-ws/src/terminal.rs` — create paths in units (Tasks 12, 23), kill handler (Task 13), holder answers (Tasks 14, 16), claim waits (Task 15), stopped attach answer (Task 18).
- `crates/freshell-ws/src/codex_proxy_route.rs` — held-thread feed (Task 14), writer-conflict detection (Task 16), richer loss logs (Task 17), work events (Task 22).
- `crates/freshell-ws/src/auto_resume.rs`, `crates/freshell-freshagent/src/lib.rs` (claim wrappers), `terminal_tabs.rs`, `session_handoff.rs` — entry points (Task 15); `pane_ops.rs` — automation (Task 20).
- `crates/freshell-ws/src/pane_ledger.rs`, `reconcile.rs` — stopped-pane memory (Task 18).
- `crates/freshell-server/src/main.rs` — `__unit-exec` (Task 6), wiring (Tasks 12, 17, 20), shutdown and boot finish (Task 19), cleanup (Task 22), watchdog simplification (Task 24).
- `crates/freshell-activity/src/codex.rs` — helper threads (Task 21).
- `crates/freshell-freshagent/src/codex.rs`, `claude.rs`, `session_lease.rs`, `crates/freshell-opencode/src/transport.rs` — fresh-agent sidecars and the opencode daemon on units (Task 23).
- `crates/freshell-protocol/src/{client_messages,server_messages}.rs`, `shared/ws-protocol.ts` — wire changes (Tasks 13, 16, 18, 22, 24, 29).
- `crates/freshell-server/src/logging.rs` — HTTP noise and retention proof (Task 30).
- Client: `src/lib/kill-ack.ts`, `src/lib/pane-utils.ts`, `src/store/closeAndStopThunks.ts` (new), `src/components/TabBar.tsx`, `TabItem.tsx`, `panes/PaneContainer.tsx` (Task 25); `context-menu/*` (Task 26); `TerminalView.tsx`, `fresh-agent/FreshAgentView.tsx`, `lib/pane-reconcile.ts`, `lib/reopen-intent.ts` (Task 27); `SessionHandoffErrorBanner.tsx` and the fenced folds (Task 28); `Sidebar.tsx`, selectors (Task 29); `settings/RuntimeSettings.tsx` (Task 22).
- Tools: `tools/node-client-runtime/action-capabilities.ts`, `tools/freshell-mcp/freshell-tool.ts`, `tools/freshell-cli/index.ts`, `.agents/skills/freshell-orchestration/SKILL.md` (Task 20).
- Fakes: `test/fixtures/coding-cli/codex-app-server/{fake-codex-launcher.mjs,native-role.mjs,fake-app-server.mjs,fake-codex-tui.mjs,fake-lock.mjs}` (Task 1); `test/e2e-browser/fixtures/codex-dual-role.ts` (Task 32).
- Docs and installers: `README.md` (Tasks 28, 31), `docs/index.html` (Task 29), `docs/development/agent-units.md` (new, linked from `AGENTS.md`, Task 31), `installers/systemd/freshell-rust.service` (Task 19).

## Shared interfaces (defined once; later tasks use these exact names)

```rust
// crates/freshell-containment/src/unit_id.rs
pub const UNIT_ENV: &str = "FRESHELL_UNIT_ID";
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct UnitId(String);
impl UnitId {
    pub fn mint() -> Self;                    // "u" + uuid v4 simple (32 lowercase hex)
    pub fn parse(raw: &str) -> Option<Self>;  // accepts exactly that shape
    pub fn as_str(&self) -> &str;
}

// crates/freshell-containment/src/process.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcIdentity { pub pid: u32, pub start: u64, pub argv: Vec<String> }
pub fn identity(pid: u32) -> std::io::Result<ProcIdentity>;
pub fn is_codex_managed_daemon(argv: &[String]) -> bool; // argv contains "app-server" AND "--managed-daemon"

// crates/freshell-containment/src/proc_watch.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Sig { Interrupt, Terminate, Kill }
#[derive(Clone)] pub struct ProcWatch { /* Arc<inner> */ }
impl ProcWatch {
    pub fn open(pid: u32) -> std::io::Result<Self>;                  // pins the current incarnation
    pub fn open_expecting(pid: u32, start: u64) -> std::io::Result<Self>; // ErrorKind::NotFound if start differs or pid gone
    pub fn identity(&self) -> &ProcIdentity;
    pub fn pid(&self) -> u32;
    pub fn has_exited(&self) -> bool;                                 // non-blocking
    pub async fn exited(&self);                                       // event-driven
    pub fn signal(&self, sig: Sig) -> std::io::Result<()>;            // never reaches a recycled pid
}

// crates/freshell-containment/src/backend/mod.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind { SystemdScope, LinuxTag, WindowsJob, MacosTag }
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Capability { pub kind: BackendKind, pub full: bool, pub reason: Option<String> }

// crates/freshell-containment/src/containment.rs
#[derive(Debug, Clone, Default)] pub struct SelectOptions { pub shim: Option<ShimCommand> }
#[derive(Clone)] pub struct ShimCommand { pub exe: std::path::PathBuf, pub leading_args: Vec<String> }
#[derive(Clone)] pub struct Containment { /* Arc<dyn Backend> */ }
impl Containment {
    pub fn select(opts: SelectOptions) -> Self;          // logs event=containment.backend once
    pub fn tag_backend(opts: SelectOptions) -> Self;      // forced degraded backend (tests, sandbox)
    pub fn capability(&self) -> Capability;
    pub fn create_unit(&self, id: UnitId, label: UnitLabel) -> std::io::Result<AgentUnit>;
    pub fn reopen_unit(&self, id: &UnitId, label: UnitLabel) -> std::io::Result<Option<AgentUnit>>;
    pub fn adopt_legacy(&self, tag_key: &str, tag_value: &str, roots: &[u32], label: UnitLabel) -> AgentUnit;
    pub fn surviving_units(&self) -> std::io::Result<Vec<UnitId>>;
}
pub fn set_global_containment(c: Containment) -> bool;
pub fn global_containment() -> Option<Containment>;

// crates/freshell-containment/src/unit.rs
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitLabel { pub provider: String, pub session_id: Option<String>, pub terminal_id: Option<String> }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum MemberRole { Screen, Agent }
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement { pub wrapper: Option<Vec<String>>, pub env: Vec<(String, String)> }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum StopMode { Force, Graceful { grace: std::time::Duration } }
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason { ShiftX, KillCommand, Respawn, Cleanup, Handoff, StuckRestart, StartCancelled,
                      AgentExited { exit_code: Option<i64> }, BootFinish, ServerShutdown }
pub type GoneCallback = Box<dyn FnOnce(StopReport) -> futures_core_shim::BoxFuture<'static, ()> + Send>;
pub struct StopRequest {
    pub mode: StopMode,
    pub reason: StopReason,
    pub initiator: String,
    pub operation_id: Option<String>,
    pub before_signal: Option<futures_core_shim::BoxFuture<'static, ()>>,
    pub on_gone: Option<GoneCallback>,
    pub soft_interrupt: Option<Box<dyn FnOnce() + Send>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopReport { pub unit_id: UnitId, pub reason: String, pub mode: &'static str,
                        pub duration_ms: u64, pub escalated: bool, pub lock_released: bool }
#[derive(Clone)] pub struct StopHandle { /* tokio::sync::watch::Receiver<Option<StopReport>> */ }
impl StopHandle {
    pub async fn wait(&self) -> StopReport;
    pub async fn wait_for(&self, limit: std::time::Duration) -> Option<StopReport>;
    pub fn try_report(&self) -> Option<StopReport>;
    pub async fn wait_swept(&self) -> Vec<ProcIdentity>;               // survivors of the post-Gone sweep (logged)
}
#[derive(Clone)] pub struct AgentUnit { /* Arc */ }
impl AgentUnit {
    pub fn id(&self) -> &UnitId;
    pub fn label(&self) -> UnitLabel;
    pub fn set_label(&self, label: UnitLabel);
    pub fn capability(&self) -> Capability;
    pub fn placement(&self, role: MemberRole) -> std::io::Result<Placement>;
    pub fn tokio_command(&self, program: &str, args: &[String], role: MemberRole) -> std::io::Result<tokio::process::Command>;
    pub fn set_screen(&self, watch: ProcWatch);
    pub fn set_main(&self, watch: ProcWatch);
    pub fn add_root(&self, watch: ProcWatch);
    pub fn screen(&self) -> Option<ProcWatch>;
    pub fn main(&self) -> Option<ProcWatch>;
    pub fn main_is_screen(&self) -> bool;
    pub fn set_lock_paths(&self, paths: Vec<std::path::PathBuf>);
    pub fn stop(&self, req: StopRequest) -> StopHandle;      // single-flight; a Force join escalates
    pub fn stop_in_flight(&self) -> Option<StopHandle>;
    pub fn members(&self) -> std::io::Result<Vec<ProcIdentity>>;
}

// crates/freshell-containment/src/directory.rs
#[derive(Clone)]
pub struct UnitEntry { pub unit: AgentUnit, pub provider: String, pub mode: String,
                       pub create_request_id: Option<String>, pub terminal_id: Option<String> }
pub struct UnitDirectory { /* Mutex<...> */ }
impl UnitDirectory {
    pub fn new() -> std::sync::Arc<Self>;
    pub fn set_on_bind(&self, hook: std::sync::Arc<dyn Fn(UnitEntry) + Send + Sync>); // fired by bind_terminal
    pub fn register(&self, entry: UnitEntry);
    pub fn bind_terminal(&self, unit_id: &UnitId, terminal_id: &str);
    pub fn get(&self, unit_id: &UnitId) -> Option<UnitEntry>;
    pub fn by_terminal(&self, terminal_id: &str) -> Option<UnitEntry>;
    pub fn by_create_request(&self, create_request_id: &str) -> Option<UnitEntry>;
    pub fn remove(&self, unit_id: &UnitId) -> Option<UnitEntry>;
    pub fn replace_unit(&self, old: &UnitId, new_unit: AgentUnit) -> Option<AgentUnit>;
    pub fn mark_start_settled(&self, unit_id: &UnitId);
    pub fn start_settled(&self, unit_id: &UnitId) -> BoxFuture<'static, ()>;
    pub fn cancel_start(&self, unit_id: &UnitId) -> bool;     // true when the unit had not bound a terminal yet
    pub fn start_cancelled(&self, unit_id: &UnitId) -> bool;
    pub async fn wait_start_cancelled(&self, unit_id: &UnitId);
    pub fn all(&self) -> Vec<UnitEntry>;
}

// crates/freshell-containment/src/locks.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LockHolder { pub pid: u32, pub command: String, pub path: std::path::PathBuf }
pub fn lock_holders(paths: &[std::path::PathBuf]) -> Vec<LockHolder>;
pub fn codex_thread_lock_path(codex_home: &std::path::Path, thread_id: &str) -> std::path::PathBuf;

// crates/freshell-containment/src/listener.rs
pub fn listening_socket_owner(port: u16, candidates: &[u32]) -> Option<u32>;
```

`futures_core_shim::BoxFuture` above means `std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>`; the crate defines `pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;` in `src/lib.rs` and uses it everywhere instead of pulling in `futures`.

```rust
// crates/freshell-ownership/src/lib.rs (additions)
pub struct OwnerIdentity { /* existing fields */ #[serde(default, skip_serializing_if = "Option::is_none")] pub unit_id: Option<String> }
pub enum StopOutcome { /* existing */ AlreadyStopping { operation_id: String, generation: u64, owner: Option<OwnerIdentity> } }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct UnitStopKey { pub key: SessionKey, pub generation: u64, pub joined: bool }
#[derive(Debug, Clone, PartialEq, Eq)] pub enum HoldOutcome { Held { generation: u64 }, AlreadyHeld, HeldByOther { owner: OwnerIdentity }, Skipped { state: OwnershipState } }
impl RuntimeOwnershipRegistry {
    pub fn wait_settled(self: &Arc<Self>, provider: &str, session_id: &str) -> SettledWait; // Future<Output = OwnershipSnapshot>
    pub fn begin_unit_stop(&self, unit_id: &str, operation_id: &str, initiator: &str, now_ms: u64) -> Vec<UnitStopKey>;
    pub fn commit_unit_stop(&self, unit_id: &str) -> Vec<UnitStopKey>; // generation = the committed key's generation (for the vacant broadcast)
    pub fn hold_extra(&self, provider: &str, session_id: &str, owner: OwnerIdentity, initiator: &str, now_ms: u64) -> HoldOutcome;
    pub fn release_extra(&self, provider: &str, session_id: &str, unit_id: &str) -> bool;
    pub fn restore_stopping(&self, provider: &str, session_id: &str, owner: OwnerIdentity, operation_id: &str, initiator: &str, now_ms: u64) -> bool;
    pub fn keys_for_unit(&self, unit_id: &str) -> Vec<(SessionKey, OwnershipState)>;
    pub fn states_for_terminal(&self, terminal_id: &str) -> Vec<(SessionKey, OwnershipState)>;
}

// crates/freshell-terminal/src/registry.rs (additions)
#[derive(Debug, Clone, PartialEq, Eq)] pub struct UnitPlacement { pub unit_id: String, pub wrapper: Option<Vec<String>>, pub env: Vec<(String, String)>, pub main_is_screen: bool }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum UnitEnding { Requested, AgentExited { exit_code: i64 } }
#[derive(Debug, Clone, PartialEq, Eq)] pub struct UnitScreenExit { pub terminal_id: String, pub unit_id: String, pub exit_code: i64, pub screen_generation: u32 }
impl TerminalRegistry {
    pub fn create_in_unit(&self, spec: &SpawnSpec, env: &BTreeMap<String, String>, terminal_id: String, stream_id: String, mode: &str,
                          resume_session_id: Option<&str>, create_request_id: Option<&str>, ring_max_bytes: Option<i64>,
                          on_exit: Option<crate::pty::ExitHook>, placement: UnitPlacement) -> io::Result<u32 /* screen pid */>;
    pub fn unit_id_for(&self, terminal_id: &str) -> Option<String>;
    pub fn terminal_for_create_request(&self, create_request_id: &str) -> Option<String>;
    pub fn mark_ending(&self, terminal_id: &str, ending: UnitEnding) -> bool;
    pub fn ending(&self, terminal_id: &str) -> Option<UnitEnding>;
    pub fn complete_unit_end(&self, terminal_id: &str, ending: UnitEnding) -> bool;
    pub fn replace_screen(&self, terminal_id: &str, spec: &SpawnSpec, env: &BTreeMap<String, String>, placement: UnitPlacement) -> io::Result<u32>;
    pub fn set_unit_screen_exit_hook(&self, hook: Arc<dyn Fn(UnitScreenExit) + Send + Sync>);
}
```

```ts
// shared/ws-protocol.ts (changes)
// terminal.kill: terminalId becomes optional; at least one of terminalId / createRequestId (refine).
// error frame: terminalStopped?: true (INVALID_TERMINAL_ID for a pane whose unit was stopped).
// pane.reconcile verdict enum gains 'stopped'.
// error codes gain 'CONVERSATION_HELD_ELSEWHERE' (holderPid, holderCommand on the frame).
// BackgroundTerminal.runtimeStatus gains 'stopping'.
```

## Test command reference (from `workspace-baseline.md`; exact)

- Containment crate: `cargo test -p freshell-containment --locked`
- Containment on the degraded backend in the sandbox: `scripts/sandbox-test.sh "cargo test -p freshell-containment --locked"`
- Cross-target checks: `cargo check -p freshell-containment --tests --target x86_64-pc-windows-gnu --locked` and `cargo check -p freshell-containment --tests --target aarch64-apple-darwin --locked`
- Ownership: `cargo test -p freshell-ownership --locked`
- Codex (integration files need the feature): `cargo test -p freshell-codex --features real-transport --locked`
- Terminal: `cargo test -p freshell-terminal --locked`
- One ws integration file: `cargo test -p freshell-ws --test <file_stem> --locked`
- Server binary tests: `cargo build -p freshell-server --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test <file_stem> --locked`
- Client unit tests: `pnpm run test:vitest run <paths...> --config config/vitest/vitest.config.ts`
- Cloud e2e (committed clean tree): `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/<spec>.spec.ts`
- Lint/types/format: `pnpm run lint`, `pnpm run typecheck`, `cargo fmt --all --check`, `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`
- Full gate: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY="codex-pane-lifecycle: <purpose>" pnpm run check`

---

## Slice A — Realistic fakes and test harness

### Task 1: Realistic Codex fake (launcher + separate native, real flock, signal semantics, descendants)

**Files:**
- Create: `test/fixtures/coding-cli/codex-app-server/fake-codex-launcher.mjs`
- Create: `test/fixtures/coding-cli/codex-app-server/native-role.mjs`
- Create: `test/fixtures/coding-cli/codex-app-server/fake-lock.mjs`
- Create: `test/fixtures/coding-cli/codex-app-server/fake-codex-tui.mjs`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (hook points: the message dispatch before `successResult` (~`:870-880`), the turn notification block (`turnCompleteDelayMs` await ~`:936` and the `turn/completed` broadcast ~`:942`), the top-level `process.on('SIGTERM')` at `:1035`)
- Create: `crates/freshell-codex/tests/support/fake_codex.rs`
- Test: `crates/freshell-codex/tests/realistic_fake.rs`

**Interfaces:**
- Consumes: nothing new (Node 22, `ws`, util-linux `flock`, `perl`).
- Produces (used by Tasks 10, 12–23, 32, 34):
  - `node fake-codex-launcher.mjs <codex argv...>` — a launcher process that spawns `node fake-app-server.mjs <argv...>` as a separate native child with `FAKE_CODEX_ROLE=native`, forwards only the first SIGINT/SIGTERM/SIGHUP, and exits after the native (code, or 128+signal).
  - Native role behavior keys in `FAKE_CODEX_APP_SERVER_BEHAVIOR` (JSON): `turnCompleteDelayMs` (existing), `spawnHelperProcess` (bool, own process group, same session), `mcpChild` (bool, exits on stdin EOF), `turnSpawnsShellCommand` (bool, own session), `detachedJobOnTurn` (bool, reparented `nohup` job), `helperThreadOnTurn` (`{ "id": string, "durationMs": number }`), `preloadedThreads` (string[]), `queuedSubmissions` (`{ [threadId]: number }`), `goals` (`{ [threadId]: { "status": string } }`), `threadStartThreadId` (existing), `listenDelayMs` (number: the native waits this long before listening — makes "kill during start" reproducible), `ignoreSigint` (bool: record SIGINT but keep running — a wedged agent that only the whole-unit kill ends), `ignoreSigterm` (bool: record SIGTERM but never finish the polite stop), `approvalWaiting` (string[]: threads reported `active{waitingOnApproval}` by `thread/read`).
  - Env: `FAKE_CODEX_MANIFEST_DIR` (launcher writes `launcher-<pid>.json`, native writes `native-<pid>.json`), `FAKE_CODEX_RECORD_DIR` (on the first signal the native snapshots `<dir>/<FRESHELL_CODEX_SIDECAR_ID>.json`'s `state.kind` into its manifest), `CODEX_HOME` (lock files under `<CODEX_HOME>/thread-writer-locks/`).
  - Native JSON-RPC: `thread/start`/`thread/resume` and the fork child of `thread/fork` take a real exclusive `flock` per thread and answer `{"code":-32600,"message":"thread-store conflict: thread <id> already has an active writer"}` when another process holds it; `thread/loaded/list` returns every locked thread; `thread/queue/list` and `thread/goal/get` answer from behavior; SIGTERM drains (rejects new `turn/start` with `-32001 "app-server is draining"`, waits for running turns, exits 100 ms after the last); SIGINT completes running turns as `interrupted`, kills its shell commands and exits within 150 ms; a second SIGTERM exits immediately without killing shell commands.
  - `node fake-codex-tui.mjs --remote <ws url> [-c ...] [resume <id>]` — a TUI fake: prints `FAKE_TUI_READY thread=<id>`; on a writer conflict prints `This conversation is open in another app. Close it there and press R to continue here.` and stays running; input line `turn <text>` starts a turn and prints `FAKE_TUI_TURN_COMPLETED status=<status>` plus BEL at completion; input `quit` exits 0; input `crash` exits 1 (a TUI crash); input `resume <id>` switches the TUI to another thread (Codex's `/resume`), printing the same conflict line on an active-writer refusal; input `fork` forks the current thread and switches to the child; an upstream close prints `FAKE_TUI_DISCONNECTED` and exits 1.
  - Rust test support (`crates/freshell-codex/tests/support/fake_codex.rs`): `fixture_path(name: &str) -> PathBuf`, `launcher_command() -> String`, `tui_command() -> String`, `struct FakeAppServer { pub child: tokio::process::Child, pub port: u16, pub codex_home: PathBuf, pub manifest_dir: PathBuf }` with `async fn spawn(behavior: serde_json::Value, codex_home: &Path, extra_env: &[(&str, &str)]) -> FakeAppServer`, `fn launcher_pid(&self) -> u32`, `async fn native(&self) -> NativeManifest`; `struct NativeManifest { pub pid: u32, pub threads: Vec<String>, pub children: ChildPids, pub signals: Vec<SignalEntry> }`; `struct ChildPids { pub helper: Option<u32>, pub mcp: Option<u32>, pub shell: Vec<u32>, pub detached: Vec<u32> }`; `struct SignalEntry { pub sig: String, pub at_ms: u64, pub record_state: Option<String> }`; `async fn wait_until(what: &str, limit: Duration, f: impl Fn() -> bool)` (test-only bounded wait); `fn pid_alive(pid: u32) -> bool`; `fn proc_ids(pid: u32) -> (u32 /*ppid*/, u32 /*pgid*/, u32 /*sid*/)`; `fn environ_value(pid: u32, key: &str) -> Option<String>`; `fn lock_held(path: &Path) -> bool` (inode match in `/proc/locks`); `fn thread_lock_path(codex_home: &Path, id: &str) -> PathBuf`; `struct Rpc` with `async fn connect(port: u16) -> Rpc`, `async fn initialize(&mut self)`, `async fn call(&mut self, method: &str, params: Value) -> Result<Value, Value>`, `async fn next_notification(&mut self, method: &str, limit: Duration) -> Option<Value>`; `fn signal_own_child(pid: u32, sig: i32)` (doc: only for pids this test spawned).

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-codex/tests/support/fake_codex.rs`:

```rust
//! Test-only support for the realistic Codex fake (launcher + separate native).
//! Every process these helpers signal was spawned by the calling test.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

pub fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server")
        .join(name)
        .canonicalize()
        .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

pub fn launcher_command() -> String {
    format!("node {}", fixture_path("fake-codex-launcher.mjs").display())
}

pub fn tui_command() -> String {
    format!("node {}", fixture_path("fake-codex-tui.mjs").display())
}

pub fn thread_lock_path(codex_home: &Path, id: &str) -> PathBuf {
    codex_home.join("thread-writer-locks").join(format!("{id}.lock"))
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChildPids {
    pub helper: Option<u32>,
    pub mcp: Option<u32>,
    #[serde(default)]
    pub shell: Vec<u32>,
    #[serde(default)]
    pub detached: Vec<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalEntry {
    pub sig: String,
    pub at_ms: u64,
    pub record_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativeManifest {
    pub pid: u32,
    #[serde(default)]
    pub threads: Vec<String>,
    #[serde(default)]
    pub children: ChildPids,
    #[serde(default)]
    pub signals: Vec<SignalEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherManifest {
    native_pid: u32,
}

pub struct FakeAppServer {
    pub child: tokio::process::Child,
    pub port: u16,
    pub codex_home: PathBuf,
    pub manifest_dir: PathBuf,
}

impl FakeAppServer {
    pub async fn spawn(behavior: Value, codex_home: &Path, extra_env: &[(&str, &str)]) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let manifest_dir = codex_home.join("manifests");
        std::fs::create_dir_all(&manifest_dir).unwrap();
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg(fixture_path("fake-codex-launcher.mjs"))
            .args(["app-server", "--listen", &format!("ws://127.0.0.1:{port}")])
            .env("CODEX_HOME", codex_home)
            .env("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1")
            .env("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string())
            .env("FAKE_CODEX_MANIFEST_DIR", &manifest_dir)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let child = cmd.spawn().expect("spawn fake launcher");
        let me = Self { child, port, codex_home: codex_home.to_path_buf(), manifest_dir };
        wait_until("native manifest", Duration::from_secs(10), || me.try_native().is_some()).await;
        me
    }

    pub fn launcher_pid(&self) -> u32 {
        self.child.id().expect("launcher pid")
    }

    fn try_native(&self) -> Option<NativeManifest> {
        let raw = std::fs::read_to_string(
            self.manifest_dir.join(format!("launcher-{}.json", self.child.id()?)),
        )
        .ok()?;
        let launcher: LauncherManifest = serde_json::from_str(&raw).ok()?;
        let raw = std::fs::read_to_string(
            self.manifest_dir.join(format!("native-{}.json", launcher.native_pid)),
        )
        .ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub async fn native(&self) -> NativeManifest {
        self.try_native().expect("native manifest present")
    }
}

/// Test-only bounded wait (product code never polls; this is harness code).
pub async fn wait_until(what: &str, limit: Duration, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + limit;
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn stat_fields(pid: u32) -> Option<Vec<String>> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after = &raw[raw.rfind(')')? + 2..];
    Some(after.split_whitespace().map(str::to_string).collect())
}

pub fn pid_alive(pid: u32) -> bool {
    stat_fields(pid).is_some_and(|f| f[0] != "Z" && f[0] != "X")
}

pub fn proc_ids(pid: u32) -> (u32, u32, u32) {
    let f = stat_fields(pid).expect("process exists");
    (f[1].parse().unwrap(), f[2].parse().unwrap(), f[3].parse().unwrap())
}

pub fn environ_value(pid: u32, key: &str) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    raw.split(|b| *b == 0).find_map(|kv| {
        let s = String::from_utf8_lossy(kv);
        s.strip_prefix(&format!("{key}=")).map(str::to_string)
    })
}

pub fn lock_held(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    let needle = format!(":{} ", meta.ino());
    std::fs::read_to_string("/proc/locks")
        .unwrap_or_default()
        .lines()
        .any(|l| l.contains("FLOCK") && format!("{l} ").contains(&needle))
}

/// Only for pids this test spawned (launcher, native, or their children).
pub fn signal_own_child(pid: u32, sig: i32) {
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

pub struct Rpc {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    next_id: u64,
    pending_notes: Vec<Value>,
}

impl Rpc {
    pub async fn connect(port: u16) -> Rpc {
        let url = format!("ws://127.0.0.1:{port}");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await {
                return Rpc { ws, next_id: 1, pending_notes: Vec::new() };
            }
            assert!(tokio::time::Instant::now() < deadline, "fake app-server never listened");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub async fn initialize(&mut self) {
        self.call("initialize", json!({"clientInfo": {"name": "t", "version": "1"},
            "capabilities": {"experimentalApi": true}})).await.expect("initialize");
        self.ws
            .send(Message::Text(json!({"jsonrpc":"2.0","method":"initialized"}).to_string().into()))
            .await
            .unwrap();
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.ws
            .send(Message::Text(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string().into()))
            .await
            .unwrap();
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(20), self.ws.next())
                .await
                .expect("rpc answer in time")
                .expect("socket open")
                .expect("frame");
            let Message::Text(text) = msg else { continue };
            let v: Value = serde_json::from_str(&text).unwrap();
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                return match v.get("error") {
                    Some(err) => Err(err.clone()),
                    None => Ok(v["result"].clone()),
                };
            }
            if v.get("method").is_some() {
                self.pending_notes.push(v);
            }
        }
    }

    pub async fn next_notification(&mut self, method: &str, limit: Duration) -> Option<Value> {
        if let Some(i) = self.pending_notes.iter().position(|n| n["method"] == method) {
            return Some(self.pending_notes.remove(i));
        }
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let remaining = deadline.checked_duration_since(tokio::time::Instant::now())?;
            let msg = tokio::time::timeout(remaining, self.ws.next()).await.ok()??.ok()?;
            let Message::Text(text) = msg else { continue };
            let v: Value = serde_json::from_str(&text).ok()?;
            if v["method"] == method {
                return Some(v);
            }
            if v.get("method").is_some() {
                self.pending_notes.push(v);
            }
        }
    }
}
```

`crates/freshell-codex/tests/realistic_fake.rs`:

```rust
#![cfg(all(feature = "real-transport", target_os = "linux"))]
//! The realistic Codex fake must reproduce the process and lock facts the
//! lifecycle work depends on (design §3). Every signalled pid was spawned here.

#[path = "support/fake_codex.rs"]
mod fake_codex;

use std::time::{Duration, Instant};

use fake_codex::*;
use serde_json::json;

const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

async fn start_turn(rpc: &mut Rpc, thread: &str) {
    rpc.call("turn/start", json!({"threadId": thread, "input": [{"type":"text","text":"go"}]}))
        .await
        .expect("turn/start");
}

#[tokio::test(flavor = "multi_thread")]
async fn launcher_spawns_a_separate_native_that_owns_the_listener() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let native = fake.native().await;
    assert_ne!(native.pid, fake.launcher_pid());
    let (ppid, pgid, _sid) = proc_ids(native.pid);
    assert_eq!(ppid, fake.launcher_pid(), "native is the launcher's child");
    assert_eq!(pgid, proc_ids(fake.launcher_pid()).1, "launcher and native share a group");
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn launcher_forwards_only_the_first_signal() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({"turnCompleteDelayMs": 3000, "threadStartThreadId": "t-fwd"}), home.path(), &[]).await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-fwd").await;
    signal_own_child(fake.launcher_pid(), SIGTERM);
    tokio::time::sleep(Duration::from_millis(200)).await;
    signal_own_child(fake.launcher_pid(), SIGINT);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let native = fake.native().await;
    let sigs: Vec<_> = native.signals.iter().map(|s| s.sig.as_str()).collect();
    assert_eq!(sigs, vec!["SIGTERM"], "the second signal never reaches the native");
    assert!(pid_alive(native.pid), "a draining native keeps running its turn");
    signal_own_child(native.pid, SIGKILL);
}

#[tokio::test(flavor = "multi_thread")]
async fn sigterm_drains_the_running_turn_before_exit() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({"turnCompleteDelayMs": 1500, "threadStartThreadId": "t-drain"}), home.path(), &[]).await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-drain").await;
    let native = fake.native().await.pid;
    let t0 = Instant::now();
    signal_own_child(native, SIGTERM);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(pid_alive(native), "SIGTERM must not stop a running turn");
    let done = rpc.next_notification("turn/completed", Duration::from_secs(5)).await.expect("turn completes");
    assert_eq!(done["params"]["turn"]["status"], "completed");
    wait_until("native exit after drain", Duration::from_secs(3), || !pid_alive(native)).await;
    assert!(t0.elapsed() >= Duration::from_millis(1400));
}

#[tokio::test(flavor = "multi_thread")]
async fn sigint_stops_at_once() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(json!({"turnCompleteDelayMs": 60000, "threadStartThreadId": "t-int"}), home.path(), &[]).await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-int").await;
    let native = fake.native().await.pid;
    let t0 = Instant::now();
    signal_own_child(native, SIGINT);
    wait_until("native exit after SIGINT", Duration::from_secs(2), || !pid_alive(native)).await;
    assert!(t0.elapsed() < Duration::from_millis(1000));
}

#[tokio::test(flavor = "multi_thread")]
async fn descendants_have_the_realistic_topology() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"spawnHelperProcess": true, "mcpChild": true, "turnSpawnsShellCommand": true,
               "detachedJobOnTurn": true, "turnCompleteDelayMs": 60000, "threadStartThreadId": "t-topo"}),
        home.path(),
        &[("FRESHELL_UNIT_ID", "uabc")],
    ).await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-topo").await;
    wait_until("turn descendants", Duration::from_secs(5), || {
        futures_executor_shim::block_on_manifest(&fake).is_some_and(|m| !m.children.shell.is_empty() && !m.children.detached.is_empty())
    }).await;
    let m = fake.native().await;
    let (_, native_pgid, native_sid) = proc_ids(m.pid);
    let helper = m.children.helper.expect("helper");
    let (_, hp, hs) = proc_ids(helper);
    assert_eq!(hp, helper, "helper leads its own process group");
    assert_eq!(hs, native_sid, "helper stays in the native's session");
    assert_ne!(hp, native_pgid);
    let shell = m.children.shell[0];
    assert_eq!(proc_ids(shell).2, shell, "shell command leads its own session");
    let detached = m.children.detached[0];
    assert_ne!(proc_ids(detached).0, m.pid, "detached job is reparented away from the native");
    for pid in [m.pid, helper, shell, detached] {
        assert_eq!(environ_value(pid, "FRESHELL_UNIT_ID").as_deref(), Some("uabc"));
    }
    for pid in [detached, shell, helper, m.pid] {
        signal_own_child(pid, SIGKILL);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn flock_refuses_a_second_writer_and_releases_on_native_exit() {
    let home = tempfile::tempdir().unwrap();
    let a = FakeAppServer::spawn(json!({"threadStartThreadId": "t-lock"}), home.path(), &[]).await;
    let mut rpc_a = Rpc::connect(a.port).await;
    rpc_a.initialize().await;
    rpc_a.call("thread/start", json!({})).await.unwrap();
    let lock = thread_lock_path(home.path(), "t-lock");
    assert!(lock_held(&lock), "native A holds the thread lock");
    let b = FakeAppServer::spawn(json!({}), home.path(), &[]).await;
    let mut rpc_b = Rpc::connect(b.port).await;
    rpc_b.initialize().await;
    let refused = rpc_b.call("thread/resume", json!({"threadId": "t-lock"})).await.expect_err("conflict");
    assert!(refused["message"].as_str().unwrap().contains("thread t-lock already has an active writer"));
    signal_own_child(a.native().await.pid, SIGKILL);
    wait_until("lock release", Duration::from_secs(2), || !lock_held(&lock)).await;
    rpc_b.call("thread/resume", json!({"threadId": "t-lock"})).await.expect("resume after release");
    signal_own_child(b.native().await.pid, SIGKILL);
}

#[tokio::test(flavor = "multi_thread")]
async fn queue_goal_and_helper_threads_are_reported() {
    let home = tempfile::tempdir().unwrap();
    let fake = FakeAppServer::spawn(
        json!({"threadStartThreadId": "t-root", "turnCompleteDelayMs": 60000,
               "helperThreadOnTurn": {"id": "t-helper", "durationMs": 60000},
               "queuedSubmissions": {"t-root": 2}, "goals": {"t-root": {"status": "active"}},
               "preloadedThreads": ["t-earlier"]}),
        home.path(),
        &[],
    ).await;
    let mut rpc = Rpc::connect(fake.port).await;
    rpc.initialize().await;
    rpc.call("thread/start", json!({})).await.unwrap();
    start_turn(&mut rpc, "t-root").await;
    let status = rpc.next_notification("thread/status/changed", Duration::from_secs(5)).await;
    assert!(status.is_some());
    let loaded = rpc.call("thread/loaded/list", json!({})).await.unwrap();
    let ids: Vec<_> = loaded["data"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    for id in ["t-root", "t-helper", "t-earlier"] {
        assert!(ids.contains(&id.to_string()), "{id} loaded");
        assert!(lock_held(&thread_lock_path(home.path(), id)), "{id} locked");
    }
    let helper = rpc.call("thread/read", json!({"threadId": "t-helper"})).await.unwrap();
    assert_eq!(helper["thread"]["status"]["type"], "active");
    let q = rpc.call("thread/queue/list", json!({"threadId": "t-root"})).await.unwrap();
    assert_eq!(q["data"].as_array().unwrap().len(), 2);
    let g = rpc.call("thread/goal/get", json!({"threadId": "t-root"})).await.unwrap();
    assert_eq!(g["goal"]["status"], "active");
    signal_own_child(fake.native().await.pid, SIGKILL);
}

mod futures_executor_shim {
    use super::fake_codex::{FakeAppServer, NativeManifest};
    /// Synchronous manifest read for wait_until predicates.
    pub fn block_on_manifest(fake: &FakeAppServer) -> Option<NativeManifest> {
        let launcher = std::fs::read_to_string(fake.manifest_dir.join(format!("launcher-{}.json", fake.child.id()?))).ok()?;
        let v: serde_json::Value = serde_json::from_str(&launcher).ok()?;
        let pid = v["nativePid"].as_u64()?;
        let raw = std::fs::read_to_string(fake.manifest_dir.join(format!("native-{pid}.json"))).ok()?;
        serde_json::from_str(&raw).ok()
    }
}
```

Add to `crates/freshell-codex/Cargo.toml` `[dev-dependencies]`: `serde = { workspace = true }` (derive is already a normal dependency; keep it there), `tokio-tungstenite = "0.24"`, `futures-util = { version = "0.3", default-features = false, features = ["sink", "std"] }`, `libc = "0.2"` (all already in the lock).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-codex --features real-transport --test realistic_fake --locked`

Expected: FAIL — `fixture fake-codex-launcher.mjs: No such file or directory` panics in every test (the launcher/native role does not exist yet).

- [ ] **Step 3: Add the minimal production implementation**

`test/fixtures/coding-cli/codex-app-server/fake-codex-launcher.mjs` (mirrors `@openai/codex` 0.162 `bin/codex.js:241-298`):

```js
#!/usr/bin/env node
// Realistic launcher: a separate Node process in front of the native
// app-server, exactly like `node …/@openai/codex/bin/codex.js`.
// - spawns the native with inherited stdio in the SAME process group;
// - forwards only the FIRST SIGINT/SIGTERM/SIGHUP (codex.js returns early
//   once `child.killed` is true);
// - exits only after the native exits, mirroring its code (or 128+signal).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const nativeScript = process.env.FAKE_CODEX_NATIVE_SCRIPT || path.join(here, 'fake-app-server.mjs')
const child = spawn(process.execPath, [nativeScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, FAKE_CODEX_ROLE: 'native', CODEX_MANAGED_BY_NPM: '1' },
})
const forwarded = []
const manifestDir = process.env.FAKE_CODEX_MANIFEST_DIR
function writeManifest() {
  if (!manifestDir) return
  fs.mkdirSync(manifestDir, { recursive: true })
  const file = path.join(manifestDir, `launcher-${process.pid}.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ role: 'launcher', pid: process.pid, nativePid: child.pid, forwarded }))
  fs.renameSync(`${file}.tmp`, file)
}
writeManifest()
function forwardSignal(signal) {
  if (child.killed) return
  forwarded.push(signal)
  writeManifest()
  try { child.kill(signal) } catch { /* already gone */ }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => forwardSignal(sig))
child.on('exit', (code, signal) => {
  if (signal) process.exit(128 + (os.constants.signals[signal] ?? 1))
  process.exit(code ?? 1)
})
```

`test/fixtures/coding-cli/codex-app-server/fake-lock.mjs`:

```js
// Real exclusive flock(2) held by THIS process's own open file description.
// Node has no flock(); util-linux `flock -x -n 3` locks the description we pass
// as fd 3 and exits — the lock stays with our fd and disappears exactly when
// this process closes it or dies (same semantics as Codex's O_CLOEXEC
// File::try_lock). /proc/locks shows the exited flock(1) pid in the pid column,
// so tests identify locks by inode, never by pid.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const held = new Map()

export function lockPath(codexHome, threadId) {
  return path.join(codexHome, 'thread-writer-locks', `${threadId}.lock`)
}

export function acquireThreadLock(codexHome, threadId) {
  if (held.has(threadId)) return { ok: true }
  if (process.platform !== 'linux') {
    // util-linux flock(1) is Linux-only; elsewhere (the Windows/macOS desktop
    // smoke) the fake records the thread as held without an OS lock.
    held.set(threadId, -1)
    return { ok: true }
  }
  const file = lockPath(codexHome, threadId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'a')
  const r = spawnSync('flock', ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] })
  if (r.status !== 0) {
    fs.closeSync(fd)
    return { ok: false, message: `thread-store conflict: thread ${threadId} already has an active writer` }
  }
  held.set(threadId, fd)
  return { ok: true }
}

export function heldThreadIds() {
  return [...held.keys()]
}
```

`test/fixtures/coding-cli/codex-app-server/native-role.mjs`:

```js
// The native app-server role (FAKE_CODEX_ROLE=native, set by the launcher).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { acquireThreadLock, heldThreadIds } from './fake-lock.mjs'

export function createNativeRole({ behavior, codexHome, broadcast }) {
  const manifestDir = process.env.FAKE_CODEX_MANIFEST_DIR
  const recordDir = process.env.FAKE_CODEX_RECORD_DIR
  const children = { helper: null, mcp: null, shell: [], detached: [] }
  const signals = []
  const activeTurns = new Map() // turnId -> { threadId, resolve }
  const helperTurns = new Map()
  let draining = false
  let sigtermCount = 0

  function writeManifest() {
    if (!manifestDir) return
    fs.mkdirSync(manifestDir, { recursive: true })
    const file = path.join(manifestDir, `native-${process.pid}.json`)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ role: 'native', pid: process.pid, threads: heldThreadIds(), children, signals }))
    fs.renameSync(`${file}.tmp`, file)
  }
  function recordStateSnapshot() {
    const id = process.env.FRESHELL_CODEX_SIDECAR_ID
    if (!recordDir || !id) return null
    try { return JSON.parse(fs.readFileSync(path.join(recordDir, `${id}.json`), 'utf8')).state?.kind ?? null } catch { return null }
  }
  function lockOrError(threadId) {
    const r = acquireThreadLock(codexHome, threadId)
    writeManifest()
    return r.ok ? null : { code: -32600, message: r.message }
  }
  function spawnOwnGroupHelper() {
    // code-mode-host analogue: own process group, same session.
    const p = spawn('perl', ['-e', 'setpgrp(0,0); sleep 600'], { stdio: 'ignore' })
    children.helper = p.pid
  }
  function spawnMcpChild() {
    const p = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'] })
    children.mcp = p.pid
  }
  function spawnShellCommand() {
    const p = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' }) // setsid
    p.unref()
    children.shell.push(p.pid)
  }
  function spawnDetachedJob() {
    const r = spawnSyncShell("nohup sleep 600 >/dev/null 2>&1 & echo $!")
    if (r) children.detached.push(r)
  }
  function spawnSyncShell(script) {
    const out = require_spawnSync('sh', ['-c', script])
    const pid = Number(String(out.stdout).trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  }

  for (const id of behavior.preloadedThreads ?? []) lockOrError(id)
  if (behavior.spawnHelperProcess) spawnOwnGroupHelper()
  if (behavior.mcpChild) spawnMcpChild()
  writeManifest()

  function exitSoon(ms) { setTimeout(() => process.exit(0), ms) }

  process.on('SIGTERM', () => {
    sigtermCount += 1
    signals.push({ sig: 'SIGTERM', atMs: Date.now(), recordState: recordStateSnapshot() })
    writeManifest()
    if (behavior.ignoreSigterm) return // never finishes a polite stop (cleanup escalation test)
    if (sigtermCount > 1) process.exit(0) // second SIGTERM: fast exit, commands left alive
    draining = true
    if (activeTurns.size === 0 && helperTurns.size === 0) exitSoon(100)
  })
  process.on('SIGINT', () => {
    signals.push({ sig: 'SIGINT', atMs: Date.now(), recordState: recordStateSnapshot() })
    writeManifest()
    if (behavior.ignoreSigint) return // a wedged agent: only the unit kill ends it
    for (const pid of children.shell) { try { process.kill(pid, 'SIGKILL') } catch {} }
    for (const t of activeTurns.values()) t.resolve('interrupted')
    exitSoon(100)
  })
  process.on('SIGHUP', () => {
    signals.push({ sig: 'SIGHUP', atMs: Date.now(), recordState: recordStateSnapshot() })
    writeManifest()
  })

  return {
    get draining() { return draining },
    /** Returns {error} to answer, {result} to answer, or null to fall through. */
    intercept(method, params) {
      if (method === 'thread/start') {
        const err = lockOrError(behavior.threadStartThreadId || 'thread-new-1')
        return err ? { error: err } : null
      }
      if (method === 'thread/resume') {
        const err = lockOrError(params?.threadId || 'thread-new-1')
        return err ? { error: err } : null
      }
      if (method === 'turn/start' && draining) {
        return { error: { code: -32001, message: 'app-server is draining' } }
      }
      if (method === 'thread/loaded/list') return { result: { data: heldThreadIds(), nextCursor: null } }
      if (method === 'thread/queue/list') {
        const n = behavior.queuedSubmissions?.[params?.threadId] ?? 0
        const data = Array.from({ length: n }, (_, i) => ({ id: `q-${i}`, input: [], clientUserMessageId: `c-${i}` }))
        return { result: { data, nextCursor: null } }
      }
      if (method === 'thread/goal/get') {
        const g = behavior.goals?.[params?.threadId]
        return { result: { goal: g ? { threadId: params.threadId, objective: 'fixture', status: g.status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 } : null } }
      }
      if (method === 'thread/read' && helperTurns.has(params?.threadId)) {
        return null // fall through; statusFor() below is consulted by the patched thread/read
      }
      return null
    },
    /** A thread this native just created (a fork child): it holds that lock too. */
    noteLoaded(threadId) {
      lockOrError(threadId)
    },
    statusFor(threadId) {
      if ((behavior.approvalWaiting ?? []).includes(threadId)) return { type: 'active', activeFlags: ['waitingOnApproval'] }
      if (helperTurns.has(threadId)) return { type: 'active', activeFlags: [] }
      for (const t of activeTurns.values()) if (t.threadId === threadId) return { type: 'active', activeFlags: [] }
      return null
    },
    /** Await the turn's natural end or an interrupt. Resolves to the final status. */
    turnDelay(threadId, turnId, delayMs) {
      if (behavior.turnSpawnsShellCommand) spawnShellCommand()
      if (behavior.detachedJobOnTurn) spawnDetachedJob()
      const helper = behavior.helperThreadOnTurn
      if (helper?.id && !helperTurns.has(helper.id)) {
        lockOrError(helper.id)
        helperTurns.set(helper.id, true)
        broadcast('thread/status/changed', { threadId: helper.id, status: { type: 'active', activeFlags: [] } })
        broadcast('turn/started', { threadId: helper.id, turn: { id: `${helper.id}-turn`, status: 'inProgress', items: [] } })
        setTimeout(() => {
          helperTurns.delete(helper.id)
          broadcast('turn/completed', { threadId: helper.id, turn: { id: `${helper.id}-turn`, status: 'completed', items: [] } })
          broadcast('thread/status/changed', { threadId: helper.id, status: { type: 'idle' } })
          if (draining && activeTurns.size === 0 && helperTurns.size === 0) exitSoon(100)
        }, Number(helper.durationMs ?? 0))
      }
      writeManifest()
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('completed'), delayMs)
        activeTurns.set(turnId, { threadId, resolve: (status) => { clearTimeout(timer); resolve(status) } })
      })
    },
    turnEnded(turnId) {
      activeTurns.delete(turnId)
      if (draining && activeTurns.size === 0 && helperTurns.size === 0) exitSoon(100)
    },
  }
}

import { spawnSync as require_spawnSync } from 'node:child_process'
```

Edits to `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`:

1. After `const behavior = loadBehavior()` add:
   ```js
   import { createNativeRole } from './native-role.mjs'
   const nativeRole = process.env.FAKE_CODEX_ROLE === 'native'
     ? createNativeRole({ behavior, codexHome: getCodexHome(), broadcast: (m, p) => broadcastNotification(m, p) })
     : null
   ```
   (Static `import` statements must sit at the top of the module; move the `import` line up with the other imports and keep the `const` after `behavior` is loaded.)
2. In the message dispatch, immediately after the `behavior.ignoreMethods` check and before the durable-write guard (~`:785`), add:
   ```js
   if (nativeRole) {
     const intercepted = nativeRole.intercept(method, message.params)
     if (intercepted?.error) { socket.send(JSON.stringify({ id: message.id, error: intercepted.error })); return }
     if (intercepted?.result) { socket.send(JSON.stringify({ id: message.id, result: intercepted.result })); return }
   }
   ```
3. In `successResult('thread/read')` after the `threadStatuses` block, add: `const live = nativeRole?.statusFor(thread.id); if (live) thread.status = live`. In `successResult('thread/fork')` (`:371`), right after `childThreadId` is minted, add `nativeRole?.noteLoaded(childThreadId)` (the native holds both the original's and the fork's locks, design fact 3.5).
4. In the turn notification block, replace `await new Promise((resolve) => setTimeout(resolve, Number(behavior.turnCompleteDelayMs ?? 150)))` with:
   ```js
   const turnOutcome = nativeRole
     ? await nativeRole.turnDelay(threadId, turnId, Number(behavior.turnCompleteDelayMs ?? 150))
     : (await new Promise((resolve) => setTimeout(resolve, Number(behavior.turnCompleteDelayMs ?? 150))), 'completed')
   ```
   use `turnOutcome` as the `status` of the `turn` in the following `turn/completed` broadcast (the existing literal `'completed'`), and right after that broadcast add `nativeRole?.turnEnded(turnId)`. (`threadId`/`turnId` are the variables that block already uses for its `turn/started` broadcast.)
5. Wrap the top-level `process.on('SIGTERM', …)` at `:1035` in `if (!nativeRole) { … }` (the native role installs its own handlers).
6. Where the module creates its `WebSocketServer` on the `--listen` port, honor `behavior.listenDelayMs` by creating it inside `setTimeout(..., Number(behavior.listenDelayMs || 0))` (0 keeps today's immediate listen).

`test/fixtures/coding-cli/codex-app-server/fake-codex-tui.mjs`:

```js
#!/usr/bin/env node
// Minimal Codex TUI stand-in for `codex --remote <ws> [-c ...] [resume <id>]`.
import WebSocket from 'ws'

const argv = process.argv.slice(2)
const remote = argv[argv.indexOf('--remote') + 1]
const resumeIdx = argv.indexOf('resume')
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : null
const ws = new WebSocket(remote)
let nextId = 1
const pending = new Map()
let threadId = null
const say = (s) => process.stdout.write(`${s}\r\n`)
function rpc(method, params) {
  const id = nextId++
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p.reject(msg.error) : p.resolve(msg.result)
    return
  }
  if (msg.method === 'turn/completed' && msg.params?.threadId === threadId) {
    say(`FAKE_TUI_TURN_COMPLETED status=${msg.params?.turn?.status}`)
    process.stdout.write('\x07')
  }
})
ws.on('close', () => { say('FAKE_TUI_DISCONNECTED'); process.exit(1) })
ws.on('error', () => {})
ws.on('open', async () => {
  try {
    await rpc('initialize', { clientInfo: { name: 'fake-codex-tui', version: '1' }, capabilities: { experimentalApi: true } })
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
    const r = resumeId ? await rpc('thread/resume', { threadId: resumeId, cwd: process.cwd() }) : await rpc('thread/start', { cwd: process.cwd() })
    threadId = r.thread.id
    say(`FAKE_TUI_READY thread=${threadId}`)
  } catch (error) {
    if (String(error?.message ?? '').includes('active writer')) {
      say('This conversation is open in another app. Close it there and press R to continue here.')
    } else {
      say(`FAKE_TUI_ERROR ${error?.message ?? error}`)
    }
  }
})
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.search(/[\r\n]/)) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
    if (line === 'quit') process.exit(0)
    if (line === 'crash') process.exit(1)
    if (line === 'fork' && threadId) {
      // like Codex's fork: a new thread id; the app-server keeps holding both
      await rpc('thread/fork', { threadId })
        .then((r) => { threadId = r.thread.id; say(`FAKE_TUI_READY thread=${threadId}`) })
        .catch((e) => say(`FAKE_TUI_ERROR ${e?.message}`))
    }
    if (line.startsWith('resume ')) {
      // like Codex's /resume picker: switch this TUI to another thread
      await rpc('thread/resume', { threadId: line.slice(7).trim(), cwd: process.cwd() })
        .then((r) => { threadId = r.thread.id; say(`FAKE_TUI_READY thread=${threadId}`) })
        .catch((e) => say(String(e?.message ?? '').includes('active writer')
          ? 'This conversation is open in another app. Close it there and press R to continue here.'
          : `FAKE_TUI_ERROR ${e?.message}`))
    }
    if (line.startsWith('turn ') && threadId) {
      await rpc('turn/start', { threadId, input: [{ type: 'text', text: line.slice(5) }] }).catch((e) => say(`FAKE_TUI_ERROR ${e?.message}`))
    }
  }
})
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-codex --features real-transport --test realistic_fake --locked`

Expected: PASS (7 tests).

- [ ] **Step 5: Refactor while green**

Move the `require_spawnSync` import in `native-role.mjs` to the top-level import block (rename to `spawnSync`), and fold `spawnSyncShell` into `spawnDetachedJob`; replace `futures_executor_shim::block_on_manifest` in the test with a public synchronous `FakeAppServer::try_native()` (make it `pub`) and delete the shim module. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

The fake is shared by every Codex test (Rust and e2e). The native role is opt-in (`FAKE_CODEX_ROLE=native`, set only by the new launcher), so the existing single-process paths must be unchanged:

Run: `cargo test -p freshell-codex --features real-transport --locked && cargo test -p freshell-ws --test codex_managed_launch_e2e --test codex_sidecar_reattach_e2e --test codex_fork_rebind --locked && cargo test -p freshell-freshagent codex_sidecar_tracking --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/fixtures/coding-cli/codex-app-server/fake-codex-launcher.mjs test/fixtures/coding-cli/codex-app-server/native-role.mjs test/fixtures/coding-cli/codex-app-server/fake-lock.mjs test/fixtures/coding-cli/codex-app-server/fake-codex-tui.mjs test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs crates/freshell-codex/tests/support/fake_codex.rs crates/freshell-codex/tests/realistic_fake.rs crates/freshell-codex/Cargo.toml Cargo.lock
git commit -m "test(codex): realistic launcher+native fake with real flock and Codex signal semantics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice B — Generic OS containment (`crates/freshell-containment`)

### Task 2: Containment crate foundation — unit ids, process identity, event-driven `ProcWatch`, unit log events

**Files:**
- Create: `crates/freshell-containment/Cargo.toml`
- Create: `crates/freshell-containment/src/lib.rs`
- Create: `crates/freshell-containment/src/unit_id.rs`
- Create: `crates/freshell-containment/src/process.rs`
- Create: `crates/freshell-containment/src/proc_watch.rs`
- Create: `crates/freshell-containment/src/events.rs`
- Create: `crates/freshell-containment/src/testing.rs`
- Test: `crates/freshell-containment/tests/proc_watch.rs`
- Modify: `Cargo.lock` (new workspace member)

**Interfaces:**
- Consumes: nothing.
- Produces: `UnitId`, `UNIT_ENV`, `ProcIdentity`, `identity(pid)`, `is_codex_managed_daemon(argv)`, `ProcWatch`/`Sig` (see Shared interfaces), `BoxFuture<'a, T>`, and in `events.rs`:
  ```rust
  #[derive(Debug, Clone, Default, PartialEq, Eq)]
  pub struct UnitLogKeys { pub unit_id: String, pub provider: String, pub session_id: Option<String>,
                           pub terminal_id: Option<String>, pub operation_id: Option<String> }
  pub fn stop_requested(k: &UnitLogKeys, reason: &str, mode: &str, initiator: &str);
  pub fn signal_sent(k: &UnitLogKeys, signal: &str, target: &str, pid: Option<u32>);
  pub fn gone(k: &UnitLogKeys, reason: &str, duration_ms: u64, lock_released: bool, escalated: bool);
  pub fn escalated(k: &UnitLogKeys, from: &str, to: &str, after_ms: u64);
  pub fn unconfirmed(k: &UnitLogKeys, after_ms: u64, waiting_on: &str);
  pub fn descendants_survived(k: &UnitLogKeys, survivors: &[ProcIdentity]);
  pub fn start_waited(k: &UnitLogKeys, entry_point: &str, wait_ms: u64);
  pub fn writer_conflict(k: &UnitLogKeys, thread_id: &str, holder_pid: Option<u32>, holder_command: Option<&str>, source: &str);
  pub fn main_discovery_failed(k: &UnitLogKeys, port: u16, fallback_pid: u32);
  ```
  and `testing::gone_delay() -> Option<std::time::Duration>`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/proc_watch.rs`:

```rust
//! ProcWatch is the event-driven, pid-reuse-safe exit watch every Gone
//! decision rests on. Every process signalled here was spawned by the test.
use std::time::{Duration, Instant};

use freshell_containment::{identity, is_codex_managed_daemon, ProcWatch, Sig, UnitId};

#[test]
fn unit_id_is_dash_free_and_round_trips() {
    let id = UnitId::mint();
    assert!(id.as_str().starts_with('u'));
    assert_eq!(id.as_str().len(), 33);
    assert!(!id.as_str().contains('-'));
    assert_eq!(UnitId::parse(id.as_str()), Some(id.clone()));
    assert_eq!(UnitId::parse("u-not-valid"), None);
    assert_eq!(UnitId::parse("x0123456789abcdef0123456789abcdef"), None);
}

#[test]
fn managed_daemon_detection_needs_both_tokens() {
    let argv = |s: &str| s.split(' ').map(str::to_string).collect::<Vec<_>>();
    assert!(is_codex_managed_daemon(&argv("/x/codex app-server --listen unix:// --managed-daemon")));
    assert!(!is_codex_managed_daemon(&argv("/x/codex app-server --listen ws://127.0.0.1:1")));
    assert!(!is_codex_managed_daemon(&argv("/x/other --managed-daemon")));
}

#[cfg(unix)]
fn spawn_grandchild(seconds: &str) -> u32 {
    let out = std::process::Command::new("sh")
        .args(["-c", &format!("sleep {seconds} >/dev/null 2>&1 & echo $!")])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().parse().unwrap()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exited_fires_for_a_non_child_when_it_exits() {
    let pid = spawn_grandchild("0.4");
    let watch = ProcWatch::open(pid).expect("open");
    assert!(!watch.has_exited());
    let t0 = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), watch.exited()).await.expect("exit event");
    assert!(watch.has_exited());
    assert!(t0.elapsed() >= Duration::from_millis(300));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_signal_ends_the_watched_process() {
    let pid = spawn_grandchild("600");
    let watch = ProcWatch::open(pid).unwrap();
    assert_eq!(watch.identity().pid, pid);
    watch.signal(Sig::Kill).unwrap();
    tokio::time::timeout(Duration::from_secs(5), watch.exited()).await.expect("killed");
    // Signalling an exited process is a quiet no-op, never a stray signal.
    watch.signal(Sig::Kill).unwrap();
}

#[cfg(unix)]
#[test]
fn open_expecting_refuses_a_different_incarnation() {
    let pid = spawn_grandchild("600");
    let real = identity(pid).unwrap();
    let err = ProcWatch::open_expecting(pid, real.start + 1).err().expect("mismatch refused");
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    let ok = ProcWatch::open_expecting(pid, real.start).unwrap();
    ok.signal(Sig::Kill).unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn exited_fires_when_a_windows_process_exits() {
    let child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Milliseconds 400"])
        .spawn()
        .unwrap();
    let watch = ProcWatch::open(child.id()).unwrap();
    assert!(!watch.has_exited());
    tokio::time::timeout(Duration::from_secs(10), watch.exited()).await.expect("exit event");
    assert!(watch.has_exited());
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn kill_terminates_a_windows_process() {
    let child = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 600"])
        .spawn()
        .unwrap();
    let watch = ProcWatch::open(child.id()).unwrap();
    watch.signal(Sig::Kill).unwrap();
    tokio::time::timeout(Duration::from_secs(10), watch.exited()).await.expect("killed");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

First create `crates/freshell-containment/Cargo.toml` and an empty `src/lib.rs` so the package exists, then:

Run: `cargo test -p freshell-containment --test proc_watch`

Expected: FAIL to compile — `unresolved imports freshell_containment::{identity, is_codex_managed_daemon, ProcWatch, Sig, UnitId}` (the API does not exist yet). (This first run is unlocked on purpose: it adds the new member to `Cargo.lock`.)

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-containment/Cargo.toml`:

```toml
# freshell-containment — OS containment for coding-agent panes: one unit per
# pane (systemd transient scopes on Linux, Job Objects on Windows, tagged
# process sets elsewhere), an event-driven per-process exit watch, the single
# stop sequence, and lock-holder/listener lookups. Leaf crate: no workspace deps.
[package]
name = "freshell-containment"
version = "0.1.0"
description = "Per-pane OS process containment, confirmed exit, and the one stop sequence for Freshell coding-agent panes."
edition.workspace = true
rust-version.workspace = true
publish.workspace = true

[dependencies]
libc = "0.2"
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { version = "1", features = ["rt", "macros", "time", "sync", "net", "process", "io-util"] }
tracing = "0.1"
uuid = { version = "1", features = ["v4"] }

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = [
  "Win32_Foundation",
  "Win32_Security",
  "Win32_System_Threading",
  "Win32_System_JobObjects",
  "Win32_System_IO",
  "Win32_System_Diagnostics_ToolHelp",
  "Win32_System_RestartManager",
  "Win32_NetworkManagement_IpHelper",
  "Win32_Networking_WinSock",
  "Wdk_System_Threading",
] }

[dev-dependencies]
tempfile = "3"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "process"] }

[[bin]]
name = "freshell-unit-exec"
path = "src/bin/freshell-unit-exec.rs"
test = false
```

(Create `src/bin/freshell-unit-exec.rs` now as `fn main() { std::process::exit(freshell_containment::exec_shim::unit_exec_main(std::env::args_os().skip(1).collect())) }` together with a minimal `src/exec_shim.rs` whose `unit_exec_main` on every OS runs `args[after "--"]` with `std::process::Command`, waits, and returns its exit code — Task 6 adds the Windows job self-placement in front of that.)

`crates/freshell-containment/src/lib.rs`:

```rust
//! Per-pane OS containment for Freshell coding-agent panes.
//!
//! A pane is ONE unit: its screen (PTY child), its agent main process, and
//! everything they start. This crate owns how the unit's processes are
//! grouped (per OS backend), how their exit is observed without polling
//! (`ProcWatch`), and the single stop sequence. Lifecycle STATE (Running /
//! Stopping / Gone) lives in `freshell-ownership`, never here.

use std::future::Future;
use std::pin::Pin;

pub mod events;
pub mod exec_shim;
pub mod process;
pub mod proc_watch;
pub mod testing;
pub mod unit_id;

pub use process::{identity, is_codex_managed_daemon, ProcIdentity};
pub use proc_watch::{ProcWatch, Sig};
pub use unit_id::{UnitId, UNIT_ENV};

/// A boxed, sendable future (no `futures` dependency).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
```

`crates/freshell-containment/src/unit_id.rs`:

```rust
/// The environment tag every contained process carries (degraded backends
/// find members by it; full backends set it too, for diagnostics).
pub const UNIT_ENV: &str = "FRESHELL_UNIT_ID";

/// `u` + 32 lowercase hex: dash-free, so it is a valid systemd unit-name
/// component and a Windows job-name component.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct UnitId(String);

impl UnitId {
    pub fn mint() -> Self {
        Self(format!("u{}", uuid::Uuid::new_v4().simple()))
    }

    pub fn parse(raw: &str) -> Option<Self> {
        let hex = raw.strip_prefix('u')?;
        (hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .then(|| Self(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for UnitId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
```

`crates/freshell-containment/src/process.rs` (Linux part now; Windows and macOS functions land in Tasks 6 and 7 behind the same names):

```rust
use std::io;

/// One process incarnation: (pid, start time) is unique across pid reuse.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcIdentity {
    pub pid: u32,
    pub start: u64,
    pub argv: Vec<String>,
}

/// The ONLY argv inspection the kill path performs, and it can only SPARE a
/// process: Codex's own managed daemon must never be signalled.
pub fn is_codex_managed_daemon(argv: &[String]) -> bool {
    argv.iter().any(|a| a == "app-server") && argv.iter().any(|a| a == "--managed-daemon")
}

pub fn identity(pid: u32) -> io::Result<ProcIdentity> {
    Ok(ProcIdentity { pid, start: start_time(pid)?, argv: argv(pid).unwrap_or_default() })
}

#[cfg(target_os = "linux")]
pub(crate) fn stat_fields(pid: u32) -> io::Result<Vec<String>> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let close = raw.rfind(')').ok_or_else(|| io::Error::other("malformed stat"))?;
    Ok(raw[close + 2..].split_whitespace().map(str::to_string).collect())
}

/// Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot).
#[cfg(target_os = "linux")]
pub fn start_time(pid: u32) -> io::Result<u64> {
    stat_fields(pid)?
        .get(19) // field 22 overall; index 19 after "pid (comm) "
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| io::Error::other("no starttime"))
}

#[cfg(target_os = "linux")]
pub fn argv(pid: u32) -> io::Result<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline"))?;
    Ok(raw.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect())
}

/// Linux: true for a live (non-zombie) process.
#[cfg(target_os = "linux")]
pub fn is_running(pid: u32) -> bool {
    stat_fields(pid).is_ok_and(|f| f.first().is_some_and(|s| s != "Z" && s != "X"))
}

#[cfg(target_os = "linux")]
pub fn parent(pid: u32) -> Option<u32> {
    stat_fields(pid).ok()?.get(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
pub fn children(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(raw) = std::fs::read_to_string(task.path().join("children")) {
                out.extend(raw.split_whitespace().filter_map(|p| p.parse::<u32>().ok()));
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
pub fn all_pids() -> Vec<u32> {
    std::fs::read_dir("/proc")
        .map(|it| it.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).collect())
        .unwrap_or_default()
}

/// Linux: one environment value, or None when unreadable (other uid,
/// non-dumpable) — callers log unreadable candidates, never guess.
#[cfg(target_os = "linux")]
pub fn environ_value(pid: u32, key: &str) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    let prefix = format!("{key}=");
    raw.split(|b| *b == 0).find_map(|kv| {
        let s = String::from_utf8_lossy(kv);
        s.strip_prefix(&prefix).map(str::to_string)
    })
}
```

`crates/freshell-containment/src/proc_watch.rs` (Linux; Windows and macOS variants are added under the same API in Tasks 6 and 7):

```rust
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::process::{self, ProcIdentity};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sig {
    Interrupt,
    Terminate,
    Kill,
}

/// An event-driven exit watch on ONE process incarnation. Linux: a pidfd
/// (readable exactly when the process exits; signals through it can never
/// reach a recycled pid). No polling anywhere.
#[derive(Clone)]
pub struct ProcWatch {
    inner: Arc<Inner>,
}

struct Inner {
    identity: ProcIdentity,
    exited: AtomicBool,
    #[cfg(target_os = "linux")]
    fd: std::os::fd::OwnedFd,
}

impl std::fmt::Debug for ProcWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProcWatch").field("identity", &self.inner.identity).finish()
    }
}

impl ProcWatch {
    pub fn open(pid: u32) -> io::Result<Self> {
        Self::open_inner(pid, None)
    }

    pub fn open_expecting(pid: u32, start: u64) -> io::Result<Self> {
        Self::open_inner(pid, Some(start))
    }

    pub fn identity(&self) -> &ProcIdentity {
        &self.inner.identity
    }

    pub fn pid(&self) -> u32 {
        self.inner.identity.pid
    }

    #[cfg(target_os = "linux")]
    fn open_inner(pid: u32, expect_start: Option<u64>) -> io::Result<Self> {
        use std::os::fd::FromRawFd;
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if raw < 0 {
            let err = io::Error::last_os_error();
            return Err(if err.raw_os_error() == Some(libc::ESRCH) {
                io::Error::new(io::ErrorKind::NotFound, "process gone")
            } else {
                err
            });
        }
        let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(raw as i32) };
        // Identity is read AFTER the pidfd pins the incarnation: a pid recycled
        // before pidfd_open shows a different start time and is refused.
        let identity = process::identity(pid)
            .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "process gone"))?;
        if expect_start.is_some_and(|s| s != identity.start) {
            return Err(io::Error::new(io::ErrorKind::NotFound, "different incarnation"));
        }
        Ok(Self { inner: Arc::new(Inner { identity, exited: AtomicBool::new(false), fd }) })
    }

    /// Non-blocking: has the process exited (zombies count as exited)?
    #[cfg(target_os = "linux")]
    pub fn has_exited(&self) -> bool {
        use std::os::fd::AsRawFd;
        if self.inner.exited.load(Ordering::SeqCst) {
            return true;
        }
        let mut pfd = libc::pollfd { fd: self.inner.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        let ready = unsafe { libc::poll(&mut pfd, 1, 0) } > 0 && (pfd.revents & libc::POLLIN) != 0;
        if ready {
            self.inner.exited.store(true, Ordering::SeqCst);
        }
        ready
    }

    /// Resolves when the process exits. Event-driven (pidfd readiness in the
    /// tokio reactor). Must be awaited inside a tokio runtime.
    #[cfg(target_os = "linux")]
    pub async fn exited(&self) {
        if self.has_exited() {
            return;
        }
        let dup = self.inner.fd.try_clone().expect("dup pidfd");
        let afd = tokio::io::unix::AsyncFd::with_interest(dup, tokio::io::Interest::READABLE)
            .expect("register pidfd with the tokio reactor");
        let _ = afd.readable().await;
        self.inner.exited.store(true, Ordering::SeqCst);
    }

    /// Send a signal to THIS incarnation. An already-exited process is Ok(()).
    #[cfg(target_os = "linux")]
    pub fn signal(&self, sig: Sig) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let signum = match sig {
            Sig::Interrupt => libc::SIGINT,
            Sig::Terminate => libc::SIGTERM,
            Sig::Kill => libc::SIGKILL,
        };
        let rc = unsafe {
            libc::syscall(libc::SYS_pidfd_send_signal, self.inner.fd.as_raw_fd(), signum, std::ptr::null::<libc::siginfo_t>(), 0)
        };
        if rc < 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(err);
        }
        Ok(())
    }
}
```

`crates/freshell-containment/src/events.rs`:

```rust
//! The `freshell_unit` JSONL event family (target `freshell_unit`). Every
//! event carries the same key set; absent values are empty strings, numbers
//! are numbers (never `?`-formatted Options).
use crate::process::ProcIdentity;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitLogKeys {
    pub unit_id: String,
    pub provider: String,
    pub session_id: Option<String>,
    pub terminal_id: Option<String>,
    pub operation_id: Option<String>,
}

macro_rules! keyed {
    ($lvl:ident, $k:expr, $event:literal, $($rest:tt)*) => {
        tracing::$lvl!(target: "freshell_unit",
            event = $event,
            unit_id = %$k.unit_id,
            provider = %$k.provider,
            session_id = %$k.session_id.as_deref().unwrap_or(""),
            terminal_id = %$k.terminal_id.as_deref().unwrap_or(""),
            operation_id = %$k.operation_id.as_deref().unwrap_or(""),
            $($rest)*)
    };
}

pub fn stop_requested(k: &UnitLogKeys, reason: &str, mode: &str, initiator: &str) {
    keyed!(info, k, "unit.stop.requested", reason = %reason, mode = %mode, initiator = %initiator, "");
}
pub fn signal_sent(k: &UnitLogKeys, signal: &str, target: &str, pid: Option<u32>) {
    keyed!(info, k, "unit.stop.signal_sent", signal = %signal, target = %target, pid = pid.unwrap_or(0), "");
}
pub fn gone(k: &UnitLogKeys, reason: &str, duration_ms: u64, lock_released: bool, escalated: bool) {
    keyed!(info, k, "unit.stop.gone", reason = %reason, duration_ms, lock_released, escalated, "");
}
pub fn escalated(k: &UnitLogKeys, from: &str, to: &str, after_ms: u64) {
    keyed!(warn, k, "unit.stop.escalated", from = %from, to = %to, after_ms, "");
}
pub fn unconfirmed(k: &UnitLogKeys, after_ms: u64, waiting_on: &str) {
    keyed!(error, k, "unit.stop.unconfirmed", after_ms, waiting_on = %waiting_on, "");
}
pub fn descendants_survived(k: &UnitLogKeys, survivors: &[ProcIdentity]) {
    let list = serde_json::to_string(survivors).unwrap_or_default();
    keyed!(warn, k, "unit.descendants.survived", count = survivors.len(), survivors = %list, "");
}
pub fn start_waited(k: &UnitLogKeys, entry_point: &str, wait_ms: u64) {
    keyed!(info, k, "unit.start.waited", entry_point = %entry_point, wait_ms, "");
}
pub fn writer_conflict(k: &UnitLogKeys, thread_id: &str, holder_pid: Option<u32>, holder_command: Option<&str>, source: &str) {
    keyed!(error, k, "unit.writer_conflict", thread_id = %thread_id, holder_pid = holder_pid.unwrap_or(0),
        holder_command = %holder_command.unwrap_or(""), source = %source, "");
}
pub fn main_discovery_failed(k: &UnitLogKeys, port: u16, fallback_pid: u32) {
    keyed!(warn, k, "unit.main_discovery_failed", port, fallback_pid, "");
}
```

`crates/freshell-containment/src/testing.rs`:

```rust
//! Env-gated fault injection for system tests (never active unless the
//! process runs with FRESHELL_TEST_HOOKS=1). Holds the Gone CONFIRMATION
//! (not the kill) so the unconfirmed path is testable end to end.
pub fn gone_delay() -> Option<std::time::Duration> {
    if std::env::var("FRESHELL_TEST_HOOKS").as_deref() != Ok("1") {
        return None;
    }
    std::env::var("FRESHELL_TEST_UNIT_GONE_DELAY_MS")
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
        .map(std::time::Duration::from_millis)
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-containment --test proc_watch --locked`

Expected: PASS (6 tests on Linux; the 2 Windows tests are compiled out here and run in Task 6's CI step).

- [ ] **Step 5: Refactor while green**

Make `ProcWatch::exited` cache one `AsyncFd` per watch (store a `tokio::sync::OnceCell<AsyncFd<OwnedFd>>` in `Inner`) so repeated awaits do not re-register; keep `has_exited` lock-free. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

New leaf crate; only the workspace build and the cross-target checks are impacted. macOS/Windows bodies for `process.rs`/`proc_watch.rs` do not exist yet, so add `#[cfg(not(target_os = "linux"))]` bodies now that return `io::ErrorKind::Unsupported` from `identity`/`open` (Tasks 6 and 7 replace every one of them; Task 7 Step 5 checks none remain):

Run: `cargo test -p freshell-containment --locked && cargo check -p freshell-containment --tests --target x86_64-pc-windows-gnu --locked && cargo check -p freshell-containment --tests --target aarch64-apple-darwin --locked && cargo clippy -p freshell-containment --all-targets --locked -- -D warnings`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-containment Cargo.lock
git commit -m "feat(containment): unit ids, process identity, event-driven ProcWatch, unit log events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Lock-holder and listening-socket lookups (Linux)

**Files:**
- Create: `crates/freshell-containment/src/locks.rs`
- Create: `crates/freshell-containment/src/listener.rs`
- Modify: `crates/freshell-containment/src/lib.rs` (add `pub mod locks; pub mod listener;` and re-export `lock_holders`, `LockHolder`, `codex_thread_lock_path`, `listening_socket_owner`)
- Test: `crates/freshell-containment/tests/locks_listener.rs`

**Interfaces:**
- Consumes: `process::{argv, children}` (Task 2).
- Produces: `LockHolder { pid, command, path }`, `lock_holders(paths) -> Vec<LockHolder>` (only CURRENT holders; a path that is not locked yields nothing; the file existing proves nothing), `codex_thread_lock_path(codex_home, thread_id)`, `listening_socket_owner(port, candidates) -> Option<u32>` (searches the candidates and all their descendants for the process whose fd table holds the LISTEN socket on `127.0.0.1:<port>` / `[::1]:<port>`). Windows and macOS bodies arrive in Tasks 6 and 7 under the same signatures (until then they return empty / `None`).

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/locks_listener.rs`:

```rust
#![cfg(target_os = "linux")]
//! Lock holders come from the OS lock table (by inode), never from the lock
//! file's existence; the app-server main process is whoever owns the
//! listening socket. Every process here is spawned and killed by the test.
use std::time::Duration;

use freshell_containment::{codex_thread_lock_path, listening_socket_owner, lock_holders};

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[test]
fn codex_lock_path_layout() {
    let p = codex_thread_lock_path(std::path::Path::new("/h/.codex"), "01a1");
    assert_eq!(p, std::path::PathBuf::from("/h/.codex/thread-writer-locks/01a1.lock"));
}

#[tokio::test(flavor = "multi_thread")]
async fn lock_holders_names_the_current_flock_holder() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    std::fs::write(&lock, b"").unwrap();
    assert!(lock_holders(&[lock.clone()]).is_empty(), "an unlocked file has no holder");
    let mut holder = std::process::Command::new("flock")
        .args(["-x", lock.to_str().unwrap(), "sleep", "600"])
        .spawn()
        .unwrap();
    let pid = holder.id();
    eventually("flock taken", || !lock_holders(&[lock.clone()]).is_empty()).await;
    let found = lock_holders(&[lock.clone()]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].pid, pid);
    assert!(found[0].command.contains("flock"));
    assert_eq!(found[0].path, lock);
    holder.kill().unwrap();
    holder.wait().unwrap();
    eventually("lock released", || lock_holders(&[lock.clone()]).is_empty()).await;
}

#[test]
fn lock_holders_ignores_missing_paths() {
    assert!(lock_holders(&[std::path::PathBuf::from("/nonexistent/x.lock")]).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn listening_socket_owner_finds_a_grandchild_listener() {
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let script = format!(
        "node -e \"require('net').createServer().listen({port}, '127.0.0.1')\" & wait"
    );
    let mut wrapper = std::process::Command::new("sh").args(["-c", &script]).spawn().unwrap();
    let wrapper_pid = wrapper.id();
    eventually("listener up", || std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()).await;
    let owner = listening_socket_owner(port, &[wrapper_pid]).expect("owner found");
    assert_ne!(owner, wrapper_pid, "the shell does not own the socket; its node child does");
    assert_eq!(freshell_containment::process::parent(owner), Some(wrapper_pid));
    assert_eq!(listening_socket_owner(port, &[std::process::id()]), None, "outside the candidates' trees");
    unsafe { libc::kill(owner as i32, libc::SIGKILL) };
    wrapper.kill().ok();
    wrapper.wait().ok();
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-containment --test locks_listener --locked`

Expected: FAIL to compile — `unresolved imports freshell_containment::{codex_thread_lock_path, listening_socket_owner, lock_holders}`.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-containment/src/locks.rs`:

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LockHolder {
    pub pid: u32,
    pub command: String,
    pub path: PathBuf,
}

/// Codex's per-thread writer lock (codex-rs rollout/src/writer_lock.rs).
pub fn codex_thread_lock_path(codex_home: &Path, thread_id: &str) -> PathBuf {
    codex_home.join("thread-writer-locks").join(format!("{thread_id}.lock"))
}

/// Linux: the CURRENT holders of locks on these files, from `/proc/locks`
/// matched by (device, inode). One read; no polling. Waiters (`->` lines)
/// are not holders.
#[cfg(target_os = "linux")]
pub fn lock_holders(paths: &[PathBuf]) -> Vec<LockHolder> {
    use std::os::unix::fs::MetadataExt;
    let wanted: Vec<(u64, u64, &PathBuf)> = paths
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok().map(|m| (m.dev(), m.ino(), p)))
        .collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let table = std::fs::read_to_string("/proc/locks").unwrap_or_default();
    let mut out = Vec::new();
    for line in table.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.get(1) == Some(&"->") || f.len() < 6 {
            continue;
        }
        let (Ok(pid), Some(devino)) = (f[4].parse::<u32>(), f.get(5)) else { continue };
        let parts: Vec<&str> = devino.split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        let (Ok(maj), Ok(min), Ok(ino)) = (
            u32::from_str_radix(parts[0], 16),
            u32::from_str_radix(parts[1], 16),
            parts[2].parse::<u64>(),
        ) else {
            continue;
        };
        let dev = libc::makedev(maj, min) as u64;
        for (wdev, wino, path) in &wanted {
            if *wdev == dev && *wino == ino {
                let command = crate::process::argv(pid).map(|a| a.join(" ")).unwrap_or_default();
                out.push(LockHolder { pid, command, path: (*path).clone() });
            }
        }
    }
    out
}

#[cfg(not(target_os = "linux"))]
pub fn lock_holders(_paths: &[PathBuf]) -> Vec<LockHolder> {
    Vec::new() // Windows: Task 6 (Restart Manager); macOS: Task 7 (lsof)
}
```

`crates/freshell-containment/src/listener.rs`:

```rust
/// Linux: the pid (among `candidates` and their descendants) whose fd table
/// holds the LISTEN socket bound to `port`. Used once, right after a
/// sidecar's readiness probe succeeds, to find the native app-server behind
/// any launcher/wrapper chain.
#[cfg(target_os = "linux")]
pub fn listening_socket_owner(port: u16, candidates: &[u32]) -> Option<u32> {
    let inodes = listening_inodes(port);
    if inodes.is_empty() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut frontier: Vec<u32> = candidates.to_vec();
    while let Some(pid) = frontier.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if owns_socket(pid, &inodes) {
            return Some(pid);
        }
        frontier.extend(crate::process::children(pid));
    }
    None
}

#[cfg(target_os = "linux")]
fn listening_inodes(port: u16) -> Vec<String> {
    let mut out = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(raw) = std::fs::read_to_string(table) else { continue };
        for line in raw.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                continue;
            }
            let Some(port_hex) = f[1].rsplit(':').next() else { continue };
            if u16::from_str_radix(port_hex, 16).ok() == Some(port) {
                out.push(f[9].to_string());
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn owns_socket(pid: u32, inodes: &[String]) -> bool {
    let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return false };
    fds.flatten().any(|fd| {
        std::fs::read_link(fd.path())
            .ok()
            .and_then(|t| t.to_str().map(str::to_string))
            .and_then(|t| t.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')).map(str::to_string))
            .is_some_and(|ino| inodes.contains(&ino))
    })
}

#[cfg(not(target_os = "linux"))]
pub fn listening_socket_owner(_port: u16, _candidates: &[u32]) -> Option<u32> {
    None // Windows: Task 6 (GetExtendedTcpTable); macOS: Task 7 (lsof)
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-containment --test locks_listener --locked`

Expected: PASS (4 tests).

- [ ] **Step 5: Refactor while green**

Extract the `/proc/locks` line parser into `fn parse_lock_line(line: &str) -> Option<(u32 /*pid*/, u64 /*dev*/, u64 /*ino*/)>` with a unit test for the `->` waiter line and the hex device form (`08:11:3150923`). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-containment --locked && cargo check -p freshell-containment --tests --target x86_64-pc-windows-gnu --locked && cargo check -p freshell-containment --tests --target aarch64-apple-darwin --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-containment
git commit -m "feat(containment): OS lock-holder and listening-socket owner lookups (Linux)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Units and the single stop sequence, with the tag backend

**Files:**
- Create: `crates/freshell-containment/src/backend/mod.rs`
- Create: `crates/freshell-containment/src/backend/tag.rs` (`cfg(unix)`)
- Create: `crates/freshell-containment/src/backend/roots.rs` (`cfg(windows)` only; deleted by Task 6)
- Create: `crates/freshell-containment/src/unit.rs`
- Create: `crates/freshell-containment/src/containment.rs`
- Modify: `crates/freshell-containment/src/lib.rs` (modules + re-exports: `AgentUnit, UnitLabel, MemberRole, Placement, StopMode, StopReason, StopRequest, StopReport, StopHandle, GoneCallback, Containment, SelectOptions, ShimCommand, set_global_containment, global_containment, BackendKind, Capability`)
- Modify: `crates/freshell-containment/src/process.rs` (`is_running`, `parent`, `children`, `all_pids`, `environ_value`, `argv` get `cfg(not(target_os = "linux"))` bodies: Linux keeps Task 2's; others return empty/false until Tasks 6–7)
- Modify: `crates/freshell-containment/Cargo.toml` (dev-dep `tracing-subscriber = { version = "0.3", default-features = false, features = ["registry", "std"] }`)
- Test: `crates/freshell-containment/tests/support/mod.rs`, `crates/freshell-containment/tests/support/capture.rs`, `crates/freshell-containment/tests/conformance.rs`, `crates/freshell-containment/tests/unconfirmed.rs`

**Interfaces:**
- Consumes: Task 2 (`ProcWatch`, `events`, `testing::gone_delay`, `process`), Task 3 (`lock_holders`).
- Produces: everything in the Shared interfaces block for `unit.rs` and `containment.rs`, with these exact refinements:
  - `SelectOptions { pub shim: Option<ShimCommand> }` (derives `Default`, `Clone`).
  - `StopReport { unit_id, reason: String, mode: &'static str, duration_ms, escalated, lock_released }` (no survivor list: survivors are reported by the post-Gone sweep).
  - `StopHandle::wait() -> StopReport` resolves at Gone (after `on_gone` ran); `StopHandle::wait_swept() -> Vec<ProcIdentity>` resolves after the post-Gone sweep with the survivors (empty when none).
  - `StopRequest::new(mode, reason, initiator)` plus builder methods `.operation(id)`, `.before_signal(fut)`, `.on_gone(cb)`, `.soft_interrupt(f)`.
  - Constants `FORCE_GRACE = 1 s`, `UNCONFIRMED_AFTER = 5 s`, `POST_GONE_EMPTY_WAIT = 2 s` (all `pub` in `unit.rs`).
  - `StopReason::as_str()` → `"shift-x" | "kill-command" | "respawn" | "cleanup" | "handoff" | "stuck-restart" | "start-cancelled" | "agent-exited" | "boot-finish" | "server-shutdown"`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/support/capture.rs`:

```rust
//! Captures `freshell_unit` events (level + `event` field) for assertions.
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;

#[derive(Clone, Default)]
pub struct Captured(pub Arc<Mutex<Vec<(tracing::Level, String)>>>);

struct EventName(Option<String>);
impl Visit for EventName {
    fn record_str(&mut self, f: &Field, v: &str) {
        if f.name() == "event" {
            self.0 = Some(v.to_string());
        }
    }
    fn record_debug(&mut self, f: &Field, v: &dyn std::fmt::Debug) {
        if f.name() == "event" {
            self.0 = Some(format!("{v:?}").trim_matches('"').to_string());
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for Captured {
    fn on_event(&self, e: &tracing::Event<'_>, _: Context<'_, S>) {
        let mut name = EventName(None);
        e.record(&mut name);
        if let Some(n) = name.0 {
            self.0.lock().unwrap().push((*e.metadata().level(), n));
        }
    }
}

pub fn install() -> (Captured, tracing::subscriber::DefaultGuard) {
    let cap = Captured::default();
    let guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(cap.clone()));
    (cap, guard)
}

impl Captured {
    pub fn has(&self, level: tracing::Level, event: &str) -> bool {
        self.0.lock().unwrap().iter().any(|(l, n)| *l == level && n == event)
    }
}
```

`crates/freshell-containment/tests/support/mod.rs`:

```rust
#![allow(dead_code)]
pub mod capture;

use std::path::PathBuf;
use std::time::Duration;

use freshell_containment::{AgentUnit, BackendKind, Containment, MemberRole, ProcWatch, SelectOptions};

/// The backends this host must pass the conformance suite on: always the tag
/// backend; plus the selected backend when it is a full one. With
/// FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 (garageserver, CI after Task 5) the
/// selected backend MUST be the systemd one.
pub fn backends() -> Vec<(&'static str, Containment)> {
    let mut out = vec![("tag", Containment::tag_backend(SelectOptions::default()))];
    let selected = Containment::select(SelectOptions::default());
    let kind = selected.capability().kind;
    if std::env::var("FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT").as_deref() == Ok("1") {
        assert_eq!(kind, BackendKind::SystemdScope, "systemd containment required on this host");
    }
    if selected.capability().full {
        out.push(("selected", selected));
    }
    out
}

#[derive(Default, Clone)]
pub struct AgentOpts {
    pub exit_on_int: bool,
    pub exit_on_term: bool,
    pub managed_daemon_child: bool,
    pub lock_child: Option<PathBuf>,
}

pub struct AgentScript {
    pub dir: tempfile::TempDir,
    pub script: PathBuf,
    pub pids: PathBuf,
    pub marker: PathBuf,
}

#[derive(Debug, Clone, Copy)]
pub struct Pids {
    pub main: u32,
    pub setsid: u32,
    pub pgrp: u32,
    pub nohup: u32,
    pub daemon: u32,
    pub locker: u32,
}

pub fn agent_script(opts: &AgentOpts) -> AgentScript {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("agent.sh");
    let pids = dir.path().join("pids");
    let marker = dir.path().join("marker");
    let body = format!(
        r#"#!/bin/bash
trap 'echo INT >> "{marker}"; [ "{ei}" = 1 ] && exit 0' INT
trap 'echo TERM >> "{marker}"; [ "{et}" = 1 ] && exit 0' TERM
perl -e 'use POSIX; POSIX::setsid(); exec "sleep", "600"' & S=$!
perl -e 'setpgrp(0,0); sleep 600' & P=$!
nohup sh -c 'sleep 600 & echo $! > "{dir}/nohup.pid"' >/dev/null 2>&1 &
D=0; [ "{daemon}" = 1 ] && {{ perl -e 'sleep 600' app-server --managed-daemon & D=$!; }}
L=0; [ -n "{lock}" ] && {{ perl -e 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; sleep 600' "{lock}" & L=$!; }}
while [ ! -s "{dir}/nohup.pid" ]; do sleep 0.05; done
echo "$$ $S $P $(cat "{dir}/nohup.pid") $D $L" > "{pids}.tmp" && mv "{pids}.tmp" "{pids}"
while true; do sleep 1 & wait $!; done
"#,
        marker = marker.display(),
        ei = u8::from(opts.exit_on_int),
        et = u8::from(opts.exit_on_term),
        dir = dir.path().display(),
        daemon = u8::from(opts.managed_daemon_child),
        lock = opts.lock_child.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
        pids = pids.display(),
    );
    std::fs::write(&script, body).unwrap();
    AgentScript { dir, script, pids, marker }
}

pub async fn spawn_main(unit: &AgentUnit, s: &AgentScript) -> tokio::process::Child {
    let mut cmd = unit
        .tokio_command("bash", &[s.script.display().to_string()], MemberRole::Agent)
        .unwrap();
    cmd.kill_on_drop(false).stdin(std::process::Stdio::null());
    let child = cmd.spawn().unwrap();
    unit.set_main(ProcWatch::open(child.id().unwrap()).unwrap());
    child
}

pub async fn read_pids(s: &AgentScript) -> Pids {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&s.pids) {
            let v: Vec<u32> = raw.split_whitespace().map(|x| x.parse().unwrap()).collect();
            return Pids { main: v[0], setsid: v[1], pgrp: v[2], nohup: v[3], daemon: v[4], locker: v[5] };
        }
        assert!(tokio::time::Instant::now() < deadline, "agent script never wrote its pids");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub fn alive(pid: u32) -> bool {
    pid != 0 && freshell_containment::process::is_running(pid)
}
```

`crates/freshell-containment/tests/conformance.rs`:

```rust
#![cfg(target_os = "linux")]
//! The one stop sequence, on every backend this host can run. Every process
//! signalled here was spawned by the test (through the unit under test).
mod support;

use std::time::{Duration, Instant};

use freshell_containment::*;
use support::*;

fn label() -> UnitLabel {
    UnitLabel { provider: "test".into(), ..Default::default() }
}

#[tokio::test(flavor = "multi_thread")]
async fn force_stop_interrupts_main_first_then_kills_the_whole_unit() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default()); // ignores SIGINT
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let t0 = Instant::now();
        let report = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
        let took = t0.elapsed();
        assert!(std::fs::read_to_string(&s.marker).unwrap().contains("INT"), "{name}: SIGINT first");
        assert!(took >= Duration::from_millis(900) && took < Duration::from_secs(4), "{name}: {took:?}");
        assert_eq!(report.reason, "shift-x");
        assert_eq!(report.mode, "force");
        assert!(report.lock_released);
        let survivors = unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(survivors.is_empty(), "{name}: survivors {survivors:?}");
        for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
            assert!(!alive(pid), "{name}: pid {pid} survived Shift-X");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn force_stop_kills_the_rest_as_soon_as_main_exits() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts { exit_on_int: true, ..Default::default() });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let t0 = Instant::now();
        unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
        assert!(t0.elapsed() < Duration::from_millis(800), "{name}: no idle wait after main exit");
        unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(!alive(p.nohup) && !alive(p.setsid), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn graceful_stop_escalates_after_its_grace() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default()); // ignores SIGTERM
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let report = unit
            .stop(StopRequest::new(StopMode::Graceful { grace: Duration::from_millis(400) }, StopReason::Cleanup, "test"))
            .wait()
            .await;
        assert!(std::fs::read_to_string(&s.marker).unwrap().contains("TERM"), "{name}: polite first");
        assert!(report.escalated, "{name}: escalated after grace");
        assert!(!alive(p.main), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_force_stop_joins_and_skips_the_grace() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let t0 = Instant::now();
        let first = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "a"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let second = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "b"));
        let (r1, r2) = (first.wait().await, second.wait().await);
        assert_eq!(r1, r2, "{name}: one stop, joined");
        assert!(r1.escalated, "{name}");
        assert!(t0.elapsed() < Duration::from_millis(800), "{name}: {:?}", t0.elapsed());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn force_on_a_graceful_stop_escalates_immediately() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts::default());
        let _child = spawn_main(&unit, &s).await;
        read_pids(&s).await;
        let t0 = Instant::now();
        let polite = unit.stop(StopRequest::new(StopMode::Graceful { grace: Duration::from_secs(30) }, StopReason::Cleanup, "cleanup"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "user"));
        assert!(polite.wait().await.escalated);
        assert!(t0.elapsed() < Duration::from_secs(2), "{name}: {:?}", t0.elapsed());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_codex_managed_daemon_is_never_signalled() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let s = agent_script(&AgentOpts { managed_daemon_child: true, ..Default::default() });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        assert!(alive(p.daemon));
        unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
        let survivors = unit.stop_in_flight().unwrap().wait_swept().await;
        assert!(alive(p.daemon), "{name}: managed daemon must survive");
        assert!(survivors.iter().all(|s| s.pid != p.daemon), "{name}: a spared daemon is not a survivor");
        assert!(!alive(p.main) && !alive(p.nohup), "{name}");
        unsafe { libc::kill(p.daemon as i32, libc::SIGKILL) }; // our own test process
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_holding_the_conversation_lock_is_killed_before_gone() {
    for (name, c) in backends() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("t.lock");
        std::fs::write(&lock, b"").unwrap();
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        unit.set_lock_paths(vec![lock.clone()]);
        let s = agent_script(&AgentOpts { exit_on_int: true, lock_child: Some(lock.clone()), ..Default::default() });
        let _child = spawn_main(&unit, &s).await;
        let p = read_pids(&s).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while lock_holders(&[lock.clone()]).is_empty() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let report = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
        assert!(report.lock_released, "{name}");
        assert!(lock_holders(&[lock.clone()]).is_empty(), "{name}: lock released at Gone");
        assert!(!alive(p.locker), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn placement_carries_the_unit_tag_and_a_unit_with_nothing_running_is_gone_at_once() {
    for (name, c) in backends() {
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let placement = unit.placement(MemberRole::Screen).unwrap();
        assert!(placement.env.contains(&(UNIT_ENV.to_string(), unit.id().as_str().to_string())), "{name}");
        let t0 = Instant::now();
        unit.stop(StopRequest::new(StopMode::Force, StopReason::StartCancelled, "test")).wait().await;
        assert!(t0.elapsed() < Duration::from_millis(500), "{name}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn before_signal_runs_first_and_on_gone_runs_before_the_handle_resolves() {
    let c = Containment::tag_backend(SelectOptions::default());
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let s = agent_script(&AgentOpts { exit_on_int: true, ..Default::default() });
    let _child = spawn_main(&unit, &s).await;
    read_pids(&s).await;
    let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (o1, o2, marker) = (order.clone(), order.clone(), s.marker.clone());
    let report = unit
        .stop(
            StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")
                .before_signal(Box::pin(async move {
                    assert!(!marker.exists(), "no signal before persistence");
                    o1.lock().unwrap().push("before".into());
                }))
                .on_gone(Box::new(move |r| Box::pin(async move { o2.lock().unwrap().push(format!("gone:{}", r.reason)); }))),
        )
        .wait()
        .await;
    assert_eq!(*order.lock().unwrap(), vec!["before".to_string(), "gone:shift-x".to_string()]);
    assert_eq!(report.reason, "shift-x");
}
```

`crates/freshell-containment/tests/unconfirmed.rs` (own test binary because it sets process env):

```rust
#![cfg(target_os = "linux")]
mod support;

use std::time::Duration;

use freshell_containment::*;
use support::*;

#[tokio::test(flavor = "current_thread")]
async fn an_unconfirmed_stop_logs_an_error_at_five_seconds_and_keeps_waiting() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", "6500");
    let (cap, _guard) = capture::install();
    let c = Containment::tag_backend(SelectOptions::default());
    let unit = c.create_unit(UnitId::mint(), UnitLabel { provider: "test".into(), ..Default::default() }).unwrap();
    let s = agent_script(&AgentOpts { exit_on_int: true, ..Default::default() });
    let _child = spawn_main(&unit, &s).await;
    read_pids(&s).await;
    let handle = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test"));
    assert!(handle.wait_for(Duration::from_secs(5)).await.is_none(), "not Gone within 5 s");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed"));
    let report = handle.wait().await;
    assert!(report.duration_ms >= 6500);
    assert!(cap.has(tracing::Level::INFO, "unit.stop.gone"));
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-containment --test conformance --test unconfirmed`

Expected: FAIL to compile — `cannot find type AgentUnit / Containment / StopRequest in crate freshell_containment` (unlocked once to add the `tracing-subscriber` dev edge to `Cargo.lock`).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-containment/src/backend/mod.rs`:

```rust
use std::io;
use std::sync::Arc;

use crate::process::ProcIdentity;
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId};

#[cfg(unix)]
pub(crate) mod tag;
#[cfg(windows)]
pub(crate) mod roots;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    SystemdScope,
    LinuxTag,
    WindowsJob,
    MacosTag,
}

impl BackendKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SystemdScope => "systemd-scope",
            Self::LinuxTag => "linux-tag",
            Self::WindowsJob => "windows-job",
            Self::MacosTag => "macos-tag",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Capability {
    pub kind: BackendKind,
    /// true = membership is kernel-tracked (cgroup / job); false = tag + tree.
    pub full: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct KillSummary {
    pub killed: usize,
    pub spared: Vec<ProcIdentity>,
}

pub(crate) trait Backend: Send + Sync {
    fn capability(&self) -> Capability;
    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>>;
    fn reopen(&self, id: &UnitId) -> io::Result<Option<Arc<dyn UnitBackend>>>;
    fn surviving(&self) -> io::Result<Vec<UnitId>>;
}

pub(crate) trait UnitBackend: Send + Sync {
    /// How to start a member so it is inside the unit before it runs code.
    fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement>;
    /// Kill every member except Codex managed-daemon processes (and their
    /// descendants). `roots` are the known member pids (screen, main, launcher).
    fn kill_all(&self, roots: &[u32]) -> io::Result<KillSummary>;
    fn members(&self, roots: &[u32]) -> io::Result<Vec<ProcIdentity>>;
    /// Event-driven "no live member left"; None when the backend cannot tell.
    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>>;
    fn remove(&self);
}

pub(crate) fn log_spared(spared: &[ProcIdentity]) {
    for p in spared {
        tracing::info!(target: "freshell_unit", event = "unit.stop.spared_managed_daemon",
            pid = p.pid, command = %p.argv.join(" "), "");
    }
}
```

`crates/freshell-containment/src/backend/tag.rs`:

```rust
//! Tag backend (Linux without a user systemd manager; macOS): members are
//! the processes carrying the unit's environment tag plus every descendant of
//! the unit's known roots. Kill is a stop-the-world sweep: SIGSTOP members
//! until the set stops growing (bounded by count, never by sleeping), verify
//! each stopped process still belongs to the unit (pid-reuse guard), then
//! SIGKILL them all. The Codex managed daemon and its descendants are spared.
use std::collections::BTreeSet;
use std::io;
use std::sync::Arc;

use super::{log_spared, Backend, BackendKind, Capability, KillSummary, UnitBackend};
use crate::process::{self, is_codex_managed_daemon, ProcIdentity};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

pub(crate) struct TagBackend {
    pub kind: BackendKind,
    pub reason: String,
}

impl Backend for TagBackend {
    fn capability(&self) -> Capability {
        Capability { kind: self.kind, full: false, reason: Some(self.reason.clone()) }
    }
    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(TagUnit::new(UNIT_ENV, id.as_str())))
    }
    fn reopen(&self, id: &UnitId) -> io::Result<Option<Arc<dyn UnitBackend>>> {
        let unit = TagUnit::new(UNIT_ENV, id.as_str());
        Ok((!unit.tagged().is_empty()).then(|| Arc::new(unit) as Arc<dyn UnitBackend>))
    }
    fn surviving(&self) -> io::Result<Vec<UnitId>> {
        let me = std::process::id();
        let mut ids: BTreeSet<UnitId> = BTreeSet::new();
        for pid in process::all_pids().into_iter().filter(|p| *p != me) {
            if let Some(id) = process::environ_value(pid, UNIT_ENV).and_then(|v| UnitId::parse(&v)) {
                ids.insert(id);
            }
        }
        Ok(ids.into_iter().collect())
    }
}

pub(crate) struct TagUnit {
    key: String,
    value: String,
}

impl TagUnit {
    pub(crate) fn new(key: &str, value: &str) -> Self {
        Self { key: key.to_string(), value: value.to_string() }
    }

    fn carries_tag(&self, pid: u32) -> bool {
        process::environ_value(pid, &self.key).as_deref() == Some(self.value.as_str())
    }

    fn tagged(&self) -> Vec<u32> {
        let me = std::process::id();
        process::all_pids().into_iter().filter(|p| *p != me && self.carries_tag(*p)).collect()
    }

    /// (members, spared) — spared = managed daemon(s) and their descendants.
    fn member_set(&self, roots: &[u32]) -> (BTreeSet<u32>, BTreeSet<u32>) {
        let me = std::process::id();
        let mut set: BTreeSet<u32> = self.tagged().into_iter().collect();
        set.extend(roots.iter().copied().filter(|p| process::is_running(*p)));
        let mut frontier: Vec<u32> = set.iter().copied().collect();
        while let Some(p) = frontier.pop() {
            for c in process::children(p) {
                if set.insert(c) {
                    frontier.push(c);
                }
            }
        }
        let mut spared = BTreeSet::new();
        let mut frontier: Vec<u32> = set
            .iter()
            .copied()
            .filter(|p| process::argv(*p).map(|a| is_codex_managed_daemon(&a)).unwrap_or(false))
            .collect();
        while let Some(p) = frontier.pop() {
            if spared.insert(p) {
                frontier.extend(process::children(p));
            }
        }
        set.retain(|p| *p != me && !spared.contains(p) && process::is_running(*p));
        (set, spared)
    }
}

impl UnitBackend for TagUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        Ok(Placement { wrapper: None, env: vec![(self.key.clone(), self.value.clone())] })
    }

    fn kill_all(&self, roots: &[u32]) -> io::Result<KillSummary> {
        let mut stopped: BTreeSet<u32> = BTreeSet::new();
        let mut spared_all = BTreeSet::new();
        for _round in 0..64 {
            let (set, spared) = self.member_set(roots);
            spared_all.extend(spared);
            let fresh: Vec<u32> = set.difference(&stopped).copied().collect();
            if fresh.is_empty() {
                break;
            }
            for pid in fresh {
                unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) };
                stopped.insert(pid);
            }
        }
        // Pid-reuse guard: a stopped process must still be a member (tagged, a
        // root, or a descendant of a member) — anything else is resumed.
        let (confirmed, _) = self.member_set(roots);
        for pid in &stopped {
            if confirmed.contains(pid) {
                unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
            } else {
                unsafe { libc::kill(*pid as libc::pid_t, libc::SIGCONT) };
            }
        }
        let spared: Vec<ProcIdentity> = spared_all.iter().filter_map(|p| process::identity(*p).ok()).collect();
        log_spared(&spared);
        Ok(KillSummary { killed: stopped.len(), spared })
    }

    fn members(&self, roots: &[u32]) -> io::Result<Vec<ProcIdentity>> {
        Ok(self.member_set(roots).0.into_iter().filter_map(|p| process::identity(p).ok()).collect())
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>> {
        None
    }

    fn remove(&self) {}
}
```

(Note the member re-check after SIGSTOP: a stopped process cannot exit or exec, so a pid that is still in the confirmed set is the same incarnation that carried the tag/tree relation.)

`crates/freshell-containment/src/backend/roots.rs` (Windows placeholder until Task 6; deleted there):

```rust
use std::io;
use std::sync::Arc;

use super::{Backend, BackendKind, Capability, KillSummary, UnitBackend};
use crate::process::ProcIdentity;
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

pub(crate) struct RootsBackend;
pub(crate) struct RootsUnit(String);

impl Backend for RootsBackend {
    fn capability(&self) -> Capability {
        Capability { kind: BackendKind::WindowsJob, full: false, reason: Some("job objects arrive in Task 6".into()) }
    }
    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(RootsUnit(id.as_str().to_string())))
    }
    fn reopen(&self, _id: &UnitId) -> io::Result<Option<Arc<dyn UnitBackend>>> {
        Ok(None)
    }
    fn surviving(&self) -> io::Result<Vec<UnitId>> {
        Ok(Vec::new())
    }
}

impl UnitBackend for RootsUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        Ok(Placement { wrapper: None, env: vec![(UNIT_ENV.to_string(), self.0.clone())] })
    }
    fn kill_all(&self, _roots: &[u32]) -> io::Result<KillSummary> {
        Ok(KillSummary::default())
    }
    fn members(&self, _roots: &[u32]) -> io::Result<Vec<ProcIdentity>> {
        Ok(Vec::new())
    }
    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>> {
        None
    }
    fn remove(&self) {}
}
```

`crates/freshell-containment/src/unit.rs`:

```rust
//! One coding-agent pane = one unit. `AgentUnit::stop` is the ONLY stop
//! sequence: SIGINT (force) or SIGTERM (graceful) to the main process, then
//! kill the whole unit, then confirm screen + main dead and the conversation
//! locks released (Gone), then sweep and log survivors. It holds no
//! lifecycle state of its own: Running/Stopping/Gone live in the owner
//! registry; this type only executes and joins the in-flight stop.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{watch, Notify};

use crate::backend::{Capability, UnitBackend};
use crate::events::{self, UnitLogKeys};
use crate::proc_watch::{ProcWatch, Sig};
use crate::process::{self, ProcIdentity};
use crate::{locks, testing, BoxFuture, UnitId};

pub const FORCE_GRACE: Duration = Duration::from_secs(1);
pub const UNCONFIRMED_AFTER: Duration = Duration::from_secs(5);
pub const POST_GONE_EMPTY_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitLabel {
    pub provider: String,
    pub session_id: Option<String>,
    pub terminal_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberRole {
    Screen,
    Agent,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement {
    pub wrapper: Option<Vec<String>>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    Force,
    Graceful { grace: Duration },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    ShiftX,
    KillCommand,
    Respawn,
    Cleanup,
    Handoff,
    StuckRestart,
    StartCancelled,
    AgentExited { exit_code: Option<i64> },
    BootFinish,
    ServerShutdown,
}

impl StopReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ShiftX => "shift-x",
            Self::KillCommand => "kill-command",
            Self::Respawn => "respawn",
            Self::Cleanup => "cleanup",
            Self::Handoff => "handoff",
            Self::StuckRestart => "stuck-restart",
            Self::StartCancelled => "start-cancelled",
            Self::AgentExited { .. } => "agent-exited",
            Self::BootFinish => "boot-finish",
            Self::ServerShutdown => "server-shutdown",
        }
    }
}

pub type GoneCallback = Box<dyn FnOnce(StopReport) -> BoxFuture<'static, ()> + Send>;

pub struct StopRequest {
    pub mode: StopMode,
    pub reason: StopReason,
    pub initiator: String,
    pub operation_id: Option<String>,
    pub before_signal: Option<BoxFuture<'static, ()>>,
    pub on_gone: Option<GoneCallback>,
    pub soft_interrupt: Option<Box<dyn FnOnce() + Send>>,
}

impl StopRequest {
    pub fn new(mode: StopMode, reason: StopReason, initiator: impl Into<String>) -> Self {
        Self { mode, reason, initiator: initiator.into(), operation_id: None, before_signal: None, on_gone: None, soft_interrupt: None }
    }
    pub fn operation(mut self, id: impl Into<String>) -> Self {
        self.operation_id = Some(id.into());
        self
    }
    pub fn before_signal(mut self, f: BoxFuture<'static, ()>) -> Self {
        self.before_signal = Some(f);
        self
    }
    pub fn on_gone(mut self, cb: GoneCallback) -> Self {
        self.on_gone = Some(cb);
        self
    }
    pub fn soft_interrupt(mut self, f: Box<dyn FnOnce() + Send>) -> Self {
        self.soft_interrupt = Some(f);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopReport {
    pub unit_id: UnitId,
    pub reason: String,
    pub mode: &'static str,
    pub duration_ms: u64,
    pub escalated: bool,
    pub lock_released: bool,
}

#[derive(Clone)]
pub struct StopHandle {
    gone: watch::Receiver<Option<StopReport>>,
    swept: watch::Receiver<Option<Vec<ProcIdentity>>>,
}

impl StopHandle {
    pub async fn wait(&self) -> StopReport {
        let mut rx = self.gone.clone();
        loop {
            if let Some(r) = rx.borrow().clone() {
                return r;
            }
            if rx.changed().await.is_err() {
                return rx.borrow().clone().expect("stop task ended without a report");
            }
        }
    }
    pub async fn wait_for(&self, limit: Duration) -> Option<StopReport> {
        tokio::time::timeout(limit, self.wait()).await.ok()
    }
    pub fn try_report(&self) -> Option<StopReport> {
        self.gone.borrow().clone()
    }
    pub async fn wait_swept(&self) -> Vec<ProcIdentity> {
        let mut rx = self.swept.clone();
        loop {
            if let Some(s) = rx.borrow().clone() {
                return s;
            }
            if rx.changed().await.is_err() {
                return rx.borrow().clone().unwrap_or_default();
            }
        }
    }
}

#[derive(Clone)]
pub struct AgentUnit {
    inner: Arc<Inner>,
}

struct Inner {
    id: UnitId,
    backend: Arc<dyn UnitBackend>,
    capability: Capability,
    label: Mutex<UnitLabel>,
    screen: Mutex<Option<ProcWatch>>,
    main: Mutex<Option<ProcWatch>>,
    roots: Mutex<Vec<ProcWatch>>,
    lock_paths: Mutex<Vec<PathBuf>>,
    seq: AtomicU32,
    stop: Mutex<Option<StopHandle>>,
    escalate_flag: AtomicBool,
    escalate: Notify,
}

async fn wait_opt(w: Option<ProcWatch>) {
    if let Some(w) = w {
        w.exited().await;
    }
}

impl AgentUnit {
    pub(crate) fn new(id: UnitId, backend: Arc<dyn UnitBackend>, capability: Capability, label: UnitLabel) -> Self {
        Self {
            inner: Arc::new(Inner {
                id,
                backend,
                capability,
                label: Mutex::new(label),
                screen: Mutex::new(None),
                main: Mutex::new(None),
                roots: Mutex::new(Vec::new()),
                lock_paths: Mutex::new(Vec::new()),
                seq: AtomicU32::new(0),
                stop: Mutex::new(None),
                escalate_flag: AtomicBool::new(false),
                escalate: Notify::new(),
            }),
        }
    }

    pub fn id(&self) -> &UnitId {
        &self.inner.id
    }
    pub fn label(&self) -> UnitLabel {
        self.inner.label.lock().unwrap().clone()
    }
    pub fn set_label(&self, label: UnitLabel) {
        *self.inner.label.lock().unwrap() = label;
    }
    pub fn capability(&self) -> Capability {
        self.inner.capability.clone()
    }

    pub fn placement(&self, role: MemberRole) -> std::io::Result<Placement> {
        let seq = self.inner.seq.fetch_add(1, Ordering::SeqCst);
        self.inner.backend.placement(role, seq)
    }

    pub fn tokio_command(&self, program: &str, args: &[String], role: MemberRole) -> std::io::Result<tokio::process::Command> {
        let placement = self.placement(role)?;
        let mut cmd = match &placement.wrapper {
            Some(w) => {
                let mut c = tokio::process::Command::new(&w[0]);
                c.args(&w[1..]).arg(program).args(args);
                c
            }
            None => {
                let mut c = tokio::process::Command::new(program);
                c.args(args);
                c
            }
        };
        for (k, v) in &placement.env {
            cmd.env(k, v);
        }
        Ok(cmd)
    }

    pub fn set_screen(&self, watch: ProcWatch) {
        *self.inner.screen.lock().unwrap() = Some(watch);
    }
    pub fn set_main(&self, watch: ProcWatch) {
        *self.inner.main.lock().unwrap() = Some(watch);
    }
    pub fn add_root(&self, watch: ProcWatch) {
        self.inner.roots.lock().unwrap().push(watch);
    }
    pub fn screen(&self) -> Option<ProcWatch> {
        self.inner.screen.lock().unwrap().clone()
    }
    pub fn main(&self) -> Option<ProcWatch> {
        self.inner.main.lock().unwrap().clone()
    }
    pub fn main_is_screen(&self) -> bool {
        matches!((self.main(), self.screen()), (Some(m), Some(s)) if m.identity() == s.identity())
    }
    pub fn set_lock_paths(&self, paths: Vec<PathBuf>) {
        *self.inner.lock_paths.lock().unwrap() = paths;
    }
    pub fn members(&self) -> std::io::Result<Vec<ProcIdentity>> {
        self.inner.backend.members(&self.root_pids())
    }
    pub fn stop_in_flight(&self) -> Option<StopHandle> {
        self.inner.stop.lock().unwrap().clone()
    }

    /// Start the stop, or join the one in flight. A Force request that joins
    /// a stop in flight escalates it straight to the whole-unit kill.
    pub fn stop(&self, req: StopRequest) -> StopHandle {
        let mut slot = self.inner.stop.lock().unwrap();
        if let Some(existing) = slot.as_ref() {
            if req.mode == StopMode::Force {
                self.inner.escalate_flag.store(true, Ordering::SeqCst);
                self.inner.escalate.notify_waiters();
            }
            return existing.clone();
        }
        let (gone_tx, gone_rx) = watch::channel(None);
        let (swept_tx, swept_rx) = watch::channel(None);
        let handle = StopHandle { gone: gone_rx, swept: swept_rx };
        *slot = Some(handle.clone());
        drop(slot);
        let unit = self.clone();
        tokio::spawn(async move {
            let report = unit.run_until_gone(req).await;
            let _ = gone_tx.send(Some(report));
            let survivors = unit.sweep().await;
            let _ = swept_tx.send(Some(survivors));
        });
        handle
    }

    fn root_pids(&self) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        for w in [self.screen(), self.main()].into_iter().flatten() {
            if !w.has_exited() {
                out.push(w.pid());
            }
        }
        for w in self.inner.roots.lock().unwrap().iter() {
            if !w.has_exited() {
                out.push(w.pid());
            }
        }
        out
    }

    fn log_keys(&self, operation_id: Option<String>) -> UnitLogKeys {
        let label = self.label();
        UnitLogKeys {
            unit_id: self.inner.id.as_str().to_string(),
            provider: label.provider,
            session_id: label.session_id,
            terminal_id: label.terminal_id,
            operation_id,
        }
    }

    async fn escalation(&self) {
        loop {
            let notified = self.inner.escalate.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.escalate_flag.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    async fn confirm_locks(&self) -> bool {
        let paths = self.inner.lock_paths.lock().unwrap().clone();
        if paths.is_empty() {
            return true;
        }
        let members: HashSet<u32> = self.members().unwrap_or_default().iter().map(|p| p.pid).collect();
        for holder in locks::lock_holders(&paths) {
            if !members.contains(&holder.pid) {
                continue; // not ours: someone took the lock after our holder died
            }
            if let Ok(w) = ProcWatch::open(holder.pid) {
                let _ = w.signal(Sig::Kill);
                w.exited().await;
            }
        }
        let members: HashSet<u32> = self.members().unwrap_or_default().iter().map(|p| p.pid).collect();
        !locks::lock_holders(&paths).iter().any(|h| members.contains(&h.pid) && process::is_running(h.pid))
    }

    async fn run_until_gone(&self, mut req: StopRequest) -> StopReport {
        let t0 = Instant::now();
        let keys = self.log_keys(req.operation_id.clone());
        let mode: &'static str = match req.mode {
            StopMode::Force => "force",
            StopMode::Graceful { .. } => "graceful",
        };
        events::stop_requested(&keys, req.reason.as_str(), mode, &req.initiator);
        if let Some(f) = req.before_signal.take() {
            f.await;
        }
        let main = self.main();
        let screen = self.screen();
        let main_alive = main.as_ref().is_some_and(|m| !m.has_exited());
        let mut escalated = false;
        match req.mode {
            StopMode::Force => {
                if self.inner.escalate_flag.load(Ordering::SeqCst) {
                    escalated = true;
                } else {
                    let interrupted = main_alive
                        && main.as_ref().is_some_and(|m| m.signal(Sig::Interrupt).is_ok());
                    if interrupted {
                        events::signal_sent(&keys, "SIGINT", "main", main.as_ref().map(ProcWatch::pid));
                    } else if let Some(f) = req.soft_interrupt.take() {
                        f();
                        events::signal_sent(&keys, "ctrl-c", "screen", screen.as_ref().map(ProcWatch::pid));
                    } else if main_alive {
                        events::signal_sent(&keys, "none", "main", main.as_ref().map(ProcWatch::pid));
                    }
                    if main_alive {
                        tokio::select! {
                            _ = wait_opt(main.clone()) => {}
                            _ = tokio::time::sleep(FORCE_GRACE) => {}
                            _ = self.escalation() => { escalated = true; }
                        }
                    }
                }
            }
            StopMode::Graceful { grace } => {
                if let Some(m) = main.as_ref().filter(|_| main_alive) {
                    if m.signal(Sig::Terminate).is_ok() {
                        events::signal_sent(&keys, "SIGTERM", "main", Some(m.pid()));
                    }
                    tokio::select! {
                        _ = m.exited() => {}
                        _ = tokio::time::sleep(grace) => {
                            escalated = true;
                            events::escalated(&keys, "SIGTERM", "SIGKILL", t0.elapsed().as_millis() as u64);
                        }
                        _ = self.escalation() => {
                            escalated = true;
                            events::escalated(&keys, "SIGTERM", "SIGKILL", t0.elapsed().as_millis() as u64);
                        }
                    }
                }
            }
        }
        match self.inner.backend.kill_all(&self.root_pids()) {
            Ok(_) => events::signal_sent(&keys, "SIGKILL", "unit", None),
            Err(error) => tracing::error!(target: "freshell_unit", event = "unit.stop.kill_all_failed",
                unit_id = %keys.unit_id, error = %error, ""),
        }
        for w in [main.as_ref(), screen.as_ref()].into_iter().flatten() {
            let _ = w.signal(Sig::Kill);
        }
        let confirm = async {
            wait_opt(main.clone()).await;
            wait_opt(screen.clone()).await;
            if let Some(delay) = testing::gone_delay() {
                tokio::time::sleep(delay).await;
            }
            self.confirm_locks().await
        };
        tokio::pin!(confirm);
        let unconfirmed_at = tokio::time::Instant::from_std(t0) + UNCONFIRMED_AFTER;
        let lock_released = tokio::select! {
            released = &mut confirm => released,
            _ = tokio::time::sleep_until(unconfirmed_at) => {
                events::unconfirmed(&keys, t0.elapsed().as_millis() as u64, "screen+main+lock");
                (&mut confirm).await
            }
        };
        let report = StopReport {
            unit_id: self.inner.id.clone(),
            reason: req.reason.as_str().to_string(),
            mode,
            duration_ms: t0.elapsed().as_millis() as u64,
            escalated,
            lock_released,
        };
        events::gone(&keys, &report.reason, report.duration_ms, lock_released, escalated);
        if let Some(cb) = req.on_gone.take() {
            cb(report.clone()).await;
        }
        report
    }

    /// After Gone: kill anything that appeared since, wait (event-driven,
    /// bounded) for the unit to empty, log survivors, release the unit.
    async fn sweep(&self) -> Vec<ProcIdentity> {
        let keys = self.log_keys(None);
        let _ = self.inner.backend.kill_all(&self.root_pids());
        if let Some(empty) = self.inner.backend.wait_empty() {
            let _ = tokio::time::timeout(POST_GONE_EMPTY_WAIT, empty).await;
        }
        let survivors: Vec<ProcIdentity> = self
            .inner
            .backend
            .members(&self.root_pids())
            .unwrap_or_default()
            .into_iter()
            .filter(|p| process::is_running(p.pid))
            .collect();
        if !survivors.is_empty() {
            events::descendants_survived(&keys, &survivors);
        }
        self.inner.backend.remove();
        survivors
    }
}
```

`crates/freshell-containment/src/containment.rs`:

```rust
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use crate::backend::{Backend, BackendKind, Capability};
use crate::proc_watch::ProcWatch;
use crate::unit::{AgentUnit, UnitLabel};
use crate::UnitId;

#[derive(Debug, Clone)]
pub struct ShimCommand {
    pub exe: PathBuf,
    pub leading_args: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SelectOptions {
    /// The self-placing exec shim (Windows job placement): the server passes
    /// its own exe + `__unit-exec`; tests pass the `freshell-unit-exec` bin.
    pub shim: Option<ShimCommand>,
}

#[derive(Clone)]
pub struct Containment {
    backend: Arc<dyn Backend>,
}

impl Containment {
    /// Pick the best backend this process can use and log the choice once
    /// (`event=containment.backend`). Degraded never blocks a kill.
    pub fn select(opts: SelectOptions) -> Self {
        let chosen = Self::probe(&opts);
        let cap = chosen.capability();
        tracing::info!(target: "freshell_unit", event = "containment.backend",
            backend = cap.kind.as_str(), full = cap.full,
            reason = %cap.reason.clone().unwrap_or_default(), "");
        chosen
    }

    #[allow(unused_variables)]
    fn probe(opts: &SelectOptions) -> Self {
        #[cfg(target_os = "linux")]
        {
            // Task 5 inserts the systemd user-manager probe here.
            return Self::tag_with(BackendKind::LinuxTag, "no systemd user manager backend");
        }
        #[cfg(target_os = "macos")]
        {
            return Self::tag_with(BackendKind::MacosTag, "macOS has no kernel process containment");
        }
        #[cfg(windows)]
        {
            return Self { backend: Arc::new(crate::backend::roots::RootsBackend) };
        }
    }

    /// The degraded tag backend, forced (tests; the sandbox).
    pub fn tag_backend(_opts: SelectOptions) -> Self {
        #[cfg(target_os = "macos")]
        {
            return Self::tag_with(BackendKind::MacosTag, "forced tag backend");
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            return Self::tag_with(BackendKind::LinuxTag, "forced tag backend");
        }
        #[cfg(windows)]
        {
            Self { backend: Arc::new(crate::backend::roots::RootsBackend) }
        }
    }

    #[cfg(unix)]
    fn tag_with(kind: BackendKind, reason: &str) -> Self {
        Self { backend: Arc::new(crate::backend::tag::TagBackend { kind, reason: reason.to_string() }) }
    }

    pub fn capability(&self) -> Capability {
        self.backend.capability()
    }

    pub fn create_unit(&self, id: UnitId, label: UnitLabel) -> std::io::Result<AgentUnit> {
        let backend = self.backend.create(&id)?;
        Ok(AgentUnit::new(id, backend, self.capability(), label))
    }

    pub fn reopen_unit(&self, id: &UnitId, label: UnitLabel) -> std::io::Result<Option<AgentUnit>> {
        Ok(self.backend.reopen(id)?.map(|b| AgentUnit::new(id.clone(), b, self.capability(), label)))
    }

    /// A pre-containment (v1 record) sidecar: members are found by its legacy
    /// tag (e.g. FRESHELL_CODEX_SIDECAR_ID) plus the recorded root pids.
    pub fn adopt_legacy(&self, tag_key: &str, tag_value: &str, roots: &[u32], label: UnitLabel) -> AgentUnit {
        #[cfg(unix)]
        let backend: Arc<dyn crate::backend::UnitBackend> = Arc::new(crate::backend::tag::TagUnit::new(tag_key, tag_value));
        #[cfg(windows)]
        let backend: Arc<dyn crate::backend::UnitBackend> = { let _ = (tag_key, tag_value); self.backend.create(&UnitId::mint()).expect("roots unit") };
        let unit = AgentUnit::new(UnitId::mint(), backend, self.capability(), label);
        for pid in roots {
            if let Ok(w) = ProcWatch::open(*pid) {
                unit.add_root(w);
            }
        }
        unit
    }

    pub fn surviving_units(&self) -> std::io::Result<Vec<UnitId>> {
        self.backend.surviving()
    }
}

static GLOBAL: OnceLock<Containment> = OnceLock::new();

/// Install the process-global containment (freshell-server main, once).
pub fn set_global_containment(c: Containment) -> bool {
    GLOBAL.set(c).is_ok()
}

pub fn global_containment() -> Option<Containment> {
    GLOBAL.get().cloned()
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-containment --test conformance --test unconfirmed --locked`

Expected: PASS (on this Linux host the suite runs against the tag backend only until Task 5).

- [ ] **Step 5: Refactor while green**

Extract the Force and Graceful arms of `run_until_gone` into `async fn soft_phase(&self, …) -> bool /*escalated*/` and the Gone confirmation into `async fn confirm_gone(&self, …) -> bool /*lock_released*/` so `run_until_gone` reads as the five steps of the design (request → soft signal → kill unit → confirm → publish). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Leaf crate; nothing else depends on it yet. Also run the degraded suite inside the Docker sandbox (read-only cgroupfs, non-root), which is where Cloud Run and the sandbox will run it:

Run: `cargo test -p freshell-containment --locked && cargo check -p freshell-containment --tests --target x86_64-pc-windows-gnu --locked && cargo check -p freshell-containment --tests --target aarch64-apple-darwin --locked && scripts/sandbox-test.sh "cargo test -p freshell-containment --locked"`

Expected: PASS (all four).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-containment Cargo.lock
git commit -m "feat(containment): agent units and the one stop sequence with the tag backend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Linux systemd transient-scope backend (cgroup per pane)

**Files:**
- Create: `crates/freshell-containment/src/backend/systemd.rs` (`cfg(target_os = "linux")`)
- Create: `crates/freshell-containment/src/backend/inotify.rs` (`cfg(target_os = "linux")`; event-driven `cgroup.events` waits)
- Modify: `crates/freshell-containment/src/backend/mod.rs` (`#[cfg(target_os = "linux")] pub(crate) mod systemd; #[cfg(target_os = "linux")] pub(crate) mod inotify;`)
- Modify: `crates/freshell-containment/src/containment.rs` (`probe`: try `SystemdBackend::probe()` first on Linux)
- Modify: `.github/workflows/rust-tests.yml` (enable a user manager for the runner; export `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1`)
- Test: `crates/freshell-containment/tests/systemd.rs`; the Task 4 conformance suite now also runs against the selected systemd backend.

**Interfaces:**
- Consumes: Task 4 `Backend`/`UnitBackend`, `Placement`, `KillSummary`, `log_spared`, `process::*`.
- Produces: `Containment::select` returns `BackendKind::SystemdScope` (`full: true`) when the probe passes; otherwise the Linux tag backend with `reason` naming the failed probe step. Unit layout (A1): slice `freshell-agents-<unit id>.slice` (nests under `freshell-agents.slice` → `freshell.slice` in the user manager), one scope per member spawn `freshell-<unit id>-<screen|agent>-<seq>.scope`; cgroup dir `<manager root>/freshell.slice/freshell-agents.slice/freshell-agents-<unit id>.slice`. Placement wrapper: `[<systemd-run>, "--user", "--scope", "--quiet", "--collect", "--slice=<slice>", "--unit=<scope>", "--"]`, env adds `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` (captured at probe) and `FRESHELL_UNIT_ID`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/systemd.rs`:

```rust
#![cfg(target_os = "linux")]
//! systemd backend specifics. On hosts with a user manager (garageserver;
//! CI after this task) FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 makes the
//! selection itself a hard requirement; elsewhere these tests assert the
//! degraded selection instead, so they never silently pass on nothing.
mod support;

use std::time::Duration;

use freshell_containment::*;
use support::*;

fn require() -> bool {
    std::env::var("FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT").as_deref() == Ok("1")
}

#[tokio::test(flavor = "multi_thread")]
async fn selection_matches_the_host() {
    let c = Containment::select(SelectOptions::default());
    if require() {
        assert_eq!(c.capability().kind, BackendKind::SystemdScope);
        assert!(c.capability().full);
    } else if c.capability().kind != BackendKind::SystemdScope {
        assert_eq!(c.capability().kind, BackendKind::LinuxTag);
        assert!(c.capability().reason.is_some(), "a degraded selection names why");
    }
}

fn systemd_or_skip_reason() -> Option<Containment> {
    let c = Containment::select(SelectOptions::default());
    (c.capability().kind == BackendKind::SystemdScope).then_some(c)
}

#[tokio::test(flavor = "multi_thread")]
async fn members_land_in_the_unit_slice_with_their_pid_preserved_outside_our_cgroup() {
    let Some(c) = systemd_or_skip_reason() else { assert!(!require()); return };
    let unit = c.create_unit(UnitId::mint(), UnitLabel { provider: "test".into(), ..Default::default() }).unwrap();
    let s = agent_script(&AgentOpts { exit_on_int: true, ..Default::default() });
    let child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;
    assert_eq!(child.id(), Some(p.main), "systemd-run exec'd the agent in place");
    let cg = std::fs::read_to_string(format!("/proc/{}/cgroup", p.main)).unwrap();
    let slice = format!("freshell-agents-{}.slice", unit.id());
    assert!(cg.contains(&format!("/freshell.slice/freshell-agents.slice/{slice}/freshell-{}-agent-", unit.id())), "{cg}");
    let ours = std::fs::read_to_string("/proc/self/cgroup").unwrap();
    let ours_path = ours.trim().trim_start_matches("0::");
    assert!(!cg.contains(ours_path) || ours_path == "/", "the unit is NOT inside the spawner's cgroup");
    unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_outlives_its_handle_and_is_found_and_stopped_after_reopen() {
    let Some(c) = systemd_or_skip_reason() else { assert!(!require()); return };
    let id = UnitId::mint();
    let label = UnitLabel { provider: "test".into(), ..Default::default() };
    let unit = c.create_unit(id.clone(), label.clone()).unwrap();
    let s = agent_script(&AgentOpts::default());
    let _child = spawn_main(&unit, &s).await;
    let p = read_pids(&s).await;
    drop(unit); // the server "restarts": no handle, no stop
    assert!(c.surviving_units().unwrap().contains(&id));
    let reopened = c.reopen_unit(&id, label).unwrap().expect("unit still exists");
    let members: Vec<u32> = reopened.members().unwrap().iter().map(|m| m.pid).collect();
    for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
        assert!(members.contains(&pid), "{pid} is a member by cgroup, not by tree walk");
    }
    reopened.stop(StopRequest::new(StopMode::Force, StopReason::BootFinish, "test")).wait().await;
    let survivors = reopened.stop_in_flight().unwrap().wait_swept().await;
    assert!(survivors.is_empty());
    for pid in [p.main, p.setsid, p.pgrp, p.nohup] {
        assert!(!alive(pid));
    }
    // The slice is collected once empty (event-driven wait in the sweep).
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!c.surviving_units().unwrap().contains(&id));
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 cargo test -p freshell-containment --test systemd --locked`

Expected: FAIL — `selection_matches_the_host` panics with `assertion left == right failed: left: LinuxTag, right: SystemdScope` (no systemd backend yet).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-containment/src/backend/inotify.rs`:

```rust
//! Event-driven waits on cgroup v2 `cgroup.events` (populated / frozen).
//! The kernel raises a file-modified event when either value changes.
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

fn read_flag(events: &Path, key: &str) -> Option<u8> {
    let raw = std::fs::read_to_string(events).ok()?;
    raw.lines().find_map(|l| l.strip_prefix(key)?.trim().parse().ok())
}

/// Resolve when `<dir>/cgroup.events` shows `key value` (or the cgroup is gone).
pub(crate) async fn wait_flag(dir: PathBuf, key: &'static str, value: u8) {
    let events = dir.join("cgroup.events");
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if fd < 0 {
        return;
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let c = std::ffi::CString::new(events.as_os_str().as_encoded_bytes()).unwrap();
    let wd = unsafe { libc::inotify_add_watch(fd.as_raw_fd(), c.as_ptr(), libc::IN_MODIFY | libc::IN_DELETE_SELF) };
    // Watch first, then check: no lost wake-up.
    if wd < 0 || read_flag(&events, key).is_none_or(|v| v == value) {
        return;
    }
    let Ok(afd) = tokio::io::unix::AsyncFd::with_interest(fd, tokio::io::Interest::READABLE) else { return };
    loop {
        let Ok(mut guard) = afd.readable().await else { return };
        let mut buf = [0u8; 4096];
        loop {
            let n = unsafe { libc::read(afd.get_ref().as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                break;
            }
        }
        guard.clear_ready();
        if read_flag(&events, key).is_none_or(|v| v == value) {
            return;
        }
    }
}
```

`crates/freshell-containment/src/backend/systemd.rs`:

```rust
//! Linux, user systemd manager reachable: one transient SLICE per unit, one
//! SCOPE per member spawn (`systemd-run --user --scope` places itself, then
//! execs the command with the same pid — race-free, works for portable-pty
//! children that offer no pre_exec hook). The slice is a sibling of the
//! server's own unit, so units survive a server restart (and a
//! `KillMode=control-group` stop of the server's unit).
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{inotify, log_spared, Backend, BackendKind, Capability, KillSummary, UnitBackend};
use crate::process::{self, is_codex_managed_daemon, ProcIdentity};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

const CGROUP_ROOT: &str = "/sys/fs/cgroup";

#[derive(Clone)]
pub(crate) struct SystemdBackend {
    systemd_run: PathBuf,
    busctl: PathBuf,
    systemctl: PathBuf,
    agents_cg: PathBuf,
    bus_env: Vec<(String, String)>,
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())
}

fn run_ok(cmd: &mut std::process::Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

impl SystemdBackend {
    /// One-shot boot probe. Err(reason) selects the tag backend.
    pub(crate) fn probe() -> Result<Self, String> {
        if !Path::new(CGROUP_ROOT).join("cgroup.controllers").exists() {
            return Err("cgroup v2 not mounted".into());
        }
        let systemd_run = which("systemd-run").ok_or("systemd-run not found")?;
        let busctl = which("busctl").ok_or("busctl not found")?;
        let systemctl = which("systemctl").ok_or("systemctl not found")?;
        let runtime = std::env::var("XDG_RUNTIME_DIR").map_err(|_| "XDG_RUNTIME_DIR unset")?;
        let bus = std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap_or_else(|_| format!("unix:path={runtime}/bus"));
        let bus_env = vec![("XDG_RUNTIME_DIR".to_string(), runtime), ("DBUS_SESSION_BUS_ADDRESS".to_string(), bus)];
        let manager_cg = run_ok(
            std::process::Command::new(&systemctl).args(["--user", "show", "-p", "ControlGroup", "--value"]).envs(bus_env.clone()),
        )?;
        if manager_cg.is_empty() {
            return Err("user manager has no control group".into());
        }
        let agents_cg = PathBuf::from(format!("{CGROUP_ROOT}{manager_cg}/freshell.slice/freshell-agents.slice"));
        // Prove placement end to end (A1): a throwaway scope must land in our slice.
        let probe_slice = "freshell-agents-probe.slice";
        let cg = run_ok(
            std::process::Command::new(&systemd_run)
                .args(["--user", "--scope", "--quiet", "--collect", &format!("--slice={probe_slice}"), "--", "cat", "/proc/self/cgroup"])
                .envs(bus_env.clone()),
        )?;
        if !cg.contains(&format!("/freshell.slice/freshell-agents.slice/{probe_slice}/")) {
            return Err(format!("probe scope landed elsewhere: {cg}"));
        }
        Ok(Self { systemd_run, busctl, systemctl, agents_cg, bus_env })
    }

    fn unit_dir(&self, id: &UnitId) -> PathBuf {
        self.agents_cg.join(format!("freshell-agents-{}.slice", id.as_str()))
    }
}

impl Backend for SystemdBackend {
    fn capability(&self) -> Capability {
        Capability { kind: BackendKind::SystemdScope, full: true, reason: None }
    }
    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        Ok(Arc::new(SystemdUnit { id: id.clone(), dir: self.unit_dir(id), backend: self.clone() }))
    }
    fn reopen(&self, id: &UnitId) -> io::Result<Option<Arc<dyn UnitBackend>>> {
        let dir = self.unit_dir(id);
        Ok(dir.is_dir().then(|| Arc::new(SystemdUnit { id: id.clone(), dir, backend: self.clone() }) as Arc<dyn UnitBackend>))
    }
    fn surviving(&self) -> io::Result<Vec<UnitId>> {
        let Ok(rd) = std::fs::read_dir(&self.agents_cg) else { return Ok(Vec::new()) };
        Ok(rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                UnitId::parse(name.strip_prefix("freshell-agents-")?.strip_suffix(".slice")?)
            })
            .collect())
    }
}

struct SystemdUnit {
    id: UnitId,
    dir: PathBuf,
    backend: SystemdBackend,
}

fn procs_recursive(dir: &Path, out: &mut Vec<u32>) {
    if let Ok(raw) = std::fs::read_to_string(dir.join("cgroup.procs")) {
        out.extend(raw.split_whitespace().filter_map(|p| p.parse::<u32>().ok()));
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                procs_recursive(&e.path(), out);
            }
        }
    }
}

impl SystemdUnit {
    fn pids(&self) -> Vec<u32> {
        let mut out = Vec::new();
        procs_recursive(&self.dir, &mut out);
        out
    }

    /// Managed-daemon processes (and their descendants within the unit).
    fn spared(&self, pids: &[u32]) -> Vec<u32> {
        let mut spared: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|p| process::argv(*p).map(|a| is_codex_managed_daemon(&a)).unwrap_or(false))
            .collect();
        let mut grew = true;
        while grew {
            grew = false;
            for p in pids {
                if !spared.contains(p) && process::parent(*p).is_some_and(|pp| spared.contains(&pp)) {
                    spared.push(*p);
                    grew = true;
                }
            }
        }
        spared
    }

    /// Move spared processes out of the slice into their own scope (A3).
    fn evict(&self, spared: &[u32]) {
        if spared.is_empty() {
            return;
        }
        let name = format!("freshell-spared-{}.scope", spared[0]);
        let mut args: Vec<String> = vec![
            "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        args.extend([name, "fail".into(), "2".into(), "PIDs".into(), "au".into(), spared.len().to_string()]);
        args.extend(spared.iter().map(|p| p.to_string()));
        args.extend(["CollectMode".into(), "s".into(), "inactive-or-failed".into(), "0".into()]);
        if let Err(error) = run_ok(std::process::Command::new(&self.backend.busctl).args(&args).envs(self.backend.bus_env.clone())) {
            tracing::error!(target: "freshell_unit", event = "unit.stop.spare_failed",
                unit_id = %self.id, error = %error, "");
        }
    }
}

impl UnitBackend for SystemdUnit {
    fn placement(&self, role: MemberRole, seq: u32) -> io::Result<Placement> {
        let role = match role {
            MemberRole::Screen => "screen",
            MemberRole::Agent => "agent",
        };
        let wrapper = vec![
            self.backend.systemd_run.display().to_string(),
            "--user".into(),
            "--scope".into(),
            "--quiet".into(),
            "--collect".into(),
            format!("--slice=freshell-agents-{}.slice", self.id.as_str()),
            format!("--unit=freshell-{}-{role}-{seq}.scope", self.id.as_str()),
            "--".into(),
        ];
        let mut env = self.backend.bus_env.clone();
        env.push((UNIT_ENV.to_string(), self.id.as_str().to_string()));
        Ok(Placement { wrapper: Some(wrapper), env })
    }

    fn kill_all(&self, _roots: &[u32]) -> io::Result<KillSummary> {
        if !self.dir.is_dir() {
            return Ok(KillSummary::default());
        }
        let _ = std::fs::write(self.dir.join("cgroup.freeze"), "1");
        let pids = self.pids();
        let spared_pids = self.spared(&pids);
        let spared: Vec<ProcIdentity> = spared_pids.iter().filter_map(|p| process::identity(*p).ok()).collect();
        self.evict(&spared_pids);
        log_spared(&spared);
        let killed = pids.len().saturating_sub(spared_pids.len());
        if std::fs::write(self.dir.join("cgroup.kill"), "1").is_err() {
            let slice = format!("freshell-agents-{}.slice", self.id.as_str());
            let _ = run_ok(
                std::process::Command::new(&self.backend.systemctl)
                    .args(["--user", "kill", "--signal=SIGKILL", &slice])
                    .envs(self.backend.bus_env.clone()),
            );
        }
        let _ = std::fs::write(self.dir.join("cgroup.freeze"), "0");
        Ok(KillSummary { killed, spared })
    }

    fn members(&self, _roots: &[u32]) -> io::Result<Vec<ProcIdentity>> {
        let pids = self.pids();
        let spared = self.spared(&pids);
        Ok(pids.into_iter().filter(|p| !spared.contains(p)).filter_map(|p| process::identity(p).ok()).collect())
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>> {
        let dir = self.dir.clone();
        Some(Box::pin(async move { inotify::wait_flag(dir, "populated ", 0).await }))
    }

    fn remove(&self) {} // --collect: systemd garbage-collects the empty scopes and slice
}
```

(`cgroup.freeze` is written without waiting for `frozen 1`: freezing only stabilizes the member snapshot used to pick spared processes; `cgroup.kill` itself is fork-safe and also kills frozen tasks.)

In `crates/freshell-containment/src/containment.rs`, replace the Linux arm of `probe`:

```rust
        #[cfg(target_os = "linux")]
        {
            return match crate::backend::systemd::SystemdBackend::probe() {
                Ok(b) => Self { backend: Arc::new(b) },
                Err(reason) => Self::tag_with(BackendKind::LinuxTag, &format!("systemd backend unavailable: {reason}")),
            };
        }
```

`.github/workflows/rust-tests.yml`, in the job that runs `cargo test --workspace --exclude freshell-tauri --locked` (`:54-77`), add before that step:

```yaml
      - name: Start a systemd user manager for containment tests
        run: |
          sudo loginctl enable-linger "$(id -un)"
          uid="$(id -u)"
          echo "XDG_RUNTIME_DIR=/run/user/${uid}" >> "$GITHUB_ENV"
          timeout 30 bash -c "until [ -S /run/user/${uid}/bus ]; do sleep 0.2; done"
          XDG_RUNTIME_DIR="/run/user/${uid}" systemctl --user is-system-running --wait || true
          echo "FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1" >> "$GITHUB_ENV"
```

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 cargo test -p freshell-containment --test systemd --test conformance --locked`

Expected: PASS — `conformance` now runs every case twice (tag and selected/systemd) on this host.

- [ ] **Step 5: Refactor while green**

Move `which`/`run_ok` into `process.rs` (`pub(crate) fn find_on_path`, `pub(crate) fn run_capture`) so Task 7's macOS `lsof` calls reuse them. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Run: `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 cargo test -p freshell-containment --locked && scripts/sandbox-test.sh "cargo test -p freshell-containment --locked" && cargo check -p freshell-containment --tests --target x86_64-pc-windows-gnu --locked && cargo check -p freshell-containment --tests --target aarch64-apple-darwin --locked`

Expected: PASS (the sandbox run selects the tag backend and its `selection_matches_the_host` asserts that).

- [ ] **Step 7: Commit the task, then validate the CI step on the runner (A9)**

```bash
git add crates/freshell-containment .github/workflows/rust-tests.yml
git commit -m "feat(containment): systemd transient scope backend with cgroup.kill and event-driven empty wait

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin the-usual/codex-pane-lifecycle
gh workflow run rust-tests.yml --ref the-usual/codex-pane-lifecycle
gh run watch "$(gh run list --workflow rust-tests.yml --branch the-usual/codex-pane-lifecycle --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: the push's pre-push hook (fmt/clippy/targeted tests) passes and the `rust-tests.yml` run succeeds with `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1`. If A9 fails on the runner, apply A9's fallback in a follow-up commit (drop the `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT` export from the workflow, so CI proves the degraded backend and `selection_matches_the_host` asserts the tag fallback) and record the residual in the run state.

---

### Task 6: Windows Job Object backend, self-placing exec shim, Windows process facts

**Files:**
- Create: `crates/freshell-containment/src/backend/windows_job.rs` (`cfg(windows)`)
- Delete: `crates/freshell-containment/src/backend/roots.rs`
- Modify: `crates/freshell-containment/src/backend/mod.rs`, `src/containment.rs` (Windows `probe`/`tag_backend`/`adopt_legacy` use the job backend; `adopt_legacy` on Windows returns a job unit with no members because Windows sidecars are never retained)
- Modify: `crates/freshell-containment/src/process.rs` (Windows: `start_time` via `GetProcessTimes`, `argv` via `NtQueryInformationProcess(ProcessCommandLineInformation)`, `is_running`, `parent`/`children`/`all_pids` via Toolhelp32)
- Modify: `crates/freshell-containment/src/proc_watch.rs` (Windows: process handle; `exited` = `WaitForSingleObject` on a blocking thread; `signal(Kill)` = `TerminateProcess`; `Interrupt`/`Terminate` = `ErrorKind::Unsupported`)
- Modify: `crates/freshell-containment/src/exec_shim.rs` (Windows: `--job <name>` self-assignment before spawning the command)
- Modify: `crates/freshell-containment/src/locks.rs` (Windows: Restart Manager), `src/listener.rs` (Windows: `GetExtendedTcpTable`)
- Modify: `crates/freshell-server/src/main.rs` (first lines of `main`: dispatch `__unit-exec` to `freshell_containment::exec_shim::unit_exec_main` before any other initialization) and `crates/freshell-server/Cargo.toml` (`freshell-containment = { path = "../freshell-containment" }`)
- Modify: `.github/workflows/electron-build.yml` (after "Install dependencies": `- name: Test containment (Windows and macOS)` / `if: matrix.os != 'ubuntu-latest'` / `run: cargo test --locked -p freshell-containment`)
- Test: `crates/freshell-containment/tests/windows_job.rs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `BackendKind::WindowsJob` (`full: true`); placement wrapper `[<shim exe>, <shim leading args...>, "--job", "Local\\freshell-unit-<id>", "--"]`; one job per unit with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK`; one completion port for all units delivering `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` to `wait_empty`; `surviving_units()` is always empty (Windows units are not retained across a server restart, as today); `freshell-server.exe __unit-exec --job <name> -- <cmd...>` is the production shim (`SelectOptions.shim = None` defaults to `current_exe()` + `["__unit-exec"]`).

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/windows_job.rs`:

```rust
#![cfg(windows)]
//! Job Object containment on the windows-2022 runner. Every process here is
//! spawned through the unit under test.
use std::time::Duration;

use freshell_containment::*;

fn containment() -> Containment {
    Containment::select(SelectOptions {
        shim: Some(ShimCommand { exe: env!("CARGO_BIN_EXE_freshell-unit-exec").into(), leading_args: vec![] }),
    })
}

fn node_sleeper(extra: &[&str]) -> Vec<String> {
    let mut v = vec!["-e".to_string(), "setTimeout(() => {}, 600000)".to_string()];
    v.extend(extra.iter().map(|s| s.to_string()));
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn a_job_unit_contains_a_process_tree_and_kill_ends_all_of_it() {
    let c = containment();
    assert_eq!(c.capability().kind, BackendKind::WindowsJob);
    let unit = c.create_unit(UnitId::mint(), UnitLabel { provider: "test".into(), ..Default::default() }).unwrap();
    // node spawns a grandchild node; both must be job members.
    let script = "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore'}).unref(); setTimeout(()=>{},600000)";
    let mut cmd = unit.tokio_command("node", &["-e".into(), script.into()], MemberRole::Agent).unwrap();
    let child = cmd.spawn().unwrap();
    unit.set_main(ProcWatch::open(child.id().unwrap()).unwrap());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while unit.members().unwrap().len() < 3 {
        assert!(tokio::time::Instant::now() < deadline, "shim + node + grandchild never all joined the job");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let members = unit.members().unwrap();
    let report = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
    assert!(report.lock_released);
    assert!(unit.stop_in_flight().unwrap().wait_swept().await.is_empty());
    for m in members {
        assert!(!process::is_running(m.pid), "{} survived", m.pid);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_codex_managed_daemon_is_never_terminated() {
    let c = containment();
    let unit = c.create_unit(UnitId::mint(), UnitLabel::default()).unwrap();
    let mut cmd = unit.tokio_command("node", &node_sleeper(&["app-server", "--managed-daemon"]), MemberRole::Agent).unwrap();
    let daemon = cmd.spawn().unwrap();
    let daemon_pid = daemon.id().unwrap();
    let mut cmd = unit.tokio_command("node", &node_sleeper(&[]), MemberRole::Agent).unwrap();
    let other = cmd.spawn().unwrap();
    unit.set_main(ProcWatch::open(other.id().unwrap()).unwrap());
    tokio::time::sleep(Duration::from_secs(2)).await;
    unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
    unit.stop_in_flight().unwrap().wait_swept().await;
    let spared: Vec<u32> = process::children(daemon_pid);
    let daemon_node = spared.first().copied().unwrap_or(daemon_pid);
    assert!(process::is_running(daemon_node), "managed daemon spared");
    ProcWatch::open(daemon_node).unwrap().signal(Sig::Kill).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn lock_holders_and_listener_owner_are_found() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.lock");
    std::fs::write(&file, b"").unwrap();
    let holder = std::process::Command::new("node")
        .args(["-e", &format!("require('fs').openSync({:?}, 'r+'); setTimeout(()=>{{}},600000)", file.display().to_string())])
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(lock_holders(&[file.clone()]).iter().any(|h| h.pid == holder.id()));
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let listener = std::process::Command::new("node")
        .args(["-e", &format!("require('net').createServer().listen({port}, '127.0.0.1')")])
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(listening_socket_owner(port, &[listener.id()]), Some(listener.id()));
    for pid in [holder.id(), listener.id()] {
        ProcWatch::open(pid).unwrap().signal(Sig::Kill).unwrap();
    }
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Windows tests can only run on Windows. Commit the test file together with the workflow step (`.github/workflows/electron-build.yml`, below) BEFORE the implementation, push, and watch the runner:

Run: `git add crates/freshell-containment/tests/windows_job.rs .github/workflows/electron-build.yml && git commit -m "test(containment): windows job-object unit tests (red)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin the-usual/codex-pane-lifecycle && gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle && sleep 5 && gh run watch "$(gh run list --workflow electron-build.yml --branch the-usual/codex-pane-lifecycle --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: the `windows-2022` job FAILS in `Test containment (Windows and macOS)`: every Windows test panics at `ProcWatch::open(..).unwrap()` with `Unsupported` (Task 2's placeholder body) — there is no Windows process watch or job object yet. (The macOS jobs pass this step: Task 4's tag backend compiles there and has no macOS-specific tests yet.)

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-containment/src/exec_shim.rs`:

```rust
use std::ffi::OsString;

/// `freshell-server __unit-exec [--job <name>] -- <program> [args...]`:
/// (Windows) put THIS process into the unit's job before anything else runs,
/// then run the command (it inherits the job, console/pseudoconsole and
/// stdio) and exit with its code. Elsewhere it only runs the command.
pub fn unit_exec_main(args: Vec<OsString>) -> i32 {
    let mut job: Option<OsString> = None;
    let mut it = args.into_iter();
    let mut rest: Vec<OsString> = Vec::new();
    while let Some(a) = it.next() {
        if a == "--job" {
            job = it.next();
        } else if a == "--" {
            rest = it.collect();
            break;
        }
    }
    let Some((program, argv)) = rest.split_first() else { return 2 };
    #[cfg(windows)]
    if let Some(name) = job.as_ref() {
        if let Err(code) = windows_assign_self(name) {
            return code;
        }
    }
    #[cfg(not(windows))]
    let _ = job;
    match std::process::Command::new(program).args(argv).status() {
        Ok(s) => s.code().unwrap_or(1),
        Err(_) => 127,
    }
}

#[cfg(windows)]
fn windows_assign_self(name: &OsString) -> Result<(), i32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, OpenJobObjectW, JOB_OBJECT_ASSIGN_PROCESS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let wide: Vec<u16> = name.encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let job = OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, wide.as_ptr());
        if job.is_null() {
            return Err(3);
        }
        let ok = AssignProcessToJobObject(job, GetCurrentProcess());
        CloseHandle(job);
        if ok == 0 { Err(4) } else { Ok(()) }
    }
}
```

`crates/freshell-containment/src/backend/windows_job.rs`:

```rust
//! Windows: one Job Object per unit (KILL_ON_JOB_CLOSE | BREAKAWAY_OK), one
//! completion port for every unit (JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO =
//! "unit empty", event-driven). Members are placed race-free by the
//! self-assigning exec shim. Gone still rests on the screen/main process
//! handles (completion-port messages are not guaranteed delivery).
use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED};

use super::{log_spared, Backend, BackendKind, Capability, KillSummary, UnitBackend};
use crate::containment::ShimCommand;
use crate::process::{self, is_codex_managed_daemon, ProcIdentity};
use crate::unit::{MemberRole, Placement};
use crate::{BoxFuture, UnitId, UNIT_ENV};

struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

pub(crate) struct JobBackend {
    shim: ShimCommand,
    port: Arc<SendHandle>,
    empties: Arc<Mutex<HashMap<usize, watch::Sender<bool>>>>,
    next_key: Arc<std::sync::atomic::AtomicUsize>,
}

impl JobBackend {
    pub(crate) fn new(shim: ShimCommand) -> io::Result<Self> {
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
        if port.is_null() {
            return Err(io::Error::last_os_error());
        }
        let port = Arc::new(SendHandle(port));
        let empties: Arc<Mutex<HashMap<usize, watch::Sender<bool>>>> = Arc::default();
        let (p, e) = (port.clone(), empties.clone());
        std::thread::Builder::new().name("freshell-job-port".into()).spawn(move || loop {
            let (mut msg, mut key, mut ov) = (0u32, 0usize, std::ptr::null_mut::<OVERLAPPED>());
            let ok = unsafe { GetQueuedCompletionStatus(p.0, &mut msg, &mut key, &mut ov, u32::MAX) };
            if ok == 0 {
                continue;
            }
            if msg == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO {
                if let Some(tx) = e.lock().unwrap().get(&key) {
                    let _ = tx.send(true);
                }
            }
        })?;
        Ok(Self { shim, port, empties, next_key: Arc::default() })
    }
}

fn job_name(id: &UnitId) -> String {
    format!("Local\\freshell-unit-{}", id.as_str())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl Backend for JobBackend {
    fn capability(&self) -> Capability {
        Capability { kind: BackendKind::WindowsJob, full: true, reason: None }
    }

    fn create(&self, id: &UnitId) -> io::Result<Arc<dyn UnitBackend>> {
        let name = job_name(id);
        let job = unsafe { CreateJobObjectW(std::ptr::null(), wide(&name).as_ptr()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        unsafe {
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&info as *const _) as *const _, std::mem::size_of_val(&info) as u32);
        }
        let key = self.next_key.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: key as *mut _, CompletionPort: self.port.0 };
        unsafe {
            SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, (&assoc as *const _) as *const _, std::mem::size_of_val(&assoc) as u32);
        }
        let (tx, rx) = watch::channel(false);
        self.empties.lock().unwrap().insert(key, tx);
        Ok(Arc::new(JobUnit { id: id.clone(), name, job: SendHandle(job), empty: rx, shim: self.shim.clone() }))
    }

    fn reopen(&self, _id: &UnitId) -> io::Result<Option<Arc<dyn UnitBackend>>> {
        Ok(None) // Windows units never outlive the server (KILL_ON_JOB_CLOSE)
    }

    fn surviving(&self) -> io::Result<Vec<UnitId>> {
        Ok(Vec::new())
    }
}

struct JobUnit {
    id: UnitId,
    name: String,
    job: SendHandle,
    empty: watch::Receiver<bool>,
    shim: ShimCommand,
}

impl JobUnit {
    fn pids(&self) -> Vec<u32> {
        let mut buf = vec![0u8; 8 + 4096 * std::mem::size_of::<usize>()];
        let ok = unsafe {
            QueryInformationJobObject(self.job.0, JobObjectBasicProcessIdList, buf.as_mut_ptr().cast(), buf.len() as u32, std::ptr::null_mut())
        };
        if ok == 0 {
            return Vec::new();
        }
        let list = unsafe { &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
        let ids = unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), list.NumberOfProcessIdsInList as usize) };
        ids.iter().map(|p| *p as u32).collect()
    }

    fn spared(&self, pids: &[u32]) -> Vec<u32> {
        let mut spared: Vec<u32> = pids.iter().copied().filter(|p| process::argv(*p).map(|a| is_codex_managed_daemon(&a)).unwrap_or(false)).collect();
        let mut grew = true;
        while grew {
            grew = false;
            for p in pids {
                if !spared.contains(p) && process::parent(*p).is_some_and(|pp| spared.contains(&pp)) {
                    spared.push(*p);
                    grew = true;
                }
            }
        }
        spared
    }
}

impl UnitBackend for JobUnit {
    fn placement(&self, _role: MemberRole, _seq: u32) -> io::Result<Placement> {
        let mut wrapper = vec![self.shim.exe.display().to_string()];
        wrapper.extend(self.shim.leading_args.iter().cloned());
        wrapper.extend(["--job".to_string(), self.name.clone(), "--".to_string()]);
        Ok(Placement { wrapper: Some(wrapper), env: vec![(UNIT_ENV.to_string(), self.id.as_str().to_string())] })
    }

    fn kill_all(&self, _roots: &[u32]) -> io::Result<KillSummary> {
        let pids = self.pids();
        let spared_pids = self.spared(&pids);
        let spared: Vec<ProcIdentity> = spared_pids.iter().filter_map(|p| process::identity(*p).ok()).collect();
        if spared_pids.is_empty() {
            unsafe { TerminateJobObject(self.job.0, 1) };
        } else {
            // Members cannot leave a job: terminate everyone else one by one,
            // and drop KILL_ON_JOB_CLOSE so closing the job spares the daemon.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            unsafe {
                SetInformationJobObject(self.job.0, JobObjectExtendedLimitInformation, (&info as *const _) as *const _, std::mem::size_of_val(&info) as u32);
            }
            for _round in 0..16 {
                let targets: Vec<u32> = self.pids().into_iter().filter(|p| !spared_pids.contains(p)).collect();
                if targets.is_empty() {
                    break;
                }
                for pid in targets {
                    unsafe {
                        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                        if !h.is_null() {
                            TerminateProcess(h, 1);
                            CloseHandle(h);
                        }
                    }
                }
            }
        }
        log_spared(&spared);
        Ok(KillSummary { killed: pids.len().saturating_sub(spared_pids.len()), spared })
    }

    fn members(&self, _roots: &[u32]) -> io::Result<Vec<ProcIdentity>> {
        let pids = self.pids();
        let spared = self.spared(&pids);
        Ok(pids.into_iter().filter(|p| !spared.contains(p)).filter_map(|p| process::identity(p).ok()).collect())
    }

    fn wait_empty(&self) -> Option<BoxFuture<'static, ()>> {
        let mut rx = self.empty.clone();
        Some(Box::pin(async move {
            while !*rx.borrow() {
                if rx.changed().await.is_err() {
                    return;
                }
            }
        }))
    }

    fn remove(&self) {
        unsafe { CloseHandle(self.job.0) };
    }
}
```

Windows `process.rs` / `proc_watch.rs` / `locks.rs` / `listener.rs` bodies (same signatures as Linux):

```rust
// process.rs (cfg(windows))
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ};

fn snapshot() -> Vec<(u32, u32)> { // (pid, parent)
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                out.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e) == 0 { break; }
            }
        }
        CloseHandle(snap);
    }
    out
}
pub fn all_pids() -> Vec<u32> { snapshot().into_iter().map(|(p, _)| p).collect() }
pub fn parent(pid: u32) -> Option<u32> { snapshot().into_iter().find(|(p, _)| *p == pid).map(|(_, pp)| pp) }
pub fn children(pid: u32) -> Vec<u32> { snapshot().into_iter().filter(|(_, pp)| *pp == pid).map(|(p, _)| p).collect() }
pub fn start_time(pid: u32) -> std::io::Result<u64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "process gone")); }
        let (mut c, mut e, mut k, mut u): (FILETIME, FILETIME, FILETIME, FILETIME) = std::mem::zeroed();
        let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
        CloseHandle(h);
        if ok == 0 { return Err(std::io::Error::last_os_error()); }
        Ok(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
    }
}
pub fn is_running(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() { return false; }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}
/// Command line via NtQueryInformationProcess(ProcessCommandLineInformation = 60),
/// split on whitespace (enough for the managed-daemon token check).
pub fn argv(pid: u32) -> std::io::Result<Vec<String>> {
    use windows_sys::Wdk::System::Threading::NtQueryInformationProcess;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() { return Err(std::io::Error::last_os_error()); }
        let mut buf = vec![0u8; 64 * 1024];
        let mut len = 0u32;
        let status = NtQueryInformationProcess(h, 60, buf.as_mut_ptr().cast(), buf.len() as u32, &mut len);
        CloseHandle(h);
        if status != 0 { return Err(std::io::Error::other(format!("NtQueryInformationProcess {status:#x}"))); }
        let us = &*(buf.as_ptr() as *const windows_sys::Win32::Foundation::UNICODE_STRING);
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(us.Buffer, (us.Length / 2) as usize));
        Ok(s.split_whitespace().map(str::to_string).collect())
    }
}
pub fn environ_value(_pid: u32, _key: &str) -> Option<String> { None } // not readable cross-process; the job is authoritative

// proc_watch.rs (cfg(windows)): Inner { identity, exited: AtomicBool, handle: SendHandle, done: tokio::sync::watch::Sender<bool>, waiter: std::sync::Once }
// open_inner: OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE); identity via start_time/argv;
//   expect_start mismatch -> NotFound.
// has_exited: WaitForSingleObject(handle, 0) == WAIT_OBJECT_0.
// exited: start (once) a std thread that blocks in WaitForSingleObject(handle, INFINITE) then sends `true`;
//   await the watch until true.
// signal: Kill -> TerminateProcess(handle, 1) (ERROR_ACCESS_DENIED after exit is Ok); Interrupt/Terminate -> Err(Unsupported).

// locks.rs (cfg(windows)): Restart Manager — processes holding the file OPEN (Codex unlocks only by closing).
pub fn lock_holders(paths: &[std::path::PathBuf]) -> Vec<LockHolder> {
    use windows_sys::Win32::System::RestartManager::*;
    let mut out = Vec::new();
    unsafe {
        let mut session = 0u32;
        let mut key = [0u16; (CCH_RM_SESSION_KEY as usize) + 1];
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 { return out; }
        for path in paths.iter().filter(|p| p.exists()) {
            let w: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            let ptrs = [w.as_ptr()];
            if RmRegisterResources(session, 1, ptrs.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) != 0 { continue; }
            let (mut needed, mut count, mut reasons) = (0u32, 16u32, 0u32);
            let mut infos: Vec<RM_PROCESS_INFO> = vec![std::mem::zeroed(); 16];
            if RmGetList(session, &mut needed, &mut count, infos.as_mut_ptr(), &mut reasons) == 0 {
                for info in &infos[..count as usize] {
                    let pid = info.Process.dwProcessId;
                    let command = crate::process::argv(pid).map(|a| a.join(" ")).unwrap_or_else(|_| String::from_utf16_lossy(&info.strAppName).trim_end_matches('\0').to_string());
                    out.push(LockHolder { pid, command, path: path.clone() });
                }
            }
        }
        RmEndSession(session);
    }
    out
}

// listener.rs (cfg(windows)): GetExtendedTcpTable(AF_INET, TCP_TABLE_OWNER_PID_LISTENER) -> MIB_TCPTABLE_OWNER_PID rows;
//   a row matches when u16::from_be(row.dwLocalPort as u16) == port; return row.dwOwningPid when it is one of
//   `candidates` or a descendant of one (walk `process::children`), else None.
```

(The Windows `proc_watch.rs`, `listener.rs` bodies are written out in full by the implementer from the comments above; they have the same structure as the Linux versions and are exercised by Step 6's runner tests.)

In `crates/freshell-server/src/main.rs`, first statements of `async fn main()` (before any logging/runtime work; `main` is `#[tokio::main]`, which is acceptable because the shim spawns and waits synchronously):

```rust
    if std::env::args_os().nth(1).is_some_and(|a| a == "__unit-exec") {
        std::process::exit(freshell_containment::exec_shim::unit_exec_main(std::env::args_os().skip(2).collect()));
    }
```

- [ ] **Step 4: Run the focused test**

Run: `cargo check -p freshell-containment --tests --target x86_64-pc-windows-gnu --locked && cargo test -p freshell-containment --locked`

Expected: PASS locally (Windows code compiles; Linux suites unaffected). The Windows tests run in Step 6.

- [ ] **Step 5: Refactor while green**

Share the "spared set" closure (managed daemon + descendants by parent) between `systemd.rs` and `windows_job.rs` as `backend::spared_closure(pids: &[u32]) -> Vec<u32>` (the tag backend keeps its own because it builds membership from the tag). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the containment crate on all OSes, and the server binary (new dependency + `__unit-exec` dispatch). Local: `cargo build -p freshell-server --locked && ./target/debug/freshell-server __unit-exec -- sh -c 'exit 7'; echo "exit=$?"` → Expected `exit=7`. Commit (Step 7) first, then on the runners:

Run: `git push origin the-usual/codex-pane-lifecycle && gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle && sleep 5 && gh run watch "$(gh run list --workflow electron-build.yml --branch the-usual/codex-pane-lifecycle --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: PASS on `windows-2022` (job tests, Task 2's Windows `ProcWatch` tests) and the existing macOS/Linux jobs (macOS runs the containment crate with the Task 4 tag backend; its macOS-specific tests arrive in Task 7).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-containment crates/freshell-server/src/main.rs crates/freshell-server/Cargo.toml Cargo.lock .github/workflows/electron-build.yml
git commit -m "feat(containment): Windows job-object units with a self-placing exec shim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: macOS tag backend facts (libproc, kqueue `ProcWatch`, `lsof` lookups)

**Files:**
- Modify: `crates/freshell-containment/src/process.rs` (macOS: `all_pids` via `proc_listallpids`, `parent`/`is_running`/`start_time` via `proc_pidinfo(PROC_PIDTBSDINFO)` (`pbi_ppid`, `pbi_status != SZOMB`, `pbi_start_tvsec * 1_000_000 + pbi_start_tvusec`), `children` = `all_pids` filtered by parent, `argv` and `environ_value` via `sysctl([CTL_KERN, KERN_PROCARGS2, pid])`)
- Modify: `crates/freshell-containment/src/proc_watch.rs` (macOS: `kqueue` + `EVFILT_PROC`/`NOTE_EXIT` registered at `open` (ESRCH ⇒ already exited); one blocking `kevent` thread per watch publishes to a `tokio::sync::watch`; `has_exited` = flag or `!is_running`/start mismatch; `signal` = start-time re-check then `kill(2)`)
- Modify: `crates/freshell-containment/src/locks.rs` (macOS: `lsof -nP -Fpc <path>` → holders with the file open), `src/listener.rs` (macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` → owner, accepted only inside a candidate's tree)
- Modify: `crates/freshell-containment/tests/conformance.rs`, `tests/unconfirmed.rs`, `tests/support/mod.rs` (`#![cfg(unix)]`; the agent script already uses `perl` for `setsid` and `flock`, see the note below)
- Test: `crates/freshell-containment/tests/macos.rs`

**Interfaces:**
- Consumes: Task 4 tag backend (unchanged; it only needed these process facts), Task 5's `find_on_path`/`run_capture` helpers.
- Produces: macOS selection `BackendKind::MacosTag` (`full: false`, `reason: "macOS has no kernel process containment"`), passing the same conformance suite as Linux.

Note for Tasks 4 and 7 (portability of the conformance agent): the agent script in `tests/support/mod.rs` uses `perl -e 'use POSIX; POSIX::setsid(); exec "sleep", "600"' & S=$!` for the own-session child and `perl -e 'use Fcntl qw(:flock); open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; sleep 600' "<lock>" & L=$!` for the lock holder (macOS has neither `setsid(1)` nor `flock(1)`); Task 4 writes it this way from the start.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/macos.rs`:

```rust
#![cfg(target_os = "macos")]
use std::time::Duration;

use freshell_containment::*;

#[tokio::test(flavor = "multi_thread")]
async fn macos_selects_the_tag_backend_and_reads_the_unit_tag() {
    let c = Containment::select(SelectOptions::default());
    assert_eq!(c.capability().kind, BackendKind::MacosTag);
    let unit = c.create_unit(UnitId::mint(), UnitLabel::default()).unwrap();
    let mut cmd = unit.tokio_command("sleep", &["600".into()], MemberRole::Agent).unwrap();
    let child = cmd.spawn().unwrap();
    let pid = child.id().unwrap();
    assert_eq!(process::environ_value(pid, UNIT_ENV).as_deref(), Some(unit.id().as_str()));
    let watch = ProcWatch::open(pid).unwrap();
    unit.set_main(watch.clone());
    unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
    tokio::time::timeout(Duration::from_secs(5), watch.exited()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn lsof_lookups_find_lock_file_holders_and_listeners() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    std::fs::write(&lock, b"").unwrap();
    let mut holder = std::process::Command::new("perl")
        .args(["-e", "use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX); sleep 600", lock.to_str().unwrap()])
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(lock_holders(&[lock.clone()]).iter().any(|h| h.pid == holder.id()));
    let port = { let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); l.local_addr().unwrap().port() };
    let mut listener = std::process::Command::new("node")
        .args(["-e", &format!("require('net').createServer().listen({port}, '127.0.0.1')")])
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(listening_socket_owner(port, &[listener.id()]), Some(listener.id()));
    holder.kill().unwrap();
    listener.kill().unwrap();
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

macOS tests can only run on macOS. Commit `tests/macos.rs` alone first and watch the runner:

Run: `git add crates/freshell-containment/tests/macos.rs && git commit -m "test(containment): macOS tag backend tests (red)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push origin the-usual/codex-pane-lifecycle && gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle && sleep 5 && gh run watch "$(gh run list --workflow electron-build.yml --branch the-usual/codex-pane-lifecycle --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: the `macos-latest` and `macos-15-intel` jobs FAIL in `Test containment (Windows and macOS)` with `assertion failed: left None, right Some("u…")` (no environ reader on macOS yet).

- [ ] **Step 3: Add the minimal production implementation**

Implement the macOS bodies listed under **Files** with `libc` (`libc::proc_listallpids`, `libc::proc_pidinfo`, `libc::proc_bsdinfo`, `libc::PROC_PIDTBSDINFO`, `libc::sysctl` with `CTL_KERN`/`KERN_PROCARGS2`, `libc::kqueue`, `libc::kevent`, `EVFILT_PROC`, `NOTE_EXIT`, `EV_ADD | EV_ONESHOT`). Where `libc` lacks a constant or struct field for this target, declare it locally with `#[repr(C)]` exactly as in `<sys/proc_info.h>` / `<sys/sysctl.h>`. `KERN_PROCARGS2` layout: `argc: i32`, then the exec path NUL-terminated, NUL padding, `argc` NUL-terminated argv strings, then NUL-terminated `KEY=VALUE` env strings until an empty string. The lsof lookups use `process::run_capture("lsof", &[...])` and parse `-F` output (`p<pid>` lines, `c<command>` lines).

- [ ] **Step 4: Run the focused test**

Run: `cargo check -p freshell-containment --tests --target aarch64-apple-darwin --locked && cargo test -p freshell-containment --locked`

Expected: PASS locally (compile + Linux suites).

- [ ] **Step 5: Refactor while green**

Remove every remaining `cfg(not(target_os = "linux"))` "unsupported" body added in Task 2 now that Windows and macOS have real ones; the crate must have no stub bodies left (`grep -n "Unsupported" crates/freshell-containment/src` should show only `ProcWatch::signal` for `Interrupt`/`Terminate` on Windows).

- [ ] **Step 6: Run impacted-test verification**

Commit (Step 7) first, then:

Run: `git push origin the-usual/codex-pane-lifecycle && gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle && sleep 5 && gh run watch "$(gh run list --workflow electron-build.yml --branch the-usual/codex-pane-lifecycle --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: PASS on `macos-15-intel` and `macos-latest` (conformance on the macOS tag backend + `macos.rs`) and still on `windows-2022`.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-containment
git commit -m "feat(containment): macOS tag backend facts via libproc, kqueue and lsof

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice C — The owner registry: event-driven waiting and unit scope

### Task 8: Registry wait/wake, unit-scoped stop/commit, extra-thread holds, boot seed

**Files:**
- Modify: `crates/freshell-ownership/src/lib.rs` — `OwnerIdentity` (`:295-305`) gains `unit_id`; `RuntimeOwnerKind` (`:272-277`) derives `Default` (`#[default] Terminal`) and `OwnerIdentity` derives `Default`; `RuntimeOwnershipRegistry` (`:1106-1109`) gains `waiters: Mutex<Vec<Waker>>`; every mutating `self.inner.lock()` (the 30 `let mut inner = self.inner.lock()` sites listed by `grep -n "let mut inner = self.inner.lock()"`, plus `AttachGuard::release_window` at `:935`) becomes `self.lock_records()`; `StopOutcome` (`:574-601`) gains `AlreadyStopping`; `begin_stop`'s fallback arm (`:3388`) returns `AlreadyStopping` for `Stopping`; new methods after `force_release_for_confirmed_kill` (`:3653`).
- Modify: every non-test `OwnerIdentity { ... }` literal in the workspace (compiler-guided: `cargo build --workspace --locked` lists each) — add `unit_id: None`; and every exhaustive `match` on `StopOutcome` (compiler-guided) — treat `AlreadyStopping` exactly as the arm that handled `NotLive { state: Stopping { .. } }` did, until Task 23 makes the fresh-agent lanes join it (terminal units join through `AgentUnit::stop` from Task 12 on).
- Modify: `crates/freshell-ownership/Cargo.toml` — `[dev-dependencies] tokio = { version = "1", features = ["rt", "macros", "time"] }` (production stays tokio-free).
- Create: `crates/freshell-ownership/src/unit_scope_tests.rs` (wired with `#[cfg(test)] mod unit_scope_tests;` next to the existing `#[cfg(test)] mod tests` at `:4182`).

**Interfaces:**
- Consumes: nothing new.
- Produces (exact; used by Tasks 9–23): see the `freshell-ownership` block in Shared interfaces, plus:
  ```rust
  pub struct SettledWait { /* Arc<registry>, SessionKey */ }
  impl std::future::Future for SettledWait { type Output = OwnershipSnapshot; }
  // "settled" = state is Vacant | Live | Aliased | Fenced (Fenced removed in Task 24); in progress = Starting | Handoff | Stopping.
  ```
  `begin_unit_stop` moves every `Live { owner }` with `owner.unit_id == Some(unit_id)` to `Stopping` (generation + 1, `prior_generation: Some(live generation)`, the given operation id) and reports keys already `Stopping` for that unit as `joined: true`; it never refuses because of an attach guard (a kill wins; it logs `attach_in_flight=true`). `commit_unit_stop` moves every `Stopping { owner: Some(o) }` with `o.unit_id == Some(unit_id)` to `Vacant`, whatever its operation id, and returns those keys with their generations (sorted by session id). `hold_extra` turns a `Vacant` key `Live` with the given owner (which must carry `unit_id`); `Live` with the same `unit_id` → `AlreadyHeld`; `Live` with another owner → `HeldByOther`; any other state → `Skipped`. `restore_stopping` turns a `Vacant` (never-seen at boot) key into `Stopping { owner: Some(owner), prior_generation: None, .. }`. Every transition logs the existing uniform `ownership.*` schema plus `unit_id`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ownership/src/unit_scope_tests.rs`:

```rust
//! Unit-scoped lifecycle on the ONE registry (no second state machine):
//! Running = Live, Stopping = Stopping, Gone = Vacant, with event-driven
//! waiting (wakers; no polling).
use std::sync::Arc;
use std::time::Duration;

use super::*;

const NOW: u64 = 1_000;

fn owner(terminal: &str, unit: &str) -> OwnerIdentity {
    OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(terminal.into()),
        unit_id: Some(unit.into()),
        ..OwnerIdentity::default()
    }
}

/// Drive a key to Live{owner} through the ordinary start path.
fn make_live(reg: &RuntimeOwnershipRegistry, sid: &str, who: OwnerIdentity) {
    let BeginOutcome::Granted { generation } =
        reg.begin_start("codex", sid, RuntimeOwnerKind::Terminal, "op-start", None, "test", NOW)
    else {
        panic!("start granted")
    };
    assert_eq!(reg.commit_live("codex", sid, "op-start", generation, who), CommitOutcome::Committed);
}

#[tokio::test]
async fn wait_settled_is_ready_at_once_for_settled_states() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    let snap = tokio::time::timeout(Duration::from_millis(50), reg.wait_settled("codex", "a")).await.unwrap();
    assert_eq!(snap.state, OwnershipState::Vacant);
    make_live(&reg, "a", owner("T1", "u1"));
    let snap = tokio::time::timeout(Duration::from_millis(50), reg.wait_settled("codex", "a")).await.unwrap();
    assert!(matches!(snap.state, OwnershipState::Live { .. }));
}

#[tokio::test]
async fn wait_settled_wakes_on_the_gone_commit_without_polling() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    make_live(&reg, "a", owner("T1", "u1"));
    let keys = reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    assert_eq!(keys.len(), 1);
    let waiter = tokio::spawn({
        let reg = reg.clone();
        async move { reg.wait_settled("codex", "a").await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiter.is_finished(), "Stopping is in progress: the wait parks");
    assert_eq!(reg.commit_unit_stop("u1").into_iter().map(|k| k.key).collect::<Vec<_>>(), vec![SessionKey::new("codex", "a")]);
    let snap = tokio::time::timeout(Duration::from_millis(200), waiter).await.expect("woken by the commit").unwrap();
    assert_eq!(snap.state, OwnershipState::Vacant);
}

#[test]
fn a_second_stop_on_a_stopping_key_is_told_to_join() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "a", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill-1", "test", NOW);
    let claim = StopClaim { expected_kind: RuntimeOwnerKind::Terminal, expected_runtime: None, observed: ObservedFence { epoch: 7, generation: 1 } };
    match reg.begin_stop("codex", "a", "op-kill-2", &claim, "test", NOW) {
        StopOutcome::AlreadyStopping { operation_id, owner, .. } => {
            assert_eq!(operation_id, "op-kill-1");
            assert_eq!(owner.and_then(|o| o.unit_id).as_deref(), Some("u1"));
        }
        other => panic!("expected AlreadyStopping, got {other:?}"),
    }
}

#[test]
fn unit_stop_moves_every_key_the_unit_holds_and_commit_vacates_them() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    assert!(matches!(reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW), HoldOutcome::Held { .. }));
    assert!(matches!(reg.hold_extra("codex", "earlier", owner("T1", "u1"), "test", NOW), HoldOutcome::Held { .. }));
    make_live(&reg, "other", owner("T2", "u2"));
    let keys = reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    let mut ids: Vec<_> = keys.iter().map(|k| k.key.session_id.clone()).collect();
    ids.sort();
    assert_eq!(ids, vec!["earlier", "helper", "root"]);
    assert!(keys.iter().all(|k| !k.joined));
    assert!(matches!(reg.observe("codex", "other").state, OwnershipState::Live { .. }), "other units untouched");
    let rejoin = reg.begin_unit_stop("u1", "op-kill-2", "test", NOW);
    assert!(rejoin.iter().all(|k| k.joined), "a second unit stop joins");
    let mut gone: Vec<_> = reg.commit_unit_stop("u1").into_iter().map(|k| k.key.session_id).collect();
    gone.sort();
    assert_eq!(gone, vec!["earlier", "helper", "root"]);
    for sid in ["earlier", "helper", "root"] {
        assert_eq!(reg.observe("codex", sid).state, OwnershipState::Vacant);
    }
}

#[test]
fn extra_holds_respect_other_units_and_reopen_adopts_the_holder() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW);
    assert_eq!(reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW), HoldOutcome::AlreadyHeld);
    assert!(matches!(reg.hold_extra("codex", "helper", owner("T9", "u9"), "test", NOW), HoldOutcome::HeldByOther { .. }));
    match reg.begin_start("codex", "helper", RuntimeOwnerKind::Terminal, "op-reopen", None, "test", NOW) {
        BeginOutcome::AdoptLive { owner, .. } => assert_eq!(owner.terminal_id.as_deref(), Some("T1")),
        other => panic!("reopen of an extra thread adopts its holder, got {other:?}"),
    }
    assert!(!reg.release_extra("codex", "helper", "u9"), "only the holding unit releases");
    assert!(reg.release_extra("codex", "helper", "u1"));
    assert_eq!(reg.observe("codex", "helper").state, OwnershipState::Vacant);
}

#[test]
fn boot_seeds_stopping_and_the_finish_vacates() {
    let reg = RuntimeOwnershipRegistry::with_epoch(8);
    assert!(reg.restore_stopping("codex", "a", owner("T1", "u1"), "op-boot", "boot", NOW));
    assert!(matches!(reg.observe("codex", "a").state, OwnershipState::Stopping { .. }));
    assert!(matches!(
        reg.begin_start("codex", "a", RuntimeOwnerKind::Terminal, "op-new", None, "test", NOW),
        BeginOutcome::Blocked { .. }
    ), "never offered for reuse while Stopping");
    assert_eq!(reg.commit_unit_stop("u1").into_iter().map(|k| k.key).collect::<Vec<_>>(), vec![SessionKey::new("codex", "a")]);
}

#[test]
fn states_for_terminal_and_keys_for_unit_report_holdings() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW);
    assert_eq!(reg.states_for_terminal("T1").len(), 2);
    assert_eq!(reg.keys_for_unit("u1").len(), 2);
    assert!(reg.states_for_terminal("T2").is_empty());
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ownership unit_scope_tests`

Expected: FAIL to compile — `no field unit_id on OwnerIdentity`, `no method wait_settled/begin_unit_stop/hold_extra/...`, `no variant AlreadyStopping` (first run unlocked: adds the dev edge).

- [ ] **Step 3: Add the minimal production implementation**

Type changes:

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeOwnerKind {
    #[default]
    Terminal,
    FreshAgent,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerIdentity {
    pub kind: RuntimeOwnerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_id: Option<String>,
    /// The containment unit (freshell-containment) whose processes ARE this
    /// owner. Every key a unit holds (main conversation and extra threads)
    /// carries the same unit id; unit stops and commits move them together.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_id: Option<String>,
}
```

`StopOutcome` gains:

```rust
    /// A stop is already in flight for this key (a unit stop or another
    /// kill). The caller JOINS it (waits for Gone through the unit's stop
    /// handle / `wait_settled`) and, for a forced stop, escalates it — it
    /// never starts a second, competing stop.
    AlreadyStopping {
        operation_id: String,
        generation: u64,
        owner: Option<OwnerIdentity>,
    },
```

and the last arm of `begin_stop` becomes:

```rust
            OwnershipState::Stopping { operation_id, generation, owner, .. } => StopOutcome::AlreadyStopping {
                operation_id,
                generation,
                owner,
            },
            state => StopOutcome::NotLive { state },
```

Waking guard and waiters:

```rust
pub struct RuntimeOwnershipRegistry {
    epoch: u64,
    inner: Mutex<HashMap<SessionKey, SessionRecord>>,
    /// Parked `wait_settled` futures. Woken (all of them; each re-checks its
    /// own key) whenever a mutating lock scope ends. No timers, no polling.
    waiters: Mutex<Vec<std::task::Waker>>,
}

struct RecordsGuard<'a> {
    guard: Option<std::sync::MutexGuard<'a, HashMap<SessionKey, SessionRecord>>>,
    waiters: &'a Mutex<Vec<std::task::Waker>>,
}

impl std::ops::Deref for RecordsGuard<'_> {
    type Target = HashMap<SessionKey, SessionRecord>;
    fn deref(&self) -> &Self::Target {
        self.guard.as_ref().expect("guard live")
    }
}
impl std::ops::DerefMut for RecordsGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard.as_mut().expect("guard live")
    }
}
impl Drop for RecordsGuard<'_> {
    fn drop(&mut self) {
        drop(self.guard.take()); // release the records lock BEFORE waking
        let wakers = std::mem::take(&mut *self.waiters.lock().expect("waiters lock"));
        for w in wakers {
            w.wake();
        }
    }
}

impl RuntimeOwnershipRegistry {
    fn lock_records(&self) -> RecordsGuard<'_> {
        RecordsGuard { guard: Some(self.inner.lock().expect("ownership lock poisoned")), waiters: &self.waiters }
    }
}

fn in_progress(state: &OwnershipState) -> bool {
    matches!(state, OwnershipState::Starting { .. } | OwnershipState::Handoff { .. } | OwnershipState::Stopping { .. })
}

pub struct SettledWait {
    registry: Arc<RuntimeOwnershipRegistry>,
    key: SessionKey,
}

impl std::future::Future for SettledWait {
    type Output = OwnershipSnapshot;
    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<OwnershipSnapshot> {
        // Register the waker WHILE holding the records lock: any later
        // mutation acquires the lock after us and wakes us on release.
        let inner = self.registry.inner.lock().expect("ownership lock poisoned");
        let snapshot = match inner.get(&self.key) {
            Some(r) => OwnershipSnapshot { epoch: self.registry.epoch, generation: snapshot_generation(r), state: r.state.clone() },
            None => OwnershipSnapshot { epoch: self.registry.epoch, generation: 0, state: OwnershipState::Vacant },
        };
        if in_progress(&snapshot.state) {
            self.registry.waiters.lock().expect("waiters lock").push(cx.waker().clone());
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(snapshot)
        }
    }
}
```

`with_epoch` initializes `waiters: Mutex::new(Vec::new())`. New methods:

```rust
    /// Event-driven: resolves once the key is not Starting/Handoff/Stopping.
    pub fn wait_settled(self: &Arc<Self>, provider: &str, session_id: &str) -> SettledWait {
        SettledWait { registry: Arc::clone(self), key: SessionKey::new(provider, session_id) }
    }

    pub fn begin_unit_stop(&self, unit_id: &str, operation_id: &str, initiator: &str, now_ms: u64) -> Vec<UnitStopKey> {
        let mut inner = self.lock_records();
        let mut out = Vec::new();
        for (key, record) in inner.iter_mut() {
            match record.state.clone() {
                OwnershipState::Live { owner, generation, since_ms } if owner.unit_id.as_deref() == Some(unit_id) => {
                    record.generation += 1;
                    record.state = OwnershipState::Stopping {
                        owner: Some(owner.clone()),
                        prior_generation: Some(generation),
                        operation_id: operation_id.to_string(),
                        generation: record.generation,
                        initiator: initiator.to_string(),
                        since_ms: now_ms,
                    };
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.stop.begin", operation_id, provider = %key.provider,
                        session_id = %key.session_id, initiator, unit_id,
                        attach_in_flight = record.in_flight_attaches > 0,
                        runtime_id = %owner.terminal_id.clone().unwrap_or_default(),
                        epoch = self.epoch, generation = record.generation,
                        duration_ms = now_ms.saturating_sub(since_ms),
                        outcome = "granted", failure_reason = "");
                    out.push(UnitStopKey { key: key.clone(), generation: record.generation, joined: false });
                }
                OwnershipState::Stopping { owner: Some(owner), generation, .. } if owner.unit_id.as_deref() == Some(unit_id) => {
                    out.push(UnitStopKey { key: key.clone(), generation, joined: true });
                }
                _ => {}
            }
        }
        out
    }

    pub fn commit_unit_stop(&self, unit_id: &str) -> Vec<UnitStopKey> {
        let mut inner = self.lock_records();
        let mut out = Vec::new();
        for (key, record) in inner.iter_mut() {
            if let OwnershipState::Stopping { owner: Some(owner), operation_id, since_ms, initiator, .. } = record.state.clone() {
                if owner.unit_id.as_deref() == Some(unit_id) {
                    record.state = OwnershipState::Vacant;
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.stop.commit", operation_id = %operation_id,
                        provider = %key.provider, session_id = %key.session_id, initiator = %initiator,
                        unit_id, runtime_id = %owner.terminal_id.clone().unwrap_or_default(),
                        epoch = self.epoch, generation = record.generation,
                        duration_ms = now_epoch_ms().saturating_sub(since_ms),
                        outcome = "committed", failure_reason = "");
                    out.push(UnitStopKey { key: key.clone(), generation: record.generation, joined: false });
                }
            }
        }
        out.sort_by(|a, b| a.key.session_id.cmp(&b.key.session_id));
        out
    }

    pub fn hold_extra(&self, provider: &str, session_id: &str, owner: OwnerIdentity, initiator: &str, now_ms: u64) -> HoldOutcome {
        let mut inner = self.lock_records();
        let record = inner.entry(SessionKey::new(provider, session_id)).or_default();
        match record.state.clone() {
            OwnershipState::Vacant => {
                record.generation += 1;
                record.state = OwnershipState::Live { owner: owner.clone(), generation: record.generation, since_ms: now_ms };
                tracing::info!(target: "freshell_ownership", event = "ownership.extra.hold",
                    provider, session_id, initiator, unit_id = %owner.unit_id.clone().unwrap_or_default(),
                    runtime_id = %owner.terminal_id.clone().unwrap_or_default(),
                    epoch = self.epoch, generation = record.generation, outcome = "held");
                HoldOutcome::Held { generation: record.generation }
            }
            OwnershipState::Live { owner: current, .. } if current.unit_id.is_some() && current.unit_id == owner.unit_id => HoldOutcome::AlreadyHeld,
            OwnershipState::Live { owner: current, .. } => HoldOutcome::HeldByOther { owner: current },
            state => HoldOutcome::Skipped { state },
        }
    }

    pub fn release_extra(&self, provider: &str, session_id: &str, unit_id: &str) -> bool {
        let mut inner = self.lock_records();
        let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) else { return false };
        match &record.state {
            OwnershipState::Live { owner, .. } if owner.unit_id.as_deref() == Some(unit_id) => {
                record.state = OwnershipState::Vacant;
                tracing::info!(target: "freshell_ownership", event = "ownership.extra.release",
                    provider, session_id, unit_id, epoch = self.epoch, generation = record.generation, outcome = "released");
                true
            }
            _ => false,
        }
    }

    pub fn restore_stopping(&self, provider: &str, session_id: &str, owner: OwnerIdentity, operation_id: &str, initiator: &str, now_ms: u64) -> bool {
        let mut inner = self.lock_records();
        let record = inner.entry(SessionKey::new(provider, session_id)).or_default();
        if record.state != OwnershipState::Vacant {
            return false;
        }
        record.generation += 1;
        record.state = OwnershipState::Stopping {
            owner: Some(owner.clone()),
            prior_generation: None,
            operation_id: operation_id.to_string(),
            generation: record.generation,
            initiator: initiator.to_string(),
            since_ms: now_ms,
        };
        tracing::info!(target: "freshell_ownership", event = "ownership.stop.restored",
            provider, session_id, operation_id, initiator, unit_id = %owner.unit_id.clone().unwrap_or_default(),
            epoch = self.epoch, generation = record.generation, outcome = "stopping");
        true
    }

    pub fn keys_for_unit(&self, unit_id: &str) -> Vec<(SessionKey, OwnershipState)> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        inner
            .iter()
            .filter(|(_, r)| match &r.state {
                OwnershipState::Live { owner, .. } => owner.unit_id.as_deref() == Some(unit_id),
                OwnershipState::Stopping { owner: Some(owner), .. } => owner.unit_id.as_deref() == Some(unit_id),
                _ => false,
            })
            .map(|(k, r)| (k.clone(), r.state.clone()))
            .collect()
    }

    pub fn states_for_terminal(&self, terminal_id: &str) -> Vec<(SessionKey, OwnershipState)> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        inner
            .iter()
            .filter(|(_, r)| match &r.state {
                OwnershipState::Live { owner, .. } => owner.terminal_id.as_deref() == Some(terminal_id),
                OwnershipState::Stopping { owner: Some(owner), .. } => owner.terminal_id.as_deref() == Some(terminal_id),
                _ => false,
            })
            .map(|(k, r)| (k.clone(), r.state.clone()))
            .collect()
    }
```

(`UnitStopKey` and `HoldOutcome` are defined next to `StopOutcome` with the derives shown in Shared interfaces. `SessionRecord` already implements `Default`, used by `or_default`.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ownership --locked`

Expected: PASS (the 7 new tests and the existing 60).

- [ ] **Step 5: Refactor while green**

Replace the remaining 30 `self.inner.lock()` call sites that mutate with `self.lock_records()` (read-only methods — `observe`, `snapshot_records`, `resolve_canonical`, `stale_start_fences`, `keys_for_unit`, `states_for_terminal` — keep `self.inner.lock()` so a read never wakes waiters). Add a crate doc paragraph: "Waiting is event-driven: `wait_settled` registers a waker under the records lock; every mutating scope wakes parked waiters when it ends." Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

The `OwnerIdentity` field and the new `StopOutcome` variant touch every lifecycle crate (freshagent lanes, ws, terminal, server). The impacted set is the Rust workspace:

Run: `cargo build --workspace --locked && cargo test --workspace --exclude freshell-tauri --locked`

Expected: PASS (behavior is unchanged: `AlreadyStopping` is handled exactly as the old `NotLive{Stopping}` everywhere until Task 23).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ownership crates/freshell-freshagent crates/freshell-ws crates/freshell-terminal crates/freshell-server crates/freshell-session-host Cargo.lock
git commit -m "feat(ownership): event-driven wait_settled, unit-scoped stop/commit, extra-thread holds, boot seed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice D — Codex panes as units (Codex first)

### Task 9: Sidecar record v2 — persisted Stopping, unit id, native main process, every held thread

**Files:**
- Modify: `crates/freshell-codex/src/sidecar_store.rs` (`SIDECAR_RECORD_VERSION` `:36` → 2; `CodexSidecarRecord` `:41-71`; `SidecarRecordState` `:77-80`; the version gate in `load_all` accepts 1 and 2)
- Modify: `crates/freshell-codex/src/sidecar_reconcile.rs` (`boot_reconcile` `:92-185`: Stopping records are never held/claimable and are returned in the report; `by_session` indexes every held thread id; `claim_for_session` `:189` matches any of them)
- Modify: every `CodexSidecarRecord { ... }` literal (compiler-guided: `launch_lifecycle.rs:1281`, `crates/freshell-freshagent/src/codex_sidecar_tracking.rs`, `sidecar_test_support.rs`, tests)
- Test: `crates/freshell-codex/src/sidecar_store_tests.rs`, `crates/freshell-codex/src/sidecar_reconcile_tests.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```rust
  pub const SIDECAR_RECORD_VERSION: u32 = 2;
  pub struct CodexSidecarRecord {
      /* v1 fields unchanged: record_version, ownership_id, pid, starttime, cmdline, ws_url,
         session_id, terminal_id, server_instance_id, created_at, updated_at, state, lane */
      #[serde(default, skip_serializing_if = "Vec::is_empty")] pub held_thread_ids: Vec<String>,
      #[serde(default, skip_serializing_if = "Option::is_none")] pub unit_id: Option<String>,
      #[serde(default, skip_serializing_if = "Option::is_none")] pub main_pid: Option<u32>,
      #[serde(default, skip_serializing_if = "Option::is_none")] pub main_starttime: Option<u64>,
  }
  pub enum SidecarRecordState { Active, Retained { reason: String }, Stopping { reason: String, since: i64, operation_id: String } }
  impl CodexSidecarRecord {
      pub fn holds_thread(&self, id: &str) -> bool;      // session_id == id || held_thread_ids.contains(id)
      pub fn all_thread_ids(&self) -> Vec<String>;       // session_id (if any) first, then held_thread_ids, deduped
  }
  pub struct BootReconcileReport { /* existing fields */ pub stopping: Vec<CodexSidecarRecord> }
  ```
  A v1 row loads with `held_thread_ids = []`, `unit_id = None` (legacy, stopped through its `FRESHELL_CODEX_SIDECAR_ID` tag), and is rewritten as v2 on its next write.

- [ ] **Step 1: Write the failing behavioral test**

Append to `crates/freshell-codex/src/sidecar_store_tests.rs`:

```rust
#[test]
fn v1_rows_load_and_stopping_rows_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let v1 = serde_json::json!({
        "recordVersion": 1, "ownershipId": "codex-sidecar-v1", "pid": 4242, "starttime": 7,
        "cmdline": ["node", "codex"], "wsUrl": "ws://127.0.0.1:1", "sessionId": "t-root",
        "serverInstanceId": "srv", "createdAt": 1, "updatedAt": 1, "state": {"kind": "active"}
    });
    std::fs::write(dir.path().join("codex-sidecar-v1.json"), v1.to_string()).unwrap();
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 1, "a v1 row is not quarantined");
    assert!(loaded[0].holds_thread("t-root"));
    assert_eq!(loaded[0].unit_id, None);

    let mut row = loaded[0].clone();
    row.record_version = SIDECAR_RECORD_VERSION;
    row.held_thread_ids = vec!["t-helper".into(), "t-earlier".into()];
    row.unit_id = Some("u0123456789abcdef0123456789abcdef".into());
    row.main_pid = Some(4243);
    row.main_starttime = Some(8);
    row.state = SidecarRecordState::Stopping { reason: "shift-x".into(), since: 99, operation_id: "op-1".into() };
    store.write(&row).unwrap();
    let back = store.load_all();
    assert_eq!(back, vec![row.clone()]);
    assert_eq!(back[0].all_thread_ids(), vec!["t-root", "t-helper", "t-earlier"]);
}
```

Append to `crates/freshell-codex/src/sidecar_reconcile_tests.rs` (uses the file's existing live-child record helper `record_for_child` from `sidecar_test_support.rs`, which returns a Verified record for a `sleep` child the test spawned):

```rust
#[tokio::test]
async fn stopping_records_are_never_offered_and_are_reported_for_finishing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()));
    let (mut child_a, mut a) = spawn_verified_record("t-a");
    a.state = SidecarRecordState::Stopping { reason: "shift-x".into(), since: 1, operation_id: "op".into() };
    store.write(&a).unwrap();
    let (mut child_b, mut b) = spawn_verified_record("t-b-root");
    b.held_thread_ids = vec!["t-b-helper".into(), "t-b-prefork".into()];
    store.write(&b).unwrap();
    let (reconciler, report) = SidecarReconciler::boot_reconcile(store.clone());
    assert_eq!(report.stopping.iter().map(|r| r.ownership_id.clone()).collect::<Vec<_>>(), vec![a.ownership_id.clone()]);
    assert!(reconciler.claim_for_session("t-a").await.is_none(), "a dying app-server is never offered for reuse");
    let claimed = reconciler.claim_for_session("t-b-prefork").await.expect("any held thread claims");
    assert_eq!(claimed.ownership_id, b.ownership_id);
    child_a.kill().unwrap();
    child_b.kill().unwrap();
}
```

(`spawn_verified_record(session_id) -> (std::process::Child, CodexSidecarRecord)` is a 6-line helper added to `sidecar_test_support.rs`: spawn `sleep 300`, call the existing `record_for_child(&child)`, set `session_id`, return both.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-codex --features real-transport --lib sidecar_store_tests::v1_rows_load_and_stopping_rows_round_trip sidecar_reconcile_tests::stopping_records_are_never_offered --locked`

Expected: FAIL to compile — `no field held_thread_ids/unit_id/main_pid`, `no variant SidecarRecordState::Stopping`, `no field stopping on BootReconcileReport`.

- [ ] **Step 3: Add the minimal production implementation**

- Add the fields and variant exactly as in **Interfaces**; `holds_thread`/`all_thread_ids` as described.
- `load_all`: accept `record_version` 1 or 2 (anything else is still quarantined loudly).
- `boot_reconcile`: after identity verification, a `Stopping` record (Verified or Unverifiable) is pushed to `report.stopping` and NOT inserted into `held`/`by_session`; Dead/Mismatch Stopping rows are removed like any other (their processes are gone; Task 19's boot finish still kills any surviving unit members by unit id). For held records, index `by_session` under every id from `all_thread_ids()`.
- `claim_for_session(id)`: candidates are the held records with `holds_thread(id)`; the rest of the claim (re-verify, probe duplicates, newest wins, claimable once) is unchanged.
- Every writer of a record sets `record_version: SIDECAR_RECORD_VERSION` and the new fields (`held_thread_ids: vec![]`, `unit_id`/`main_*`: `None` until Task 10 fills them).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-codex --features real-transport --lib sidecar_ --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Make `SidecarReconciler` index construction a single helper (`fn index_held(&mut self, record)`) used by both boot and any later re-index; no behavior change. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Record readers/writers: freshell-codex (launch, reconcile, sweep), freshell-freshagent (freshcodex tracking), freshell-ws (reattach e2e).

Run: `cargo test -p freshell-codex --features real-transport --locked && cargo test -p freshell-freshagent codex_sidecar_tracking --locked && cargo test -p freshell-ws --test codex_sidecar_reattach_e2e --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex crates/freshell-freshagent/src/codex_sidecar_tracking.rs
git commit -m "feat(codex): sidecar record v2 with persisted Stopping, unit id, native main and every held thread

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Codex sidecar inside the pane unit; native main discovered; independent per-unit stops; kill beats retention

**Files:**
- Modify: `crates/freshell-codex/Cargo.toml` (`freshell-containment = { path = "../freshell-containment" }`, real-transport only is NOT enough — the plan type carries the seed, so make it a normal dependency)
- Modify: `crates/freshell-codex/src/launch_plan.rs` (`CodexLaunchPlan` `:186-207` gains `pub unit_seed: Option<UnitSeed>`; `CodexLaunchPlanInput` gains `pub unit_seed: Option<UnitSeed>`; new `UnitSeed`)
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs`:
  - trait `CodexLaunchRuntime` (`:86-125`): delete `shutdown`; add `fn unit(&self) -> Option<AgentUnit>`, `fn mark_stopping(&self, reason: String, operation_id: String) -> BoxFuture<'_, ()>`, `fn finish_after_gone(&self) -> BoxFuture<'_, ()>`, `fn note_held_threads(&self, ids: Vec<String>) -> BoxFuture<'_, ()>` (default no-ops where the trait already has defaults).
  - `CodexLaunchSidecar` (`:206-315`): `shutdown()` becomes `stop(&self, req: StopRequest) -> Option<StopHandle>` (closes the proxy, then `unit.stop(req)`) plus `mark_stopping`, `finish_after_gone`, `unit()`.
  - `CodexTerminalLaunch` gains `pub unit: Option<AgentUnit>` (filled after `ensure_ready`).
  - `CodexTerminalLaunchManager`: delete `teardown_tx`, `ensure_teardown_worker` (`:982-997`); `notify_terminal_exit` (`:944-952`) becomes per-unit (below); add `adopted_unit`, `mark_stopping`, `finish_unit`, `proxy_ws_url`; `shutdown` (`:965-980`) awaits stops in flight and only retains units with no stop in flight.
  - `SpawnedCodexAppServerRuntime::ensure_ready` (`:1158-1341`): spawn through the unit, discover the main, record v2 fields; failure paths stop the unit instead of `reap_owned_codex_sidecars`.
- Modify: `crates/freshell-codex/src/sidecar_reconcile.rs` (`ReattachedCodexAppServerRuntime` `:432-656`: unit = `reopen_unit(record.unit_id)` or `adopt_legacy("FRESHELL_CODEX_SIDECAR_ID", ownership_id, [pid])`; main = `ProcWatch::open_expecting(main_pid, main_starttime)` else the launcher; its failure arm and `shutdown` use the unit instead of `kill_verified_sidecar_tree`)
- Modify: `crates/freshell-codex/src/sidecar_sweep.rs` (sweep `Kill` arm uses the reopened/legacy unit's `stop(Graceful{5 s}, Cleanup)`; delete `kill_verified_sidecar_tree`, `kill_verified_tree_linux`, `capture_descendants`, `poll_incarnation_gone`, `ownership_tag_still_live`, `KILL_POLL_INTERVAL` and their tests in `sidecar_sweep_tests.rs`)
- Modify: `crates/freshell-codex/src/runtime_select.rs` (`:24-42` passes `plan.unit_seed` to both runtimes)
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs` (new tests below; adapt `runtime_shutdown_removes_the_sidecar_record` `:1745`, `sidecar_shutdown_is_idempotent` `:438`, `manager_adopts_by_terminal_id_and_tears_down_on_exit` `:493`, `notify_terminal_exit_retains_under_retention_flag` `:2063` to the new API)

**Interfaces:**
- Consumes: Task 4 (`Containment`, `AgentUnit`, `StopRequest`…), Task 3 (`listening_socket_owner`, `codex_thread_lock_path`), Task 9 (record v2).
- Produces:
  ```rust
  // launch_plan.rs
  #[derive(Clone)]
  pub struct UnitSeed { pub unit: freshell_containment::AgentUnit }
  // The pane's unit, created by the create path BEFORE planning (so a Shift-X
  // during the start can stop whatever the plan has spawned so far).
  // Debug prints the unit id; PartialEq/Eq compare unit ids (CodexLaunchPlan keeps its derives).

  // launch_lifecycle.rs
  impl CodexTerminalLaunchManager {
      pub fn adopted_unit(&self, terminal_id: &str) -> Option<AgentUnit>;
      pub fn proxy_ws_url(&self, terminal_id: &str) -> Option<String>;
      pub async fn mark_stopping(&self, terminal_id: &str, reason: &str, operation_id: &str);
      pub async fn finish_unit(&self, terminal_id: &str);   // after Gone: close proxy, abort drain, remove record
      pub fn notify_terminal_exit(&self, terminal_id: &str); // only for rows WITHOUT a unit stop in flight (see below)
  }
  pub fn codex_home_dir() -> Option<std::path::PathBuf>;   // CODEX_HOME, else $HOME/.codex (durability.rs resolution)
  ```
  `notify_terminal_exit` semantics: if the adopted unit has a stop in flight → do nothing (the stop's `on_gone` calls `finish_unit`); else if shutdown retention is set → `retain`; else → spawn ONE independent task: `unit.stop(Force, AgentExited{None})` then `finish_unit` at Gone. There is no shared queue.

- [ ] **Step 1: Write the failing behavioral test**

Add to `crates/freshell-codex/tests/launch_lifecycle.rs` (top: `#[path = "support/fake_codex.rs"] mod fake_codex;` and `use freshell_containment::*;`):

```rust
fn tag_seed(provider_session: &str) -> freshell_codex::launch_plan::UnitSeed {
    let containment = Containment::select(SelectOptions::default());
    let label = UnitLabel { provider: "codex".into(), session_id: Some(provider_session.into()), terminal_id: None };
    freshell_codex::launch_plan::UnitSeed { unit: containment.create_unit(UnitId::mint(), label).unwrap() }
}

/// No process-env mutation: everything the fake needs rides the sidecar's
/// own spawn environment (`CodexSidecarLaunchContext.env`).
fn fake_context(behavior: serde_json::Value, home: &std::path::Path, store: &CodexSidecarStore) -> CodexSidecarLaunchContext {
    let mut env = std::collections::BTreeMap::new();
    env.insert("CODEX_HOME".to_string(), home.display().to_string());
    env.insert("FAKE_CODEX_APP_SERVER_BEHAVIOR".to_string(), behavior.to_string());
    env.insert("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES".to_string(), "1".to_string());
    env.insert("FAKE_CODEX_MANIFEST_DIR".to_string(), home.join("manifests").display().to_string());
    env.insert("FAKE_CODEX_RECORD_DIR".to_string(), store.root().unwrap().display().to_string());
    CodexSidecarLaunchContext { config_args: vec![], env }
}

async fn ready_realistic(behavior: serde_json::Value, home: &std::path::Path, store: Arc<CodexSidecarStore>, seed: freshell_codex::launch_plan::UnitSeed)
    -> (SpawnedCodexAppServerRuntime, CodexRuntimeReady)
{
    let ctx = fake_context(behavior, home, &store);
    let runtime = SpawnedCodexAppServerRuntime::with_command_store_context_and_seed(fake_codex::launcher_command(), store, ctx, seed);
    let ready = runtime.ensure_ready(None).await.expect("ready");
    (runtime, ready)
}

#[tokio::test(flavor = "multi_thread")]
async fn force_stop_signals_native_first_and_kills_launcher_last() {
    let home = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexSidecarStore::new(home.path().join("records")));
    let seed = tag_seed("t-shiftx");
    let (runtime, ready) = ready_realistic(
        serde_json::json!({"threadStartThreadId": "t-shiftx", "turnCompleteDelayMs": 60000,
            "turnSpawnsShellCommand": true, "detachedJobOnTurn": true, "spawnHelperProcess": true}),
        home.path(), store.clone(), seed,
    ).await;
    let unit = runtime.unit().expect("spawned inside a unit");
    let record = store.load_all().pop().expect("record");
    let manifest_dir = home.path().join("manifests");
    let native = read_native_manifest(&manifest_dir).await; // helper over fake_codex::NativeManifest
    assert_eq!(unit.main().unwrap().pid(), native.pid, "main is the native app-server, not the launcher");
    assert_eq!(record.main_pid, Some(native.pid));
    assert_eq!(record.unit_id.as_deref(), Some(unit.id().as_str()));
    let port: u16 = ready.ws_url.rsplit(':').next().unwrap().parse().unwrap();
    let mut rpc = fake_codex::Rpc::connect(port).await;
    rpc.initialize().await;
    rpc.call("thread/start", serde_json::json!({})).await.unwrap();
    rpc.call("turn/start", serde_json::json!({"threadId": "t-shiftx", "input": []})).await.unwrap();
    let lock = fake_codex::thread_lock_path(home.path(), "t-shiftx");
    assert!(fake_codex::lock_held(&lock));
    unit.set_lock_paths(vec![lock.clone()]);
    runtime.mark_stopping("shift-x".into(), "op-1".into()).await;
    let report = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
    let native = read_native_manifest(&manifest_dir).await;
    assert_eq!(native.signals.iter().map(|s| s.sig.as_str()).collect::<Vec<_>>(), vec!["SIGINT"], "SIGINT straight to the native");
    assert_eq!(native.signals[0].record_state.as_deref(), Some("stopping"), "Stopping persisted before any signal");
    assert!(report.lock_released && !fake_codex::lock_held(&lock), "lock released at Gone");
    assert!(unit.stop_in_flight().unwrap().wait_swept().await.is_empty());
    let c = native.children;
    for pid in [native.pid, c.helper.unwrap()].into_iter().chain(c.shell).chain(c.detached) {
        assert!(!fake_codex::pid_alive(pid), "{pid} survived Shift-X");
    }
    runtime.finish_after_gone().await;
    assert!(store.load_all().is_empty(), "record removed only after Gone");
}

#[tokio::test(flavor = "multi_thread")]
async fn units_stop_independently() {
    let home = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexSidecarStore::new(home.path().join("records")));
    let (slow, slow_ready) = ready_realistic(serde_json::json!({"threadStartThreadId": "t-slow", "turnCompleteDelayMs": 4000}), home.path(), store.clone(), tag_seed("t-slow")).await;
    let (fast, _) = ready_realistic(serde_json::json!({"threadStartThreadId": "t-fast"}), home.path(), store.clone(), tag_seed("t-fast")).await;
    let port: u16 = slow_ready.ws_url.rsplit(':').next().unwrap().parse().unwrap();
    let mut rpc = fake_codex::Rpc::connect(port).await;
    rpc.initialize().await;
    rpc.call("thread/start", serde_json::json!({})).await.unwrap();
    rpc.call("turn/start", serde_json::json!({"threadId": "t-slow", "input": []})).await.unwrap();
    let draining = slow.unit().unwrap().stop(StopRequest::new(StopMode::Graceful { grace: std::time::Duration::from_secs(30) }, StopReason::Cleanup, "test"));
    let t0 = std::time::Instant::now();
    fast.unit().unwrap().stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
    assert!(t0.elapsed() < std::time::Duration::from_millis(1500), "never queued behind the draining unit");
    assert!(draining.try_report().is_none(), "the slow unit is still finishing its reply");
    draining.wait().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_beats_shutdown_retention() {
    let home = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexSidecarStore::new(home.path().join("records")));
    let manager = manager_with_realistic_runtime(store.clone(), home.path()); // file helper: CodexTerminalLaunchManager over SpawnedCodexAppServerRuntime + seed
    let launch = manager.plan_create_with_retry(&plan_input_with_seed("t-race", tag_seed("t-race")), LaunchClass::Interactive).await.unwrap();
    manager.adopt(launch, "T-race", 1).await.unwrap();
    let unit = manager.adopted_unit("T-race").unwrap();
    manager.mark_stopping("T-race", "shift-x", "op-race").await;
    let handle = unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test"));
    manager.begin_shutdown_retention();
    manager.notify_terminal_exit("T-race"); // the PTY exit hook racing the shutdown
    handle.wait().await;
    manager.finish_unit("T-race").await;
    assert!(store.load_all().is_empty(), "a kill always beats keep-on-restart: never Retained");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reattached_sidecar_is_stopped_through_its_reopened_unit() {
    let home = tempfile::tempdir().unwrap();
    let store = Arc::new(CodexSidecarStore::new(home.path().join("records")));
    let (runtime, _) = ready_realistic(serde_json::json!({"threadStartThreadId": "t-re"}), home.path(), store.clone(), tag_seed("t-re")).await;
    runtime.note_session_id("t-re".into()).await.unwrap();
    runtime.prepare_retention("server-shutdown".into()).await.unwrap(); // "restart": handle dropped, no signal
    drop(runtime);
    let (reconciler, _) = SidecarReconciler::boot_reconcile(store.clone());
    let record = reconciler.claim_for_session("t-re").await.expect("claimable survivor");
    let reattached = ReattachedCodexAppServerRuntime::new(record.clone(), store.clone());
    reattached.ensure_ready(None).await.unwrap();
    let unit = reattached.unit().expect("reopened unit");
    assert_eq!(unit.main().unwrap().pid(), record.main_pid.unwrap());
    unit.stop(StopRequest::new(StopMode::Force, StopReason::ShiftX, "test")).wait().await;
    assert!(!fake_codex::pid_alive(record.main_pid.unwrap()));
    assert!(!fake_codex::pid_alive(record.pid), "the launcher dies with the unit");
}
```

(`read_native_manifest(dir)`, `manager_with_realistic_runtime(store, home)` and `plan_input_with_seed(session, seed)` are small helpers added to this test file next to the existing `fake_app_server_command()` `:1082`; they read `native-*.json` via `fake_codex::NativeManifest`, build a `CodexTerminalLaunchManager::new(Box::new(move |plan| …SpawnedCodexAppServerRuntime::with_command_store_context_and_seed(launcher_command(), store, fake_context(json!({}), home, &store), plan.unit_seed.clone().unwrap())…))`, and build a `CodexLaunchPlanInput` with `session_id: Some(session)` and `unit_seed: Some(seed)`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-codex --features real-transport --test launch_lifecycle force_stop_signals_native_first units_stop_independently kill_beats_shutdown_retention a_reattached_sidecar_is_stopped --locked`

Expected: FAIL to compile — `no function with_command_store_context_and_seed`, `no method unit/mark_stopping/finish_after_gone/adopted_unit/finish_unit`, `no struct UnitSeed`.

- [ ] **Step 3: Add the minimal production implementation**

`SpawnedCodexAppServerRuntime` gains `seed: Option<UnitSeed>` and `unit: std::sync::OnceLock<AgentUnit>`; `with_context(ctx)` keeps `seed: None` (tests that need no unit), `with_context_and_seed(ctx, seed)` is what `select_codex_runtime` uses, and `with_command_store_context_and_seed(cmd, store, ctx, seed)` is the test constructor. `CodexSidecarStore` gains `pub fn root(&self) -> Option<&std::path::Path>` (the tests point the fake's `FAKE_CODEX_RECORD_DIR` at it). `ensure_ready` changes (replacing `:1179-1215` and the failure arms at `:1243-1258`):

```rust
            let unit = match self.unit.get() {
                Some(u) => u.clone(),
                None => {
                    let seed = self.seed.clone().ok_or("codex sidecar spawn needs the pane's unit")?;
                    let _ = self.unit.set(seed.unit.clone());
                    seed.unit
                }
            };
            let all_args: Vec<String> = leading_args.iter().cloned().chain(spec.args.iter().cloned()).collect();
            let mut cmd = unit
                .tokio_command(&program, &all_args, freshell_containment::MemberRole::Agent)
                .map_err(|e| format!("containment placement failed: {e}"))?;
            if let Some(cwd) = cwd.as_deref() {
                cmd.current_dir(cwd);
            }
            for (key, value) in &spec.env {
                cmd.env(key, value);
            }
            cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
            // The unit, not the process group or kill_on_drop, owns the
            // lifetime. Units that can outlive this server (systemd scopes,
            // the Linux tag backend with a record store) are detached;
            // Windows jobs die with the server (KILL_ON_JOB_CLOSE).
            let detach = self.store.is_enabled() && unit.capability().kind != freshell_containment::BackendKind::WindowsJob;
            cmd.kill_on_drop(!detach);
            #[cfg(unix)]
            cmd.process_group(0);
            let mut child = cmd.spawn().map_err(|error| format!("codex app-server spawn failed ({command}): {error}"))?;
            drain_child_io(&mut child);
            if let Some(pid) = child.id() {
                if let Ok(w) = freshell_containment::ProcWatch::open(pid) {
                    unit.add_root(w);
                }
            }
```

and both failure arms become:

```rust
                    unit.stop(freshell_containment::StopRequest::new(
                        freshell_containment::StopMode::Force,
                        freshell_containment::StopReason::StartCancelled,
                        "codex-sidecar-start-failed",
                    )).wait().await;
                    self.scrub_record(&ownership_id);
```

After the readiness loop, before the record write:

```rust
            let launcher_pid = child.id().unwrap_or(0);
            let main_pid = freshell_containment::listening_socket_owner(port, &[launcher_pid]).unwrap_or_else(|| {
                freshell_containment::events::main_discovery_failed(
                    &freshell_containment::events::UnitLogKeys {
                        unit_id: unit.id().to_string(),
                        provider: "codex".into(),
                        ..Default::default()
                    },
                    port,
                    launcher_pid,
                );
                launcher_pid
            });
            let main = freshell_containment::ProcWatch::open(main_pid).map_err(|e| format!("main watch failed: {e}"))?;
            unit.set_main(main.clone());
```

The record literal adds `unit_id: Some(unit.id().to_string())`, `main_pid: Some(main_pid)`, `main_starttime: Some(main.identity().start)`, `held_thread_ids: vec![]`, `record_version: SIDECAR_RECORD_VERSION`. Every other `unit.tokio_command` caller in this file follows the same shape.

New runtime methods on `SpawnedCodexAppServerRuntime` (and the reattached runtime, same bodies over its record):

```rust
    fn unit(&self) -> Option<AgentUnit> {
        self.unit.get().cloned()
    }

    /// Persist Stopping BEFORE any signal (the unit stop's `before_signal`).
    fn mark_stopping(&self, reason: String, operation_id: String) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            if let Some(record) = state.as_mut().and_then(|s| s.record.as_mut()) {
                record.state = SidecarRecordState::Stopping { reason, since: unix_millis(), operation_id };
                record.updated_at = unix_millis();
                write_record_loudly(&self.store, record);
            }
        })
    }

    /// After Gone: the record goes (and never before).
    fn finish_after_gone(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Some(spawned) = self.state.lock().await.take() {
                self.scrub_record(&spawned.ownership_id);
            }
        })
    }
```

`prepare_retention` keeps its body for recorded spawns; its record-less arm becomes `unit.stop(Force, ServerShutdown).wait().await` + `scrub_record`. Delete `shutdown()` from the trait and both impls.

`CodexTerminalLaunchManager` (replacing `:934-1000`):

```rust
    pub fn notify_terminal_exit(&self, terminal_id: &str) {
        let Some(entry) = self.adopted.lock().unwrap().remove(terminal_id) else { return };
        let Some(unit) = entry.sidecar.unit() else {
            entry.drain.abort();
            return;
        };
        if unit.stop_in_flight().is_some() {
            // A stop owns this unit; its on_gone calls finish_unit. Put the
            // entry back so finish_unit can find it.
            self.adopted.lock().unwrap().insert(terminal_id.to_string(), entry);
            return;
        }
        let retain = self.shutdown_retention.load(Ordering::SeqCst);
        tokio::spawn(async move {
            if retain {
                let _ = entry.sidecar.retain(SERVER_SHUTDOWN_RETENTION_REASON).await;
            } else {
                entry.sidecar.close_proxy().await;
                unit.stop(StopRequest::new(StopMode::Force, StopReason::AgentExited { exit_code: None }, "pty-exit")).wait().await;
                entry.sidecar.finish_after_gone().await;
            }
            entry.drain.abort();
        });
    }

    pub fn adopted_unit(&self, terminal_id: &str) -> Option<AgentUnit> {
        self.adopted.lock().unwrap().get(terminal_id).and_then(|e| e.sidecar.unit())
    }

    pub async fn mark_stopping(&self, terminal_id: &str, reason: &str, operation_id: &str) {
        let sidecar = self.adopted.lock().unwrap().get(terminal_id).map(|e| e.sidecar.clone());
        if let Some(sidecar) = sidecar {
            sidecar.mark_stopping(reason, operation_id).await;
        }
    }

    pub async fn finish_unit(&self, terminal_id: &str) {
        let entry = self.adopted.lock().unwrap().remove(terminal_id);
        if let Some(entry) = entry {
            entry.sidecar.close_proxy().await;
            entry.sidecar.finish_after_gone().await;
            entry.drain.abort();
        }
    }

    pub async fn shutdown(&self) {
        self.planner.shutdown().await; // unadopted plans: their units are stopped (Force, ServerShutdown)
        let retain = self.shutdown_retention.load(Ordering::SeqCst);
        let adopted: Vec<(String, AdoptedTerminalLaunch)> = self.adopted.lock().unwrap().drain().collect();
        for (_tid, entry) in adopted {
            match entry.sidecar.unit() {
                Some(unit) if unit.stop_in_flight().is_some() => {
                    // A kill beats keep-on-restart: finish the stop, never retain.
                    unit.stop_in_flight().unwrap().wait().await;
                    entry.sidecar.finish_after_gone().await;
                }
                _ if retain => {
                    let _ = entry.sidecar.retain(SERVER_SHUTDOWN_RETENTION_REASON).await;
                }
                Some(unit) => {
                    unit.stop(StopRequest::new(StopMode::Force, StopReason::ServerShutdown, "server-shutdown")).wait().await;
                    entry.sidecar.finish_after_gone().await;
                }
                None => {}
            }
            entry.drain.abort();
        }
    }
```

`CodexLaunchSidecar` replaces `shutdown()` with `close_proxy()` (take + close the proxy, set the idempotence flags), `retain()` (unchanged), `mark_stopping()`, `finish_after_gone()`, `unit()` delegating to the runtime. `CodexLaunchPlanner::plan_create`'s error path (`:432`) and `CodexTerminalLaunchManager::discard`/`discard_sync` (`:838-878`) stop the sidecar's unit (`Force`, `StartCancelled`) and then `finish_after_gone()`; `discard_sync` spawns that on the current runtime handle (no queue). `plan_create` sets `launch.unit = runtime.unit()` after `ensure_ready`.

`ReattachedCodexAppServerRuntime::ensure_ready` (`:470-552`): after verification, build the unit:

```rust
        let containment = freshell_containment::global_containment()
            .unwrap_or_else(|| freshell_containment::Containment::select(Default::default()));
        let label = freshell_containment::UnitLabel { provider: "codex".into(), session_id: record.session_id.clone(), terminal_id: record.terminal_id.clone() };
        let unit = record.unit_id.as_deref()
            .and_then(freshell_containment::UnitId::parse)
            .and_then(|id| containment.reopen_unit(&id, label.clone()).ok().flatten())
            .unwrap_or_else(|| containment.adopt_legacy(freshell_codex_sidecar_id_env(), &record.ownership_id, &[record.pid], label));
        if let Some(w) = record.main_pid.zip(record.main_starttime)
            .and_then(|(p, s)| freshell_containment::ProcWatch::open_expecting(p, s).ok())
            .or_else(|| freshell_containment::ProcWatch::open_expecting(record.pid, record.starttime).ok())
        {
            unit.set_main(w);
        }
```

(`freshell_codex_sidecar_id_env()` returns the existing `durability.rs:20` constant.) Its unusable-verified arm and `shutdown` replacement stop this unit (`Force`, `StartCancelled`) and remove the record only after Gone.

`codex_home_dir()` in `durability.rs` next to the sessions-root resolver (`:78-90`): `std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))`.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-codex --features real-transport --test launch_lifecycle --locked`

Expected: PASS (new tests and the adapted existing ones).

- [ ] **Step 5: Refactor while green**

Delete the now-unused terminal-lane imports of `reap_owned_codex_sidecars` in `launch_lifecycle.rs`/`sidecar_reconcile.rs` (the function itself stays until Task 23 moves freshcodex); delete the dead `CodexLaunchManager` teardown channel types. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole Codex crate, the ws Codex suites that build launches, the server shutdown test, the session host (it called `sidecar.shutdown()`; switch it to `sidecar.stop(Force, ServerShutdown)` — managed runtime keeps Docker as its outer containment).

Run: `cargo test -p freshell-codex --features real-transport --locked && cargo test -p freshell-ws --test codex_managed_launch_e2e --test codex_sidecar_reattach_e2e --test codex_fork_rebind --test codex_session_ref_resume --locked && cargo test -p freshell-session-host --locked && cargo build -p freshell-server --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test safe11_term22_shutdown_reaping --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex crates/freshell-session-host crates/freshell-ws Cargo.lock
git commit -m "feat(codex): sidecars run inside the pane unit; native main signalled directly; per-unit stops; kill beats retention

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Terminal registry unit rows — placement, stop intent, Gone-time publishing, screen replacement

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs`:
  - `TerminalShared` (`:530`) gains `unit_id: Option<String>`, `ending: Option<UnitEnding>`, `main_is_screen: bool`, `screen_generation: u32`, `respawn_spec: Option<(SpawnSpec, BTreeMap<String, String>)>` (the spawn inputs, kept for `replace_screen`).
  - `TerminalRegistry` (`:1183`) gains `unit_screen_exit_hook: Arc<RwLock<Option<Arc<dyn Fn(UnitScreenExit) + Send + Sync>>>>`.
  - `create` (`:2313`): body moved into `fn create_inner(..., placement: Option<UnitPlacement>) -> io::Result<u32>`; `create` calls it with `None` (signature unchanged); new `create_in_unit` calls it with `Some`. The output-sink construction inside `create` becomes `fn build_output_sink(&self, shared: &Arc<Mutex<TerminalShared>>, terminal_id: &str, mode: &str) -> MessageSink` (reused by `replace_screen`).
  - `finish_pty_exit` (`:4037-4150`): unit rows route to the hook (below); its natural-exit tail becomes `fn publish_natural_exit(&self, terminal_id: &str, shared: &Arc<Mutex<TerminalShared>>, exit_code: i64)`, reused by `complete_unit_end(AgentExited)`.
  - `kill_all` (`:3993`): unit rows are first marked `ending = Requested` (shutdown; the screen exit must not look like a crash), then killed as today.
  - `commit_session_ref_ownership` (`:5511`): the `OwnerIdentity` it builds carries the row's `unit_id`.
- Test: `crates/freshell-terminal/src/registry.rs` (new `#[cfg(all(test, unix))] mod unit_row_tests`)

**Interfaces:**
- Consumes: `freshell_platform::SpawnSpec`; `freshell_ownership::OwnerIdentity.unit_id` (Task 8). This crate stays tokio-free and does NOT depend on `freshell-containment`: a unit is plain data here.
- Produces (exact; used by Tasks 12, 13, 17, 19, 22, 23): the `freshell-terminal` block of Shared interfaces:
  - `create_in_unit(...) -> io::Result<u32>` — resolves `spec.program` via `$PATH` first (TERM-28 safety), then spawns `wrapper ++ [resolved, args...]` when `placement.wrapper` is `Some`, with `placement.env` added to the child env; returns the PTY child pid (the screen; with the systemd wrapper this is the agent's own pid because `systemd-run` execs in place; with the Windows shim it is the shim's pid, which exits with the agent).
  - `mark_ending(tid, ending) -> bool` — first ending wins (`Requested` set by a kill is never overwritten by a later `AgentExited`, and vice versa).
  - `complete_unit_end(tid, Requested)` — removes the row, bumps the revision, prunes session-ref bindings, sends `terminal.exit{exitCode:0}` to subscribers, releases ownership (fenced), logs `terminal.killed by=unit`, emits `ActivityEvent::Exit{spontaneous:false}`; never signals (the unit already did). `complete_unit_end(tid, AgentExited{code})` — keeps the row `Exited` with that code and runs `publish_natural_exit` (paced exit partitioning, respawn-window accounting, `terminal.exited`, ownership release, `Exit{spontaneous:true}`). Returns whether the row existed. It may join PTY threads: callers in async code run it on `spawn_blocking`.
  - `replace_screen(tid, spec, env, placement) -> io::Result<u32>` — spawns a new PTY into the SAME row (same terminal id and stream id, same subscribers and replay ring), bumps `screen_generation`, counts against the respawn liveness window (`respawn_generations`, `:2008`); errors with `ErrorKind::Other("respawn cap")` when exhausted.
  - `set_unit_screen_exit_hook(hook)`; for a unit row whose `ending` is unset, a screen exit calls `hook(UnitScreenExit{terminal_id, unit_id, exit_code, screen_generation})` and changes nothing else (no `terminal.exit`, no crash event, no ownership release). A unit row with `ending` set ignores the screen exit (the stop publishes at Gone).
  - `unit_id_for(tid)`, `terminal_for_create_request(crid)` (the running row created for that create-request id), `ending(tid)`.

- [ ] **Step 1: Write the failing behavioral test**

```rust
#[cfg(all(test, unix))]
mod unit_row_tests {
    use super::tests::collector; // existing helper at :7143 — make it `pub(super)`
    use super::*;
    use std::time::{Duration, Instant};

    fn bash(script: &str) -> SpawnSpec {
        SpawnSpec { program: "bash".into(), args: vec!["-c".into(), script.into()], env_overrides: Default::default(), cwd: None, cols: 80, rows: 24 }
    }
    fn env() -> BTreeMap<String, String> {
        std::env::vars().filter(|(k, _)| k == "PATH" || k == "HOME").collect()
    }
    fn placement(wrapper: Option<Vec<String>>) -> UnitPlacement {
        UnitPlacement { unit_id: "u1".into(), wrapper, env: vec![("FRESHELL_UNIT_ID".into(), "u1".into())], main_is_screen: true }
    }
    fn attach_collector(reg: &TerminalRegistry, tid: &str) -> Arc<Mutex<Vec<ServerMessage>>> {
        let (sink, seen) = collector();
        let _ = reg.attach(tid, 1, sink, Some("a".into()), 0, false, false, None, None, None, PacedAttachOptions::default());
        seen
    }
    fn wait(what: &str, f: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !f() {
            assert!(Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn output_text(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> String {
        seen.lock().unwrap().iter().filter_map(|m| match m { ServerMessage::TerminalOutput(o) => Some(o.data.clone()), _ => None }).collect()
    }
    fn exits(seen: &Arc<Mutex<Vec<ServerMessage>>>) -> Vec<i64> {
        seen.lock().unwrap().iter().filter_map(|m| match m { ServerMessage::TerminalExit(e) => Some(e.exit_code), _ => None }).collect()
    }

    #[test]
    fn a_unit_row_spawns_through_the_wrapper_with_the_unit_env() {
        let reg = TerminalRegistry::new();
        let wrapper = Some(vec!["/usr/bin/env".to_string(), "WRAPPED=yes".to_string()]);
        let pid = reg.create_in_unit(&bash("echo W=$WRAPPED U=$FRESHELL_UNIT_ID; sleep 30"), &env(), "T1".into(), "S1".into(),
            "claude", None, Some("crq-1"), None, None, placement(wrapper)).unwrap();
        assert!(pid > 0);
        let seen = attach_collector(&reg, "T1");
        wait("wrapped output", || output_text(&seen).contains("W=yes U=u1"));
        assert_eq!(reg.unit_id_for("T1").as_deref(), Some("u1"));
        assert_eq!(reg.terminal_for_create_request("crq-1").as_deref(), Some("T1"));
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }

    #[test]
    fn an_unrequested_screen_exit_goes_to_the_unit_hook_and_publishes_nothing() {
        let reg = TerminalRegistry::new();
        let got: Arc<Mutex<Vec<UnitScreenExit>>> = Arc::default();
        let g = got.clone();
        reg.set_unit_screen_exit_hook(Arc::new(move |e| g.lock().unwrap().push(e)));
        reg.create_in_unit(&bash("sleep 0.3; exit 3"), &env(), "T2".into(), "S2".into(), "codex", None, None, None, None, placement(None)).unwrap();
        let seen = attach_collector(&reg, "T2");
        wait("hook fired", || !got.lock().unwrap().is_empty());
        let e = got.lock().unwrap()[0].clone();
        assert_eq!((e.terminal_id.as_str(), e.unit_id.as_str(), e.exit_code), ("T2", "u1", 3));
        std::thread::sleep(Duration::from_millis(200));
        assert!(exits(&seen).is_empty(), "no terminal.exit before the unit decides");
        assert!(reg.is_running("T2"), "the row stays Running until the unit ends or the screen is replaced");
    }

    #[test]
    fn a_requested_ending_publishes_exit_only_at_complete_unit_end() {
        let reg = TerminalRegistry::new();
        let pid = reg.create_in_unit(&bash("sleep 30"), &env(), "T3".into(), "S3".into(), "codex", None, None, None, None, placement(None)).unwrap();
        let seen = attach_collector(&reg, "T3");
        let rev = reg.revision();
        assert!(reg.mark_ending("T3", UnitEnding::Requested));
        assert!(!reg.mark_ending("T3", UnitEnding::AgentExited { exit_code: 1 }), "first ending wins");
        unsafe { libc::kill(pid as i32, libc::SIGKILL) }; // the unit's kill, simulated on our own child
        std::thread::sleep(Duration::from_millis(300));
        assert!(exits(&seen).is_empty(), "screen death is not Gone");
        assert!(reg.complete_unit_end("T3", UnitEnding::Requested));
        assert_eq!(exits(&seen), vec![0]);
        assert!(!reg.is_running("T3") && reg.revision() > rev);
    }

    #[test]
    fn an_agent_exit_ending_publishes_a_natural_exit_and_keeps_the_row() {
        let reg = TerminalRegistry::new();
        reg.create_in_unit(&bash("sleep 0.2; exit 7"), &env(), "T4".into(), "S4".into(), "claude", None, None, None, None, placement(None)).unwrap();
        let seen = attach_collector(&reg, "T4");
        reg.mark_ending("T4", UnitEnding::AgentExited { exit_code: 7 });
        std::thread::sleep(Duration::from_millis(500));
        assert!(reg.complete_unit_end("T4", UnitEnding::AgentExited { exit_code: 7 }));
        assert_eq!(exits(&seen), vec![7]);
        assert!(reg.inventory().iter().any(|t| t.terminal_id == "T4"), "natural-exit rows are retained");
    }

    #[test]
    fn replace_screen_keeps_the_terminal_id_and_its_subscribers() {
        let reg = TerminalRegistry::new();
        let got: Arc<Mutex<Vec<UnitScreenExit>>> = Arc::default();
        let g = got.clone();
        reg.set_unit_screen_exit_hook(Arc::new(move |e| g.lock().unwrap().push(e)));
        reg.create_in_unit(&bash("echo FIRST; sleep 0.2; exit 9"), &env(), "T5".into(), "S5".into(), "codex", None, Some("crq-5"), None, None,
            UnitPlacement { main_is_screen: false, ..placement(None) }).unwrap();
        let seen = attach_collector(&reg, "T5");
        wait("first screen exits", || !got.lock().unwrap().is_empty());
        let pid2 = reg.replace_screen("T5", &bash("echo SECOND; sleep 30"), &env(), UnitPlacement { main_is_screen: false, ..placement(None) }).unwrap();
        wait("second screen output", || output_text(&seen).contains("SECOND"));
        assert!(exits(&seen).is_empty(), "a screen restart is invisible to subscribers");
        unsafe { libc::kill(pid2 as i32, libc::SIGKILL) };
        wait("second exit hook", || got.lock().unwrap().len() == 2);
        assert_eq!(got.lock().unwrap()[1].screen_generation, 1);
    }
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-terminal unit_row_tests --locked`

Expected: FAIL to compile — `no method create_in_unit/mark_ending/complete_unit_end/replace_screen/set_unit_screen_exit_hook`, `cannot find type UnitPlacement/UnitEnding/UnitScreenExit`.

- [ ] **Step 3: Add the minimal production implementation**

Types (top of `registry.rs`, exported from `lib.rs`):

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitPlacement {
    pub unit_id: String,
    pub wrapper: Option<Vec<String>>,
    pub env: Vec<(String, String)>,
    /// true when the screen process IS the agent main process (Claude Code,
    /// OpenCode, Gemini, Kimi, Amplifier…); false for Codex (main = sidecar).
    pub main_is_screen: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitEnding {
    /// A stop someone asked for (Shift-X, kill command, cleanup, respawn, shutdown): silent.
    Requested,
    /// The agent ended on its own: published as a natural exit (crash path).
    AgentExited { exit_code: i64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitScreenExit {
    pub terminal_id: String,
    pub unit_id: String,
    pub exit_code: i64,
    pub screen_generation: u32,
}
```

`create_in_unit`:

```rust
    #[allow(clippy::too_many_arguments)]
    pub fn create_in_unit(
        &self,
        spec: &SpawnSpec,
        env: &BTreeMap<String, String>,
        terminal_id: String,
        stream_id: String,
        mode: &str,
        resume_session_id: Option<&str>,
        create_request_id: Option<&str>,
        ring_max_bytes: Option<i64>,
        on_exit: Option<crate::pty::ExitHook>,
        placement: UnitPlacement,
    ) -> io::Result<u32> {
        let resolved = freshell_platform::path::resolve_program_via_path(&spec.program, env.get("PATH").map(String::as_str))
            .map_err(|_| io::Error::from(io::ErrorKind::NotFound))?;
        let (wrapped, child_env) = wrap_for_unit(spec, &resolved, env, &placement);
        self.create_inner(&wrapped, &child_env, terminal_id, stream_id, mode, resume_session_id, create_request_id, ring_max_bytes, on_exit,
            Some((placement, spec.clone(), env.clone())))
    }
```

with

```rust
fn wrap_for_unit(spec: &SpawnSpec, resolved: &str, env: &BTreeMap<String, String>, placement: &UnitPlacement) -> (SpawnSpec, BTreeMap<String, String>) {
    let mut wrapped = spec.clone();
    if let Some(w) = &placement.wrapper {
        wrapped.program = w[0].clone();
        wrapped.args = w[1..].iter().cloned().chain(std::iter::once(resolved.to_string())).chain(spec.args.iter().cloned()).collect();
    } else {
        wrapped.program = resolved.to_string();
    }
    let mut child_env = env.clone();
    for (k, v) in &placement.env {
        child_env.insert(k.clone(), v.clone());
    }
    (wrapped, child_env)
}
```

`create_inner` is the old `create` body plus: when `unit` is `Some((placement, original_spec, original_env))`, the new `TerminalShared` gets `unit_id: Some(placement.unit_id)`, `main_is_screen: placement.main_is_screen`, `respawn_spec: Some((original_spec, original_env))`, `screen_generation: 0`, `ending: None`; it returns `pty.pid().unwrap_or(0)` (the existing cached `PtyTerminal` pid accessor; add `pub fn pid(&self) -> Option<u32>` if absent).

`finish_pty_exit` — after the `mark_naturally_exited` block and before `if s.status == Exited`:

```rust
        {
            let s = shared.lock().expect("terminal lock");
            if let Some(unit_id) = s.unit_id.clone() {
                let ending = s.ending;
                let generation = s.screen_generation;
                drop(s);
                if ending.is_none() {
                    if let Some(hook) = self.unit_screen_exit_hook.read().expect("hook lock").clone() {
                        hook(UnitScreenExit { terminal_id: terminal_id.to_string(), unit_id, exit_code, screen_generation: generation });
                    }
                }
                return false; // the unit lifecycle decides; nothing is published here
            }
        }
```

`mark_ending`, `ending`, `unit_id_for`, `terminal_for_create_request`, `set_unit_screen_exit_hook` are straightforward lock-and-read/write helpers over `inner.terminals`.

`complete_unit_end`:

```rust
    pub fn complete_unit_end(&self, terminal_id: &str, ending: UnitEnding) -> bool {
        match ending {
            UnitEnding::Requested => {
                let handle = {
                    let mut inner = self.inner.lock().expect("registry lock");
                    let h = inner.terminals.remove(terminal_id);
                    if h.is_some() {
                        inner.revision += 1;
                    }
                    h
                };
                let Some(mut handle) = handle else { return false };
                self.session_ref_bindings.lock().expect("session-ref bindings lock").retain(|_, bound| bound != terminal_id);
                {
                    let mut s = handle.shared.lock().expect("terminal lock");
                    s.status = TerminalRunStatus::Exited;
                    s.exit_code = Some(0);
                    let exit = ServerMessage::TerminalExit(TerminalExit { exit_code: 0, terminal_id: terminal_id.to_string() });
                    for sub in s.subscribers.values() {
                        (sub.sink)(exit.clone());
                    }
                    s.subscribers.clear();
                }
                if let Some(mut pty) = handle.pty.take() {
                    pty.mark_naturally_exited(); // never signal: the unit already did
                    drop(pty);                   // joins the (finished) reader/waiter threads
                }
                tracing::info!(terminal_id = %terminal_id, by = "unit", "terminal.killed");
                self.release_session_ref_ownership(terminal_id, "unit");
                self.notify_activity(ActivityEvent::Exit { terminal_id: terminal_id.to_string(), at: now_ms(), spontaneous: false });
                true
            }
            UnitEnding::AgentExited { exit_code } => {
                let shared = {
                    let mut inner = self.inner.lock().expect("registry lock");
                    match inner.terminals.get_mut(terminal_id) {
                        Some(h) => {
                            if let Some(pty) = h.pty.as_mut() {
                                pty.mark_naturally_exited();
                            }
                            Arc::clone(&h.shared)
                        }
                        None => return false,
                    }
                };
                self.publish_natural_exit(terminal_id, &shared, exit_code);
                true
            }
        }
    }
```

`replace_screen`:

```rust
    pub fn replace_screen(&self, terminal_id: &str, spec: &SpawnSpec, env: &BTreeMap<String, String>, placement: UnitPlacement) -> io::Result<u32> {
        let (shared, create_request_id, mode) = {
            let inner = self.inner.lock().expect("registry lock");
            let h = inner.terminals.get(terminal_id).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
            let s = h.shared.lock().expect("terminal lock");
            (Arc::clone(&h.shared), s.create_request_id.clone(), s.mode.clone())
        };
        if let Some(key) = &create_request_id {
            if self.respawn_exhausted(key) {
                return Err(io::Error::other("respawn cap"));
            }
            *self.inner.lock().expect("registry lock").respawn_generations.entry(key.clone()).or_insert(0) += 1;
        }
        let resolved = freshell_platform::path::resolve_program_via_path(&spec.program, env.get("PATH").map(String::as_str))
            .map_err(|_| io::Error::from(io::ErrorKind::NotFound))?;
        let (wrapped, child_env) = wrap_for_unit(spec, &resolved, env, &placement);
        let (stream_id, ring) = {
            let s = shared.lock().expect("terminal lock");
            (s.stream_id.clone(), None)
        };
        let sink = self.build_output_sink(&shared, terminal_id, &mode);
        let on_exit = self.unit_row_exit_hook(terminal_id);
        let pty = PtyTerminal::spawn_with_sink(&wrapped, &child_env, terminal_id.to_string(), stream_id, ring, Some(sink), Some(on_exit))?;
        let pid = pty.pid().unwrap_or(0);
        let old = {
            let mut inner = self.inner.lock().expect("registry lock");
            let h = inner.terminals.get_mut(terminal_id).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
            let mut s = h.shared.lock().expect("terminal lock");
            s.screen_generation += 1;
            drop(s);
            h.pty.replace(pty)
        };
        drop(old); // the old screen is already dead; this joins its threads
        Ok(pid)
    }
```

(`respawn_exhausted` (`:2008`) and `respawn_generation_cap` are the existing reconciliation §7.5 cap; `unit_row_exit_hook(tid)` builds the same `ExitHook` the create path installs — a closure calling `finish_pty_exit(tid, code)` — so later screen exits reach the unit hook with the bumped generation.)

`kill_all` (`:3993`): inside the loop, before each `kill_internal`, call `self.mark_ending(&id, UnitEnding::Requested)` (a no-op for non-unit rows).

`commit_session_ref_ownership` (`:5511`): set `unit_id: shared.unit_id.clone()` on the `OwnerIdentity` it commits.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-terminal unit_row_tests --locked`

Expected: PASS (5 tests).

- [ ] **Step 5: Refactor while green**

Make `kill_internal` and `complete_unit_end(Requested)` share one private `fn remove_row_and_notify_exit(&self, terminal_id, by) -> Option<TerminalHandle>` (row removal, binding prune, `terminal.exit{0}` fan-out, subscriber clear); `kill_internal` then does its `pty.kill()` and `complete_unit_end` its `mark_naturally_exited`. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every registry test (shared kill/exit code), the ws crate (uses `create`, `finish_pty_exit`), the test-clock routing test.

Run: `cargo test -p freshell-terminal --locked && cargo test -p freshell-ws --test auto_resume_events --test auto_resume_respawn --test pane_ledger_triggers --test terminal_lifetime_claim --test unknown_terminal_reply --locked`

Expected: PASS (non-unit rows behave exactly as before).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-terminal
git commit -m "feat(terminal): unit rows with stop intent, Gone-time exit publishing, and in-place screen replacement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The pane-unit lifecycle core, and every Codex terminal pane created inside its unit

**Files:**
- Create: `crates/freshell-containment/src/directory.rs` (+ `pub mod directory;` and re-exports `UnitDirectory, UnitEntry` in `lib.rs`)
- Test: `crates/freshell-containment/tests/directory.rs`
- Create: `crates/freshell-ws/src/unit_lifecycle.rs` (+ `pub mod unit_lifecycle;` in `crates/freshell-ws/src/lib.rs`)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` `:116` gains ONE field `pub units: crate::unit_lifecycle::UnitServices`; `UnitServices { pub directory: Arc<UnitDirectory>, pub containment: Containment }` derives `Clone`, implements `Default` (`UnitDirectory::new()` and `global_containment().unwrap_or_else(|| Containment::select(Default::default()))`) and `Deref<Target = UnitDirectory>`, so `state.units.by_terminal(..)` reads naturally; each of the 74 `WsState { .. }` literals (compiler-guided, the `host_stats` precedent at `host_stats_collector.rs:66`) gains `units: Default::default(),`; also add `#[cfg(test)] pub(crate) fn test_ws_state() -> WsState` to `lib.rs`, a copy of `codex_proxy_route.rs::test_state` (`:261`) with an enabled `RuntimeOwnershipRegistry`, for module tests)
- Modify: `crates/freshell-ws/src/terminal.rs`:
  - `plan_codex_managed_launch` (`:2902-2950`) takes `unit_seed: Option<UnitSeed>` and puts it in the `CodexLaunchPlanInput`;
  - the interactive Codex create (`:6158` plan, `:6489` `registry.create`) and the restore-class Codex create (`prepare_launch` `:4239-4335`, then the same spawn) run inside a `StartScope` (below) and spawn the TUI with `registry.create_in_unit(.., UnitPlacement { main_is_screen: false, .. })`;
  - `respawn_agent_terminal` (`:7260`, auto-resume) does the same for Codex;
  - `build_pty_exit_hook` (`:3209`): skip `notify_terminal_exit` for unit rows (`deps.registry.unit_id_for(&terminal_id).is_some()`), the unit lifecycle owns them;
  - `after_terminal_removed` (`:10120`) becomes `pub(crate)`.
- Modify: `crates/freshell-ws/src/identity_ownership.rs` (`coordinator_commit_identity` `:308`: the committed `OwnerIdentity` carries `unit_id: state.registry.unit_id_for(&terminal_id)`)
- Modify: `crates/freshell-freshagent/src/lib.rs` (`FreshAgentState` `:1970-2180` gains `units: Arc<UnitDirectory>` + `containment: Containment` with `with_units(..)`), `crates/freshell-freshagent/src/terminal_tabs.rs` (REST Codex create `:3040` and its spawn `:2920`: same start-scope flow through `freshell_containment::directory`, with start-cancellation checks after the plan and after the spawn)
- Modify: `crates/freshell-server/src/main.rs` (after settings load, before any lane is built: `Containment::select(SelectOptions { shim: Some(ShimCommand { exe: std::env::current_exe()?, leading_args: vec!["__unit-exec".into()] }) })` → `set_global_containment`; one `UnitServices` (its `directory` Arc shared) passed to `WsState` and, as `units`/`containment`, to `FreshAgentState`; `registry.set_unit_screen_exit_hook(freshell_ws::unit_lifecycle::screen_exit_hook(ws_state.clone(), tokio::runtime::Handle::current()))`)
- Modify: `crates/freshell-ws/Cargo.toml`, `crates/freshell-freshagent/Cargo.toml` (`freshell-containment` dependency)
- Create: `crates/freshell-ws/tests/support/unit_harness.rs`, `crates/freshell-ws/tests/support/codex-dispatch.sh` (written at runtime by the harness)
- Test: `crates/freshell-ws/tests/unit_codex_create.rs`

**Interfaces:**
- Consumes: Tasks 4–5 (`Containment`, `AgentUnit`, `StopRequest`…), 8 (`begin_unit_stop`, `commit_unit_stop`), 10 (`UnitSeed`, `mark_stopping`, `finish_unit`), 11 (`create_in_unit`, `mark_ending`, `complete_unit_end`, `UnitScreenExit`).
- Produces:
  ```rust
  // freshell-containment/src/directory.rs (in addition to the Shared-interfaces list)
  impl UnitDirectory {
      pub fn replace_unit(&self, old: &UnitId, new_unit: AgentUnit) -> Option<AgentUnit>; // re-keys a starting slot (reattach)
      pub fn mark_start_settled(&self, unit_id: &UnitId);
      pub fn start_settled(&self, unit_id: &UnitId) -> BoxFuture<'static, ()>;          // ready when bound, settled, or unknown
  }
  // freshell-ws/src/unit_lifecycle.rs
  #[derive(Debug, Clone)]
  pub struct UnitStopCommand { pub mode: StopMode, pub reason: StopReason, pub initiator: String,
                               pub operation_id: String, pub record_stopped_pane: bool }
  impl UnitStopCommand { pub fn ending(&self) -> UnitEnding; }   // AgentExited{code} for StopReason::AgentExited, else Requested
  pub fn stop_terminal_unit(state: &WsState, entry: &UnitEntry, cmd: UnitStopCommand) -> StopHandle;
  pub fn screen_exit_hook(state: WsState, rt: tokio::runtime::Handle) -> Arc<dyn Fn(UnitScreenExit) + Send + Sync>;
  pub struct StartScope { /* WsState, UnitEntry, committed: bool */ }
  impl StartScope {
      pub fn begin(state: &WsState, provider: &str, mode: &str, create_request_id: &str, terminal_id: &str, session_id: Option<&str>) -> std::io::Result<StartScope>;
      pub fn unit(&self) -> AgentUnit;
      pub fn adopt_launch_unit(&mut self, launch_unit: Option<AgentUnit>);  // reattach: swap in the reopened unit, stop the unused empty one
      pub fn cancelled(&self) -> bool;
      pub async fn wait_cancelled(&self);
      pub fn bind(&mut self, terminal_id: &str, screen_pid: u32);           // ProcWatch(screen) + label + directory bind
      pub fn commit(self);
      pub async fn abandon(self);                                          // stop the unit (Force, StartCancelled), wait Gone, mark settled
  }
  // Drop without commit/abandon spawns abandon (error paths).
  ```
  Publishing contract of `stop_terminal_unit` (the only place it happens for unit rows): synchronously `begin_unit_stop` + `mark_ending` + `cancel_start`; `before_signal` = `CodexTerminalLaunchManager::mark_stopping` (record → Stopping, persisted); `on_gone`, in this order: `complete_unit_end` (row + `terminal.exit` to subscribers) on `spawn_blocking`, `after_terminal_removed` for `Requested` (identity/metadata retire + `terminals.changed`), `CodexTerminalLaunchManager::finish_unit` (record removed), `commit_unit_stop` + one `broadcast_vacant_frame` per key, for `AgentExited` the `CrashEvent` to `auto_resume_tx` (built by the extracted `crash_event_for(state, terminal_id, exit_code)` from `build_pty_exit_hook`), then `units.remove`. A second call joins (a `Force` second call escalates).
  Screen-exit hook (this task's minimal version; Task 17 extends it): an unrequested screen exit ends the whole unit — `stop_terminal_unit(Force, AgentExited{exit_code})`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-containment/tests/directory.rs`:

```rust
use std::time::Duration;

use freshell_containment::*;

fn unit() -> AgentUnit {
    Containment::tag_backend(SelectOptions::default()).create_unit(UnitId::mint(), UnitLabel::default()).unwrap()
}

#[tokio::test]
async fn starting_units_are_found_by_create_request_and_cancel_only_before_binding() {
    let dir = UnitDirectory::new();
    let u = unit();
    dir.register(UnitEntry { unit: u.clone(), provider: "codex".into(), mode: "codex".into(), create_request_id: Some("crq".into()), terminal_id: None });
    assert_eq!(dir.by_create_request("crq").unwrap().unit.id(), u.id());
    let waiter = tokio::spawn({ let dir = dir.clone(); let id = u.id().clone(); async move { dir.wait_start_cancelled(&id).await } });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiter.is_finished());
    assert!(dir.cancel_start(u.id()));
    tokio::time::timeout(Duration::from_millis(200), waiter).await.expect("woken").unwrap();
    assert!(dir.start_cancelled(u.id()));
    let settled = dir.start_settled(u.id());
    dir.mark_start_settled(u.id());
    tokio::time::timeout(Duration::from_millis(200), settled).await.expect("settled");
}

#[tokio::test]
async fn bound_units_are_found_by_terminal_and_cannot_be_start_cancelled() {
    let dir = UnitDirectory::new();
    let u = unit();
    dir.register(UnitEntry { unit: u.clone(), provider: "codex".into(), mode: "codex".into(), create_request_id: Some("crq".into()), terminal_id: None });
    dir.bind_terminal(u.id(), "T1");
    assert_eq!(dir.by_terminal("T1").unwrap().unit.id(), u.id());
    assert!(!dir.cancel_start(u.id()), "a bound unit is stopped, not start-cancelled");
    tokio::time::timeout(Duration::from_millis(50), dir.start_settled(u.id())).await.expect("bound = settled");
    let other = unit();
    let old = dir.replace_unit(u.id(), other.clone()).unwrap();
    assert_eq!(old.id(), u.id());
    assert_eq!(dir.by_terminal("T1").unwrap().unit.id(), other.id());
    assert!(dir.remove(other.id()).is_some());
    assert!(dir.by_terminal("T1").is_none());
}
```

`crates/freshell-ws/tests/support/unit_harness.rs` (shared by every ws unit test file via `#[path = "support/unit_harness.rs"] mod unit_harness;`):

```rust
//! A WsState-backed server with CODEX_CMD pointing at the realistic fake
//! (launcher + native for `app-server`, the TUI fake otherwise), isolated
//! HOME/CODEX_HOME/FRESHELL_HOME, and helpers to read the fake's manifests.
//! Built from `codex_managed_launch_e2e.rs::spawn_server` (:177-258).
#![allow(dead_code)]
#[path = "../../../freshell-codex/tests/support/fake_codex.rs"]
pub mod fake_codex;

use std::path::PathBuf;
use std::time::Duration;

/// Hub = the real auto-resume hub runs (spawn_server_with_specs_and_auto_resume_hub);
/// Capture = crash events are captured on `crash_rx` instead (spawn_server_with_specs_and_auto_resume_rx).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AutoResumeMode { Hub, Capture }

pub struct HarnessOpts {
    pub behavior: serde_json::Value,
    pub containment: Option<freshell_containment::Containment>,
    pub auto_resume: AutoResumeMode,
}

impl Default for HarnessOpts {
    fn default() -> Self {
        Self { behavior: serde_json::json!({}), containment: None, auto_resume: AutoResumeMode::Hub }
    }
}

pub struct UnitHarness {
    pub url: String,
    pub state: freshell_ws::WsState,
    pub home: tempfile::TempDir,
    pub codex_home: PathBuf,
    pub manifests: PathBuf,
    pub crash_rx: Option<tokio::sync::mpsc::UnboundedReceiver<freshell_ws::auto_resume::CrashEvent>>,
    _env: tokio::sync::MutexGuard<'static, ()>,
}

static HARNESS_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn write_dispatcher(dir: &std::path::Path) -> PathBuf {
    let path = dir.join("codex");
    let script = format!(
        "#!/bin/bash\nif [[ \" $* \" == *\" app-server \"* ]]; then exec node {} \"$@\"; else exec node {} \"$@\"; fi\n",
        fake_codex::fixture_path("fake-codex-launcher.mjs").display(),
        fake_codex::fixture_path("fake-codex-tui.mjs").display(),
    );
    std::fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

impl UnitHarness {
    /// Holds HARNESS_ENV for the test's lifetime (process env is shared).
    pub async fn start(opts: HarnessOpts) -> Self;          // body: copy of spawn_server() plus the env below
    pub async fn connect(&self) -> TestWs;                   // hello/ready handshake (paneReconcileV1 + terminalLifetimeClaimV1)
    pub async fn create_codex(&self, ws: &mut TestWs, request_id: &str, resume: Option<&str>) -> String; // returns terminalId
    pub async fn send(&self, ws: &mut TestWs, frame: serde_json::Value);
    pub async fn next_matching(&self, ws: &mut TestWs, limit: Duration, pred: impl Fn(&serde_json::Value) -> bool) -> Option<serde_json::Value>;
    pub fn unit_for(&self, terminal_id: &str) -> freshell_containment::AgentUnit;   // state.units.by_terminal(..).unwrap().unit
    pub fn native_pid(&self, terminal_id: &str) -> u32;     // unit.main().pid()
    pub fn native_manifest(&self, terminal_id: &str) -> fake_codex::NativeManifest; // manifests/native-<pid>.json
    pub fn lock(&self, thread_id: &str) -> PathBuf;          // fake_codex::thread_lock_path(codex_home, id)
}
```

Method bodies are copied, not invented: `start` = `codex_managed_launch_e2e.rs::spawn_server` (`:177-258`) with the `WsState` additions below (and the auto-resume wiring of `common/mod.rs::spawn_server_with_specs_and_auto_resume_hub` (`:743`) or `…_auto_resume_rx` (`:648`) per `opts.auto_resume`); `connect` = that file's `connect_and_handshake` (`:258`) with `paneReconcileV1` and `terminalLifetimeClaimV1` in the hello capabilities; `create_codex` = `create_codex_terminal` / `create_codex_terminal_resume` (`:286`, `:332`) returning the `terminal.created` id; `send`/`next_matching` = thin wrappers over the `TestWs` sink/stream with a deadline; `unit_for`/`native_pid`/`native_manifest`/`lock` read `state.units`, the unit's `main()` pid and `<manifests>/native-<pid>.json`.

`start` sets, under `HARNESS_ENV`: `CODEX_CMD=<write_dispatcher(home)>`, `CODEX_HOME`, `HOME`, `FRESHELL_HOME` (all in the tempdir), `FAKE_CODEX_APP_SERVER_BEHAVIOR=<opts.behavior>`, `FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES=1`, `FAKE_CODEX_MANIFEST_DIR=<home>/manifests`, `FAKE_CODEX_RECORD_DIR=<home>/.freshell/rust-codex-sidecars`; installs a `CodexSidecarStore::new_locked(Some(<that dir>))` as the global store when not yet installed; builds `WsState` with `units: UnitServices { directory: UnitDirectory::new(), containment: opts.containment.unwrap_or_else(|| Containment::select(Default::default())) }`, and installs `registry.set_unit_screen_exit_hook(unit_lifecycle::screen_exit_hook(state.clone(), Handle::current()))`.

`crates/freshell-ws/tests/unit_codex_create.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, HarnessOpts, UnitHarness};

#[tokio::test(flavor = "multi_thread")]
async fn a_codex_pane_is_one_unit_holding_the_tui_and_the_sidecar() {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"threadStartThreadId": "t-one", "spawnHelperProcess": true}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-one", None).await;
    let unit = h.unit_for(&tid);
    let manifest = h.native_manifest(&tid);
    let members: Vec<u32> = unit.members().unwrap().iter().map(|m| m.pid).collect();
    assert!(members.contains(&unit.screen().unwrap().pid()), "the TUI is a member");
    assert!(members.contains(&manifest.pid), "the native app-server is a member");
    assert!(members.contains(&manifest.children.helper.unwrap()), "its own-process-group helper is a member");
    assert_ne!(unit.screen().unwrap().pid(), manifest.pid, "screen and main differ for Codex");
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_the_codex_tui_ends_the_whole_unit_before_anything_is_published() {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"threadStartThreadId": "t-quit"}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-quit", None).await;
    let native = h.native_pid(&tid);
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY"))).await.expect("tui ready");
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"})).await;
    let exit = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.exit" && f["terminalId"] == tid).await.expect("terminal.exit");
    assert!(!fake_codex::pid_alive(native), "terminal.exit is published only after the app-server is gone");
    assert_eq!(exit["exitCode"], 0);
    assert!(h.state.units.by_terminal(&tid).is_none(), "the unit left the directory at Gone");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-containment --test directory --locked; cargo test -p freshell-ws --test unit_codex_create --locked`

Expected: FAIL to compile — `freshell_containment::UnitDirectory` / `UnitEntry` do not exist; `WsState` has no field `units`; `freshell_ws::unit_lifecycle` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-containment/src/directory.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{watch, Notify};

use crate::unit::AgentUnit;
use crate::{BoxFuture, UnitId};

#[derive(Clone)]
pub struct UnitEntry {
    pub unit: AgentUnit,
    pub provider: String,
    pub mode: String,
    pub create_request_id: Option<String>,
    pub terminal_id: Option<String>,
}

struct Slot {
    entry: UnitEntry,
    cancelled: bool,
    cancel: Arc<Notify>,
    settled: watch::Sender<bool>,
}

/// Which unit is which pane: unit id <-> terminal id / create-request id,
/// plus start cancellation. Holds handles only; lifecycle STATE lives in the
/// owner registry.
#[derive(Default)]
pub struct UnitDirectory {
    slots: Mutex<HashMap<UnitId, Slot>>,
    on_bind: Mutex<Option<Arc<dyn Fn(UnitEntry) + Send + Sync>>>,
}

impl UnitDirectory {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Fired whenever a unit is bound to its terminal (its main process is
    /// known by then): the WS side starts the unit's exit watchers here, for
    /// units created by any lane (WS, REST, auto-resume).
    pub fn set_on_bind(&self, hook: Arc<dyn Fn(UnitEntry) + Send + Sync>) {
        *self.on_bind.lock().unwrap() = Some(hook);
    }

    pub fn register(&self, entry: UnitEntry) {
        let (settled, _) = watch::channel(entry.terminal_id.is_some());
        self.slots.lock().unwrap().insert(
            entry.unit.id().clone(),
            Slot { entry, cancelled: false, cancel: Arc::new(Notify::new()), settled },
        );
    }

    pub fn replace_unit(&self, old: &UnitId, new_unit: AgentUnit) -> Option<AgentUnit> {
        let mut slots = self.slots.lock().unwrap();
        let mut slot = slots.remove(old)?;
        let previous = std::mem::replace(&mut slot.entry.unit, new_unit);
        slots.insert(slot.entry.unit.id().clone(), slot);
        Some(previous)
    }

    pub fn bind_terminal(&self, unit_id: &UnitId, terminal_id: &str) {
        let bound = {
            let mut slots = self.slots.lock().unwrap();
            slots.get_mut(unit_id).map(|slot| {
                slot.entry.terminal_id = Some(terminal_id.to_string());
                let _ = slot.settled.send(true);
                slot.entry.clone()
            })
        };
        let hook = self.on_bind.lock().unwrap().clone();
        if let (Some(entry), Some(hook)) = (bound, hook) {
            hook(entry);
        }
    }

    pub fn get(&self, unit_id: &UnitId) -> Option<UnitEntry> {
        self.slots.lock().unwrap().get(unit_id).map(|s| s.entry.clone())
    }

    pub fn by_terminal(&self, terminal_id: &str) -> Option<UnitEntry> {
        self.slots.lock().unwrap().values().find(|s| s.entry.terminal_id.as_deref() == Some(terminal_id)).map(|s| s.entry.clone())
    }

    pub fn by_create_request(&self, create_request_id: &str) -> Option<UnitEntry> {
        self.slots.lock().unwrap().values().find(|s| s.entry.create_request_id.as_deref() == Some(create_request_id)).map(|s| s.entry.clone())
    }

    pub fn remove(&self, unit_id: &UnitId) -> Option<UnitEntry> {
        let slot = self.slots.lock().unwrap().remove(unit_id)?;
        let _ = slot.settled.send(true);
        Some(slot.entry)
    }

    pub fn cancel_start(&self, unit_id: &UnitId) -> bool {
        let mut slots = self.slots.lock().unwrap();
        let Some(slot) = slots.get_mut(unit_id) else { return false };
        if slot.entry.terminal_id.is_some() || *slot.settled.borrow() {
            return false;
        }
        slot.cancelled = true;
        slot.cancel.notify_waiters();
        true
    }

    pub fn start_cancelled(&self, unit_id: &UnitId) -> bool {
        self.slots.lock().unwrap().get(unit_id).is_some_and(|s| s.cancelled)
    }

    pub async fn wait_start_cancelled(&self, unit_id: &UnitId) {
        loop {
            let notify = match self.slots.lock().unwrap().get(unit_id) {
                Some(s) if s.cancelled => return,
                Some(s) => s.cancel.clone(),
                None => return std::future::pending().await,
            };
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.start_cancelled(unit_id) {
                return;
            }
            notified.await;
        }
    }

    pub fn mark_start_settled(&self, unit_id: &UnitId) {
        if let Some(slot) = self.slots.lock().unwrap().get(unit_id) {
            let _ = slot.settled.send(true);
        }
    }

    pub fn start_settled(&self, unit_id: &UnitId) -> BoxFuture<'static, ()> {
        let rx = self.slots.lock().unwrap().get(unit_id).map(|s| s.settled.subscribe());
        Box::pin(async move {
            let Some(mut rx) = rx else { return };
            while !*rx.borrow() {
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
    }

    pub fn all(&self) -> Vec<UnitEntry> {
        self.slots.lock().unwrap().values().map(|s| s.entry.clone()).collect()
    }
}
```

`crates/freshell-ws/src/unit_lifecycle.rs`:

```rust
//! The pane-unit lifecycle (WebSocket side). Every stop of a coding-agent
//! terminal pane runs through `stop_terminal_unit`, and `terminal.exit`,
//! `terminals.changed` and Vacant are published only at Gone.
use std::sync::Arc;

use freshell_codex::launch_lifecycle::CodexTerminalLaunchManager;
use freshell_containment::{
    AgentUnit, BoxFuture, MemberRole, ProcWatch, StopHandle, StopMode, StopReason, StopReport, StopRequest, UnitEntry, UnitId, UnitLabel,
};
use freshell_terminal::{UnitEnding, UnitScreenExit};

use crate::WsState;

/// The unit services every lane shares: which unit is which pane, and the
/// process-wide containment backend.
#[derive(Clone)]
pub struct UnitServices {
    pub directory: Arc<freshell_containment::UnitDirectory>,
    pub containment: freshell_containment::Containment,
}

impl Default for UnitServices {
    fn default() -> Self {
        Self {
            directory: freshell_containment::UnitDirectory::new(),
            containment: freshell_containment::global_containment()
                .unwrap_or_else(|| freshell_containment::Containment::select(Default::default())),
        }
    }
}

impl std::ops::Deref for UnitServices {
    type Target = freshell_containment::UnitDirectory;
    fn deref(&self) -> &Self::Target {
        &self.directory
    }
}

#[derive(Debug, Clone)]
pub struct UnitStopCommand {
    pub mode: StopMode,
    pub reason: StopReason,
    pub initiator: String,
    pub operation_id: String,
    pub record_stopped_pane: bool,
}

impl UnitStopCommand {
    pub fn ending(&self) -> UnitEnding {
        match &self.reason {
            StopReason::AgentExited { exit_code } => UnitEnding::AgentExited { exit_code: exit_code.unwrap_or(1) },
            _ => UnitEnding::Requested,
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn stop_terminal_unit(state: &WsState, entry: &UnitEntry, cmd: UnitStopCommand) -> StopHandle {
    let unit = entry.unit.clone();
    if let Some(existing) = unit.stop_in_flight() {
        if cmd.mode == StopMode::Force {
            return unit.stop(StopRequest::new(StopMode::Force, cmd.reason.clone(), cmd.initiator.clone()));
        }
        return existing;
    }
    let unit_id = unit.id().to_string();
    if let Some(ownership) = state.ownership.as_ref() {
        ownership.begin_unit_stop(&unit_id, &cmd.operation_id, &cmd.initiator, now_ms());
    }
    let ending = cmd.ending();
    if let Some(tid) = entry.terminal_id.as_deref() {
        state.registry.mark_ending(tid, ending);
    }
    state.units.cancel_start(unit.id());
    let before: BoxFuture<'static, ()> = {
        let tid = entry.terminal_id.clone();
        let reason = cmd.reason.as_str().to_string();
        let op = cmd.operation_id.clone();
        Box::pin(async move {
            if let Some(tid) = tid {
                CodexTerminalLaunchManager::global().mark_stopping(&tid, &reason, &op).await;
            }
        })
    };
    let on_gone = {
        let state = state.clone();
        let entry = entry.clone();
        let cmd = cmd.clone();
        Box::new(move |report: StopReport| -> BoxFuture<'static, ()> {
            Box::pin(async move { publish_gone(&state, &entry, &cmd, ending, &report).await })
        })
    };
    unit.stop(
        StopRequest::new(cmd.mode, cmd.reason.clone(), cmd.initiator.clone())
            .operation(cmd.operation_id.clone())
            .before_signal(before)
            .on_gone(on_gone),
    )
}

async fn publish_gone(state: &WsState, entry: &UnitEntry, cmd: &UnitStopCommand, ending: UnitEnding, _report: &StopReport) {
    let crash = match (ending, entry.terminal_id.as_deref()) {
        (UnitEnding::AgentExited { exit_code }, Some(tid)) => crate::terminal::crash_event_for(state, tid, exit_code),
        _ => None,
    };
    if let Some(tid) = entry.terminal_id.clone() {
        let registry = state.registry.clone();
        let t = tid.clone();
        let _ = tokio::task::spawn_blocking(move || registry.complete_unit_end(&t, ending)).await;
        if ending == UnitEnding::Requested {
            crate::terminal::after_terminal_removed(state, &tid);
        }
        CodexTerminalLaunchManager::global().finish_unit(&tid).await;
    }
    if let Some(ownership) = state.ownership.as_ref() {
        for k in ownership.commit_unit_stop(entry.unit.id().as_str()) {
            crate::identity_ownership::broadcast_vacant_frame(state, &k.key.provider, &k.key.session_id, &cmd.operation_id, ownership.boot_epoch(), k.generation);
        }
    }
    if let Some(event) = crash {
        let _ = state.auto_resume_tx.send(event);
    }
    state.units.remove(entry.unit.id());
}

/// The registry's screen-exit hook runs on the PTY reader thread: hand the
/// decision to the runtime. This task: an unrequested screen exit ends the
/// whole unit (Task 17 adds screen-only restarts and main-process deaths).
pub fn screen_exit_hook(state: WsState, rt: tokio::runtime::Handle) -> Arc<dyn Fn(UnitScreenExit) + Send + Sync> {
    Arc::new(move |exit: UnitScreenExit| {
        let state = state.clone();
        rt.spawn(async move {
            if let Some(entry) = state.units.by_terminal(&exit.terminal_id) {
                stop_terminal_unit(
                    &state,
                    &entry,
                    UnitStopCommand {
                        mode: StopMode::Force,
                        reason: StopReason::AgentExited { exit_code: Some(exit.exit_code) },
                        initiator: "screen-exit".into(),
                        operation_id: format!("unit-exit-{}", uuid::Uuid::new_v4()),
                        record_stopped_pane: false,
                    },
                );
            }
        });
    })
}

pub struct StartScope {
    state: WsState,
    entry: UnitEntry,
    done: bool,
}

impl StartScope {
    pub fn begin(state: &WsState, provider: &str, mode: &str, create_request_id: &str, terminal_id: &str, session_id: Option<&str>) -> std::io::Result<Self> {
        let label = UnitLabel { provider: provider.into(), session_id: session_id.map(str::to_string), terminal_id: Some(terminal_id.into()) };
        let unit = state.units.containment.create_unit(UnitId::mint(), label)?;
        let entry = UnitEntry { unit, provider: provider.into(), mode: mode.into(), create_request_id: Some(create_request_id.into()), terminal_id: None };
        state.units.register(entry.clone());
        Ok(Self { state: state.clone(), entry, done: false })
    }

    pub fn unit(&self) -> AgentUnit {
        self.entry.unit.clone()
    }

    pub fn adopt_launch_unit(&mut self, launch_unit: Option<AgentUnit>) {
        if let Some(u) = launch_unit.filter(|u| u.id() != self.entry.unit.id()) {
            if let Some(unused) = self.state.units.replace_unit(self.entry.unit.id(), u.clone()) {
                unused.stop(StopRequest::new(StopMode::Force, StopReason::StartCancelled, "reattach-swap"));
            }
            self.entry.unit = u;
        }
    }

    pub fn cancelled(&self) -> bool {
        self.state.units.start_cancelled(self.entry.unit.id())
    }

    pub async fn wait_cancelled(&self) {
        self.state.units.wait_start_cancelled(self.entry.unit.id()).await
    }

    pub fn bind(&mut self, terminal_id: &str, screen_pid: u32) {
        if let Ok(w) = ProcWatch::open(screen_pid) {
            self.entry.unit.set_screen(w);
        }
        let mut label = self.entry.unit.label();
        label.terminal_id = Some(terminal_id.into());
        self.entry.unit.set_label(label);
        self.entry.terminal_id = Some(terminal_id.into());
        self.state.units.bind_terminal(self.entry.unit.id(), terminal_id);
    }

    pub fn commit(mut self) {
        self.done = true;
    }

    pub async fn abandon(mut self) {
        self.done = true;
        let handle = stop_terminal_unit(
            &self.state,
            &self.entry,
            UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::StartCancelled,
                initiator: "start-cancelled".into(),
                operation_id: format!("unit-start-cancel-{}", uuid::Uuid::new_v4()),
                record_stopped_pane: false,
            },
        );
        handle.wait().await;
        self.state.units.mark_start_settled(self.entry.unit.id());
    }
}

impl Drop for StartScope {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let scope = StartScope { state: self.state.clone(), entry: self.entry.clone(), done: false };
        self.done = true;
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(scope.abandon());
        }
    }
}
```

Create-path integration (both WS Codex create flavors and `respawn_agent_terminal`), in this order:
1. Right after the preallocated terminal id exists (`terminal_start_tid_slot`), `let mut scope = unit_lifecycle::StartScope::begin(state, "codex", &mode, &create.request_id, &tid, resume_id.as_deref())?;` (spawn failure → the existing `PTY_SPAWN_FAILED` create error).
2. Plan with `Some(UnitSeed { unit: scope.unit() })`, raced against cancellation:
   ```rust
   let launch = tokio::select! {
       r = plan_codex_managed_launch(state, &create, &setup, Some(UnitSeed { unit: scope.unit() })) => r?,
       _ = scope.wait_cancelled() => { scope.abandon().await; return Ok(()) /* the client already closed the pane */ }
   };
   scope.adopt_launch_unit(launch.unit.clone());
   ```
3. Spawn the TUI with `registry.create_in_unit(&spec, &child_env, tid, stream_id, &mode, resume, Some(&create.request_id), None, on_exit, UnitPlacement { unit_id, wrapper: placement.wrapper, env: placement.env, main_is_screen: false })` where `placement = scope.unit().placement(MemberRole::Screen)?`.
4. `if scope.cancelled() { scope.abandon().await; return Ok(()) }` then `scope.bind(&tid, screen_pid)`, adopt the launch (`manager.adopt(launch, &tid, generation)` as today), `scope.commit()`.
5. The create's `OperationTicket`/`TerminalOwnershipClaim` is declared BEFORE `scope` so it drops AFTER `abandon` finished (Vacant only after Gone).

The REST create (`terminal_tabs.rs:3040` + `:2920`) follows the same five steps against `FreshAgentState.units`/`.containment`, inlined with `freshell_containment::directory` calls (it cannot depend on `freshell-ws`): register the starting entry, seed the plan, `create_in_unit`, check `units.start_cancelled`, bind; on cancellation it stops the unit with `unit.stop(StopRequest::new(StopMode::Force, StopReason::StartCancelled, "rest-start-cancelled"))`, waits, then `mark_start_settled`. Its Gone publishing for later kills comes from the WS side (the kill always goes through `unit_lifecycle`).

`crash_event_for(state, terminal_id, exit_code) -> Option<CrashEvent>` is extracted from the tail of `build_pty_exit_hook` (it reads `probe_create_request_id`, the row's lifetime, mode and `retained_ownership_fence`); `build_pty_exit_hook` keeps calling it for non-unit rows.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-containment --test directory --locked && cargo test -p freshell-ws --test unit_codex_create --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Move the five create-path steps into one helper `async fn spawn_codex_pane_in_unit(state, create, tid, resume, setup) -> Result<Option<SpawnedPane>, CreateError>` shared by the interactive and restore creates and `respawn_agent_terminal`; `None` means "start cancelled". Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Every Codex create path and the exit hook changed; the WS Codex suites, auto-resume suites and the REST tabs tests are impacted.

Run: `cargo test -p freshell-ws --test codex_managed_launch_e2e --test codex_sidecar_reattach_e2e --test codex_fork_rebind --test codex_session_ref_resume --test auto_resume_e2e --test auto_resume_respawn --test auto_resume_events --test restore_spawn_gate --test restore_plan_queue_cap --locked && cargo test -p freshell-freshagent terminal_tabs --locked && cargo test -p freshell-containment --locked`

Expected: PASS (a Codex TUI exit now ends the unit before `terminal.exit` and the crash event; non-Codex panes are unchanged until Task 23).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-containment crates/freshell-ws crates/freshell-freshagent crates/freshell-server/src/main.rs Cargo.lock
git commit -m "feat(ws): pane-unit lifecycle core; Codex panes created inside their unit with Gone-time publishing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Shift-X through the unit — kill by terminal or create-request id, ack only at Gone, joins, start cancellation, the not-found rule

**Files:**
- Modify: `crates/freshell-protocol/src/client_messages.rs` (`TerminalKill` `:626-656`: `terminal_id: Option<String>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`)
- Modify: `shared/ws-protocol.ts` (`TerminalKillSchema` `:706-735`: `terminalId: z.string().min(1).optional()` plus `.refine((m) => m.terminalId !== undefined || m.createRequestId !== undefined, { message: 'terminal.kill needs terminalId or createRequestId' })`; doc comment: "`success:true` means Gone was confirmed — never merely 'not found'")
- Modify: `crates/freshell-ws/src/terminal.rs` (`handle_kill` `:9520-10016`: unit resolution first, then the legacy path for non-unit rows; the legacy path's unknown-terminal success goes through `confirm_gone_for_unknown`)
- Modify: `crates/freshell-ws/src/unit_lifecycle.rs` (`kill_unit`, `confirm_gone_for_unknown`)
- Test: `crates/freshell-ws/tests/unit_kill.rs`, `crates/freshell-ws/tests/unit_kill_unconfirmed.rs`, unit tests in `crates/freshell-ws/src/unit_lifecycle.rs`; update `crates/freshell-protocol` round-trip tests for the optional field.

**Interfaces:**
- Consumes: Task 12 (`stop_terminal_unit`, `UnitDirectory`, `StartScope` cancellation), Task 8 (`states_for_terminal`, `wait_settled`).
- Produces:
  ```rust
  pub async fn kill_unit(kill: TerminalKill, entry: UnitEntry, out: WriterSender, state: &WsState, initiator: &str) -> bool;
  /// Ok(()) only when the registry confirms nothing holds a conversation for this terminal
  /// (waiting, event-driven, for any Stopping key it owns); Err(code) when a key is still Live under it.
  pub async fn confirm_gone_for_unknown(state: &WsState, terminal_id: &str) -> Result<(), String>;
  ```
  Resolution order in `handle_kill`: `units.by_terminal(terminalId)` → `units.by_create_request(createRequestId)` (a starting pane, or the pane's replacement after auto-resume) → `registry.terminal_for_create_request(createRequestId)` → `units.by_terminal`. A resolved unit is stopped with `Force` (`ShiftX`; `StuckRestart` for `reason: "stuck-recovery"`, which also skips the durable pane close as today). The `terminal.killed{requestId, success:true}` ack is sent from a spawned task after `StopHandle::wait()` AND `units.start_settled(unit)` — never from the connection loop, which returns at once. A second kill for the same unit joins (same handle, `Force` escalates). Not found anywhere: `confirm_gone_for_unknown`, then `success:true`; a key still `Live` under that terminal answers `success:false, error:"OWNER_WITHOUT_RUNTIME"` and logs `event=unit.kill_inconsistent` at ERROR.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_kill.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, HarnessOpts, UnitHarness};

fn kill(tid: Option<&str>, crq: &str, rid: &str) -> serde_json::Value {
    let mut f = json!({"type": "terminal.kill", "requestId": rid, "createRequestId": crq});
    if let Some(t) = tid {
        f["terminalId"] = json!(t);
    }
    f
}

#[tokio::test(flavor = "multi_thread")]
async fn shift_x_mid_turn_publishes_exit_and_vacant_only_after_gone() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"turnCompleteDelayMs": 60000, "turnSpawnsShellCommand": true, "detachedJobOnTurn": true}),
        ..Default::default()
    }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-k1", Some("t-k1")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY"))).await.unwrap();
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"})).await;
    tokio::time::sleep(Duration::from_millis(500)).await; // mid-turn: shell command + detached job running
    let native = h.native_pid(&tid);
    let manifest = h.native_manifest(&tid);
    let lock = h.lock("t-k1");
    assert!(fake_codex::lock_held(&lock));
    h.send(&mut ws, kill(Some(&tid), "crq-k1", "rk1")).await;
    let mut seen = std::collections::BTreeSet::new();
    while seen.len() < 4 {
        let f = h.next_matching(&mut ws, Duration::from_secs(10), |f| {
            (f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str())
                || f["type"] == "terminals.changed"
                || (f["type"] == "session.runtimeOwner" && f["sessionId"] == "t-k1" && f["ownerKind"] == "vacant")
                || (f["type"] == "terminal.killed" && f["requestId"] == "rk1")
        }).await.expect("all four publications arrive");
        assert!(!fake_codex::pid_alive(native), "{} published while the app-server lived", f["type"]);
        assert!(!fake_codex::lock_held(&lock), "{} published while the lock was held", f["type"]);
        if f["type"] == "terminal.killed" {
            assert_eq!(f["success"], true);
        }
        seen.insert(f["type"].as_str().unwrap().to_string());
    }
    let after = h.native_manifest(&tid);
    assert_eq!(after.signals.iter().map(|s| s.sig.as_str()).collect::<Vec<_>>(), vec!["SIGINT"]);
    for pid in manifest.children.shell.iter().chain(manifest.children.detached.iter()) {
        assert!(!fake_codex::pid_alive(*pid), "descendant {pid} survived");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_during_start_cancels_the_start() {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"listenDelayMs": 4000}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    h.send(&mut ws, json!({"type": "terminal.create", "requestId": "crq-start", "mode": "codex", "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": "t-start"}, "restore": true})).await;
    tokio::time::sleep(Duration::from_millis(500)).await; // launcher + native spawned, not yet listening
    let launcher_manifests: Vec<_> = std::fs::read_dir(&h.manifests).unwrap().flatten().collect();
    assert!(!launcher_manifests.is_empty(), "the start is under way");
    h.send(&mut ws, kill(None, "crq-start", "rks")).await;
    let killed = h.next_matching(&mut ws, Duration::from_secs(5), |f| f["type"] == "terminal.killed" && f["requestId"] == "rks").await.expect("ack");
    assert_eq!(killed["success"], true);
    for e in std::fs::read_dir(&h.manifests).unwrap().flatten() {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap();
        assert!(!fake_codex::pid_alive(v["pid"].as_u64().unwrap() as u32), "start leftovers die: {v}");
    }
    assert!(h.next_matching(&mut ws, Duration::from_secs(2), |f| f["type"] == "terminal.created" && f["requestId"] == "crq-start").await.is_none(), "the cancelled start never completes");
    let snap = h.state.ownership.as_ref().unwrap().observe("codex", "t-start");
    assert_eq!(snap.state, freshell_ownership::OwnershipState::Vacant);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_kill_joins_the_first_and_both_ack_at_gone() {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"turnCompleteDelayMs": 60000}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-dbl", Some("t-dbl")).await;
    let native = h.native_pid(&tid);
    h.send(&mut ws, kill(Some(&tid), "crq-dbl", "rd1")).await;
    h.send(&mut ws, kill(Some(&tid), "crq-dbl", "rd2")).await;
    for rid in ["rd1", "rd2"] {
        let f = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.killed" && f["requestId"] == rid).await.expect(rid);
        assert_eq!(f["success"], true);
        assert!(!fake_codex::pid_alive(native));
    }
    assert!(h.native_manifest(&tid).signals.len() <= 1, "one stop sequence, not two");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_terminal_is_success_only_because_nothing_holds_anything() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    h.send(&mut ws, kill(Some("no-such-terminal"), "crq-none", "rn")).await;
    let f = h.next_matching(&mut ws, Duration::from_secs(5), |f| f["type"] == "terminal.killed" && f["requestId"] == "rn").await.unwrap();
    assert_eq!(f["success"], true);
}
```

`crates/freshell-ws/tests/unit_kill_unconfirmed.rs` (own binary: sets the env-gated Gone delay):

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;
#[path = "../../freshell-containment/tests/support/capture.rs"]
mod capture;

use std::time::Duration;

use serde_json::json;
use unit_harness::{HarnessOpts, UnitHarness};

#[tokio::test(flavor = "multi_thread")]
async fn an_unconfirmed_stop_keeps_stopping_logs_an_error_and_acks_when_gone() {
    std::env::set_var("FRESHELL_TEST_HOOKS", "1");
    std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", "6500");
    let cap = capture::Captured::default();
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(cap.clone()));
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-u", Some("t-u")).await;
    h.send(&mut ws, json!({"type": "terminal.kill", "terminalId": tid, "requestId": "ru", "createRequestId": "crq-u"})).await;
    assert!(h.next_matching(&mut ws, Duration::from_secs(5), |f| f["type"] == "terminal.killed").await.is_none(), "no ack before Gone");
    assert!(cap.has(tracing::Level::ERROR, "unit.stop.unconfirmed"));
    let records = h.home.path().join(".freshell/rust-codex-sidecars");
    let row: serde_json::Value = std::fs::read_dir(&records).unwrap().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap()).next().expect("record kept");
    assert_eq!(row["state"]["kind"], "stopping");
    assert!(matches!(h.state.ownership.as_ref().unwrap().observe("codex", "t-u").state, freshell_ownership::OwnershipState::Stopping { .. }));
    let f = h.next_matching(&mut ws, Duration::from_secs(5), |f| f["type"] == "terminal.killed" && f["requestId"] == "ru").await.expect("ack at Gone");
    assert_eq!(f["success"], true);
    assert_eq!(h.state.ownership.as_ref().unwrap().observe("codex", "t-u").state, freshell_ownership::OwnershipState::Vacant);
}
```

(`use tracing_subscriber::prelude::*;` and the `tracing-subscriber` dev-dependency are added to `crates/freshell-ws/Cargo.toml`.)

Unit test in `crates/freshell-ws/src/unit_lifecycle.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unknown_terminal_whose_conversation_is_stopping_waits_for_gone() {
        let state = crate::test_ws_state(); // Task 12's lib.rs test builder (ownership enabled)
        let ownership = state.ownership.clone().unwrap();
        let owner = freshell_ownership::OwnerIdentity { terminal_id: Some("T-gone".into()), unit_id: Some("u-g".into()), ..Default::default() };
        assert!(ownership.restore_stopping("codex", "t-g", owner, "op", "test", 1));
        let wait = tokio::spawn({ let state = state.clone(); async move { confirm_gone_for_unknown(&state, "T-gone").await } });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!wait.is_finished(), "a Stopping conversation is not Gone");
        ownership.commit_unit_stop("u-g");
        assert_eq!(tokio::time::timeout(std::time::Duration::from_millis(200), wait).await.unwrap().unwrap(), Ok(()));
    }
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_kill --test unit_kill_unconfirmed --locked; cargo test -p freshell-ws --lib unit_lifecycle --locked`

Expected: FAIL — `kill_during_start_cancels_the_start` fails to deserialize the terminalId-less kill (`missing field terminalId`); `shift_x_mid_turn…` sees `terminal.exit` while the native is alive (today's registry kill path); `confirm_gone_for_unknown` does not exist (compile error in the lib test).

- [ ] **Step 3: Add the minimal production implementation**

In `handle_kill`, before the existing body (after `unknown_terminal_error`):

```rust
    let crq = kill.create_request_id.clone();
    let unit_entry = kill.terminal_id.as_deref().and_then(|t| state.units.by_terminal(t))
        .or_else(|| crq.as_deref().and_then(|c| state.units.by_create_request(c)))
        .or_else(|| crq.as_deref().and_then(|c| state.registry.terminal_for_create_request(c)).and_then(|t| state.units.by_terminal(&t)));
    if let Some(entry) = unit_entry {
        return crate::unit_lifecycle::kill_unit(kill, entry, ws_tx.clone(), state, initiator).await;
    }
    let Some(terminal_id) = kill.terminal_id.clone() else {
        // No terminal id and no unit for this create-request id: nothing runs for this pane.
        return reply_killed(ws_tx, &kill, "", true, None).await;
    };
```

and the rest of the existing body uses `terminal_id` where it used `kill.terminal_id`. In its "registry does not hold this terminal" arm, replace the unconditional success with:

```rust
        match crate::unit_lifecycle::confirm_gone_for_unknown(state, &terminal_id).await {
            Ok(()) => reply_killed(ws_tx, &kill, &terminal_id, true, None).await,
            Err(code) => reply_killed(ws_tx, &kill, &terminal_id, false, Some(code)).await,
        }
```

(`reply_killed` is the existing correlated-answer code at `:9980-9992` extracted into a helper.)

In `unit_lifecycle.rs`:

```rust
pub async fn kill_unit(kill: TerminalKill, entry: UnitEntry, out: crate::terminal::WsSink, state: &WsState, initiator: &str) -> bool {
    let stuck = kill.reason.as_deref() == Some("stuck-recovery");
    let tid = entry.terminal_id.clone();
    if !stuck {
        if let Err(error) = crate::terminal::durable_pane_close(state, tid.as_deref(), entry.create_request_id.as_deref().or(kill.create_request_id.as_deref())).await {
            return crate::terminal::reply_killed_owned(&out, &kill, tid.as_deref().unwrap_or(""), false, Some(error)).await;
        }
    }
    let cmd = UnitStopCommand {
        mode: StopMode::Force,
        reason: if stuck { StopReason::StuckRestart } else { StopReason::ShiftX },
        initiator: initiator.to_string(),
        operation_id: format!("term-kill-{}", uuid::Uuid::new_v4()),
        record_stopped_pane: !stuck,
    };
    let handle = stop_terminal_unit(state, &entry, cmd);
    let settled = state.units.start_settled(entry.unit.id());
    if let Some(request_id) = kill.request_id.clone() {
        let terminal_id = tid.or(kill.terminal_id.clone()).unwrap_or_default();
        tokio::spawn(async move {
            handle.wait().await;
            settled.await;
            let _ = crate::terminal::send_killed(&out, request_id, terminal_id, true, None).await;
        });
    }
    true
}

pub async fn confirm_gone_for_unknown(state: &WsState, terminal_id: &str) -> Result<(), String> {
    let Some(ownership) = state.ownership.clone() else { return Ok(()) };
    for (key, st) in ownership.states_for_terminal(terminal_id) {
        match st {
            freshell_ownership::OwnershipState::Stopping { .. } => {
                ownership.wait_settled(&key.provider, &key.session_id).await;
            }
            _ => {
                tracing::error!(target: "freshell_unit", event = "unit.kill_inconsistent",
                    terminal_id, provider = %key.provider, session_id = %key.session_id, "");
                return Err("OWNER_WITHOUT_RUNTIME".into());
            }
        }
    }
    Ok(())
}
```

(`durable_pane_close` is the existing ledger `close_pane` block `:9812-9907` extracted into a `pub(crate)` async helper returning `Result<(), String>`; `send_killed`/`reply_killed_owned` are the extracted `terminal.killed` writers; `WsSink` is `connection_writer::WriterSender`, which is `Clone` (`connection_writer.rs:65`).)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_kill --test unit_kill_unconfirmed --locked && cargo test -p freshell-ws --lib unit_lifecycle --locked && cargo test -p freshell-protocol --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Delete the now-unreachable Codex-specific branches of the legacy kill path (the retained-claim `begin_stop` for Codex rows can no longer occur: every Codex row is a unit row); keep the legacy path for plain shells and not-yet-contained agent rows (Task 23 moves the rest). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

The kill handler, the protocol message, and the release ordering changed. Impacted: every kill test (`pane_ledger_triggers.rs`, `cross_kind_liveness.rs` — update `the_terminal_kill_broadcasts_the_release_frame` (`:4519`) only if its pane is Codex: the release frame now follows the stop instead of preceding it — `unknown_terminal_reply.rs`, `auto_resume_events.rs::user_kill_sends_no_crash_event`), the TS protocol tests and the client kill tests that parse the schema.

Run: `cargo test -p freshell-ws --test pane_ledger_triggers --test cross_kind_liveness --test unknown_terminal_reply --test auto_resume_events --test unit_codex_create --locked && pnpm run test:vitest run test/unit/shared test/unit/client/lib/kill-ack.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol crates/freshell-ws shared/ws-protocol.ts Cargo.lock
git commit -m "feat(ws): Shift-X stops the pane unit, acks only at Gone, cancels starts, joins second kills

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Every thread the app-server holds is held by the pane unit; reopening an extra thread answers the holder

**Files:**
- Create: `crates/freshell-ws/src/unit_threads.rs` (+ `pub mod unit_threads;` in `lib.rs`)
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs` (`:46-139` event match: `ThreadStarted`, `ThreadLifecycle(ThreadStatusChanged)`, `TurnStarted` → `unit_threads::note_thread`; `ThreadLifecycleLoss` (`thread/closed`, status `notLoaded`) → `unit_threads::drop_thread`; both still log as today)
- Modify: `crates/freshell-ws/src/codex_identity.rs` (`rebind_codex_identity` `:138-238`: after the rebind commit, `unit_threads::note_thread` for the new id and keep the old id held — the app-server still holds its lock)
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (runtime `note_held_threads` merges ids into the record's `held_thread_ids` and sets the unit's lock paths; manager `note_held_threads(terminal_id, ids)`, `sidecar_ws_url(terminal_id)`; `mark_stopping` first refreshes the held set with a bounded (1 s) `thread/loaded/list`)
- Modify: `crates/freshell-freshagent/src/lib.rs` (`TerminalLaneClaim::Adopt` becomes `Adopt { owner: OwnerIdentity }` (from `BeginOutcome::AdoptLive { owner, .. }`); callers updated)
- Modify: `crates/freshell-ws/src/terminal.rs` (create path Adopt arm `:4779+`: when the adopted owner's terminal is a running unit row and the key is not that row's main session ref, answer the existing reattach `terminal.created` naming that terminal — the `BoundElsewhere` reply at `:5009-5163`, extracted as `reply_reattach_to_existing` — and spawn nothing; log `event=unit.reopen.holder`); the post-adopt step of Task 12's create flow spawns `unit_threads::reconcile_loaded(state, tid)`
- Test: `crates/freshell-ws/tests/unit_threads.rs`; extend `crates/freshell-ws/tests/codex_fork_rebind.rs`

**Interfaces:**
- Consumes: Task 8 (`hold_extra`, `release_extra`, `begin_unit_stop` covers every held key), Task 9 (`held_thread_ids`), Task 12 (directory, create flow).
- Produces:
  ```rust
  // unit_threads.rs
  pub async fn note_thread(state: &WsState, terminal_id: &str, thread_id: &str);   // hold_extra + record + lock paths
  pub async fn drop_thread(state: &WsState, terminal_id: &str, thread_id: &str);   // release_extra + record
  pub async fn reconcile_loaded(state: &WsState, terminal_id: &str);              // one thread/loaded/list (1 s budget) → note_thread each
  // launch_lifecycle.rs
  impl CodexTerminalLaunchManager {
      pub async fn note_held_threads(&self, terminal_id: &str, ids: Vec<String>);
      pub async fn forget_held_thread(&self, terminal_id: &str, id: &str);
      pub fn sidecar_ws_url(&self, terminal_id: &str) -> Option<String>;
  }
  pub enum TerminalLaneClaim { Granted(OperationTicket), Adopt { owner: OwnerIdentity }, Unwired, Refused(BeginOutcome) }
  ```
  Decision 1 is implemented here (server side): a reopen of a thread held as an extra by live unit X answers X's terminal; the client (Task 27) turns that into a jump.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_threads.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use freshell_ownership::OwnershipState;
use serde_json::json;
use unit_harness::{fake_codex, HarnessOpts, UnitHarness};

async fn eventually(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn live_under(h: &UnitHarness, sid: &str, tid: &str) -> bool {
    matches!(h.state.ownership.as_ref().unwrap().observe("codex", sid).state,
        OwnershipState::Live { ref owner, .. } if owner.terminal_id.as_deref() == Some(tid))
}

#[tokio::test(flavor = "multi_thread")]
async fn helper_and_earlier_threads_are_held_by_the_pane_unit_and_released_at_gone() {
    let h = UnitHarness::start(HarnessOpts {
        behavior: json!({"preloadedThreads": ["t-old"], "turnCompleteDelayMs": 60000,
                         "helperThreadOnTurn": {"id": "t-help", "durationMs": 60000}}),
        ..Default::default()
    }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-th", Some("t-main")).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY"))).await.unwrap();
    eventually("earlier conversation held (thread/loaded/list)", || live_under(&h, "t-old", &tid)).await;
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"})).await;
    eventually("helper thread held (proxy stream)", || live_under(&h, "t-help", &tid)).await;
    let records = h.home.path().join(".freshell/rust-codex-sidecars");
    let row: serde_json::Value = std::fs::read_dir(&records).unwrap().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap()).next().unwrap();
    let held: Vec<String> = serde_json::from_value(row["heldThreadIds"].clone()).unwrap();
    assert!(held.contains(&"t-old".to_string()) && held.contains(&"t-help".to_string()), "{held:?}");
    h.send(&mut ws, json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-th"})).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.killed").await.unwrap();
    for sid in ["t-main", "t-old", "t-help"] {
        assert_eq!(h.state.ownership.as_ref().unwrap().observe("codex", sid).state, OwnershipState::Vacant, "{sid}");
        assert!(!fake_codex::lock_held(&h.lock(sid)), "{sid} lock released");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn reopen_of_an_extra_thread_answers_the_holder_and_spawns_nothing() {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"preloadedThreads": ["t-extra"]}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-holder", Some("t-shown")).await;
    eventually("extra held", || live_under(&h, "t-extra", &tid)).await;
    let launchers_before = std::fs::read_dir(&h.manifests).unwrap().count();
    let mut other = h.connect().await;
    h.send(&mut other, json!({"type": "terminal.create", "requestId": "crq-reopen", "mode": "codex", "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": "t-extra"}})).await;
    let created = h.next_matching(&mut other, Duration::from_secs(10), |f| f["type"] == "terminal.created" && f["requestId"] == "crq-reopen").await.expect("answered");
    assert_eq!(created["terminalId"], tid.as_str(), "the reopen names the holding pane's terminal");
    assert_eq!(std::fs::read_dir(&h.manifests).unwrap().count(), launchers_before, "no second app-server");
}
```

Extend `crates/freshell-ws/tests/codex_fork_rebind.rs` with `fork_rebind_keeps_both_threads_on_the_sidecar_record` — after the file's existing rebind flow reaches its post-rebind assertions, read the record store and assert `record.holds_thread(<pre-fork id>) && record.holds_thread(<fork id>)`, and `observe("codex", <pre-fork id>)` is not `Vacant` (it is `Aliased` to the fork, which is Live under the same terminal).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_threads --test codex_fork_rebind --locked`

Expected: FAIL — `timed out: earlier conversation held` (nothing holds extra threads) and the reopen test receives a NEW terminal id (a second app-server spawns).

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-ws/src/unit_threads.rs`:

```rust
//! Every thread a pane's Codex app-server holds is held by the pane's unit
//! in the owner registry (design 5.1): helpers, forks, earlier conversations.
use freshell_codex::launch_lifecycle::CodexTerminalLaunchManager;
use freshell_ownership::{HoldOutcome, OwnerIdentity, RuntimeOwnerKind};

use crate::WsState;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub async fn note_thread(state: &WsState, terminal_id: &str, thread_id: &str) {
    let Some(entry) = state.units.by_terminal(terminal_id) else { return };
    if let Some(ownership) = state.ownership.as_ref() {
        let main = state.identity.session_ref_for(terminal_id).map(|s| s.session_id);
        if main.as_deref() != Some(thread_id) {
            let owner = OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some(terminal_id.to_string()),
                unit_id: Some(entry.unit.id().to_string()),
                ..OwnerIdentity::default()
            };
            if let HoldOutcome::HeldByOther { owner } = ownership.hold_extra("codex", thread_id, owner, "codex-thread", now_ms()) {
                tracing::warn!(target: "freshell_unit", event = "unit.thread_conflict", terminal_id, thread_id,
                    holder_terminal = %owner.terminal_id.unwrap_or_default(), "");
            }
        }
    }
    CodexTerminalLaunchManager::global().note_held_threads(terminal_id, vec![thread_id.to_string()]).await;
}

pub async fn drop_thread(state: &WsState, terminal_id: &str, thread_id: &str) {
    let Some(entry) = state.units.by_terminal(terminal_id) else { return };
    if let Some(ownership) = state.ownership.as_ref() {
        ownership.release_extra("codex", thread_id, entry.unit.id().as_str());
    }
    CodexTerminalLaunchManager::global().forget_held_thread(terminal_id, thread_id).await;
}

/// Ask the app-server directly which threads it has loaded (one query).
pub async fn reconcile_loaded(state: &WsState, terminal_id: &str) {
    let Some(url) = CodexTerminalLaunchManager::global().sidecar_ws_url(terminal_id) else { return };
    let query = async {
        let transport = freshell_codex::transport::TungsteniteTransport::connect(&url).await.ok()?;
        let client = freshell_codex::app_server::CodexAppServerClient::new(std::sync::Arc::new(transport));
        client.initialize().await.ok()?;
        let ids = client.list_loaded_threads().await.ok();
        client.close().await;
        ids
    };
    if let Ok(Some(ids)) = tokio::time::timeout(std::time::Duration::from_secs(1), query).await {
        for id in ids {
            note_thread(state, terminal_id, &id).await;
        }
    }
}
```

(Use the `CodexAppServerClient` constructor and `close` exactly as `sidecar_sweep.rs::probe_loaded_threads` (`:399-427`) does.)

Runtime `note_held_threads` (both runtimes):

```rust
    fn note_held_threads(&self, ids: Vec<String>) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            let Some(record) = state.as_mut().and_then(|s| s.record.as_mut()) else { return };
            for id in ids {
                if !record.holds_thread(&id) {
                    record.held_thread_ids.push(id);
                }
            }
            record.updated_at = unix_millis();
            write_record_loudly(&self.store, record);
            if let (Some(unit), Some(home)) = (self.unit(), crate::durability::codex_home_dir()) {
                unit.set_lock_paths(record.all_thread_ids().iter().map(|t| freshell_containment::codex_thread_lock_path(&home, t)).collect());
            }
        })
    }
```

Create path Adopt arm: with `TerminalLaneClaim::Adopt { owner }`, before the existing guard/lease flow:

```rust
    if let Some(holder) = owner.terminal_id.as_deref() {
        let is_main = state.identity.session_ref_for(holder).is_some_and(|s| s.session_id == locator.session_id);
        if !is_main && state.registry.is_running(holder) && state.units.by_terminal(holder).is_some() {
            tracing::info!(target: "freshell_unit", event = "unit.reopen.holder", provider = %locator.provider,
                session_id = %locator.session_id, holder_terminal = holder, "");
            return reply_reattach_to_existing(out, &create, holder).await;
        }
    }
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_threads --test codex_fork_rebind --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

`codex_proxy_route.rs` now has three call sites converting proxy events to thread ids; extract `fn thread_ids_of(event: &RemoteProxyEvent) -> (Vec<String> /*held*/, Vec<String> /*dropped*/)` with a unit test per event kind. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the proxy router (`codex_proxy_route.rs` tests), fork rebind, every `TerminalLaneClaim` caller (WS create, REST spawn, auto-resume), the reattach suite.

Run: `cargo test -p freshell-ws --lib codex_proxy_route --locked && cargo test -p freshell-ws --test codex_fork_rebind --test codex_sidecar_reattach_e2e --test codex_session_ref_resume --test auto_resume_e2e --test unit_kill --test unit_codex_create --locked && cargo test -p freshell-freshagent terminal_tabs --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws crates/freshell-codex crates/freshell-freshagent
git commit -m "feat(codex): the pane unit holds every thread its app-server holds; reopening an extra thread names its holder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Every way back into a conversation waits (event-driven) for Gone

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (`ownership_lane` module `:138+`): new `claim_terminal_lane_waiting` and `claim_lane_waiting` (fresh-agent twin of `begin_lane_claim` `:767`), both looping on `wait_settled` while the key is Starting/Handoff/Stopping and logging `unit.start.waited`.
- Modify: `crates/freshell-ws/src/terminal.rs` (claims at `:3451`, `:4699`, `:5678`, `:6997` use the waiting variant; the Adopt arm's `begin_adopt_guard` refusal for an in-progress incumbent (`:4849-4855`) waits and re-runs the claim instead of answering `SESSION_RESERVED`; `terminal.attach` with a `sessionRef` on an in-progress key (`:1307-1344`) waits instead of answering `SESSION_RESERVED`; `prepare_launch` (`:4239-4335`) awaits `wait_settled` for a Codex resume id BEFORE planning and does not plan at all when the key is then `Live` (the claim will Adopt and answer the holder))
- Modify: `crates/freshell-ws/src/auto_resume.rs` (claims `:921`, `:1021` use the waiting variant; delete the 10 ms / 2 s observe loop `:995-1015` — the waiting claim replaces it)
- Modify: `crates/freshell-ws/src/unit_lifecycle.rs` (`kill_unit`: when it joins an in-flight `AgentExited` stop, insert the pane's createRequestId into `state.auto_resume_cancels` (`lib.rs:179`, consulted by the hub at `auto_resume.rs:1375`) so a crash's auto-resume never re-creates a pane the user killed)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (claims `:1832`, `:3233` use the waiting variant)
- Modify: `crates/freshell-freshagent/src/session_handoff.rs` (the terminal-prior stop at `:3283-3399` and its `registry.kill` sites `:3313`, `:3363`: for a unit row, `mark_ending(Requested)` + `unit.stop(Force, Handoff)` + wait + `complete_unit_end(Requested)` + `CodexTerminalLaunchManager::finish_unit`; delete the 10 s PTY-pid death wait for unit rows — Gone is the confirmation)
- Modify: `crates/freshell-freshagent/src/{codex.rs,claude.rs,opencode_ws.rs}` (fresh-agent create/resume claims use `claim_lane_waiting`; `SESSION_RESERVED` remains only for stale observed fences)
- Test: `crates/freshell-ws/tests/unit_entry_points.rs`; `crates/freshell-freshagent/src/session_handoff/tests.rs` (`handoff_from_a_codex_terminal_unit_waits_for_gone`); `crates/freshell-freshagent/src/codex.rs` tests (`a_fresh_codex_create_during_a_recovery_stop_waits_and_succeeds`)

**Interfaces:**
- Consumes: Task 8 `wait_settled`, Task 2 `events::start_waited`, Tasks 12–13 lifecycle.
- Produces:
  ```rust
  pub async fn claim_terminal_lane_waiting(registry: &Option<Arc<RuntimeOwnershipRegistry>>, provider: &str, session_id: &str,
      operation_id: &str, observed: Option<ObservedFence>, initiator: &str, entry_point: &'static str) -> (TerminalLaneClaim, u64 /*wait_ms*/);
  pub async fn claim_lane_waiting(/* begin_lane_claim's parameters */, entry_point: &'static str) -> (LaneClaim, u64);
  ```
  `entry_point` values (logged on `unit.start.waited`): `"ws-create"`, `"ws-restore"`, `"ws-attach"`, `"rest-create"`, `"auto-resume"`, `"handoff"`, `"respawn-pane"`, `"fresh-agent-create"`. The wait has no timeout: it ends at the registry transition (Gone → Vacant, or a start reaching Live); a dropped/cancelled create drops the wait.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_entry_points.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, HarnessOpts, UnitHarness};

async fn ready(h: &UnitHarness, ws: &mut unit_harness::TestWs) {
    h.next_matching(ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY"))).await.expect("tui ready");
}

/// Kill and reopen back to back: the reopen must wait for Gone, then start a
/// NEW app-server that resumes cleanly — never "open in another app".
async fn kill_then_reopen(create: serde_json::Value, reason: Option<&str>) {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"turnCompleteDelayMs": 60000}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    let old = h.create_codex(&mut ws, "crq-old", Some("t-ep")).await;
    ready(&h, &mut ws).await;
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": old, "data": "turn go\r"})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let old_native = h.native_pid(&old);
    let mut kill = json!({"type": "terminal.kill", "terminalId": old, "requestId": "rk", "createRequestId": "crq-old"});
    if let Some(r) = reason {
        kill["reason"] = json!(r);
    }
    h.send(&mut ws, kill).await;
    h.send(&mut ws, create).await; // immediately: the key is Stopping right now
    let created = h.next_matching(&mut ws, Duration::from_secs(15), |f| f["type"] == "terminal.created" && f["requestId"] == "crq-new").await.expect("created");
    assert!(!fake_codex::pid_alive(old_native), "the reopen started only after the old app-server was gone");
    let new = created["terminalId"].as_str().unwrap().to_string();
    assert_ne!(new, old);
    let out = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["terminalId"] == new.as_str()
        && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY") || d.contains("open in another app"))).await.expect("new tui answered");
    assert!(out["data"].as_str().unwrap().contains("FAKE_TUI_READY thread=t-ep"), "resumed cleanly: {out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interactive_reopen_waits_for_gone() {
    kill_then_reopen(json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system",
        "sessionRef": {"provider": "codex", "sessionId": "t-ep"}}), None).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restore_reopen_waits_for_gone() {
    kill_then_reopen(json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": "t-ep"}}), None).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stuck_restart_waits_for_gone() {
    kill_then_reopen(json!({"type": "terminal.create", "requestId": "crq-new", "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": "t-ep"}}), Some("stuck-recovery")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_resume_after_a_crash_waits_for_gone_and_a_kill_racing_it_wins() {
    std::env::set_var("FRESHELL_AUTO_RESUME_DELAYS_MS", "50,50");
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-ar", Some("t-ar")).await;
    ready(&h, &mut ws).await;
    let native = h.native_pid(&tid);
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"})).await; // TUI exits 1
    h.send(&mut ws, json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-ar"})).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.killed" && f["requestId"] == "rk").await.expect("ack");
    assert!(!fake_codex::pid_alive(native));
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(h.state.units.by_create_request("crq-ar").is_none(), "auto-resume never re-created the pane the user killed");
    assert!(h.state.registry.terminal_for_create_request("crq-ar").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attach_by_session_ref_during_stopping_waits_instead_of_refusing() {
    let h = UnitHarness::start(HarnessOpts { behavior: json!({"turnCompleteDelayMs": 60000}), ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-at", Some("t-at")).await;
    h.send(&mut ws, json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-at"})).await;
    let mut other = h.connect().await;
    h.send(&mut other, json!({"type": "terminal.attach", "terminalId": tid, "requestId": "ra",
        "sessionRef": {"provider": "codex", "sessionId": "t-at"}})).await;
    let answer = h.next_matching(&mut other, Duration::from_secs(10), |f| f["requestId"] == "ra" || f["terminalId"] == tid.as_str() && f["type"] == "error").await.expect("answered");
    assert_ne!(answer["code"], "SESSION_RESERVED", "waits for Gone instead of asking the client to poll");
}
```

Freshagent tests: in `crates/freshell-freshagent/src/session_handoff/tests.rs` add `handoff_from_a_codex_terminal_unit_waits_for_gone` (with the file's terminal-prior fixture, make the prior row a unit row via `create_in_unit` + a tag-backend unit holding a `bash` child that traps SIGINT; run the `switch` action; assert the target start happened after the prior's `ProcWatch::has_exited()` became true and the outcome is not a fence/`PLATFORM_LIMITED`); in `crates/freshell-freshagent/src/codex.rs` tests add `a_fresh_codex_create_during_a_recovery_stop_waits_and_succeeds` (start a recovery stop on the file's fake sidecar session, immediately send `freshAgent.create` resume for the same session; assert a `freshAgent.created` (not `SESSION_RESERVED`) arrives after the stop's `freshAgent.recovery.stopped`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_entry_points --locked`

Expected: FAIL — the reopens are answered `SESSION_RESERVED` (`retryAfterMs: 1000`) instead of `terminal.created`; the attach answers `SESSION_RESERVED`.

- [ ] **Step 3: Add the minimal production implementation**

```rust
    /// Claim, and while the key is mid-transition (a start, a handoff, or a
    /// stop on its way to Gone) WAIT for the registry to settle — woken by
    /// the transition itself, never by a timer.
    pub async fn claim_terminal_lane_waiting(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        entry_point: &'static str,
    ) -> (TerminalLaneClaim, u64) {
        let started = std::time::Instant::now();
        loop {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            let claim = begin_terminal_lane_claim(registry, provider, session_id, operation_id, observed, initiator, now);
            match (&claim, registry.as_ref()) {
                (TerminalLaneClaim::Refused(BeginOutcome::Blocked { state, .. }), Some(reg))
                    if matches!(state, OwnershipState::Starting { .. } | OwnershipState::Handoff { .. } | OwnershipState::Stopping { .. }) =>
                {
                    reg.wait_settled(provider, session_id).await;
                }
                _ => {
                    let wait_ms = started.elapsed().as_millis() as u64;
                    if wait_ms > 0 {
                        freshell_containment::events::start_waited(
                            &freshell_containment::events::UnitLogKeys {
                                provider: provider.into(),
                                session_id: Some(session_id.into()),
                                operation_id: Some(operation_id.into()),
                                ..Default::default()
                            },
                            entry_point,
                            wait_ms,
                        );
                    }
                    return (claim, wait_ms);
                }
            }
        }
    }
```

`claim_lane_waiting` is the same loop over `begin_lane_claim`. Each listed call site replaces `begin_terminal_lane_claim(...)` / `begin_lane_claim(...)` with `.._waiting(..., "<entry point>").await.0`. The Adopt-arm guard refusal and the attach refusal call `reg.wait_settled(provider, session_id).await` and restart their claim. `prepare_launch`: before `plan_codex_managed_launch` for a resume id, `if let Some(reg) = &state.ownership { let snap = reg.wait_settled("codex", &id).await; if matches!(snap.state, OwnershipState::Live { .. }) { return PreparedLaunch::Adopt } }` (the later claim answers the holder; nothing is spawned).

In `kill_unit` (Task 13), when `entry.unit.stop_in_flight()` is `Some` and `state.registry.ending(tid) == Some(UnitEnding::AgentExited { .. })`, insert the createRequestId into `state.auto_resume_cancels` before joining.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_entry_points --locked && cargo test -p freshell-freshagent handoff_from_a_codex_terminal_unit_waits_for_gone a_fresh_codex_create_during_a_recovery_stop_waits_and_succeeds --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

With every in-progress refusal replaced by a wait, `send_session_reserved` (`terminal.rs:3128-3150`) is only reachable for stale observed fences: rename it `send_stale_owner_fence` and drop its `retryAfterMs` field (the client heals from the carried pair and re-sends once). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Every create/attach/handoff/fresh-agent-create path changed its refusal behavior. Impacted: `create_protection.rs`, `create_dedupe.rs`, `live_session_ref_guard.rs`, `session_ref_singleflight.rs`, `cross_kind_liveness.rs`, `freshagent_session_lease.rs`, `restore_*`, `auto_resume_*`, the handoff and fresh-agent lane test modules.

Run: `cargo test -p freshell-ws --locked && cargo test -p freshell-freshagent --locked`

Expected: PASS (tests that asserted `SESSION_RESERVED` for an in-progress key are updated to assert the wait-then-answer behavior; tests asserting `SESSION_RESERVED` for STALE fences keep passing).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent crates/freshell-ws
git commit -m "feat(ownership): every entry point waits on the registry for Gone instead of refusing and polling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Conversations held outside Freshell are reported (pid + command) at once; every writer conflict is an ERROR log

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`ErrorCode` gains `ConversationHeldElsewhere` → wire `"CONVERSATION_HELD_ELSEWHERE"`; `ErrorMsg` gains `#[serde(skip_serializing_if = "Option::is_none")] holder_pid: Option<u32>`, `holder_command: Option<String>`), `shared/ws-protocol.ts` (the error schema's code enum + optional `holderPid`, `holderCommand`)
- Create: `crates/freshell-ws/src/unit_holders.rs` (+ `pub mod unit_holders;`)
- Modify: `crates/freshell-ws/src/terminal.rs` (`prepare_launch` and the interactive Codex create: after the registry wait (Task 15) finds the key `Vacant`, run `unit_holders::preflight_codex_resume` before planning; an outside holder answers the typed error and spawns nothing)
- Modify: `crates/freshell-codex/src/remote_proxy.rs` (`RemoteProxyEvent` `:242-276` gains `WriterConflict { thread_id: String, message: String }`, emitted when an upstream error response to a pending `thread/resume`/`thread/fork` request (method tracking already exists at `:1274-1286`) contains `"already has an active writer"`), `crates/freshell-ws/src/codex_proxy_route.rs` (route it to `unit_holders::log_writer_conflict(state, terminal_id, thread_id, "proxy")`)
- Modify: `crates/freshell-freshagent/src/codex.rs` (where a freshcodex `thread/resume` error is surfaced to the client, log the same `unit.writer_conflict` with `source: "freshcodex"`)
- Test: `crates/freshell-ws/tests/unit_outside_holder.rs`

**Interfaces:**
- Consumes: Task 3 `lock_holders`, `codex_thread_lock_path`; Task 10 `codex_home_dir`; Task 12 directory; Task 14 `reply_reattach_to_existing`.
- Produces:
  ```rust
  pub enum Preflight { Clear, HeldByUnit { terminal_id: String }, HeldOutside { pid: u32, command: String } }
  pub fn preflight_codex_resume(state: &WsState, thread_id: &str) -> Preflight;   // one lock-table read, no waiting
  pub fn log_writer_conflict(state: &WsState, terminal_id: Option<&str>, thread_id: &str, source: &str); // ERROR + holder pid/command
  ```
  A holder belongs to a Freshell unit when its `FRESHELL_UNIT_ID` environment value (Linux/macOS) names a unit in `state.units`, or (Windows, or unreadable environ) when its pid is a member of a Codex unit in `state.units`; such a holder answers that pane (`reply_reattach_to_existing`), never an error. Anything else is outside: `error{code:"CONVERSATION_HELD_ELSEWHERE", message:"This conversation is open in another program (pid <pid>: <command>). Close it there, then reopen it here.", holderPid, holderCommand, requestId}`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_outside_holder.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;
#[path = "../../freshell-containment/tests/support/capture.rs"]
mod capture;

use std::time::{Duration, Instant};

use serde_json::json;
use tracing_subscriber::prelude::*;
use unit_harness::{HarnessOpts, UnitHarness};

#[tokio::test(flavor = "multi_thread")]
async fn an_outside_holder_is_reported_at_once_and_nothing_is_spawned() {
    let cap = capture::Captured::default();
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(cap.clone()));
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let lock = h.lock("t-out");
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    std::fs::write(&lock, b"").unwrap();
    // "a shell codex": an outside process holding the thread's writer lock (spawned by this test)
    let mut outside = std::process::Command::new("flock").args(["-x", lock.to_str().unwrap(), "sleep", "600"]).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while freshell_containment::lock_holders(&[lock.clone()]).is_empty() {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut ws = h.connect().await;
    let t0 = Instant::now();
    h.send(&mut ws, json!({"type": "terminal.create", "requestId": "crq-out", "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": "t-out"}})).await;
    let err = h.next_matching(&mut ws, Duration::from_secs(5), |f| f["type"] == "error" && f["requestId"] == "crq-out").await.expect("typed refusal");
    assert!(t0.elapsed() < Duration::from_secs(3), "does not wait for an outside holder");
    assert_eq!(err["code"], "CONVERSATION_HELD_ELSEWHERE");
    assert_eq!(err["holderPid"], outside.id());
    assert!(err["holderCommand"].as_str().unwrap().contains("flock"));
    assert_eq!(std::fs::read_dir(&h.manifests).map(|d| d.count()).unwrap_or(0), 0, "no app-server spawned");
    assert!(cap.has(tracing::Level::ERROR, "unit.writer_conflict"));
    outside.kill().unwrap();
    outside.wait().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conflict_the_tui_hits_by_itself_is_logged_as_an_error() {
    let cap = capture::Captured::default();
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(cap.clone()));
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let holder = h.create_codex(&mut ws, "crq-a", Some("t-held")).await;
    let other = h.create_codex(&mut ws, "crq-b", Some("t-other")).await;
    let _ = holder;
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": other, "data": "resume t-held\r"})).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["terminalId"] == other.as_str()
        && f["data"].as_str().is_some_and(|d| d.contains("open in another app"))).await.expect("the TUI shows the conflict");
    assert!(cap.has(tracing::Level::ERROR, "unit.writer_conflict"), "every active-writer conflict is an ERROR log");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_outside_holder --locked`

Expected: FAIL — the first test times out waiting for a typed refusal (today an app-server is spawned and the TUI shows the conflict); the second finds no `unit.writer_conflict` event.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-ws/src/unit_holders.rs`:

```rust
use freshell_containment::{codex_thread_lock_path, events, lock_holders, UnitId, UNIT_ENV};

use crate::WsState;

pub enum Preflight {
    Clear,
    HeldByUnit { terminal_id: String },
    HeldOutside { pid: u32, command: String },
}

fn unit_of_holder(state: &WsState, pid: u32) -> Option<String> {
    #[cfg(unix)]
    if let Some(id) = freshell_containment::process::environ_value(pid, UNIT_ENV).and_then(|v| UnitId::parse(&v)) {
        return state.units.get(&id).and_then(|e| e.terminal_id);
    }
    state
        .units
        .all()
        .into_iter()
        .filter(|e| e.provider == "codex")
        .find(|e| e.unit.members().map(|m| m.iter().any(|p| p.pid == pid)).unwrap_or(false))
        .and_then(|e| e.terminal_id)
}

pub fn preflight_codex_resume(state: &WsState, thread_id: &str) -> Preflight {
    let Some(home) = freshell_codex::durability::codex_home_dir() else { return Preflight::Clear };
    let lock = codex_thread_lock_path(&home, thread_id);
    let Some(holder) = lock_holders(&[lock]).into_iter().find(|h| freshell_containment::process::is_running(h.pid)) else {
        return Preflight::Clear;
    };
    if let Some(terminal_id) = unit_of_holder(state, holder.pid) {
        return Preflight::HeldByUnit { terminal_id };
    }
    log_writer_conflict_with(None, thread_id, Some(holder.pid), Some(&holder.command), "preflight");
    Preflight::HeldOutside { pid: holder.pid, command: holder.command }
}

pub fn log_writer_conflict(state: &WsState, terminal_id: Option<&str>, thread_id: &str, source: &str) {
    let _ = state;
    let holder = freshell_codex::durability::codex_home_dir()
        .and_then(|home| lock_holders(&[codex_thread_lock_path(&home, thread_id)]).into_iter().next());
    log_writer_conflict_with(terminal_id, thread_id, holder.as_ref().map(|h| h.pid), holder.as_ref().map(|h| h.command.as_str()), source);
}

fn log_writer_conflict_with(terminal_id: Option<&str>, thread_id: &str, pid: Option<u32>, command: Option<&str>, source: &str) {
    events::writer_conflict(
        &events::UnitLogKeys { provider: "codex".into(), session_id: Some(thread_id.into()), terminal_id: terminal_id.map(str::to_string), ..Default::default() },
        thread_id,
        pid,
        command,
        source,
    );
}
```

In the create paths, after the Task 15 wait for a Codex resume id: `match unit_holders::preflight_codex_resume(state, &id) { Clear => continue, HeldByUnit { terminal_id } => return reply_reattach_to_existing(out, &create, &terminal_id).await, HeldOutside { pid, command } => return send_create_error_holder(out, &create, pid, &command).await }`, where `send_create_error_holder` is the existing `send_create_error` (`:4690`) with `ErrorCode::ConversationHeldElsewhere`, the message above, and the two holder fields.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_outside_holder --locked && cargo test -p freshell-protocol --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

`unit_of_holder` scans `units.all()` members only when the environ read is unavailable; extract that branch into `fn member_unit(state, pid)` with a doc comment explaining when it runs (Windows, non-dumpable processes). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: protocol round-trips (Rust + TS), the remote proxy relay tests (new event variant), the proxy router tests, Codex create paths.

Run: `cargo test -p freshell-codex --features real-transport --test remote_proxy_relay --locked && cargo test -p freshell-ws --lib codex_proxy_route --locked && cargo test -p freshell-ws --test unit_entry_points --test unit_threads --test codex_managed_launch_e2e --locked && pnpm run test:vitest run test/unit/shared --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol crates/freshell-ws crates/freshell-codex crates/freshell-freshagent/src/codex.rs shared/ws-protocol.ts
git commit -m "feat(codex): report outside conversation holders by pid and command; log every writer conflict as an error

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Crashes, screen-only crashes and self-exits — app-server death is detected, the unit always ends whole

**Files:**
- Modify: `crates/freshell-ws/src/unit_lifecycle.rs` (`screen_exit_hook` decision table below; new `spawn_main_watcher`; new `respawn_screen`)
- Modify: `crates/freshell-terminal/src/registry.rs` (`pub fn respawn_spec(&self, terminal_id: &str) -> Option<(SpawnSpec, BTreeMap<String, String>)>` reading the row's stored spawn inputs)
- Modify: `crates/freshell-server/src/main.rs` (`units.set_on_bind(unit_lifecycle::on_bind_hook(ws_state.clone(), Handle::current()))`; the harness does the same)
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs` (`RepairTrigger`/`ThreadLifecycleLoss` warn logs gain `unit_id`, `session_id`, `terminal_id` fields; they stay logs — detection is the main-process watch)
- Test: `crates/freshell-ws/tests/unit_crash.rs`

**Interfaces:**
- Consumes: Task 2 `ProcWatch::exited/has_exited`, Task 11 `replace_screen`, Task 12 lifecycle + `on_bind`, Task 14 bound thread ids.
- Produces: the decision table (the ONLY place unit ends are decided):

  | Event | Condition | Action |
  |---|---|---|
  | main process exits (ProcWatch) | no stop in flight; main ≠ screen | `stop_terminal_unit(Force, AgentExited{None})` → crash (exit code 1): bell if mid-reply, auto-resume after Gone |
  | screen exits | stop in flight (`ending` set) | ignored (the stop publishes at Gone) |
  | screen exits | main == screen (Claude Code etc.) | `AgentExited{code}` (code 0 = the agent ended on its own; non-zero = crash) |
  | screen exits | main ≠ screen, main already exited | `AgentExited{None}` (crash) |
  | screen exits | main ≠ screen, code 0 | `AgentExited{0}` — the user quit Codex; the whole unit ends, no auto-resume |
  | screen exits | main ≠ screen, code ≠ 0, main alive | `respawn_screen`: new TUI in the same row against the running app-server (`--remote <same proxy>`, `resume <bound thread>`); on `respawn cap` → `AgentExited{code}` |

  ```rust
  pub fn on_bind_hook(state: WsState, rt: tokio::runtime::Handle) -> Arc<dyn Fn(UnitEntry) + Send + Sync>; // spawns spawn_main_watcher
  pub fn spawn_main_watcher(state: WsState, entry: UnitEntry);
  pub async fn respawn_screen(state: &WsState, entry: &UnitEntry, exit_code: i64);
  ```
  A screen restart emits nothing to clients (no `terminal.exit`, no crash event, no activity `Exit`): the same terminal id keeps streaming, so no "went idle"/"turn complete" edge can fire for it.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_crash.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{fake_codex, AutoResumeMode, HarnessOpts, UnitHarness};

async fn ready(h: &UnitHarness, ws: &mut unit_harness::TestWs, tid: &str) {
    h.next_matching(ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["terminalId"] == tid
        && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY"))).await.expect("tui ready");
}

#[tokio::test(flavor = "multi_thread")]
async fn app_server_death_mid_reply_is_a_crash_that_rings_and_publishes_only_after_gone() {
    let mut h = UnitHarness::start(HarnessOpts { behavior: json!({"turnCompleteDelayMs": 60000}), auto_resume: AutoResumeMode::Capture, ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-c", Some("t-crash")).await;
    ready(&h, &mut ws, &tid).await;
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"})).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let screen = h.unit_for(&tid).screen().unwrap().pid();
    let native = h.native_pid(&tid);
    fake_codex::signal_own_child(native, libc::SIGKILL); // the app-server dies on its own
    let exit = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str()).await.expect("exit");
    assert_ne!(exit["exitCode"], 0, "a crash, not a clean exit");
    assert!(!fake_codex::pid_alive(screen), "the whole unit ended before terminal.exit");
    let bell = h.next_matching(&mut ws, Duration::from_secs(5), |f| f["type"] == "terminal.idle" && f["terminalId"] == tid.as_str()).await;
    assert!(bell.is_some(), "a crash mid-reply rings as today");
    let crash = tokio::time::timeout(Duration::from_secs(5), h.crash_rx.as_mut().unwrap().recv()).await.unwrap().unwrap();
    assert_eq!(crash.terminal_id, tid);
    assert_ne!(crash.exit_code, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn after_an_app_server_crash_auto_resume_reopens_cleanly() {
    std::env::set_var("FRESHELL_AUTO_RESUME_DELAYS_MS", "50,50");
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-r", Some("t-resume")).await;
    ready(&h, &mut ws, &tid).await;
    fake_codex::signal_own_child(h.native_pid(&tid), libc::SIGKILL);
    let replaced = h.next_matching(&mut ws, Duration::from_secs(15), |f| f["type"] == "terminal.replaced" || (f["type"] == "terminal.created" && f["terminalId"] != tid.as_str())).await.expect("auto-resumed");
    let new = replaced["newTerminalId"].as_str().or(replaced["terminalId"].as_str()).unwrap().to_string();
    let out = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.output" && f["terminalId"] == new.as_str()
        && f["data"].as_str().is_some_and(|d| d.contains("FAKE_TUI_READY") || d.contains("open in another app"))).await.unwrap();
    assert!(out["data"].as_str().unwrap().contains("FAKE_TUI_READY thread=t-resume"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_screen_only_crash_restarts_the_screen_against_the_running_app_server_silently() {
    let mut h = UnitHarness::start(HarnessOpts { auto_resume: AutoResumeMode::Capture, ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-s", Some("t-screen")).await;
    ready(&h, &mut ws, &tid).await;
    let native = h.native_pid(&tid);
    let old_screen = h.unit_for(&tid).screen().unwrap().pid();
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "crash\r"})).await; // the TUI exits 1
    ready(&h, &mut ws, &tid).await; // a NEW screen in the SAME terminal resumes the same thread
    assert!(fake_codex::pid_alive(native), "the agent kept running");
    assert_eq!(h.native_pid(&tid), native);
    assert_ne!(h.unit_for(&tid).screen().unwrap().pid(), old_screen);
    assert!(h.next_matching(&mut ws, Duration::from_secs(3), |f| (f["type"] == "terminal.exit" || f["type"] == "terminal.idle") && f["terminalId"] == tid.as_str()).await.is_none(),
        "no exit and no idle/turn-complete edge for a screen restart");
    assert!(tokio::time::timeout(Duration::from_millis(500), h.crash_rx.as_mut().unwrap().recv()).await.is_err(), "no crash event");
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_codex_ends_the_unit_without_auto_resume() {
    let mut h = UnitHarness::start(HarnessOpts { auto_resume: AutoResumeMode::Capture, ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-q", Some("t-q")).await;
    ready(&h, &mut ws, &tid).await;
    let native = h.native_pid(&tid);
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "quit\r"})).await;
    let exit = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.exit" && f["terminalId"] == tid.as_str()).await.unwrap();
    assert_eq!(exit["exitCode"], 0);
    assert!(!fake_codex::pid_alive(native));
    let crash = tokio::time::timeout(Duration::from_secs(3), h.crash_rx.as_mut().unwrap().recv()).await.unwrap().unwrap();
    assert_eq!(crash.exit_code, 0, "auto-resume's decide() settles a clean exit");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_crash --locked`

Expected: FAIL — the app-server death goes unnoticed until the TUI reacts (no `terminal.exit` while the TUI stays up), and the screen-only crash ends the whole unit (Task 12's minimal hook) instead of restarting the screen.

- [ ] **Step 3: Add the minimal production implementation**

```rust
pub fn on_bind_hook(state: WsState, rt: tokio::runtime::Handle) -> Arc<dyn Fn(UnitEntry) + Send + Sync> {
    Arc::new(move |entry: UnitEntry| {
        let state = state.clone();
        rt.spawn(async move { spawn_main_watcher(state, entry) });
    })
}

pub fn spawn_main_watcher(state: WsState, entry: UnitEntry) {
    if entry.unit.main_is_screen() {
        return; // the screen-exit hook covers agents whose screen IS the main process
    }
    let Some(main) = entry.unit.main() else { return };
    tokio::spawn(async move {
        main.exited().await;
        if entry.unit.stop_in_flight().is_some() {
            return;
        }
        let Some(current) = state.units.get(entry.unit.id()) else { return };
        tracing::warn!(target: "freshell_unit", event = "unit.agent_exited", unit_id = %entry.unit.id(),
            terminal_id = %current.terminal_id.clone().unwrap_or_default(), pid = main.pid(), "");
        stop_terminal_unit(&state, &current, UnitStopCommand {
            mode: StopMode::Force,
            reason: StopReason::AgentExited { exit_code: None },
            initiator: "agent-exited".into(),
            operation_id: format!("unit-exit-{}", uuid::Uuid::new_v4()),
            record_stopped_pane: false,
        });
    });
}

async fn on_screen_exit(state: WsState, exit: UnitScreenExit) {
    let Some(entry) = state.units.by_terminal(&exit.terminal_id) else { return };
    if entry.unit.stop_in_flight().is_some() {
        return;
    }
    let main_alive = entry.unit.main().is_some_and(|m| !m.has_exited());
    let end = |code: Option<i64>| UnitStopCommand {
        mode: StopMode::Force,
        reason: StopReason::AgentExited { exit_code: code },
        initiator: "screen-exit".into(),
        operation_id: format!("unit-exit-{}", uuid::Uuid::new_v4()),
        record_stopped_pane: false,
    };
    if entry.unit.main_is_screen() {
        stop_terminal_unit(&state, &entry, end(Some(exit.exit_code)));
    } else if !main_alive {
        stop_terminal_unit(&state, &entry, end(None));
    } else if exit.exit_code == 0 {
        stop_terminal_unit(&state, &entry, end(Some(0)));
    } else {
        respawn_screen(&state, &entry, exit.exit_code).await;
    }
}

pub async fn respawn_screen(state: &WsState, entry: &UnitEntry, exit_code: i64) {
    let tid = entry.terminal_id.clone().unwrap_or_default();
    let Some((mut spec, env)) = state.registry.respawn_spec(&tid) else { return };
    if let Some(thread) = state.identity.session_ref_for(&tid).map(|s| s.session_id) {
        match spec.args.iter().position(|a| a == "resume") {
            Some(i) if i + 1 < spec.args.len() => spec.args[i + 1] = thread,
            _ => spec.args.extend(["resume".to_string(), thread]),
        }
    }
    let placement = match entry.unit.placement(MemberRole::Screen) {
        Ok(p) => p,
        Err(_) => return,
    };
    let registry = state.registry.clone();
    let unit_id = entry.unit.id().to_string();
    let t = tid.clone();
    let result = tokio::task::spawn_blocking(move || {
        registry.replace_screen(&t, &spec, &env, freshell_terminal::UnitPlacement { unit_id, wrapper: placement.wrapper, env: placement.env, main_is_screen: false })
    })
    .await;
    match result {
        Ok(Ok(pid)) => {
            if let Ok(w) = ProcWatch::open(pid) {
                entry.unit.set_screen(w);
            }
            tracing::info!(target: "freshell_unit", event = "unit.screen.respawned", unit_id = %entry.unit.id(), terminal_id = %tid, prior_exit_code = exit_code, "");
        }
        _ => {
            stop_terminal_unit(state, entry, UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::AgentExited { exit_code: Some(exit_code) },
                initiator: "screen-respawn-failed".into(),
                operation_id: format!("unit-exit-{}", uuid::Uuid::new_v4()),
                record_stopped_pane: false,
            });
        }
    }
}
```

`screen_exit_hook` now hands every unrequested exit to `on_screen_exit` (Task 12's body is replaced). For the Codex TUI, `respawn_spec` is the stored original spawn (it already carries `--remote <proxy url>`, and the proxy lives as long as the adopted launch), so only the `resume` argument is updated.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_crash --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Fold the three `UnitStopCommand { reason: AgentExited .. }` literals into `fn agent_exited(code: Option<i64>, initiator: &'static str) -> UnitStopCommand`. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every Codex suite (exit handling changed), auto-resume suites, the activity bell suites.

Run: `cargo test -p freshell-ws --test unit_codex_create --test unit_kill --test unit_entry_points --test unit_threads --test auto_resume_e2e --test auto_resume_respawn --test auto_resume_events --test codex_locator_activity --locked && cargo test -p freshell-ws --lib activity --locked`

Expected: PASS (`unit_codex_create.rs::quitting_the_codex_tui_ends_the_whole_unit…` still passes: exit code 0 ends the unit).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws crates/freshell-terminal crates/freshell-server/src/main.rs
git commit -m "feat(ws): detect app-server death; crashes end the whole unit; screen-only crashes restart the screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Killed units are remembered — late and offline devices are told "stopped" instead of re-creating

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs` (new `StoppedPaneRecord` store under `<ledger root>/stopped-panes/`, loaded into an in-memory index at `boot_scan`, swept by the existing periodic GC with `STOPPED_PANE_TTL_MS = 30 days`; disabled ledger = no-op)
- Modify: `crates/freshell-ws/src/unit_lifecycle.rs` (`publish_gone`: when `cmd.record_stopped_pane`, write the record (on `spawn_blocking`) BEFORE the `terminal.exit`/Vacant publications)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`ErrorMsg` gains `#[serde(skip_serializing_if = "Option::is_none")] terminal_stopped: Option<bool>`; `ReconcileVerdict` `:1081` gains `Stopped`), `shared/ws-protocol.ts` (error frame `terminalStopped?: true`; verdict enum `'stopped'` at `:1135`)
- Modify: `crates/freshell-ws/src/terminal.rs` (`handle_attach` unknown-terminal answer `:8690-8710`: `terminal_stopped: Some(true)` when the ledger remembers the terminal as stopped)
- Modify: `crates/freshell-ws/src/reconcile.rs` (`verdict_for_pane` `:264`: before any `Respawn` arm (`:407`, `:433`, `:477`), a pane whose `terminalId` or `createRequestId` is remembered stopped — and has no running row — gets `ReconcileVerdict::Stopped`)
- Modify: `crates/freshell-server/src/main.rs` (the 6-hourly GC task `:2386+` also calls `gc_stopped_panes`)
- Test: `crates/freshell-ws/tests/unit_stopped_memory.rs`; `crates/freshell-ws/src/pane_ledger_tests.rs` (persistence + GC)

**Interfaces:**
- Consumes: Task 12/13 `publish_gone`, `UnitStopCommand.record_stopped_pane` (true for Shift-X, kill commands and cleanup; false for crashes, starts, respawns and stuck restarts).
- Produces:
  ```rust
  pub const STOPPED_PANE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub struct StoppedPaneRecord { pub ledger_version: u32, pub terminal_id: String, pub create_request_id: Option<String>,
                                 pub provider: Option<String>, pub session_id: Option<String>, pub stopped_at_ms: i64 }
  impl PaneLedger {
      pub fn record_stopped_pane(&self, record: &StoppedPaneRecord) -> std::io::Result<()>;
      pub fn stopped_pane_for_terminal(&self, terminal_id: &str) -> Option<StoppedPaneRecord>;
      pub fn stopped_pane_for_create_request(&self, create_request_id: &str) -> Option<StoppedPaneRecord>;
      pub fn gc_stopped_panes(&self, now_ms: i64) -> usize;
  }
  ```
  Records are keyed by terminal id (never re-minted), so a conversation the user later reopens elsewhere does not turn that new pane into "stopped" — only the killed pane's own stale copies are.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_stopped_memory.rs`:

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;

use std::time::Duration;

use serde_json::json;
use unit_harness::{HarnessOpts, UnitHarness};

async fn killed_pane(h: &UnitHarness) -> String {
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-m", Some("t-mem")).await;
    h.send(&mut ws, json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-m"})).await;
    h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "terminal.killed").await.unwrap();
    tid
}

#[tokio::test(flavor = "multi_thread")]
async fn a_late_attach_to_a_killed_pane_is_told_it_was_stopped() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let tid = killed_pane(&h).await;
    let mut late = h.connect().await; // device B, hidden pane, never subscribed
    h.send(&mut late, json!({"type": "terminal.attach", "terminalId": tid, "requestId": "ra", "intent": "viewport_hydrate"})).await;
    let err = h.next_matching(&mut late, Duration::from_secs(5), |f| f["type"] == "error" && f["terminalId"] == tid.as_str()).await.unwrap();
    assert_eq!(err["code"], "INVALID_TERMINAL_ID");
    assert_eq!(err["terminalStopped"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_offline_device_reconciling_a_killed_pane_gets_stopped_not_respawn() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let tid = killed_pane(&h).await;
    let mut offline = h.connect().await;
    h.send(&mut offline, json!({"type": "pane.reconcile.request", "requestId": "rr", "panes": [{
        "paneKey": "p1", "kind": "terminal", "mode": "codex", "terminalId": tid, "createRequestId": "crq-m",
        "sessionRef": {"provider": "codex", "sessionId": "t-mem"}}]})).await;
    let res = h.next_matching(&mut offline, Duration::from_secs(5), |f| f["type"] == "pane.reconcile.result" && f["requestId"] == "rr").await.unwrap();
    assert_eq!(res["verdicts"][0]["verdict"], "stopped");
}
```

(The `pane.reconcile.request` pane fields follow `PaneReconcileRequestSchema` (`shared/ws-protocol.ts:1121`); if the field names differ there, use the schema's names — the assertion is the `"stopped"` verdict.)

In `crates/freshell-ws/src/pane_ledger_tests.rs`:

```rust
#[test]
fn stopped_panes_persist_across_reload_and_expire_after_thirty_days() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = PaneLedger::new(Some(dir.path().to_path_buf())); // the unlocked constructor (:1574); a reload below needs no lock handoff
    let rec = StoppedPaneRecord { ledger_version: LEDGER_VERSION, terminal_id: "T1".into(), create_request_id: Some("C1".into()),
        provider: Some("codex".into()), session_id: Some("s".into()), stopped_at_ms: 1_000 };
    ledger.record_stopped_pane(&rec).unwrap();
    let reloaded = PaneLedger::new(Some(dir.path().to_path_buf()));
    assert_eq!(reloaded.stopped_pane_for_terminal("T1"), Some(rec.clone()));
    assert_eq!(reloaded.stopped_pane_for_create_request("C1"), Some(rec));
    assert_eq!(reloaded.gc_stopped_panes(1_000 + STOPPED_PANE_TTL_MS - 1), 0);
    assert_eq!(reloaded.gc_stopped_panes(1_000 + STOPPED_PANE_TTL_MS + 1), 1);
    assert!(reloaded.stopped_pane_for_terminal("T1").is_none());
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_stopped_memory --locked && cargo test -p freshell-ws --lib pane_ledger_tests::stopped_panes --locked`

Expected: FAIL — `terminalStopped` is absent (`null`), the verdict is `"respawn"`, and `StoppedPaneRecord` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

Model the store exactly on the legacy kill-tombstone files (`pane_ledger.rs:210-240`, same atomic write helper and per-row quarantine): one file per terminal id under `stopped-panes/<enc(terminalId)>.json`; an in-memory `HashMap<String /*terminal*/, StoppedPaneRecord>` plus a create-request index, filled at `boot_scan`, updated on write, pruned by `gc_stopped_panes`. In `publish_gone`:

```rust
    if cmd.record_stopped_pane {
        if let Some(tid) = entry.terminal_id.clone() {
            let ledger = state.pane_ledger.clone();
            let label = entry.unit.label();
            let record = crate::pane_ledger::StoppedPaneRecord {
                ledger_version: crate::pane_ledger::LEDGER_VERSION,
                terminal_id: tid,
                create_request_id: entry.create_request_id.clone(),
                provider: Some(entry.provider.clone()),
                session_id: label.session_id,
                stopped_at_ms: crate::terminal::now_ms(),
            };
            let _ = tokio::task::spawn_blocking(move || ledger.record_stopped_pane(&record)).await;
        }
    }
```

(placed first in `publish_gone`, before `complete_unit_end`, so any device that observes the exit can already be told "stopped"). The attach answer adds `terminal_stopped: state.pane_ledger.stopped_pane_for_terminal(&terminal_id).map(|_| true)`. In `verdict_for_pane`, before the respawn arms:

```rust
    let remembered = pane.terminal_id.as_deref().and_then(|t| deps.ledger.stopped_pane_for_terminal(t))
        .or_else(|| pane.create_request_id.as_deref().and_then(|c| deps.ledger.stopped_pane_for_create_request(c)));
    if remembered.is_some() && !pane.terminal_id.as_deref().is_some_and(|t| deps.registry.is_running(t)) {
        return PaneVerdict { ..base(pane, ReconcileVerdict::Stopped) };
    }
```

(`ReconcileDeps` gains `ledger: &PaneLedger` if it does not already carry it.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_stopped_memory --locked && cargo test -p freshell-ws --lib pane_ledger_tests --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Share the per-identity JSON file helpers between kill tombstones and stopped panes (`fn write_record_file<T: Serialize>(dir, key, &T)` / `fn load_record_dir<T: DeserializeOwned>(dir)`), with no behavior change to tombstones. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the reconcile verdict and attach answers, the ledger GC, the protocol (Rust + TS), the client fold of reconcile verdicts (an unknown verdict must not crash it).

Run: `cargo test -p freshell-ws --test pane_reconcile --test pane_reconcile_freshagent --test pane_ledger_restore --test unknown_terminal_reply --locked && cargo test -p freshell-ws --lib pane_ledger_tests reconcile --locked && cargo test -p freshell-protocol --locked && pnpm run test:vitest run test/unit/shared test/unit/client/lib/pane-reconcile.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws crates/freshell-protocol crates/freshell-server/src/main.rs shared/ws-protocol.ts
git commit -m "feat(ws): remember stopped panes so late and offline devices see Stopped instead of re-creating

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Server restart — running sidecars survive and are reclaimed; Stopping units are finished on boot; a kill always beats keep-on-restart

**Files:**
- Modify: `crates/freshell-ws/src/unit_lifecycle.rs` (new `shutdown_units`, `finish_on_boot`)
- Modify: `crates/freshell-server/src/main.rs`:
  - shutdown (`:3405-3493`): after `begin_shutdown_retention()` and BEFORE `registry.kill_all()`, `freshell_ws::unit_lifecycle::shutdown_units(&ws_state, Duration::from_millis(3500)).await`; replace the stale supervisor comment at `:3443-3447` with: "Pane units live in their own systemd slices (or, without systemd, are tagged and detached), never in this service's cgroup, so `KillMode=control-group` on the server's unit kills only the server and uncontained children; retained Codex sidecars survive";
  - boot (`:2338-2383`): right after `boot_reconcile` and BEFORE the listener binds, `freshell_ws::unit_lifecycle::finish_on_boot(ws_state.clone(), report.stopping.clone(), reconciler.held_unit_ids()).await` inline — the function contains no `.await` of its own: it seeds the registry (`Stopping`) and STARTS each stop, whose Gone completion runs on the unit's own task; so no create can be accepted before the dying keys are `Stopping`.
- Modify: `installers/systemd/freshell-rust.service` (add `KillMode=control-group` explicitly with a comment explaining that pane units are sibling slices of the user manager and survive a stop/restart of this unit; nothing else changes — the installed live unit is NOT touched by this work)
- Modify: `crates/freshell-codex/src/sidecar_reconcile.rs` (expose `pub fn held_unit_ids(&self) -> Vec<String>`)
- Test: `crates/freshell-server/tests/restart_during_stopping.rs`; adapt `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs::shutdown_reaps_terminal_and_codex_sidecar_within_5s` (`:280`) only where its expectations assumed the old teardown queue.

**Interfaces:**
- Consumes: Task 9 (`BootReconcileReport.stopping`), Task 8 (`restore_stopping`, `commit_unit_stop`), Task 4/5 (`reopen_unit`, `surviving_units`, `adopt_legacy`), Task 10 (manager retention rules).
- Produces:
  ```rust
  /// Server shutdown: every unit with a stop in flight is finished (never retained);
  /// Codex units with a durable record and no stop are retained (the manager's
  /// shutdown flips their records to Retained); every other unit is stopped
  /// (Force, ServerShutdown). Bounded by `limit` (the 5 s hard-exit watchdog still applies;
  /// an unfinished stop keeps its persisted Stopping record and is finished on the next boot).
  pub async fn shutdown_units(state: &WsState, limit: std::time::Duration);
  /// Boot: for each Stopping record, seed the registry Stopping for every thread it held,
  /// reopen its unit (or adopt the legacy tag), stop it (Force, BootFinish), and at Gone
  /// commit Vacant and remove the record. Then stop every surviving unit that no held
  /// (claimable) record references — leftovers of panes whose screens died with the server.
  pub async fn finish_on_boot(state: WsState, stopping: Vec<CodexSidecarRecord>, held_unit_ids: Vec<String>);
  ```

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-server/tests/restart_during_stopping.rs` (reuses `discover_server_binary`, `allocate_ephemeral_port`, `wait_for_health`, `send_json`, `wait_for_message_type`, `pid_alive` from `safe11_term22_shutdown_reaping.rs` by moving them into `crates/freshell-server/tests/support/server_proc.rs` and including it with `#[path]` from both files):

```rust
#![cfg(target_os = "linux")]
#[path = "support/server_proc.rs"]
mod server_proc;
#[path = "../../freshell-codex/tests/support/fake_codex.rs"]
mod fake_codex;

use std::time::Duration;

use serde_json::json;
use server_proc::*;

/// One isolated server instance over a persistent HOME (so a restart sees the previous records).
struct Instance { home: std::path::PathBuf, port: u16, child: std::process::Child }

fn start(home: &std::path::Path, extra_env: &[(&str, &str)]) -> Instance {
    let port = allocate_ephemeral_port();
    let dispatcher = write_codex_dispatcher(home); // bash: app-server -> fake-codex-launcher.mjs, else fake-codex-tui.mjs
    let mut cmd = std::process::Command::new(discover_server_binary());
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", home).env("FRESHELL_HOME", home.join(".freshell")).env("CODEX_HOME", home.join(".codex"))
        .env("XDG_RUNTIME_DIR", std::env::var("XDG_RUNTIME_DIR").unwrap_or_default())
        .env("AUTH_TOKEN", "restart-test-token").env("PORT", port.to_string())
        .env("CODEX_CMD", &dispatcher)
        .env("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1")
        .env("FAKE_CODEX_MANIFEST_DIR", home.join("manifests"))
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    Instance { home: home.to_path_buf(), port, child: cmd.spawn().unwrap() }
}

async fn create_resume(port: u16, rid: &str, thread: &str) -> (WsStream, String) {
    let mut ws = connect_ws(port, "restart-test-token").await; // hello/ready, as safe11 does
    send_json(&mut ws, &json!({"type": "terminal.create", "requestId": rid, "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": thread}})).await;
    let created = wait_for_message_type(&mut ws, "terminal.created", Duration::from_secs(20)).await.expect("created");
    (ws, created["terminalId"].as_str().unwrap().to_string())
}

fn natives(home: &std::path::Path) -> Vec<u32> {
    std::fs::read_dir(home.join("manifests")).map(|d| d.flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("native-"))
        .filter_map(|e| serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(e.path()).ok()?).ok()?["pid"].as_u64())
        .map(|p| p as u32).collect()).unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn running_sidecars_survive_a_restart_and_are_reclaimed() {
    let home = tempfile::tempdir().unwrap();
    let mut a = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(a.port, &mut a.child, Duration::from_secs(30)).await);
    let (_ws, _tid) = create_resume(a.port, "crq-s", "t-surv").await;
    let native = *natives(home.path()).first().expect("one app-server");
    unsafe { libc::kill(a.child.id() as i32, libc::SIGTERM) }; // our own server process
    a.child.wait().unwrap();
    assert!(fake_codex::pid_alive(native), "the running sidecar survives the restart");
    let mut b = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(b.port, &mut b.child, Duration::from_secs(30)).await);
    let (_ws, _tid) = create_resume(b.port, "crq-s2", "t-surv").await;
    assert_eq!(natives(home.path()), vec![native], "reclaimed: no second app-server");
    unsafe { libc::kill(b.child.id() as i32, libc::SIGKILL) };
    unsafe { libc::kill(native as i32, libc::SIGKILL) };
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crash_mid_stop_is_finished_on_boot_and_never_offered_for_reuse() {
    let home = tempfile::tempdir().unwrap();
    let wedged = r#"{"ignoreSigint": true}"#;
    let mut a = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", wedged)]);
    assert!(wait_for_health(a.port, &mut a.child, Duration::from_secs(30)).await);
    let (mut ws, tid) = create_resume(a.port, "crq-x", "t-stop").await;
    let old = *natives(home.path()).first().unwrap();
    send_json(&mut ws, &json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-x"})).await;
    tokio::time::sleep(Duration::from_millis(300)).await; // inside the 1 s SIGINT grace: record says Stopping
    unsafe { libc::kill(a.child.id() as i32, libc::SIGKILL) }; // server crash mid-stop
    a.child.wait().unwrap();
    assert!(fake_codex::pid_alive(old), "the wedged app-server outlived the crash");
    let mut b = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(b.port, &mut b.child, Duration::from_secs(30)).await);
    let (_ws, _tid) = create_resume(b.port, "crq-y", "t-stop").await;
    assert!(!fake_codex::pid_alive(old), "the boot finished the stop before the reopen started");
    let now = natives(home.path());
    assert!(now.iter().any(|p| *p != old && fake_codex::pid_alive(*p)), "a NEW app-server serves the reopen");
    unsafe { libc::kill(b.child.id() as i32, libc::SIGKILL) };
    for p in now { unsafe { libc::kill(p as i32, libc::SIGKILL) }; }
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_then_restart_and_restore_reclaims_the_same_sidecar() {
    let home = tempfile::tempdir().unwrap();
    let mut a = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(a.port, &mut a.child, Duration::from_secs(30)).await);
    let (mut ws, tid) = create_resume(a.port, "crq-f", "t-fork-src").await;
    send_json(&mut ws, &json!({"type": "terminal.input", "terminalId": tid, "data": "fork\r"})).await;
    let fork_id = wait_for_output_matching(&mut ws, &tid, r"FAKE_TUI_READY thread=(thread-fork-\S+)", Duration::from_secs(10)).await; // returns the capture
    let records = home.path().join(".freshell/rust-codex-sidecars");
    let held = || std::fs::read_dir(&records).unwrap().flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .any(|e| std::fs::read_to_string(e.path()).unwrap().contains(&fork_id));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !held() { assert!(std::time::Instant::now() < deadline, "the record learned the fork"); tokio::time::sleep(Duration::from_millis(50)).await; }
    let native = *natives(home.path()).first().unwrap();
    unsafe { libc::kill(a.child.id() as i32, libc::SIGTERM) };
    a.child.wait().unwrap();
    let mut b = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(b.port, &mut b.child, Duration::from_secs(30)).await);
    let (mut ws2, tid2) = create_resume(b.port, "crq-f2", &fork_id).await;
    let line = wait_for_output_matching(&mut ws2, &tid2, r"(FAKE_TUI_READY thread=\S+|open in another app)", Duration::from_secs(10)).await;
    assert_eq!(line, format!("FAKE_TUI_READY thread={fork_id}"), "restored onto the surviving app-server, no writer conflict");
    assert_eq!(natives(home.path()), vec![native], "no second app-server");
    unsafe { libc::kill(b.child.id() as i32, libc::SIGKILL) };
    unsafe { libc::kill(native as i32, libc::SIGKILL) };
}

#[tokio::test(flavor = "multi_thread")]
async fn a_kill_racing_a_graceful_shutdown_is_never_kept_for_reuse() {
    let home = tempfile::tempdir().unwrap();
    let mut a = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", r#"{"ignoreSigint": true}"#)]);
    assert!(wait_for_health(a.port, &mut a.child, Duration::from_secs(30)).await);
    let (mut ws, tid) = create_resume(a.port, "crq-g", "t-race").await;
    let old = *natives(home.path()).first().unwrap();
    send_json(&mut ws, &json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-g"})).await;
    unsafe { libc::kill(a.child.id() as i32, libc::SIGTERM) }; // graceful shutdown races the kill
    a.child.wait().unwrap();
    let records: Vec<serde_json::Value> = std::fs::read_dir(home.path().join(".freshell/rust-codex-sidecars")).map(|d| d.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok()).collect()).unwrap_or_default();
    assert!(records.iter().all(|r| r["state"]["kind"] != "retained"), "a kill always beats keep-on-restart: {records:?}");
    let mut b = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(b.port, &mut b.child, Duration::from_secs(30)).await);
    let (_ws, _tid) = create_resume(b.port, "crq-g2", "t-race").await;
    assert!(!fake_codex::pid_alive(old));
    unsafe { libc::kill(b.child.id() as i32, libc::SIGKILL) };
    for p in natives(home.path()) { unsafe { libc::kill(p as i32, libc::SIGKILL) }; }
}
```

(`write_codex_dispatcher(home)`, `connect_ws(port, token)` and `wait_for_output_matching(ws, terminal_id, regex, limit) -> String` (first capture group, or the whole match when the pattern has none, from `terminal.output` frames of that terminal) are added to `support/server_proc.rs`: the dispatcher is the same two-line bash router as Task 12's harness; `connect_ws` is the hello/ready handshake `safe11` performs inline at `:280+`, extracted.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo build -p freshell-server --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test restart_during_stopping --locked`

Expected: FAIL — `a_crash_mid_stop…` sees the old wedged app-server still alive after boot (nothing finishes Stopping records) and/or a writer conflict; `a_kill_racing_a_graceful_shutdown…` finds the unfinished stop (no `shutdown_units`).

- [ ] **Step 3: Add the minimal production implementation**

```rust
pub async fn shutdown_units(state: &WsState, limit: std::time::Duration) {
    let mut waits = Vec::new();
    for entry in state.units.all() {
        if let Some(h) = entry.unit.stop_in_flight() {
            waits.push(h); // a kill beats keep-on-restart: finish it
        } else if entry.provider == "codex" && entry.terminal_id.as_deref().is_some_and(|t| {
            CodexTerminalLaunchManager::global().has_durable_record(t)
        }) {
            continue; // retained by CodexTerminalLaunchManager::shutdown
        } else {
            waits.push(stop_terminal_unit(state, &entry, UnitStopCommand {
                mode: StopMode::Force,
                reason: StopReason::ServerShutdown,
                initiator: "server-shutdown".into(),
                operation_id: format!("unit-shutdown-{}", uuid::Uuid::new_v4()),
                record_stopped_pane: false,
            }));
        }
    }
    let all = async {
        for h in waits {
            h.wait().await;
        }
    };
    let _ = tokio::time::timeout(limit, all).await;
}

pub async fn finish_on_boot(state: WsState, stopping: Vec<CodexSidecarRecord>, held_unit_ids: Vec<String>) {
    let containment = state.units.containment.clone();
    let mut finished: Vec<String> = Vec::new();
    for record in stopping {
        let label = UnitLabel { provider: "codex".into(), session_id: record.session_id.clone(), terminal_id: record.terminal_id.clone() };
        let unit = record.unit_id.as_deref().and_then(UnitId::parse)
            .and_then(|id| containment.reopen_unit(&id, label.clone()).ok().flatten())
            .unwrap_or_else(|| containment.adopt_legacy("FRESHELL_CODEX_SIDECAR_ID", &record.ownership_id, &[record.pid], label));
        if let Some(w) = record.main_pid.zip(record.main_starttime).and_then(|(p, s)| ProcWatch::open_expecting(p, s).ok()) {
            unit.set_main(w);
        }
        let op = match &record.state { SidecarRecordState::Stopping { operation_id, .. } => operation_id.clone(), _ => "boot-finish".into() };
        if let Some(ownership) = state.ownership.as_ref() {
            let owner = OwnerIdentity { kind: RuntimeOwnerKind::Terminal, terminal_id: record.terminal_id.clone(), unit_id: Some(unit.id().to_string()), ..Default::default() };
            for thread in record.all_thread_ids() {
                ownership.restore_stopping("codex", &thread, owner.clone(), &op, "boot", now_ms());
            }
        }
        finished.push(unit.id().to_string());
        let state2 = state.clone();
        let ownership_id = record.ownership_id.clone();
        let unit2 = unit.clone();
        unit.stop(StopRequest::new(StopMode::Force, StopReason::BootFinish, "boot").operation(op).on_gone(Box::new(move |_| Box::pin(async move {
            if let Some(ownership) = state2.ownership.as_ref() {
                for k in ownership.commit_unit_stop(unit2.id().as_str()) {
                    crate::identity_ownership::broadcast_vacant_frame(&state2, &k.key.provider, &k.key.session_id, "boot-finish", ownership.boot_epoch(), k.generation);
                }
            }
            if let Some(store) = freshell_codex::sidecar_store::codex_sidecar_store() {
                let _ = store.remove(&ownership_id);
            }
        }))));
    }
    if let Ok(survivors) = containment.surviving_units() {
        for id in survivors {
            if held_unit_ids.contains(&id.to_string()) || finished.contains(&id.to_string()) {
                continue;
            }
            if let Ok(Some(leftover)) = containment.reopen_unit(&id, UnitLabel { provider: "unknown".into(), ..Default::default() }) {
                tracing::warn!(target: "freshell_unit", event = "unit.boot.leftover", unit_id = %id, "");
                leftover.stop(StopRequest::new(StopMode::Force, StopReason::BootFinish, "boot"));
            }
        }
    }
}
```

(`CodexTerminalLaunchManager::has_durable_record(terminal_id) -> bool` is a one-line accessor over the adopted entry's runtime record. `finish_on_boot` is awaited inline before the listener binds and never awaits a stop itself, so every dying thread is `Stopping` before the first create can arrive; creates then wait (Task 15) until `commit_unit_stop`.)

- [ ] **Step 4: Run the focused test**

Run: `cargo build -p freshell-server --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test restart_during_stopping --test safe11_term22_shutdown_reaping --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Move the record→unit reconstruction (reopen or legacy + main watch) into one `fn unit_for_record(containment, record) -> AgentUnit` in `freshell-codex` (`sidecar_reconcile.rs`), used by `finish_on_boot`, `ReattachedCodexAppServerRuntime` and the sweep. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: shutdown and boot of the server binary, the reconcile suites, the ws reattach suite.

Run: `cargo test -p freshell-codex --features real-transport --locked && cargo test -p freshell-ws --test codex_sidecar_reattach_e2e --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws crates/freshell-server crates/freshell-codex installers/systemd/freshell-rust.service
git commit -m "feat(server): finish Stopping units on boot, never retain a killed unit, keep running sidecars across restarts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Automation — `kill-tab`/`kill-pane` behave like Shift-X, new `close-tab`/`close-pane` detach, `respawn-pane` goes through the registry

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (new `PaneUnitStopper` trait + `FreshAgentState::with_pane_unit_stopper(..)` setter, following the `with_sidecar_liveness` precedent `:119`/`main.rs:2154-2175`)
- Modify: `crates/freshell-freshagent/src/pane_ops.rs` (router `:56-79` adds `POST /api/panes/{id}/kill` and `POST /api/tabs/{id}/kill`; `respawn_pane` `:917-998` stops the pane's current unit first and names a different holder on refusal; module doc `:15-32` updated: close/delete detach, kill stops)
- Modify: `crates/freshell-freshagent/src/{codex.rs,claude.rs,opencode_ws.rs}` (awaited `kill_session(&self, session_id: &str) -> Result<(), String>` wrapping the existing `handle_stop(.., Close)` / teardown path, used by the kill routes for fresh-agent panes)
- Create: `crates/freshell-ws/src/unit_stopper.rs` (`WsPaneUnitStopper` implementing the trait over `unit_lifecycle::stop_terminal_unit` (unit rows) and `kill_and_broadcast` (non-unit rows))
- Modify: `crates/freshell-server/src/main.rs` (wire `with_pane_unit_stopper(Arc::new(WsPaneUnitStopper::new(ws_state.clone())))`)
- Modify: `tools/node-client-runtime/action-capabilities.ts` (add `{ action: 'close-tab', supported: true, params: params(['target']) }` and `{ action: 'close-pane', supported: true, params: params(['target']) }` after their kill twins; `validateActionCapabilities` expects 35 canonical actions), `test/fixtures/tools/rust-action-capability-matrix.json` (`"canonicalActions": 35`), `test/unit/cli/action-capabilities.test.ts` (`:43-62` slice/index constants for 35)
- Modify: `tools/freshell-mcp/freshell-tool.ts` (`kill-tab` `:517-521` → `POST /api/tabs/<id>/kill`; `kill-pane` `:581-584` → `POST /api/panes/<target>/kill`; new `close-tab` → `DELETE /api/tabs/<id>`; new `close-pane` → `POST /api/panes/<target>/close`)
- Modify: `tools/freshell-cli/index.ts` (`kill-tab` `:518-529`, `kill-pane` `:662-674` re-pointed; `close-tab`/`close-pane` added with the same target resolution as their kill twins)
- Modify: `.agents/skills/freshell-orchestration/SKILL.md` (`:83`, `:98`, `:101`, `:137`: kill = stop the agent and close; close = detach and keep it running; respawn stops the pane's own agent first)
- Test: `crates/freshell-freshagent/src/pane_ops_tests.rs` (new route tests; `:770-775` changes to assert the old terminal was stopped), `crates/freshell-server/tests/automation_unit_kill.rs`, `test/unit/mcp/freshell-tool.test.ts`, `test/unit/cli/commands.test.ts`

**Interfaces:**
- Consumes: Task 12/13 (`stop_terminal_unit`), Task 15 (`claim_terminal_lane_waiting` with entry point `"respawn-pane"`), Task 14 (holder answers).
- Produces:
  ```rust
  pub trait PaneUnitStopper: Send + Sync {
      /// Shift-X semantics for one terminal; resolves at Gone.
      fn stop_terminal(&self, terminal_id: String, reason: &'static str) -> BoxFuture<'static, ()>;
  }
  ```
  REST contract: `POST /api/panes/{id}/kill` and `POST /api/tabs/{id}/kill` stop every agent behind the target (terminal units through the stopper, fresh-agent sessions through `kill_session`), wait up to 5 s: all Gone → close (the existing `close_pane`/`delete_tab` bookkeeping + `ui.command` broadcast) → `200 {"ok":true,"status":"stopped"}`; otherwise → `202 {"ok":false,"status":"stopping"}` and the close runs when Gone arrives (spawned task). Browser/editor panes have nothing to stop and close at once (`status: "closed"`). `respawn-pane`: stop the pane's current terminal unit (wait for Gone, no cap), then spawn; if a DIFFERENT live pane holds the conversation, nothing is killed and the existing 409 (`RESTORE_UNAVAILABLE`, "still running on the server") gains `holderPaneId` and `liveTerminalId`.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-server/tests/automation_unit_kill.rs` (server binary; reuses Task 19's `support/server_proc.rs` `start`-style helper — move `start`/`natives`/`write_codex_dispatcher` there):

```rust
#![cfg(target_os = "linux")]
#[path = "support/server_proc.rs"]
mod server_proc;
#[path = "../../freshell-codex/tests/support/fake_codex.rs"]
mod fake_codex;

use std::time::Duration;

use serde_json::json;
use server_proc::*;

async fn rest(port: u16, method: reqwest::Method, path: &str, body: serde_json::Value) -> (u16, serde_json::Value) {
    let res = reqwest::Client::new().request(method, format!("http://127.0.0.1:{port}{path}"))
        .header("x-auth-token", "restart-test-token").json(&body).send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(json!({})))
}

async fn new_codex_tab(port: u16, thread: &str) -> (String, String) {
    let (status, body) = rest(port, reqwest::Method::POST, "/api/tabs", json!({"mode": "codex", "sessionRef": {"provider": "codex", "sessionId": thread}})).await;
    assert_eq!(status, 200, "{body}");
    (body["data"]["tabId"].as_str().unwrap().into(), body["data"]["paneId"].as_str().unwrap().into())
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_pane_stops_the_agent_and_closes_only_when_gone() {
    let home = tempfile::tempdir().unwrap();
    let mut s = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(s.port, &mut s.child, Duration::from_secs(30)).await);
    let (_tab, pane) = new_codex_tab(s.port, "t-kp").await;
    wait_for_native(home.path()).await;
    let native = natives(home.path())[0];
    let (status, body) = rest(s.port, reqwest::Method::POST, &format!("/api/panes/{pane}/kill"), json!({})).await;
    assert_eq!((status, body["status"].clone()), (200, json!("stopped")));
    assert!(!fake_codex::pid_alive(native), "kill-pane = Shift-X: the agent is gone when the call returns");
    let (_, snap) = rest(s.port, reqwest::Method::GET, "/api/layout/snapshot", json!({})).await;
    assert!(!snap.to_string().contains(&pane), "the pane closed after Gone");
    unsafe { libc::kill(s.child.id() as i32, libc::SIGKILL) };
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_tab_stops_every_agent_in_the_tab() {
    let home = tempfile::tempdir().unwrap();
    let mut s = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(s.port, &mut s.child, Duration::from_secs(30)).await);
    let (tab, _pane) = new_codex_tab(s.port, "t-kt").await;
    wait_for_native(home.path()).await;
    let native = natives(home.path())[0];
    let (status, _) = rest(s.port, reqwest::Method::POST, &format!("/api/tabs/{tab}/kill"), json!({})).await;
    assert_eq!(status, 200);
    assert!(!fake_codex::pid_alive(native));
    unsafe { libc::kill(s.child.id() as i32, libc::SIGKILL) };
}

#[tokio::test(flavor = "multi_thread")]
async fn close_pane_detaches_and_keeps_the_agent_running() {
    let home = tempfile::tempdir().unwrap();
    let mut s = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(s.port, &mut s.child, Duration::from_secs(30)).await);
    let (_tab, pane) = new_codex_tab(s.port, "t-cp").await;
    wait_for_native(home.path()).await;
    let native = natives(home.path())[0];
    let (status, _) = rest(s.port, reqwest::Method::POST, &format!("/api/panes/{pane}/close"), json!({})).await;
    assert_eq!(status, 200);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(fake_codex::pid_alive(native), "a plain close leaves the unit running");
    unsafe { libc::kill(s.child.id() as i32, libc::SIGKILL) };
    unsafe { libc::kill(native as i32, libc::SIGKILL) };
}

#[tokio::test(flavor = "multi_thread")]
async fn respawn_pane_stops_the_old_agent_first_and_resumes_cleanly() {
    let home = tempfile::tempdir().unwrap();
    let mut s = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}")]);
    assert!(wait_for_health(s.port, &mut s.child, Duration::from_secs(30)).await);
    let (_tab, pane) = new_codex_tab(s.port, "t-rp").await;
    wait_for_native(home.path()).await;
    let old = natives(home.path())[0];
    let (status, body) = rest(s.port, reqwest::Method::POST, &format!("/api/panes/{pane}/respawn"),
        json!({"mode": "codex", "sessionRef": {"provider": "codex", "sessionId": "t-rp"}})).await;
    assert_eq!(status, 200, "{body}");
    assert!(!fake_codex::pid_alive(old), "the old terminal's agent was stopped before the respawn");
    wait_until_n_natives(home.path(), 2).await;
    let new = *natives(home.path()).iter().find(|p| **p != old).unwrap();
    assert!(fake_codex::pid_alive(new));
    unsafe { libc::kill(s.child.id() as i32, libc::SIGKILL) };
    unsafe { libc::kill(new as i32, libc::SIGKILL) };
}
```

(`wait_for_native(home)` / `wait_until_n_natives(home, n)` are test-only bounded waits over the manifests dir in `support/server_proc.rs`; `reqwest` is already a dev-dependency of `freshell-server` if `diag01` uses it — otherwise use the same raw `hyper`/`tokio` HTTP helper `safe11` uses for `/api/health`.)

`test/unit/mcp/freshell-tool.test.ts` additions (next to the existing `kill-tab`/`kill-pane` cases at `:397-402`, `:628-632`):

```ts
it('kill-tab stops the tab (POST /api/tabs/:id/kill)', async () => {
  const { calls } = await runTool({ action: 'kill-tab', params: { target: 'tab-1' } }, { tabs: [{ id: 'tab-1', title: 'one' }] })
  expect(calls).toContainEqual({ method: 'POST', path: '/api/tabs/tab-1/kill', body: {} })
})

it('close-tab detaches (DELETE /api/tabs/:id)', async () => {
  const { calls } = await runTool({ action: 'close-tab', params: { target: 'tab-1' } }, { tabs: [{ id: 'tab-1', title: 'one' }] })
  expect(calls).toContainEqual({ method: 'DELETE', path: '/api/tabs/tab-1' })
})

it('kill-pane stops the pane (POST /api/panes/:id/kill) and close-pane detaches', async () => {
  const kill = await runTool({ action: 'kill-pane', params: { target: 'pane-1' } })
  expect(kill.calls).toContainEqual({ method: 'POST', path: '/api/panes/pane-1/kill', body: {} })
  const close = await runTool({ action: 'close-pane', params: { target: 'pane-1' } })
  expect(close.calls).toContainEqual({ method: 'POST', path: '/api/panes/pane-1/close', body: {} })
})
```

(`runTool` is this test file's existing harness around the mocked HTTP client; if its name differs, use the one the `kill-tab → DELETE` test at `:397` uses.) Mirror the four cases in `test/unit/cli/commands.test.ts` with the CLI verbs.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo build -p freshell-server --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test automation_unit_kill --locked; pnpm run test:vitest run test/unit/mcp/freshell-tool.test.ts test/unit/cli --config config/vitest/vitest.config.ts`

Expected: FAIL — `/api/panes/{id}/kill` is 404/405; respawn leaves the old native alive; MCP `kill-tab` still calls `DELETE`; `close-tab` is an unknown action.

- [ ] **Step 3: Add the minimal production implementation**

`pane_ops.rs` kill route (the tab route iterates the tab's panes and joins all stops):

```rust
pub(crate) async fn kill_pane(State(state): State<FreshAgentState>, Path(target): Path<String>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let Some(pane_id) = resolve_pane_target(&state, &target) else {
        return crate::fail_json_code(StatusCode::NOT_FOUND, "PANE_NOT_FOUND", format!("pane {target} not found"));
    };
    let stop = stop_pane_agents(&state, &pane_id, "kill-command");
    match tokio::time::timeout(std::time::Duration::from_secs(5), stop).await {
        Ok(()) => {
            close_pane_bookkeeping(&state, &pane_id); // the body of close_pane :406-433 after resolution
            ok_json(json!({ "ok": true, "status": "stopped" }), "pane stopped")
        }
        Err(_) => {
            let st = state.clone();
            let pid = pane_id.clone();
            tokio::spawn(async move {
                stop_pane_agents(&st, &pid, "kill-command").await; // joins the same in-flight stops
                close_pane_bookkeeping(&st, &pid);
            });
            (StatusCode::ACCEPTED, Json(json!({ "ok": false, "status": "stopping" }))).into_response()
        }
    }
}

async fn stop_pane_agents(state: &FreshAgentState, pane_id: &str, reason: &'static str) {
    if let Some(terminal_id) = state.terminal_panes.lock().expect("terminal_panes mutex").get(pane_id).cloned() {
        if let Some(stopper) = state.pane_unit_stopper() {
            stopper.stop_terminal(terminal_id, reason).await;
        }
    } else if let Some(session) = state.fresh_agent_session_for_pane(pane_id) {
        let _ = state.kill_fresh_agent_session(&session).await; // dispatches to codex/claude/opencode kill_session
    }
}
```

`respawn_pane`, before `spawn_terminal_pane` (`:964`):

```rust
    if let Some(old) = state.terminal_panes.lock().expect("terminal_panes mutex").get(&pane_id).cloned() {
        if let Some(stopper) = state.pane_unit_stopper() {
            stopper.stop_terminal(old, "respawn").await;
        }
    }
```

and `spawn_terminal_pane`'s ownership refusal path (`terminal_tabs.rs:1453/1479/1593`) adds `holderPaneId` (the layout store's pane for `liveTerminalId`) to the 409 body. `WsPaneUnitStopper::stop_terminal` = `match state.units.by_terminal(&tid) { Some(e) => stop_terminal_unit(&state, &e, UnitStopCommand { mode: Force, reason: if reason == "respawn" { StopReason::Respawn } else { StopReason::KillCommand }, initiator: format!("rest-{reason}"), operation_id: format!("rest-kill-{}", Uuid::new_v4()), record_stopped_pane: reason != "respawn" }).wait().await, None => { kill_and_broadcast(&state, &tid); } }`.

TS (`freshell-tool.ts`):

```ts
    case 'kill-tab': {
      const target = requireParam(params, 'target')
      const { tab } = await resolveTabTarget(target)
      if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
      return c.post(`/api/tabs/${encodeURIComponent(tab.id)}/kill`, {})
    }
    case 'close-tab': {
      const target = requireParam(params, 'target')
      const { tab } = await resolveTabTarget(target)
      if (!tab) return { error: `Tab '${target}' not found`, hint: "Run action 'list-tabs' to see available tabs." }
      return c.delete(`/api/tabs/${encodeURIComponent(tab.id)}`)
    }
    case 'kill-pane': {
      const target = requireParam(params, 'target')
      return c.post(`/api/panes/${encodeURIComponent(target)}/kill`, {})
    }
    case 'close-pane': {
      const target = requireParam(params, 'target')
      return c.post(`/api/panes/${encodeURIComponent(target)}/close`, {})
    }
```

CLI: the same four verbs with the existing `resolveTabTarget`/`resolvePaneTarget` resolution.

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test automation_unit_kill --locked && cargo test -p freshell-freshagent pane_ops --locked && pnpm run test:vitest run test/unit/mcp/freshell-tool.test.ts test/unit/cli --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

`kill_tab` and `kill_pane` share one `async fn stop_then_close(state, panes: Vec<String>, close: impl FnOnce(&FreshAgentState) + Send + 'static) -> Response` implementing the 5 s / 202 contract once. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: pane ops (Rust), the capability matrix and every CLI/MCP test that counts actions or renders help, the MCP bridge e2e expectations (validated in Task 32).

Run: `cargo test -p freshell-freshagent --locked && pnpm run test:vitest run test/unit/mcp test/unit/cli test/unit/tools --config config/vitest/vitest.config.ts && pnpm run typecheck`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent crates/freshell-ws/src/unit_stopper.rs crates/freshell-ws/src/lib.rs crates/freshell-server tools test/unit/mcp test/unit/cli test/fixtures/tools/rust-action-capability-matrix.json .agents/skills/freshell-orchestration/SKILL.md
git commit -m "feat(automation): kill-tab/kill-pane stop agents like Shift-X; add close-tab/close-pane; respawn-pane stops first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: The Codex activity tracker counts helper threads

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs` — per-terminal state gains `helper_turns: HashMap<String /*thread*/, Option<String> /*turn*/>` and `deferred_completion: bool`; `note_proxy_turn_started` (`:626-659`), `note_proxy_turn_completed` (`:668-773`), `note_approval_requested` (`:779-815`) and the BEL/PTY completion lane (`note_output` `:552`) consult it. Rebinding (`rebind_clears_stale_in_flight_proxy_turn_state`'s path) clears `helper_turns`.
- Test: `crates/freshell-activity/src/codex.rs` test module — replace `subagent_thread_turn_completed_mid_parent_turn_is_ignored` (`:2046`), `foreign_thread_turn_started_does_not_promote_busy` (`:2084`), `foreign_thread_approval_request_is_ignored` (`:2352`) with the tests below; keep `unbound_terminal_ignores_proxy_turn_events` (`:2091`).

**Interfaces:**
- Consumes: nothing new (the proxy already relays every thread's `turn/*` events, `codex.rs:620-624`).
- Produces: busy = the bound thread's turn OR any helper thread's turn in flight. A helper `turn/started` promotes `Idle|Unknown|Pending → Busy` (without touching the root's swallow flags or `current_proxy_turn_id`); the root's completion while helpers run yields `Changed` only (the pane stays Busy, `deferred_completion = true`); the completion of the LAST helper with no root turn in flight yields exactly the effects a root completion yields (`Idle` + one `TurnComplete`, so the idle gate arms once) when `deferred_completion` is set, and a silent `Idle` otherwise. A helper approval request is an `AttentionBoundary` exactly like a root one. Unbound terminals still ignore the proxy lane.

- [ ] **Step 1: Write the failing behavioral test**

```rust
    #[test]
    fn a_helper_turn_promotes_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("thread-parent"), 0);
        let effects = tracker.note_proxy_turn_started("t", "thread-helper", Some("turn-h"), 1_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Busy]);
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
    }

    #[test]
    fn the_parent_finishing_while_helpers_work_keeps_the_pane_busy_and_rings_once_at_the_end() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("thread-parent"), 0);
        tracker.note_proxy_turn_started("t", "thread-parent", Some("turn-p"), 1_000);
        tracker.note_proxy_turn_started("t", "thread-helper", Some("turn-h"), 1_500);
        let parent = tracker.note_proxy_turn_completed("t", "thread-parent", Some("turn-p"), Some("completed"), 2_000);
        assert!(completions(&parent).is_empty(), "no bell while a helper still works");
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
        let helper = tracker.note_proxy_turn_completed("t", "thread-helper", Some("turn-h"), Some("completed"), 3_000);
        assert_eq!(phases(&helper), vec![CodexPhase::Idle]);
        assert_eq!(completions(&helper), vec![1], "exactly one completion, at the true end");
    }

    #[test]
    fn a_helper_finishing_mid_parent_turn_changes_nothing() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("thread-parent"), 0);
        tracker.note_proxy_turn_started("t", "thread-parent", Some("turn-p"), 1_000);
        tracker.note_proxy_turn_started("t", "thread-helper", Some("turn-h"), 1_100);
        let child = tracker.note_proxy_turn_completed("t", "thread-helper", Some("turn-h"), Some("completed"), 2_000);
        assert!(completions(&child).is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
        let parent = tracker.note_proxy_turn_completed("t", "thread-parent", Some("turn-p"), Some("completed"), 3_000);
        assert_eq!(completions(&parent), vec![1]);
    }

    #[test]
    fn a_helper_approval_request_is_attention_like_the_parents() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "subagent-thread", Some("turn-s"), 2_000);
        let effects = tracker.note_approval_requested("t1", Some("subagent-thread"), "41", 3_000);
        assert!(effects.iter().any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })), "a helper waiting on you is attention");
    }
```

(`phases`/`completions` are the module's existing effect helpers; `TrackerEffect::AttentionBoundary` is the existing approval effect consumed at `freshell-ws/src/activity.rs:2124-2129` — match its actual field shape.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-activity codex --locked`

Expected: FAIL — helper turns are ignored (`effects.is_empty()`), the parent's completion rings while the helper works, and the helper approval yields no effect.

- [ ] **Step 3: Add the minimal production implementation**

In `note_proxy_turn_started`, replace the foreign-thread early return:

```rust
        if state.session_id.is_none() {
            return Vec::new(); // unbound window: unchanged policy
        }
        if state.session_id.as_deref() != Some(thread_id) {
            let previous = state.to_record();
            state.helper_turns.insert(thread_id.to_string(), turn_id.map(str::to_string));
            state.last_observed_at = at;
            if matches!(state.phase, CodexPhase::Idle | CodexPhase::Unknown | CodexPhase::Pending) {
                state.phase = CodexPhase::Busy;
                state.updated_at = at;
            }
            return self.effects_after_transition(terminal_id, previous, Vec::new());
        }
```

In `note_proxy_turn_completed`, for a foreign thread (instead of returning): ignore `inProgress`; remove it from `helper_turns`; if `helper_turns` is now empty AND no root turn is in flight (`current_proxy_turn_id.is_none()` and phase is not a root-busy phase), then: `deferred_completion` set → run the SAME completion branch the root uses (Idle + one `TurnComplete`) and clear the flag; otherwise set `Idle` silently. For the ROOT thread: when `helper_turns` is non-empty after the existing guards pass, retire `current_proxy_turn_id`, set `deferred_completion = true`, keep `Busy`, and return `Changed` effects only. The PTY/BEL completion lane (`note_output`) applies the same deferral when `helper_turns` is non-empty. In `note_approval_requested`, a foreign thread id that is in `helper_turns` is treated like the root (same `AttentionBoundary` path).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-activity --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract `fn complete_turn(state, at) -> Vec<CodexEffect>` (the shared Idle + TurnComplete branch) used by the root lane, the BEL lane and the last-helper path. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the hub that consumes tracker effects (bell/idle frames) and the Codex locator activity suite.

Run: `cargo test -p freshell-activity --locked && cargo test -p freshell-ws --lib activity --locked && cargo test -p freshell-ws --test codex_locator_activity --locked`

Expected: PASS (hub tests that encoded "helpers are ignored" — the thread-parent scenario at `activity.rs:4883-4910` — are updated to the new single-bell-at-the-end expectation).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-activity crates/freshell-ws/src/activity.rs
git commit -m "fix(activity): helper threads keep a Codex pane busy; one completion at the true end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: One idle-cleanup rule based on real idleness (24 hours), replacing the setting, the hidden cap and the post-boot sweep

**Files:**
- Create: `crates/freshell-codex/src/idle_probe.rs` (direct Codex idleness query)
- Create: `crates/freshell-ws/src/unit_cleanup.rs` (+ `pub mod unit_cleanup;`)
- Modify: `crates/freshell-codex/src/remote_proxy_side_effects.rs` / `remote_proxy.rs` (sniff `thread/queue/changed` and `thread/goal/updated` too; emit `RemoteProxyEvent::ThreadWork { thread_id }`), `crates/freshell-ws/src/codex_proxy_route.rs` (forward `TurnStarted`, `ThreadLifecycle(active)` and `ThreadWork` to `state.unit_work_tx` as `(terminal_id, at)`)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState.units` (`UnitServices`) gains `work_tx: tokio::sync::broadcast::Sender<(String, i64)>`; delete `spawn_idle_monitor` `:528-535` and `spawn_periodic`'s idle use — `spawn_stuck_monitor` keeps its existing ticker)
- Modify: `crates/freshell-terminal/src/registry.rs` (delete `enforce_idle_kills` `:2068-2135`, `IDLE_HARD_CAP_MS` `:2042`, `is_agent_mode`'s idle use, `set_auto_kill_idle_minutes` `:1781-1790`, `DEFAULT_AUTO_KILL_IDLE_MINUTES` `:980`; add `pub fn last_activity_ms(&self, tid) -> Option<i64>`, `pub fn has_viewers(&self, tid) -> bool`, `pub fn shell_at_prompt(&self, tid) -> Option<bool>` (unix: the PTY's foreground process group (`MasterPty::process_group_leader`) equals the child pid; other OS: `None`), `pub fn kill_idle(&self, tid) -> bool` (= `kill_internal(tid, "idle", false)`))
- Modify: `crates/freshell-server/src/main.rs` (delete `:1430-1444` idle seed + monitor; delete the one-shot sweep `:2370-2383`; start `unit_cleanup::spawn(ws_state.clone())`; at boot register every reconciler-held (claimable) record's reopened unit in `state.units` with `terminal_id: None` so the rule covers retained, never-restored sidecars)
- Delete: `crates/freshell-codex/src/sidecar_sweep.rs` and `sidecar_sweep_tests.rs` (the sweep's only remaining job was the one-shot cleanup; `reap_grace_from_env` goes with it)
- Modify (setting removal): `shared/settings.ts` (`:158`, `:778`, `:823`, `:869`, `:1097-1101`: the `safety` section is removed), `crates/freshell-protocol/src/settings.rs` (`:44-47`), `crates/freshell-server/src/settings.rs` (`:97-99`), `crates/freshell-server/src/settings_store.rs` (`strip_deprecated_settings_patch_aliases` `:1846-1856` drops `safety` from incoming patches so older clients are not refused; `validate_patch` `:1772` no longer lists it; `apply_live_registry_settings` `:2177-2185` drops the call), `src/components/settings/RuntimeSettings.tsx` (`:74-84` slider removed), the settings JSON fixtures that carry `"safety"` (`crates/freshell-ws/tests/common/mod.rs` and the other `crates/freshell-ws/tests/*.rs` fixtures — compiler/test-guided)
- Test: `crates/freshell-ws/tests/unit_idle_cleanup.rs`, `crates/freshell-codex/tests/idle_probe.rs`, `crates/freshell-server/src/settings_store.rs` tests; delete the tests of the removed rules (`registry.rs` `enforce_idle_kills_*` `:12593-12940`, `:13228-13244`, `:7091`; `settings_store.rs:2234 patch_applies_auto_kill_idle_minutes_live_to_registry`; `terminal_lifetime_claim.rs` reaping cases `:189-308`; `test/unit/client/components/SettingsView.behavior.test.tsx:455-465`); update `test/e2e-browser/specs/cfg03-backup-restore.spec.ts` (`:224-379`: use `terminal.scrollback` as the backup/restore sentinel instead of `safety.autoKillIdleMinutes`) and `test/e2e-browser/specs/harness-14-server-clock.spec.ts` (`:14`, `:179`: the idle-reap assertion uses `FRESHELL_UNIT_IDLE_LIMIT_MS` on its server fixture instead of advancing the virtual clock; its other clock assertions stay)

**Interfaces:**
- Consumes: Task 12 (`stop_terminal_unit`), Task 14 (held threads), Task 21 (tracker phases), Task 4 (`StopMode::Graceful`).
- Produces:
  ```rust
  // freshell-codex/src/idle_probe.rs
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum CodexIdleness { Idle, Busy { thread_id: String, why: &'static str } } // why: "active" | "waiting-on-user" | "queued" | "goal"
  /// One direct query: thread/loaded/list, then per thread thread/read, thread/queue/list, thread/goal/get.
  pub async fn query_codex_idleness(ws_url: &str) -> Result<CodexIdleness, String>;
  // freshell-ws/src/unit_cleanup.rs
  pub const AGENT_IDLE_LIMIT_MS: i64 = 24 * 60 * 60 * 1000;   // env FRESHELL_UNIT_IDLE_LIMIT_MS overrides (tests)
  pub const IDLE_QUIET_WINDOW_MS: i64 = 2 * 60 * 1000;        // env FRESHELL_UNIT_IDLE_QUIET_MS overrides (tests)
  pub const POLITE_STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
  pub fn spawn(state: WsState);
  ```
  The rule (one rule, every terminal pane): when a pane has had no activity and no attached viewer for `AGENT_IDLE_LIMIT_MS`, ask whether it is really idle; if so, stop it politely. "Really idle": Codex — a direct query shows every loaded thread (helpers included) `idle`/`notLoaded`/`systemError`, nothing queued, no goal `active`/`usageLimited`, then NO work event for the unit during `IDLE_QUIET_WINDOW_MS`, then the same query again; other coding agents — their activity tracker reports idle with no pending approval at both ends of the quiet window and no screen activity in between; plain shells — at the prompt (`shell_at_prompt == Some(true)`) with no screen activity across the window. Waiting on approval/user input is never idle. Not idle → the activity clock restarts. Polite stop: `stop_terminal_unit(Graceful { POLITE_STOP_GRACE }, Cleanup, record_stopped_pane: true)` (escalation is logged at WARN by the unit); shells: `kill_idle`. Timers are armed for the earliest instant the rule could hold, re-armed from the latest activity timestamp — never a fixed interval.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/unit_idle_cleanup.rs` (own binary; short limits via env):

```rust
#![cfg(target_os = "linux")]
#[path = "support/unit_harness.rs"]
mod unit_harness;
#[path = "../../freshell-containment/tests/support/capture.rs"]
mod capture;

use std::time::Duration;

use serde_json::json;
use tracing_subscriber::prelude::*;
use unit_harness::{fake_codex, HarnessOpts, UnitHarness};

fn short_limits() {
    std::env::set_var("FRESHELL_UNIT_IDLE_LIMIT_MS", "1500");
    std::env::set_var("FRESHELL_UNIT_IDLE_QUIET_MS", "500");
}

async fn codex_unit(behavior: serde_json::Value, thread: &str) -> (UnitHarness, u32) {
    short_limits();
    let h = UnitHarness::start(HarnessOpts { behavior, ..Default::default() }).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, &format!("crq-{thread}"), Some(thread)).await;
    let native = h.native_pid(&tid);
    drop(ws); // no viewer
    (h, native)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_really_idle_codex_unit_is_stopped_politely() {
    let (h, native) = codex_unit(json!({}), "t-idle").await;
    fake_codex::wait_until("cleanup stop", Duration::from_secs(10), || !fake_codex::pid_alive(native)).await;
    let manifest = h.native_manifest_by_pid(native);
    assert_eq!(manifest.signals.first().map(|s| s.sig.as_str()), Some("SIGTERM"), "a polite stop, not a kill");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_busy_helper_thread_keeps_the_unit() {
    let (h, native) = codex_unit(json!({"turnCompleteDelayMs": 100, "helperThreadOnTurn": {"id": "t-h", "durationMs": 60000}}), "t-help").await;
    let mut ws = h.connect().await;
    let tid = h.state.units.all()[0].terminal_id.clone().unwrap();
    h.send(&mut ws, json!({"type": "terminal.input", "terminalId": tid, "data": "turn go\r"})).await;
    drop(ws);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(fake_codex::pid_alive(native), "a helper is still working: not idle");
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_messages_keep_the_unit() {
    let (_h, native) = codex_unit(json!({"queuedSubmissions": {"t-q": 1}}), "t-q").await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(fake_codex::pid_alive(native));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_automatically_continuing_goal_keeps_the_unit_but_a_finished_goal_does_not() {
    let (_h, keep) = codex_unit(json!({"goals": {"t-g1": {"status": "active"}}}), "t-g1").await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(fake_codex::pid_alive(keep));
    let (_h2, done) = codex_unit(json!({"goals": {"t-g2": {"status": "complete"}}}), "t-g2").await;
    fake_codex::wait_until("finished goal is idle", Duration::from_secs(10), || !fake_codex::pid_alive(done)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn waiting_on_approval_is_not_idle() {
    let (_h, native) = codex_unit(json!({"approvalWaiting": ["t-appr"]}), "t-appr").await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(fake_codex::pid_alive(native), "cleanup leaves a pane waiting for the user alone");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_polite_stop_that_does_not_finish_is_forced_with_a_warning() {
    let cap = capture::Captured::default();
    let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(cap.clone()));
    let (_h, native) = codex_unit(json!({"ignoreSigterm": true}), "t-stubborn").await;
    fake_codex::wait_until("forced after the grace", Duration::from_secs(15), || !fake_codex::pid_alive(native)).await;
    assert!(cap.has(tracing::Level::WARN, "unit.stop.escalated"));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_attached_viewer_keeps_the_unit() {
    short_limits();
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-view", Some("t-view")).await;
    let native = h.native_pid(&tid);
    h.send(&mut ws, json!({"type": "terminal.attach", "terminalId": tid, "requestId": "ra", "intent": "viewport_hydrate"})).await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(fake_codex::pid_alive(native), "someone is looking at it");
}
```

(`UnitHarness::native_manifest_by_pid(pid)` reads `<manifests>/native-<pid>.json`; add it to the harness.)

`crates/freshell-codex/tests/idle_probe.rs` (`#![cfg(all(feature = "real-transport", target_os = "linux"))]`): spawn the realistic fake with each behavior (`{}`, `queuedSubmissions`, `goals active`, `approvalWaiting`, a running helper turn) via `fake_codex::FakeAppServer`, call `query_codex_idleness(&format!("ws://127.0.0.1:{port}"))`, and assert `Idle`, `Busy{why:"queued"}`, `Busy{why:"goal"}`, `Busy{why:"waiting-on-user"}`, `Busy{why:"active"}` respectively.

A shell case in `unit_idle_cleanup.rs`: `a_shell_at_its_prompt_is_cleaned_up_but_a_running_command_is_not` — create two `mode: "shell"` panes (shell `bash`), send `sleep 600\r` to one; after 5 s the idle one's row is gone (`!h.state.registry.is_running(..)`), the busy one still runs.

Settings test (`settings_store.rs`): `a_patch_carrying_the_retired_auto_kill_setting_is_accepted_and_ignored` — PATCH `{"safety": {"autoKillIdleMinutes": 30}}` → 200, and the stored settings have no `safety` key.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_idle_cleanup --locked; cargo test -p freshell-codex --features real-transport --test idle_probe --locked`

Expected: FAIL — no unit is ever stopped by the new rule (the old monitor ignores Codex panes for 24 h), and `query_codex_idleness` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-codex/src/idle_probe.rs`:

```rust
use std::sync::Arc;

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexIdleness {
    Idle,
    Busy { thread_id: String, why: &'static str },
}

pub async fn query_codex_idleness(ws_url: &str) -> Result<CodexIdleness, String> {
    let transport = crate::transport::TungsteniteTransport::connect(ws_url).await?;
    let client = crate::app_server::CodexAppServerClient::new(Arc::new(transport));
    client.initialize().await.map_err(|e| e.to_string())?;
    let result = async {
        for thread in client.list_loaded_threads().await.map_err(|e| e.to_string())? {
            let read = client.request("thread/read", json!({"threadId": thread, "includeTurns": false})).await.map_err(|e| e.to_string())?;
            let status = &read["thread"]["status"];
            if status["type"] == "active" {
                let waiting = status["activeFlags"].as_array().is_some_and(|f| !f.is_empty());
                return Ok(CodexIdleness::Busy { thread_id: thread, why: if waiting { "waiting-on-user" } else { "active" } });
            }
            let queue = client.request("thread/queue/list", json!({"threadId": thread})).await.map_err(|e| e.to_string())?;
            if queue["data"].as_array().is_some_and(|d| !d.is_empty()) {
                return Ok(CodexIdleness::Busy { thread_id: thread, why: "queued" });
            }
            let goal = client.request("thread/goal/get", json!({"threadId": thread})).await.map_err(|e| e.to_string())?;
            if matches!(goal["goal"]["status"].as_str(), Some("active") | Some("usageLimited")) {
                return Ok(CodexIdleness::Busy { thread_id: thread, why: "goal" });
            }
        }
        Ok::<_, String>(CodexIdleness::Idle)
    }
    .await;
    client.close().await;
    result
}
```

(`client.request(method, params) -> Result<Value, CodexAppServerError>` is the generic JSON-RPC call `CodexAppServerClient` already uses internally for `read_thread`/`list_loaded_threads`; expose it `pub` if it is private. A missing experimental method (older Codex) answers JSON-RPC `-32601`; treat that as "no queue" / "no goal" rather than an error.)

`crates/freshell-ws/src/unit_cleanup.rs`:

```rust
//! The ONE idle-cleanup rule (design 5.4). Deadline timers only: each unit's
//! timer is armed for the earliest instant the rule could hold and re-armed
//! from the latest activity — never a fixed polling interval.
use std::time::Duration;

use crate::unit_lifecycle::{stop_terminal_unit, UnitStopCommand};
use crate::WsState;

pub const AGENT_IDLE_LIMIT_MS: i64 = 24 * 60 * 60 * 1000;
pub const IDLE_QUIET_WINDOW_MS: i64 = 2 * 60 * 1000;
pub const POLITE_STOP_GRACE: Duration = Duration::from_secs(5);

fn env_ms(key: &str, default: i64) -> i64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).filter(|v: &i64| *v > 0).unwrap_or(default)
}

/// One watcher per terminal row (shell or unit), started for every row the
/// registry reports and for every directory unit without a terminal.
pub fn spawn(state: WsState) {
    let limit = env_ms("FRESHELL_UNIT_IDLE_LIMIT_MS", AGENT_IDLE_LIMIT_MS);
    let quiet = env_ms("FRESHELL_UNIT_IDLE_QUIET_MS", IDLE_QUIET_WINDOW_MS);
    let mut created = state.registry.subscribe_created(); // the registry's existing creation notification (terminals.changed source)
    tokio::spawn(async move {
        for tid in state.registry.running_ids() {
            tokio::spawn(watch_terminal(state.clone(), tid, limit, quiet));
        }
        while let Some(tid) = created.recv().await {
            tokio::spawn(watch_terminal(state.clone(), tid, limit, quiet));
        }
    });
}

async fn watch_terminal(state: WsState, tid: String, limit: i64, quiet: i64) {
    loop {
        let Some(last) = state.registry.last_activity_ms(&tid) else { return };
        let due = last + limit;
        let now = crate::terminal::now_ms();
        if now < due {
            tokio::time::sleep(Duration::from_millis((due - now) as u64)).await;
            continue; // re-read: activity may have moved the deadline
        }
        if state.registry.has_viewers(&tid) {
            state.registry.touch_activity(&tid, now); // being looked at counts as activity
            continue;
        }
        if !really_idle(&state, &tid, quiet).await {
            state.registry.touch_activity(&tid, crate::terminal::now_ms());
            continue;
        }
        match state.units.by_terminal(&tid) {
            Some(entry) => {
                stop_terminal_unit(&state, &entry, UnitStopCommand {
                    mode: freshell_containment::StopMode::Graceful { grace: POLITE_STOP_GRACE },
                    reason: freshell_containment::StopReason::Cleanup,
                    initiator: "idle-cleanup".into(),
                    operation_id: format!("unit-cleanup-{}", uuid::Uuid::new_v4()),
                    record_stopped_pane: true,
                }).wait().await;
            }
            None => {
                state.registry.kill_idle(&tid);
            }
        }
        return;
    }
}

async fn really_idle(state: &WsState, tid: &str, quiet: i64) -> bool {
    let first = snapshot_idle(state, tid).await;
    if !first {
        return false;
    }
    let mut work = state.units.work_tx.subscribe();
    let before = state.registry.last_activity_ms(tid);
    let quiet_end = tokio::time::sleep(Duration::from_millis(quiet as u64));
    tokio::pin!(quiet_end);
    loop {
        tokio::select! {
            _ = &mut quiet_end => break,
            msg = work.recv() => if matches!(msg, Ok((ref t, _)) if t == tid) { return false },
        }
    }
    state.registry.last_activity_ms(tid) == before && snapshot_idle(state, tid).await
}

async fn snapshot_idle(state: &WsState, tid: &str) -> bool {
    let mode = state.registry.mode_of(tid).unwrap_or_default();
    if mode == "codex" {
        let Some(url) = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global().sidecar_ws_url(tid) else { return false };
        return matches!(freshell_codex::idle_probe::query_codex_idleness(&url).await, Ok(freshell_codex::idle_probe::CodexIdleness::Idle));
    }
    if mode == "shell" {
        return state.registry.shell_at_prompt(tid).unwrap_or(true);
    }
    state.activity.is_idle_without_pending_approval(tid).unwrap_or(true)
}
```

(`subscribe_created`, `running_ids`, `touch_activity`, `mode_of` are small additions to `TerminalRegistry` (a creation callback list fed from `create_inner`, a running-id snapshot, an activity-clock bump, a mode read); `state.activity.is_idle_without_pending_approval(tid)` is a read over the activity hub's per-terminal phase and pending-approval set (`crates/freshell-ws/src/activity.rs`). Units registered at boot without a terminal (retained, never-restored sidecars) get the same loop keyed by unit id, using the record's `ws_url` for the Codex query and `unit.stop(...)` directly.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_idle_cleanup --locked && cargo test -p freshell-codex --features real-transport --test idle_probe --locked && cargo test -p freshell-server --lib settings_store --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Unify the two loops (terminal-keyed and unit-keyed) behind one `enum CleanupTarget { Terminal(String), DetachedUnit(UnitId) }` with `last_activity`, `idle_snapshot` and `stop` methods. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

The setting removal crosses Rust, the TS settings schema, the client settings UI, many ws test fixtures and two e2e specs; the registry lost its sweep. Impacted set = the whole Rust workspace plus client/shared tests:

Run: `cargo test --workspace --exclude freshell-tauri --locked && pnpm run test:vitest run test/unit/shared test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.core.test.tsx test/unit/client/store/state-edge-cases.test.ts --config config/vitest/vitest.config.ts && pnpm run typecheck && pnpm run lint`

Expected: PASS (the two e2e specs are run on the cloud backend in Task 32).

- [ ] **Step 7: Commit the task**

```bash
git add -A crates/freshell-codex crates/freshell-ws crates/freshell-terminal crates/freshell-server crates/freshell-protocol shared/settings.ts src/components/settings/RuntimeSettings.tsx test/unit test/e2e-browser/specs/cfg03-backup-restore.spec.ts test/e2e-browser/specs/harness-14-server-clock.spec.ts
git commit -m "feat(cleanup): one idle rule — 24h of real idleness, asked from the agent, polite stop then force

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 23: Every other coding-agent pane on the same containment (Claude Code, OpenCode, Gemini, Kimi, Amplifier, extension CLIs, freshclaude, freshcodex)

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (the CLI create branch `:6295-6328`/`:6489` and `respawn_agent_terminal` `:7260`: EVERY non-`shell` CLI mode that does not take the managed-runtime path runs Task 12's `StartScope` flow with `UnitPlacement { main_is_screen: true, .. }`; for these the screen watch is also the main watch — `scope.bind` calls `unit.set_main(same ProcWatch)`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (REST CLI creates `:2920`, same rule)
- Modify: `crates/freshell-freshagent/src/claude.rs` (`spawn_sidecar` `:9524-9586`: create a per-session unit (`containment.create_unit`, label provider `"claude"`), spawn the Node sidecar with `unit.tokio_command(..)` (keeping the optional `/usr/bin/setpriv` prefix as the program, the sidecar as its argument), `set_main` on the sidecar pid; `teardown_removed_session` `:9926-9978` + `confirm_captured_claude_tree_dead` `:9856-9898` + `spawn_claude_tree_death_escalation` `:9834-9858`: replaced by `unit.stop(StopRequest::new(mode, reason, ..).soft_interrupt(send {"type":"shutdown"} on the sidecar stdin))` and awaiting its `StopHandle` — `TeardownConfirmation` becomes `Confirmed` only; `shutdown()` `:1796-1815` stops every session's unit; delete `reap_owned_claude_sidecars` `:9703-9714`)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`spawn_sidecar_notifying` `:7116-7240`: per-session unit, spawn via `unit.tokio_command`, main = `listening_socket_owner(port, [launcher])` as in Task 10; exit watcher `spawn_exit_watcher` `:9735-10030`: the requested-kill arm stops the unit (`Force`) and awaits Gone; the crash arm (`child.wait()` resolved unrequested) stops the unit with `AgentExited` then runs the existing crash self-heal/attention path; delete every `reap_owned_codex_sidecars` call (`:2275, :2326, :2512, :2533, :2582, :2719, :6470`) and the `session_lease::kill_and_confirm_recorded_tree_dead` use; the `PlatformLimited` result is no longer produced)
- Modify: `crates/freshell-freshagent/src/codex_sidecar_tracking.rs` (records gain `unit_id`, `main_pid`, `main_starttime`)
- Modify: `crates/freshell-opencode/Cargo.toml` (`freshell-containment` dependency), `crates/freshell-opencode/src/transport.rs` (`TokioProcessSpawner::spawn` `:230-317`: the shared `opencode serve` daemon runs in ITS OWN unit (one per daemon generation, label provider `"opencode-daemon"`); `kill` `:349-354` = `unit.stop(Force, ..)`; delete `reap_owned_processes` `:357-389`)
- Modify: `crates/freshell-freshagent/src/session_lease.rs` (delete the tree-reap and polling confirmation machinery `:46-783` that only the fresh-agent kill paths used: `kill_and_confirm_tree_dead`, `kill_and_confirm_recorded_tree_dead`, `sweep_captured_tree_until_dead`, condemned-identity capture; keep any lease/locking code unrelated to process death)
- Modify: `crates/freshell-codex/src/transport.rs` (delete `reap_owned_codex_sidecars` `:90-121`; its last callers are gone)
- Create: `crates/freshell-ws/tests/fixtures/fake-claude-agent.sh` (an agent CLI stand-in: starts a `setsid` child and a `nohup` job like Claude Code's shell commands, prints `FAKE_AGENT_READY`, then `exec`s nothing — it waits; input `exit` makes it exit 0)
- Test: `crates/freshell-ws/tests/unit_other_agents.rs`; freshagent tests `freshclaude_kill_confirms_through_the_unit` (in `crates/freshell-ws/tests/freshagent_claude_kill_interrupt.rs`) and `freshcodex_kill_signals_the_native_first_and_confirms_gone` (in `crates/freshell-ws/tests/freshagent_session_lease.rs`)

**Interfaces:**
- Consumes: Tasks 2–7 (containment on every OS), Task 12 (`StartScope`, `stop_terminal_unit`), Task 17 (screen = main decisions).
- Produces: one unit per coding-agent pane for every provider; freshopencode panes share the opencode daemon's single unit by design (decision 15), so a freshopencode pane kill ends that pane's session and never stops the shared daemon (unchanged behavior), while the daemon's own process tree is now fully contained and confirmed dead on discard/crash/shutdown.

- [ ] **Step 1: Write the failing behavioral test**

`crates/freshell-ws/tests/fixtures/fake-claude-agent.sh`:

```bash
#!/bin/bash
# Claude Code stand-in: its shell commands run in their own sessions, and it
# can leave detached jobs behind — exactly what leaks today (defect 13).
DIR="${FAKE_AGENT_PID_DIR:?}"
setsid sleep 600 & echo $! > "$DIR/setsid.pid"
nohup sh -c 'sleep 600 & echo $! > "'"$DIR"'/nohup.pid"' >/dev/null 2>&1 &
echo $$ > "$DIR/main.pid"
echo FAKE_AGENT_READY
while IFS= read -r line; do
  [ "$line" = "exit" ] && exit 0
done
```

`crates/freshell-ws/tests/unit_other_agents.rs`:

```rust
#![cfg(target_os = "linux")]
mod common;

use std::time::Duration;

use serde_json::json;

fn agent_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let mut spec = common::sleeper_cli_spec(name);
    spec.default_cmd = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-claude-agent.sh").display().to_string();
    spec
}

fn read_pid(dir: &std::path::Path, name: &str) -> u32 {
    std::fs::read_to_string(dir.join(name)).unwrap().trim().parse().unwrap()
}

fn alive(pid: u32) -> bool {
    freshell_containment::process::is_running(pid)
}

async fn create_agent(mode: &str) -> (common::TestWs, freshell_ws::WsState, String, tempfile::TempDir) {
    let pids = tempfile::tempdir().unwrap();
    std::env::set_var("FAKE_AGENT_PID_DIR", pids.path());
    let (url, _registry, state) = common::spawn_server_with_specs_and_state(vec![agent_spec(mode)]).await;
    let (mut ws, _) = common::connect_and_capture_inventory(&url).await;
    common::send_json(&mut ws, json!({"type": "terminal.create", "requestId": format!("crq-{mode}"), "mode": mode, "shell": "system"})).await;
    let created = common::next_frame_of_type(&mut ws, "terminal.created").await;
    let tid = created["terminalId"].as_str().unwrap().to_string();
    common::drain_until_marker_or_deadline(&mut ws, &tid, "FAKE_AGENT_READY", Duration::from_secs(10)).await;
    (ws, state, tid, pids)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_like_pane_kill_reaps_its_setsid_and_detached_children() {
    let (mut ws, state, tid, pids) = create_agent("claude").await;
    assert!(state.units.by_terminal(&tid).is_some(), "the Claude pane is a unit");
    let (main, setsid, nohup) = (read_pid(pids.path(), "main.pid"), read_pid(pids.path(), "setsid.pid"), read_pid(pids.path(), "nohup.pid"));
    common::send_json(&mut ws, json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-claude"})).await;
    let _ = common::next_frame_of_type(&mut ws, "terminal.killed").await;
    assert!(!alive(main), "main gone at the ack");
    let unit_gone = tokio::time::Instant::now() + Duration::from_secs(5);
    while alive(setsid) || alive(nohup) {
        assert!(tokio::time::Instant::now() < unit_gone, "descendants in other sessions are killed through containment");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_exiting_on_its_own_ends_the_whole_unit() {
    let (mut ws, _state, tid, pids) = create_agent("gemini").await;
    let setsid = read_pid(pids.path(), "setsid.pid");
    common::send_input(&mut ws, &tid, "exit\n").await;
    let exit = common::next_frame_of_type(&mut ws, "terminal.exit").await;
    assert_eq!(exit["exitCode"], 0);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while alive(setsid) {
        assert!(tokio::time::Instant::now() < deadline, "nothing is left behind");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_agent_mode_is_contained() {
    for mode in ["opencode", "kimi", "amplifier"] {
        let (_ws, state, tid, _pids) = create_agent(mode).await;
        let entry = state.units.by_terminal(&tid).expect(mode);
        assert!(entry.unit.main_is_screen(), "{mode}: main is the screen");
    }
}
```

(`common::spawn_server_with_specs_and_state` (`common/mod.rs:850`) returns the `WsState`; it must also install the unit screen-exit and on-bind hooks — add that to `common/mod.rs`'s server builder in this task so every ws test server behaves like production. `common::send_json(ws, value)` is a 3-line helper added to `common/mod.rs` if it does not exist; `drain_until_marker_or_deadline` (`:1634`) is called with its actual parameter order.)

Freshagent tests (in the named existing files, using their existing fakes): `freshclaude_kill_confirms_through_the_unit` — after `freshAgent.kill`, the fake sidecar pid and its tagged child are dead and `freshAgent.killed{success:true}` carries no `TEARDOWN_PLATFORM_LIMITED`/`TEARDOWN_NOT_CONFIRMED` code; `freshcodex_kill_signals_the_native_first_and_confirms_gone` — with `CODEX_CMD` = the realistic launcher, the native's manifest records `SIGINT` first and both launcher and native are dead at `freshAgent.killed`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test unit_other_agents --locked`

Expected: FAIL — `the Claude pane is a unit` panics (only Codex panes are units), and the `setsid`/`nohup` children survive the kill.

- [ ] **Step 3: Add the minimal production implementation**

- CLI create branch: wrap the non-managed CLI spawn exactly like Task 12's step list, with `StartScope::begin(state, &mode, &mode, &create.request_id, &tid, resume_id)` (provider = mode), `create_in_unit(.., UnitPlacement { main_is_screen: true, .. })`, and `scope.bind(&tid, pid)` followed by `scope.unit().set_main(scope.unit().screen().unwrap())`. Shell panes and managed-runtime panes keep `registry.create`.
- freshclaude spawn:
  ```rust
  let unit = state.units.containment.create_unit(UnitId::mint(), UnitLabel { provider: "claude".into(), session_id: Some(session_id.clone()), terminal_id: None })?;
  let mut cmd = match setpriv { Some(p) => unit.tokio_command(&p, &setpriv_args_then_node_and_script, MemberRole::Agent)?, None => unit.tokio_command("node", &[script], MemberRole::Agent)? };
  cmd.env(CLAUDE_SIDECAR_OWNERSHIP_ENV, &ownership_id).stdin(piped()).stdout(piped()).kill_on_drop(true);
  let child = cmd.spawn()?;
  unit.set_main(ProcWatch::open(child.id().unwrap())?);
  ```
  Teardown: `let report = unit.stop(StopRequest::new(StopMode::Graceful { grace: Duration::from_secs(2) }, reason, initiator).soft_interrupt(Box::new(move || { let _ = stdin_tx.send(r#"{"type":"shutdown"}"#.into()); }))).wait().await;` for natural teardown, `StopMode::Force` for kills; the lane commits its registry stop after `wait()` (Gone) — which is exactly where `Confirmed` used to be produced.
- freshcodex: same shape as Task 10 inside `spawn_sidecar_notifying`; the exit watcher's two arms call `unit.stop(..).wait().await` before their existing commit/crash code.
- All three fresh-agent kill handlers (`claude.rs:2768`, `codex.rs:5026`, `opencode_ws.rs:3441`): `StopOutcome::AlreadyStopping` (Task 8) now means JOIN — await the session unit's in-flight `StopHandle` (a `freshAgent.kill` while a polite/recovery stop runs calls `unit.stop(Force, ..)`, which escalates) and answer `freshAgent.killed` at Gone; a second kill never gets a refusal for "already stopping".
- opencode daemon: `TokioProcessSpawner::spawn` builds the command with a unit created per daemon generation; `kill()` → `unit.stop(StopRequest::new(StopMode::Force, StopReason::ServerShutdown, "opencode-daemon"))` (fire-and-forget is fine here: the daemon is not a pane and its own respawn ladder already waits for the process exit it observes).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test unit_other_agents --test freshagent_claude_kill_interrupt --test freshagent_session_lease --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The WS CLI branch, the Codex branch and `respawn_agent_terminal` now share `spawn_codex_pane_in_unit`-style flow: generalize Task 12's helper to `spawn_agent_pane_in_unit(state, create, tid, mode, main_is_screen, plan: Option<CodexPlan>)` and delete the duplicates. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Every agent lane changed its spawn and kill. Impacted set = the Rust workspace:

Run: `cargo test --workspace --exclude freshell-tauri --locked && scripts/sandbox-test.sh "cargo test -p freshell-ws --test unit_other_agents --test unit_kill --locked"`

Expected: PASS (the sandbox run proves the same behavior on the degraded tag backend).

- [ ] **Step 7: Commit the task**

```bash
git add -A crates/freshell-ws crates/freshell-freshagent crates/freshell-opencode crates/freshell-codex
git commit -m "feat(containment): every coding-agent pane is a contained unit; fresh-agent sidecars confirm death through units

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice E — Remove the "unconfirmed death" machinery (server)

### Task 24: Remove fences, platform-limited outcomes, force-clear and acknowledged-risk starts from the server

**Files (each item is from the inventory in `plan-ownership-terminal.md` §6; line numbers at base):**
- Modify: `crates/freshell-ownership/src/lib.rs` — delete `OwnershipState::Fenced` (`:343-364`), `FenceReason` + wire strings (`:383-446`), `force_release_platform_limited` + `ForceReleaseOutcome` (`:3132-3253`, `:553-571`), `begin_handoff_acknowledged_cleared_unverified` + `AcknowledgedStartOutcome` (`:1760-1899`, `:530-551`), `fence_unconfirmed_handoff`/`_with_prior`/`fence_unconfirmed_stop`/`fence_unconfirmed_live` (`:2780-3002`), `release_fenced` (`:3004-3058`), `stale_start_fences` + `StaleStartFence` (`:3060-3130`, `:670-711`), `recover_stale_stoppings` + `register_stop_settlement` + `StaleStopping` + `SessionRecord.stop_settled` (`:3699-3828`, `:657-668`, `:796-802`), the Fenced replay arm (`:729-739`, `:754-777`, `replay_fields_for`). `recover_stale_starts` (`:3885`) stays but never fences: an over-aged start is cancelled (its registered cancellation now cancels the pane's `StartScope`, Task 12), and when its settle does not conclude within the budget the host stops the partial unit (`Force`) and calls `fail()` after Gone. Delete the ~21 fence unit tests (e.g. `:5687`, `:6713`, `:6859`, `:6929`, `:9910-10250`).
- Modify: `crates/freshell-server/src/main.rs` — delete `probe_stale_start_fences` (`:488-767`), `broadcast_fence_released`/`broadcast_fenced_transition` (`:398-486`); `recover_stale_start` (`:175-396`) becomes the cancel → stop-unit → `fail` sequence above; the watchdog loop (`:1544-1597`) keeps only `recover_stale_starts` (its pre-existing 5 s ticker is unchanged; no new interval is added); delete the fence watchdog tests (`:5451-7759`) and rewrite the stale-start ones (`an_unregistered_stale_start_fences_never_vacant` becomes `an_unsettled_stale_start_is_stopped_then_vacated`).
- Modify: `crates/freshell-freshagent/src/session_handoff.rs` — delete actions `clear-stale-bookkeeping` and `stop-and-reopen` and the `acknowledgePlatformLimitedRisk` body field (parser `:4745-4778`), `clear_stale_bookkeeping` (`:443-561`), the fenced branches of `run()` (`:730-1095`) and their codes (`CLEARED_UNVERIFIED_FENCED`, `PLATFORM_LIMITED_FENCED`, `STALE_START_FENCED`, `STALE_STOP_FENCED`, `*_FORCE_CLEARED`, `SESSION_FENCED`), the non-Linux refusal (`:648-679`, `PLATFORM_LIMITED_PRECHECK`), `StopResult::PlatformLimited`/`ReapAnswer`/`StopOutcomePriv::PlatformLimitedFenced` arms (`:212-279`), the background reconfirmation tasks (`:2782-2933`, `:3635-3949`, abort-path fences `:2502-2604`), and the test hooks `force_platform_limited`, `force_platform_limited_skip`, `force_unsupported_preflight` (`:72-74`); `session_handoff/tests.rs` loses its ~30 fence tests and gains the two below.
- Modify: `crates/freshell-freshagent/src/claude.rs` (`SESSION_FENCED` `:3328-3356`, `TEARDOWN_PLATFORM_LIMITED` `:3658-3680`, `TEARDOWN_NOT_CONFIRMED` `:3603` — gone: kills ack at Gone; `confirm_fenced_prior_dead` `:955-1010`, `kill_raw_for_watchdog` `:1110`, condemned-prior plumbing), `codex.rs` (`SESSION_FENCED` `:5441`, `TEARDOWN_*` `:5636`, `:5705`, `confirm_fenced_prior_dead` `:1032`, the PlatformLimited arm of `settle_removed_session` `:1316-1335`, condemned-prior plumbing), `opencode_ws.rs` (`SESSION_FENCED` `:3994`)
- Modify: `crates/freshell-ws/src/lib.rs` (ready replay mapping `:645-680` drops Fenced), `identity_ownership.rs:691`, `reconcile_freshagent.rs:64`, `terminal.rs:1311`, `terminal.rs:9511`
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`RuntimeOwnerReplay.state` loses `"fenced"` `:1225-1235`; `SessionRuntimeOwner.fenced` removed `:1284-1293` — `reason` stays (handoff-failed uses it); tests `:2059-2088`, `:2326-2339` updated), `shared/ws-protocol.ts` (`:1305-1308`, `:1880-1886`: the client keeps accepting an absent `fenced`; the TS schema drops the field — the client code that read it is removed in Task 28, so until then the client treats it as always-false)
- Test: `crates/freshell-freshagent/src/session_handoff/tests.rs` (`the_force_clear_actions_no_longer_exist`, `a_switch_off_linux_is_not_refused_for_platform_reasons`), `crates/freshell-ownership/src/unit_scope_tests.rs` (`an_unconfirmed_stop_stays_stopping_until_gone`), `crates/freshell-server/src/main.rs` tests (`an_unsettled_stale_start_is_stopped_then_vacated`)

**Interfaces:**
- Consumes: units everywhere (Tasks 12–23): every runtime death is confirmed through a unit's Gone on every OS, so nothing needs a fence.
- Produces: `OwnershipState` = `Vacant | Starting | Live | Handoff | Stopping | Aliased` (Running = Live, Stopping = Stopping, Gone = Vacant; Starting/Handoff are the existing in-progress operations; Aliased is re-keying). An unconfirmed stop stays `Stopping` (error-logged by the unit) until Gone. `POST /api/sessions/handoff` accepts only `action: "switch"`.

- [ ] **Step 1: Write the failing behavioral test**

```rust
// crates/freshell-ownership/src/unit_scope_tests.rs
#[test]
fn an_unconfirmed_stop_stays_stopping_until_gone() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "a", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op", "test", NOW);
    // No fence API exists any more: the only exit from Stopping is Gone (or an abort with the runtime alive).
    let replay = reg.snapshot_records();
    assert!(replay.iter().all(|r| serde_json::to_value(&r.state).unwrap() != serde_json::json!("fenced")));
    assert!(matches!(reg.observe("codex", "a").state, OwnershipState::Stopping { .. }));
    reg.commit_unit_stop("u1");
    assert_eq!(reg.observe("codex", "a").state, OwnershipState::Vacant);
}
```

```rust
// crates/freshell-freshagent/src/session_handoff/tests.rs
#[tokio::test]
async fn the_force_clear_actions_no_longer_exist() {
    let fx = HandoffFixture::new().await; // the file's existing route fixture
    for action in ["clear-stale-bookkeeping", "stop-and-reopen"] {
        let res = fx.post_handoff(serde_json::json!({"action": action, "provider": "codex", "sessionId": "s"})).await;
        assert_eq!(res.status(), 400, "{action} was removed with the fences");
    }
}

#[tokio::test]
async fn a_switch_off_linux_is_not_refused_for_platform_reasons() {
    let fx = HandoffFixture::new().await;
    let res = fx.post_handoff(fx.switch_body()).await;
    let body: serde_json::Value = res.json().await;
    assert_ne!(body["code"], "PLATFORM_LIMITED_PRECHECK");
}
```

(Use the fixture names `session_handoff/tests.rs` actually defines for its route tests; the assertions are the contract.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ownership unit_scope_tests::an_unconfirmed_stop_stays_stopping_until_gone --locked; cargo test -p freshell-freshagent the_force_clear_actions_no_longer_exist a_switch_off_linux_is_not_refused --locked`

Expected: FAIL — the clear-stale-bookkeeping action is accepted (not 400), and with the test hook `force_unsupported_preflight` (still present) the switch answers `PLATFORM_LIMITED_PRECHECK`. (The ownership test passes already on its own assertions; it guards the removal from regressing.)

- [ ] **Step 3: Add the minimal production implementation**

Delete the listed code. Every match on `OwnershipState`, `StopOutcome`, `FenceReason` and `ReplayOwnerState` across the workspace is updated by the compiler's exhaustiveness errors; each former `Fenced` arm is removed (the state can no longer occur), and each caller that used to fence an unconfirmed reap now awaits its unit's `StopHandle` (already true after Tasks 15 and 23).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ownership --locked && cargo test -p freshell-freshagent session_handoff --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Remove now-dead helpers the deletions orphaned (`cargo build --workspace` warnings with `-D dead_code` via `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`), and update the crate doc of `freshell-ownership` (`:1-30`) to describe the six states and the unit mapping. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

This deletes a state from the shared coordinator: the impacted set is the Rust workspace plus the TS protocol tests.

Run: `cargo test --workspace --exclude freshell-tauri --locked && cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings && pnpm run test:vitest run test/unit/shared --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add -A crates shared/ws-protocol.ts
git commit -m "refactor(ownership): remove fences, platform-limited outcomes and force-clear now that every stop is confirmed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice F — Client

### Task 25: Client kill semantics — ack at Gone only, starting panes included, "Stopping…" when unconfirmed, plain pane close detaches, accessible tab X

**Files:**
- Modify: `src/lib/kill-ack.ts` — delete `EXIT_FALLBACK_GRACE_MS` and both legacy fallbacks (`:194-199`): only the correlated `terminal.killed`/`error{requestId}` decide; new `sendPaneKill` (below) with a first answer at `KILL_ACK_TIMEOUT_MS` and a final answer that has no timeout; pending kills are re-sent on every WS `ready` (the server joins the in-flight stop or confirms Gone); `sendTerminalKillAndAwait` becomes a thin wrapper over `sendPaneKill(...).firstAnswer` for existing callers (stuck card).
- Modify: `src/lib/pane-utils.ts` — `collectTerminalCloseTargets` (`:52-77`) is replaced by `collectStopTargets(node)` (every terminal leaf by `createRequestId`, with `terminalId` when present; every fresh-agent leaf).
- Create: `src/store/closeAndStopThunks.ts` — `closeTabAndStopAgents(tabId)` and `closePaneAndStopAgent({ tabId, paneId })`.
- Modify: `src/store/panesSlice.ts` (`stoppingTabs: Record<string, true>` beside `closingTabs` `:445`; actions `markTabStopping`, `clearTabStopping`; not persisted)
- Modify: `src/components/TabBar.tsx` (`onClose` `:533-580`: Shift → `dispatch(closeTabAndStopAgents(tab.id))`; plain → `closeTab` as today; `getDisplayTitle` `:267-271` appends ` (Stopping…)` while `stoppingTabs[tab.id]`)
- Modify: `src/components/TabItem.tsx` (`:225-239`: `type="button"`, `aria-label="Close tab"`, title unchanged `"Close (Shift+Click to kill)"`)
- Modify: `src/components/panes/PaneContainer.tsx` (`handleClose` `:380-454`: plain close = `closePaneWithCleanup` for every pane kind (fresh-agent panes no longer kill; drafts are still cleared); Shift → `closePaneAndStopAgent`), `src/components/panes/PaneHeader.tsx` (`:321-333`: pass `event.shiftKey` to `onClose`; title `"Close pane (Shift+Click to stop agent)"`, `aria-label` stays `"Close pane"`), `src/components/panes/Pane.tsx` (`:130-140` same)
- Modify: `src/lib/create-cancellation.ts` + the `freshAgent.created` fold (`src/lib/fresh-agent-ws.ts`) — a create cancelled by Shift-X kills the session it produced as soon as `freshAgent.created` arrives
- Test: `test/unit/client/lib/kill-ack.test.ts` (rewrite the fallback cases `:61`, `:108`), `test/unit/client/store/closeAndStopThunks.test.ts` (new), `test/unit/client/components/TabItem.test.tsx`, `test/unit/client/components/TabBar.test.tsx` (Shift-X cases `:738-1346` move to the thunk), `test/unit/client/components/panes/PaneContainer.test.tsx`, `test/unit/client/store/turnCompletionAttention.test.ts`

**Interfaces:**
- Consumes: the server contract of Tasks 13/15/23 (`terminal.kill` by `terminalId` and/or `createRequestId`, ack only at Gone; `freshAgent.killed` after Gone).
- Produces:
  ```ts
  export type KillAck = { ok: true } | { ok: false; error?: string; pending?: true; ownerEpoch?: number; ownerGeneration?: number }
  export type KillProgress = { requestId: string; firstAnswer: Promise<KillAck>; finalAnswer: Promise<KillAck> }
  export function sendPaneKill(target: { terminalId?: string | null; createRequestId: string }, opts?: { observedEpoch?: number; observedGeneration?: number; reason?: string; send?: (m: unknown) => void }): KillProgress
  export type StopTarget =
    | { kind: 'terminal'; createRequestId: string; terminalId?: string; sessionRef?: SessionLocator }
    | { kind: 'fresh-agent'; paneId: string; content: FreshAgentPaneContent }
  export function collectStopTargets(node: PaneNode): StopTarget[]
  export const closeTabAndStopAgents: AsyncThunk<void, string, {}>
  export const closePaneAndStopAgent: AsyncThunk<void, { tabId: string; paneId: string }, {}>
  ```
  `firstAnswer` resolves at the ack, or at 5 s with `{ ok: false, pending: true }`; `finalAnswer` resolves only at the ack (re-sent on reconnect). The thunks close the tab/pane only after every target's final ack is `ok`; at a pending first answer they `markTabStopping` (tab shows "Stopping…") and close when the final acks arrive; any refusal leaves the tab as it was and clears "Stopping…".

- [ ] **Step 1: Write the failing behavioral test**

Replace the two fallback tests in `test/unit/client/lib/kill-ack.test.ts` and add:

```ts
  describe('sendPaneKill', () => {
    it('never treats "not found" as success: only the correlated terminal.killed decides', async () => {
      vi.useFakeTimers()
      const { firstAnswer } = sendPaneKill({ terminalId: 'term-1', createRequestId: 'cr-1' })
      const sent = mockSend.mock.calls[0][0]
      emit({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId: 'term-1', message: 'Unknown terminalId' })
      emit({ type: 'terminal.exit', terminalId: 'term-1', exitCode: 0 })
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS)
      await expect(firstAnswer).resolves.toEqual({ ok: false, pending: true })
      expect(sent.type).toBe('terminal.kill')
    })

    it('kills a starting pane by createRequestId alone', () => {
      sendPaneKill({ createRequestId: 'cr-start' })
      const sent = mockSend.mock.calls[0][0]
      expect(sent).toMatchObject({ type: 'terminal.kill', createRequestId: 'cr-start' })
      expect(sent.terminalId).toBeUndefined()
    })

    it('reports pending at 5 s and resolves the final answer at the late ack', async () => {
      vi.useFakeTimers()
      const progress = sendPaneKill({ terminalId: 'term-2', createRequestId: 'cr-2' })
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS)
      await expect(progress.firstAnswer).resolves.toEqual({ ok: false, pending: true })
      emit({ type: 'terminal.killed', requestId: progress.requestId, terminalId: 'term-2', success: true })
      await expect(progress.finalAnswer).resolves.toEqual({ ok: true })
    })

    it('re-sends a pending kill after a reconnect and resolves on the new answer', async () => {
      const progress = sendPaneKill({ terminalId: 'term-3', createRequestId: 'cr-3' })
      emit({ type: 'ready', serverInstanceId: 'srv' })
      expect(mockSend).toHaveBeenCalledTimes(2)
      expect(mockSend.mock.calls[1][0]).toMatchObject({ type: 'terminal.kill', requestId: progress.requestId })
      emit({ type: 'terminal.killed', requestId: progress.requestId, terminalId: 'term-3', success: true })
      await expect(progress.finalAnswer).resolves.toEqual({ ok: true })
    })
  })
```

`test/unit/client/store/closeAndStopThunks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSend, handlers } = vi.hoisted(() => ({ mockSend: vi.fn(), handlers: new Set<(m: unknown) => void>() }))
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    cancelCreate: vi.fn(),
    onMessage: (h: (m: unknown) => void) => { handlers.add(h); return () => handlers.delete(h) },
  }),
}))

import { closeTabAndStopAgents } from '@/store/closeAndStopThunks'
import { makeStoreWithTab } from '@test/unit/client/helpers/store-fixtures' // existing store builder used by TabBar.test.tsx
import { KILL_ACK_TIMEOUT_MS } from '@/lib/kill-ack'

const emit = (m: unknown) => { for (const h of [...handlers]) h(m) }
const kills = () => mockSend.mock.calls.map((c) => c[0]).filter((m) => m.type === 'terminal.kill')
const answer = (m: { requestId: string; terminalId?: string }) => emit({ type: 'terminal.killed', requestId: m.requestId, terminalId: m.terminalId ?? '', success: true })
const answerPanesClosed = () => {
  const closed = mockSend.mock.calls.map((c) => c[0]).find((m) => m.type === 'panes.closed')
  if (closed) emit({ type: 'panes.closed.result', requestId: closed.requestId, success: true })
}

describe('closeTabAndStopAgents (Shift-X)', () => {
  beforeEach(() => { mockSend.mockReset(); handlers.clear(); vi.useRealTimers() })

  it('targets panes that are still starting and closes the tab only after the ack', async () => {
    const store = makeStoreWithTab({ tabId: 't1', panes: [
      { kind: 'terminal', mode: 'codex', createRequestId: 'cr-live', terminalId: 'term-live' },
      { kind: 'terminal', mode: 'codex', createRequestId: 'cr-starting' },
    ] })
    const done = store.dispatch(closeTabAndStopAgents('t1'))
    await Promise.resolve()
    expect(kills().map((k) => k.createRequestId).sort()).toEqual(['cr-live', 'cr-starting'])
    expect(kills().find((k) => k.createRequestId === 'cr-starting').terminalId).toBeUndefined()
    expect(store.getState().tabs.tabs.some((t) => t.id === 't1')).toBe(true)
    kills().forEach(answer)
    await vi.waitFor(() => answerPanesClosed())
    await done
    expect(store.getState().tabs.tabs.some((t) => t.id === 't1')).toBe(false)
  })

  it('shows Stopping… when Gone is not confirmed within 5 s, then closes at the late ack', async () => {
    vi.useFakeTimers()
    const store = makeStoreWithTab({ tabId: 't2', panes: [{ kind: 'terminal', mode: 'codex', createRequestId: 'cr-slow', terminalId: 'term-slow' }] })
    const done = store.dispatch(closeTabAndStopAgents('t2'))
    await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS)
    expect(store.getState().panes.stoppingTabs.t2).toBe(true)
    vi.useRealTimers()
    answer(kills()[0])
    await vi.waitFor(() => answerPanesClosed())
    await done
    expect(store.getState().panes.stoppingTabs.t2).toBeUndefined()
    expect(store.getState().tabs.tabs.some((t) => t.id === 't2')).toBe(false)
  })

  it('a refused kill leaves the tab standing and not Stopping', async () => {
    const store = makeStoreWithTab({ tabId: 't3', panes: [{ kind: 'terminal', mode: 'codex', createRequestId: 'cr-r', terminalId: 'term-r' }] })
    const done = store.dispatch(closeTabAndStopAgents('t3'))
    await Promise.resolve()
    emit({ type: 'terminal.killed', requestId: kills()[0].requestId, terminalId: 'term-r', success: false, error: 'DURABLE_CLOSE_FAILED' })
    await done
    expect(store.getState().tabs.tabs.some((t) => t.id === 't3')).toBe(true)
    expect(store.getState().panes.stoppingTabs.t3).toBeUndefined()
  })
})
```

(If `makeStoreWithTab` does not exist under that name, use the store fixture `TabBar.test.tsx` builds (its `renderTabBar`/`createStore` setup) and extract it into `test/unit/client/helpers/store-fixtures.ts` as part of this task.)

`TabItem.test.tsx`: `it('the tab X button has the accessible name "Close tab"', …)` — render a `TabItem`, `expect(screen.getByRole('button', { name: 'Close tab' })).toHaveAttribute('type', 'button')`.

`PaneContainer.test.tsx`: `it('a plain pane X on a fresh-agent pane detaches without killing', …)` — click the pane's "Close pane" button; assert no `freshAgent.kill` was sent and `closePaneWithCleanup` ran; `it('Shift+click on the pane X stops the agent', …)` — `fireEvent.click(button, { shiftKey: true })`; assert a `freshAgent.kill` for the pane's session was sent.

`turnCompletionAttention.test.ts`: `it('a Shift-X exit never marks attention', …)` — fold `terminal.killed` + `terminal.exit{exitCode:0}` for a pane's terminal; assert no attention mark and no ring request.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/lib/kill-ack.test.ts test/unit/client/store/closeAndStopThunks.test.ts test/unit/client/components/TabItem.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/store/turnCompletionAttention.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — `sendPaneKill`/`closeTabAndStopAgents` are not exported; INVALID_TERMINAL_ID still resolves ok; the tab X has no accessible name "Close tab"; a plain pane X on a fresh-agent pane sends `freshAgent.kill`.

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/kill-ack.ts` additions:

```ts
const pendingKills = new Map<string, { frame: Record<string, unknown>; resolveFinal: (a: KillAck) => void }>()
let readyHookInstalled = false

function installReadyResend(): void {
  if (readyHookInstalled) return
  readyHookInstalled = true
  getWsClient().onMessage((msg) => {
    const m = msg as Record<string, unknown>
    if (m.type === 'ready') {
      for (const { frame } of pendingKills.values()) getWsClient().send(frame) // the server joins the in-flight stop or confirms Gone
      return
    }
    if (m.type === 'terminal.killed' && typeof m.requestId === 'string') {
      const p = pendingKills.get(m.requestId)
      if (!p) return
      pendingKills.delete(m.requestId)
      p.resolveFinal(m.success !== false ? { ok: true } : { ok: false, error: typeof m.error === 'string' ? m.error : undefined })
    }
  })
}

export function sendPaneKill(
  target: { terminalId?: string | null; createRequestId: string },
  opts?: { observedEpoch?: number; observedGeneration?: number; reason?: string; send?: (m: unknown) => void },
): KillProgress {
  installReadyResend()
  const requestId = nanoid()
  const frame: Record<string, unknown> = {
    type: 'terminal.kill',
    requestId,
    createRequestId: target.createRequestId,
    ...(target.terminalId ? { terminalId: target.terminalId } : {}),
    ...(opts?.observedEpoch !== undefined && opts?.observedGeneration !== undefined
      ? { observedEpoch: opts.observedEpoch, observedGeneration: opts.observedGeneration }
      : {}),
    ...(opts?.reason ? { reason: opts.reason } : {}),
  }
  let resolveFinal!: (a: KillAck) => void
  const finalAnswer = new Promise<KillAck>((r) => { resolveFinal = r })
  pendingKills.set(requestId, { frame, resolveFinal })
  ;(opts?.send ?? ((m: unknown) => getWsClient().send(m)))(frame)
  const firstAnswer = Promise.race([
    finalAnswer,
    new Promise<KillAck>((r) => setTimeout(() => r({ ok: false, pending: true }), KILL_ACK_TIMEOUT_MS)),
  ])
  void finalAnswer.then((a) => { if (a.ok && target.terminalId) markTerminalReleased(target.terminalId) })
  return { requestId, firstAnswer, finalAnswer }
}
```

(Typed refusals keep surfacing `ownerEpoch`/`ownerGeneration` exactly as the current `sendTerminalKillAndAwait` parser does — move that parsing into the `terminal.killed` branch above.)

`src/store/closeAndStopThunks.ts`:

```ts
import { createAsyncThunk } from '@reduxjs/toolkit'
import type { RootState, AppDispatch } from './store'
import { closeTab, closePaneWithCleanup } from './tabsSlice'
import { markTabStopping, clearTabStopping } from './panesSlice'
import { collectStopTargets, findPaneNode, type StopTarget } from '@/lib/pane-utils'
import { sendPaneKill, stopFreshAgentPane, type KillProgress } from '@/lib/kill-ack'
import { resolveTerminalKillFence } from '@/lib/terminal-kill'

function startStop(t: StopTarget, state: RootState): KillProgress {
  if (t.kind === 'terminal') {
    const fence = t.sessionRef ? resolveTerminalKillFence(state, { sessionRef: t.sessionRef }) : undefined
    return sendPaneKill({ terminalId: t.terminalId, createRequestId: t.createRequestId }, fence)
  }
  return stopFreshAgentPane(t.content, state) // the PaneContainer kill logic (session resolution + fence), returning the same progress shape
}

async function stopAll(targets: StopTarget[], tabId: string, getState: () => RootState, dispatch: AppDispatch): Promise<boolean> {
  const progress = targets.map((t) => startStop(t, getState()))
  const first = await Promise.all(progress.map((p) => p.firstAnswer))
  if (first.some((a) => !a.ok && !a.pending)) return false
  if (first.some((a) => !a.ok)) {
    dispatch(markTabStopping(tabId))
    const final = await Promise.all(progress.map((p) => p.finalAnswer))
    dispatch(clearTabStopping(tabId))
    return final.every((a) => a.ok)
  }
  return true
}

export const closeTabAndStopAgents = createAsyncThunk<void, string, { state: RootState; dispatch: AppDispatch }>(
  'tabs/closeTabAndStopAgents',
  async (tabId, { getState, dispatch }) => {
    const layout = getState().panes.layouts[tabId]
    const targets = layout ? collectStopTargets(layout) : []
    if (targets.length > 0 && !(await stopAll(targets, tabId, getState, dispatch))) return
    await dispatch(closeTab(tabId))
  },
)

export const closePaneAndStopAgent = createAsyncThunk<void, { tabId: string; paneId: string }, { state: RootState; dispatch: AppDispatch }>(
  'panes/closePaneAndStopAgent',
  async ({ tabId, paneId }, { getState, dispatch }) => {
    const node = findPaneNode(getState().panes.layouts[tabId], paneId)
    const targets = node ? collectStopTargets(node) : []
    if (targets.length > 0 && !(await stopAll(targets, tabId, getState, dispatch))) return
    await dispatch(closePaneWithCleanup({ tabId, paneId }))
  },
)
```

`stopFreshAgentPane(content, state): KillProgress` moves the session-resolution + fence block out of `PaneContainer.handleClose` (`:390-445`) into `kill-ack.ts`; for a pane with no session yet it records the cancel intent in `create-cancellation.ts` and resolves `finalAnswer` when the late `freshAgent.created` → `freshAgent.kill` → `freshAgent.killed` chain completes. `getDisplayTitle` in `TabBar.tsx`: `(tab) => { const base = …existing…; return stoppingTabs[tab.id] ? \`${base} (Stopping…)\` : base }`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/lib/kill-ack.test.ts test/unit/client/store/closeAndStopThunks.test.ts test/unit/client/components/TabItem.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/store/turnCompletionAttention.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

`TabBar.tsx` loses its inline kill loop (`:533-576`) entirely; delete `getTerminalCloseTargetsForTab` (`:329-332`) and `collectTerminalCloseTargets` callers; `BackgroundSessions.tsx` (unmounted) keeps compiling against `sendTerminalKill`. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every client test touching close/kill/reopen/attention/pane headers, plus lint (a11y) and types.

Run: `pnpm run test:vitest run test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabBar.a11y.test.tsx test/unit/client/components/panes test/unit/client/lib test/unit/client/store --config config/vitest/vitest.config.ts && pnpm run typecheck && pnpm run lint`

Expected: PASS (the old Shift-X cases in `TabBar.test.tsx` now assert the thunk's sends and the deferred close).

- [ ] **Step 7: Commit the task**

```bash
git add src test/unit/client
git commit -m "feat(client): Shift-X stops every agent in the tab incl. starting panes, acks only at Gone, shows Stopping… when unconfirmed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 26: Right-click "Close and stop agent" on tabs and panes (the keyboard and screen-reader equivalent of Shift-X)

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts` (`MenuActions` `:30-93` gains `closeTabAndStopAgent(tabId: string): void` and `closePaneAndStopAgent(tabId: string, paneId: string): void`; tab menu `:307-360`: item `{ type: 'item', id: 'close-tab-stop-agent', label: 'Close and stop agent', danger: true, onSelect: () => actions.closeTabAndStopAgent(target.tabId), disabled: !tabHasAgent }` right after `close-tab` (`:338`); pane menu `:418-452`: after `replace-pane`, a separator `pane-close-sep` and `{ type: 'item', id: 'close-pane-stop-agent', label: 'Close and stop agent', danger: true, onSelect: () => actions.closePaneAndStopAgent(target.tabId, target.paneId), disabled: !paneHasAgent }`)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (action registry `:1405-1450` + deps `:1490-1525`: dispatch `closeTabAndStopAgents` / `closePaneAndStopAgent`)
- Test: `test/unit/client/context-menu/menu-defs.test.ts`, `test/unit/client/components/ContextMenuProvider.test.tsx`

**Interfaces:**
- Consumes: Task 25 thunks.
- Produces: `tabHasAgent` = the tab's layout has a terminal leaf whose `mode !== 'shell'` or a fresh-agent leaf; `paneHasAgent` = that pane is such a leaf. Shell-only tabs show the item disabled (Shift-X still kills shells, as today). The menu is reachable by keyboard (`Shift+F10` / ContextMenu key on the focused tab or pane shell, `ContextMenuProvider.tsx:1151-1172`) and announced as `role="menuitem"` "Close and stop agent".

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/client/context-menu/menu-defs.test.ts`:

```ts
it('the tab menu offers "Close and stop agent" right after "Close tab", enabled for agent tabs', () => {
  const actions = makeActions() // the file's existing MenuActions stub factory
  const items = buildMenuItems({ kind: 'tab', tabId: 't1' }, makeContext({ layouts: { t1: leaf({ kind: 'terminal', mode: 'codex', createRequestId: 'c' }) } }), actions)
  const ids = items.filter((i) => i.type === 'item').map((i) => i.id)
  expect(ids.indexOf('close-tab-stop-agent')).toBe(ids.indexOf('close-tab') + 1)
  const item = items.find((i) => i.id === 'close-tab-stop-agent')
  expect(item).toMatchObject({ label: 'Close and stop agent', danger: true, disabled: false })
  item.onSelect()
  expect(actions.closeTabAndStopAgent).toHaveBeenCalledWith('t1')
})

it('a shell-only tab shows the item disabled', () => {
  const items = buildMenuItems({ kind: 'tab', tabId: 't1' }, makeContext({ layouts: { t1: leaf({ kind: 'terminal', mode: 'shell', createRequestId: 'c' }) } }), makeActions())
  expect(items.find((i) => i.id === 'close-tab-stop-agent')).toMatchObject({ disabled: true })
})

it('the pane menu offers "Close and stop agent" for an agent pane', () => {
  const actions = makeActions()
  const items = buildMenuItems({ kind: 'pane', tabId: 't1', paneId: 'p1' }, makeContext({ layouts: { t1: leaf({ kind: 'fresh-agent', provider: 'codex', createRequestId: 'c' }, 'p1') } }), actions)
  const item = items.find((i) => i.id === 'close-pane-stop-agent')
  expect(item).toMatchObject({ label: 'Close and stop agent', disabled: false })
  item.onSelect()
  expect(actions.closePaneAndStopAgent).toHaveBeenCalledWith('t1', 'p1')
})
```

`ContextMenuProvider.test.tsx` (pattern of `:901`/`:971` keyboard tests): focus the tab, press `Shift+F10`, `getByRole('menuitem', { name: 'Close and stop agent' })`, press Enter, assert the store dispatched `tabs/closeTabAndStopAgents/pending` with `'t1'`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — no `close-tab-stop-agent`/`close-pane-stop-agent` items.

- [ ] **Step 3: Add the minimal production implementation**

Add the two items and actions as specified in **Files**; compute `tabHasAgent`/`paneHasAgent` with `collectStopTargets` (Task 25) filtered to `kind === 'fresh-agent' || mode !== 'shell'`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: two items and two actions follow the file's existing item/action pattern exactly.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client/context-menu test/unit/client/components/context-menu test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/ContextMenu.longpress.test.tsx test/unit/client/components/ContextMenu.mobile.test.tsx --config config/vitest/vitest.config.ts && pnpm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/context-menu test/unit/client
git commit -m "feat(client): right-click Close and stop agent on tabs and panes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 27: Client — other devices show the existing "stopped" presentation, reopen jumps to the holding pane, no retry polling, outside holders are named

**Files:**
- Modify: `src/store/terminalLifecycleSlice.ts` (`TerminalExitRecord` `:9` gains `stopped?: true`; `recordTerminalExit` `:57` accepts it)
- Modify: `src/components/TerminalView.tsx`:
  - `INVALID_TERMINAL_ID` handler (`:6491-6695`): when the frame carries `terminalStopped: true`, record `{ exitCode: 0, stopped: true }`, set the pane `status: 'exited'`, and never call `resumeRecoveryCreate` (`:6691`) or the fresh-start branch (`:6612-6682`);
  - `killedSessionVacant` (`:7256-7262`): `exitRecord?.exitCode === 0 && freshAgentOwnerDivergence === null && (terminalRuntimeOwner?.ownerKind === 'vacant' || exitRecord?.stopped === true)`;
  - the `SESSION_RESERVED` bounded re-drive (`:235-241`, `:4476-4520`, `:4113`) is deleted: a `SESSION_RESERVED` (now only a stale observed fence, Task 15) heals the fence from the frame's pair and re-sends the create ONCE immediately;
  - the create-error fold (`:6399`, `:6469`) maps `CONVERSATION_HELD_ELSEWHERE` to a typed `launchFailure` whose message is the server's message (it names pid and command), rendered by the existing `TerminalLaunchFailureCard`;
  - the `terminal.created` fold: a create marked as a user reopen whose answer names a terminal already shown by ANOTHER local pane closes this pane (or its whole tab when it is that tab's only pane, via plain `closeTab` — nothing is killed) and selects the holder (`setActiveTab` + `setActivePane({ ..., focusNudge: true })`); the same for `RESTORE_UNAVAILABLE` with `liveTerminalId`
- Create: `src/lib/reopen-intent.ts` (`markUserReopen(createRequestId)`, `isUserReopen(createRequestId)`, `clearUserReopen(createRequestId)`; in-memory set)
- Modify: the user reopen entry points to mark their create: `reopenClosedTab` (`src/store/tabsSlice.ts:1660-1692`), `openSessionTab` without a live terminal (`:1694`, sidebar + Resume dialog), the exit banner Reopen/Relaunch (`TerminalView.tsx:7630-7647`)
- Modify: `src/lib/pane-reconcile.ts` (`:470-613`: verdict `'stopped'` folds exactly like `terminalStopped`; it never calls `resetPaneForReconcileCreate`)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (delete the 1 s `SESSION_RESERVED` re-drive `:123-128`, `:2043+`: heal once and re-send)
- Test: `test/unit/client/components/TerminalView.stopped.test.tsx` (new), `test/unit/client/lib/pane-reconcile.test.ts`, `test/unit/client/lib/reopen-jump.test.ts` (new), `test/unit/client/components/TerminalView.lifecycle.test.tsx` (`:2206` "recreates terminal once after INVALID_TERMINAL_ID when canonical durable identity exists" keeps passing for a NON-stopped terminal; add the stopped counterpart), `test/unit/client/components/fresh-agent/FreshAgentView.*.test.tsx` (re-drive cases replaced by heal-once)

**Interfaces:**
- Consumes: server contracts of Tasks 14 (holder answers), 15 (no `SESSION_RESERVED` for in-progress keys), 16 (`CONVERSATION_HELD_ELSEWHERE`), 18 (`terminalStopped`, verdict `stopped`).
- Produces:
  ```ts
  export function markUserReopen(createRequestId: string): void
  export function isUserReopen(createRequestId: string): boolean
  export function clearUserReopen(createRequestId: string): void
  export interface TerminalExitRecord { exitCode: number; at: number; stopped?: true }
  ```
  The "stopped" presentation is the existing `vacantRecovery` bar ("<mode> session was stopped — reopen it to resume this conversation", `TerminalExitBanner.tsx:71-98`): no new wording.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/client/components/TerminalView.stopped.test.tsx` (built on the harness `TerminalView.lifecycle.test.tsx` uses — its `renderTerminalView`/mock-ws helpers):

```tsx
it('a late attach told "stopped" shows the stopped bar and never re-creates the conversation', async () => {
  const { ws, store } = renderTerminalView({ pane: { kind: 'terminal', mode: 'codex', terminalId: 'term-killed', createRequestId: 'cr-1', sessionRef: { provider: 'codex', sessionId: 't-1' }, status: 'running' } })
  ws.emit({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId: 'term-killed', terminalStopped: true, message: 'Terminal not running' })
  expect(await screen.findByTestId('terminal-vacant-recovery-bar')).toHaveTextContent('session was stopped')
  expect(ws.sent.filter((m) => m.type === 'terminal.create')).toHaveLength(0)
  expect(store.getState().panes.layouts.t1.content.status).toBe('exited')
})

it('a non-stopped missing terminal still recovers as before', async () => {
  const { ws } = renderTerminalView({ pane: { kind: 'terminal', mode: 'codex', terminalId: 'term-lost', createRequestId: 'cr-2', sessionRef: { provider: 'codex', sessionId: 't-2' }, status: 'running' } })
  ws.emit({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId: 'term-lost', message: 'Terminal not running' })
  await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'terminal.create')).toBe(true))
})

it('an outside holder is named in the existing launch failure card', async () => {
  const { ws } = renderTerminalView({ pane: { kind: 'terminal', mode: 'codex', createRequestId: 'cr-3', sessionRef: { provider: 'codex', sessionId: 't-3' }, status: 'creating' } })
  ws.emit({ type: 'error', code: 'CONVERSATION_HELD_ELSEWHERE', requestId: 'cr-3', holderPid: 4242, holderCommand: 'codex exec resume t-3',
    message: 'This conversation is open in another program (pid 4242: codex exec resume t-3). Close it there, then reopen it here.' })
  expect(await screen.findByRole('alert')).toHaveTextContent('pid 4242: codex exec resume t-3')
})

it('SESSION_RESERVED heals the fence and re-sends exactly once, with no timer', async () => {
  vi.useFakeTimers()
  const { ws } = renderTerminalView({ pane: { kind: 'terminal', mode: 'codex', createRequestId: 'cr-4', sessionRef: { provider: 'codex', sessionId: 't-4' }, status: 'creating' } })
  const creates = () => ws.sent.filter((m) => m.type === 'terminal.create')
  const before = creates().length
  ws.emit({ type: 'error', code: 'SESSION_RESERVED', requestId: 'cr-4', ownerEpoch: 9, ownerGeneration: 3, message: 'Session ownership moved on' })
  expect(creates().length).toBe(before + 1)
  expect(creates().at(-1)).toMatchObject({ observedEpoch: 9, observedGeneration: 3 })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(creates().length).toBe(before + 1, 'no polling re-drive')
})
```

`test/unit/client/lib/reopen-jump.test.ts`:

```ts
it('a reopen answered with a terminal another pane already shows jumps there and drops the duplicate', async () => {
  const store = makeStoreWithTabs([
    { tabId: 'holder', panes: [{ kind: 'terminal', mode: 'codex', createRequestId: 'cr-h', terminalId: 'term-h' }] },
    { tabId: 'reopened', panes: [{ kind: 'terminal', mode: 'codex', createRequestId: 'cr-r', sessionRef: { provider: 'codex', sessionId: 't-extra' } }] },
  ])
  markUserReopen('cr-r')
  foldTerminalCreated(store, { type: 'terminal.created', requestId: 'cr-r', terminalId: 'term-h' }) // the TerminalView fold, exported for tests
  expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['holder'])
  expect(store.getState().tabs.activeTabId).toBe('holder')
  expect(isUserReopen('cr-r')).toBe(false)
})

it('an automatic restore answered with an existing terminal attaches as before (no jump)', () => {
  const store = makeStoreWithTabs([{ tabId: 'a', panes: [{ kind: 'terminal', mode: 'codex', createRequestId: 'cr-a', sessionRef: { provider: 'codex', sessionId: 't' } }] }])
  foldTerminalCreated(store, { type: 'terminal.created', requestId: 'cr-a', terminalId: 'term-x' })
  expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['a'])
})
```

`pane-reconcile.test.ts`: `it('the stopped verdict folds to the stopped presentation and never respawns', …)` next to `:300`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.stopped.test.tsx test/unit/client/lib/reopen-jump.test.ts test/unit/client/lib/pane-reconcile.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the stopped attach re-creates; the reconcile verdict `stopped` is unhandled; `markUserReopen` does not exist; the `SESSION_RESERVED` re-drive schedules timers.

- [ ] **Step 3: Add the minimal production implementation**

As listed under **Files**. The jump fold (shared by `terminal.created` and the `RESTORE_UNAVAILABLE`+`liveTerminalId` refusal):

```ts
export function jumpToHolderIfUserReopen(dispatch: AppDispatch, state: RootState, createRequestId: string, holderTerminalId: string): boolean {
  if (!isUserReopen(createRequestId)) return false
  clearUserReopen(createRequestId)
  const holder = selectTabPaneByTerminalId(state, holderTerminalId)
  const mine = findPaneByCreateRequestId(state, createRequestId)
  if (!holder || !mine || (holder.tabId === mine.tabId && holder.paneId === mine.paneId)) return false
  const layout = state.panes.layouts[mine.tabId]
  if (layout?.type === 'leaf') {
    void dispatch(closeTab(mine.tabId)) // a plain close: nothing is killed
  } else {
    void dispatch(closePaneWithCleanup({ tabId: mine.tabId, paneId: mine.paneId }))
  }
  dispatch(setActiveTab(holder.tabId))
  dispatch(setActivePane({ tabId: holder.tabId, paneId: holder.paneId, focusNudge: true }))
  return true
}
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.stopped.test.tsx test/unit/client/lib/reopen-jump.test.ts test/unit/client/lib/pane-reconcile.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `terminalStopped` attach fold and the `stopped` reconcile fold share one action `markPaneStopped({ paneId, terminalId })` (records the stopped exit and sets `status: 'exited'`). Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole TerminalView/FreshAgentView suites (lifecycle, reconnect, exit banner), reconcile, tabs reopen, sidebar click and resume dialog tests.

Run: `pnpm run test:vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.exitBanner.test.tsx test/unit/client/components/TerminalExitBanner.test.tsx test/unit/client/components/fresh-agent test/unit/client/lib test/unit/client/store/tabsSlice.reopen.test.ts test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts && pnpm run typecheck`

Expected: PASS (`TerminalView.lifecycle.test.tsx` cases that pinned the 250 ms re-drive are rewritten to the heal-once behavior; `:2206` still passes because it is not a stopped terminal).

- [ ] **Step 7: Commit the task**

```bash
git add src test/unit/client
git commit -m "feat(client): stopped panes stay stopped on other devices; reopen jumps to the holder; no reserved-retry polling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 28: Client — remove the force-clear and fenced-recovery UI that existed only for unconfirmed deaths

**Files (inventory `plan-ownership-terminal.md` §6.4):**
- Modify: `src/components/SessionHandoffErrorBanner.tsx` (delete the "Force clear" button and its post-clear "Start reopen again" (`:70-154`) and `FencedOwnerRecoveryActions` (`:161-258`); keep the generic "Retry" with aria-label "Retry reopening this session")
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (`:3987-4006`) and `src/components/TerminalView.tsx` (`:7388-7407`) — delete the "Session blocked pending recovery" cards; the in-progress blocking (`FreshAgentView.tsx:3512, 3548, 3643, 3777`; `TerminalView.tsx:962, 3483`; `pane-reconcile.ts:343`) keys only on in-progress owner states (Starting/Handoff/Stopping), never on `fenced`
- Modify: `src/lib/session-handoff.ts` (`runPaneSessionRecovery` `:443-448`, the cleared-result arm `:285-322`, `allowRecovery` plumbing), `src/lib/api.ts` (`:888-1016` fence codes, `cleared` enum, `shutdownConfirmed`, `acknowledgePlatformLimitedRisk`), `src/lib/ready-message-schema.ts` (`:46-47`), `src/lib/fresh-agent-ws.ts` (`:315-346` fenced fold), `src/store/selectors/runtimeOwner.ts` (`:56`, `:205-213`, `:259`), `src/store/freshAgentTypes.ts` (`:69`, `:73`), `src/store/freshAgentSlice.ts` (`:690-691`), `shared/ws-protocol.ts` (any remaining `fenced` client-side fields)
- Modify: `README.md` (`:132-136`: remove the "Force clear" paragraph and the Linux-only "Stop and reopen" limitation; "Session switching and recovery" keeps the switch description)
- Test: delete the fence cases (~22, ~750 lines) in `test/unit/client/components/SessionHandoffErrorBanner.test.tsx` (9 of 10), `test/unit/client/lib/session-handoff.test.ts` (2), `test/unit/client/lib/api.test.ts` (5), `test/unit/client/lib/fresh-agent-ws.test.ts` (2), `test/unit/client/store/selectors-runtime-owner.test.ts` (4); add `SessionHandoffErrorBanner.test.tsx` → `it('offers only Retry — no Force clear exists any more', …)`

**Interfaces:**
- Consumes: Task 24 (the server never reports a fenced owner and has no force-clear action).
- Produces: no client code path references `fenced`, `PLATFORM_LIMITED*`, `CLEARED_UNVERIFIED*`, `STALE_*_FENCED` or `acknowledgePlatformLimitedRisk`.

- [ ] **Step 1: Write the failing behavioral test**

```tsx
// test/unit/client/components/SessionHandoffErrorBanner.test.tsx
it('offers only Retry — no Force clear exists any more', () => {
  // A platform-limited code is what used to render "Force clear"; the prop type no longer admits it.
  render(<SessionHandoffErrorBanner error={{ code: 'PLATFORM_LIMITED_FENCED' as never, message: 'The switch failed' }} onRetry={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Retry reopening this session' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /force clear/i })).toBeNull()
})

// test/unit/client/store/selectors-runtime-owner.test.ts
it('a replayed stopping owner blocks the pane as in-progress, and nothing is ever "fenced"', () => {
  const state = foldReady([{ provider: 'codex', sessionId: 's', epoch: 1, generation: 2, ownerKind: 'terminal', state: 'stopping' }])
  expect(derivePaneOwnerDivergence(state, paneFor('codex', 's'))).toMatchObject({ kind: 'inProgress' })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/SessionHandoffErrorBanner.test.tsx test/unit/client/store/selectors-runtime-owner.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the banner renders a "Force clear" button for the platform-limited code, and the selector test fails because a replayed `stopping` owner is folded as `handoff-started` without the new `'stopping'` transition the selector now expects.

- [ ] **Step 3: Add the minimal production implementation**

Delete the listed code; `foldReadyRuntimeOwners` maps replay `stopping` to the new client transition `'stopping'` (Task 29 renders it in the sidebar), and `derivePaneOwnerDivergence` treats `'stopping'` like `'handoff-started'` (in progress).

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/SessionHandoffErrorBanner.test.tsx test/unit/client/store/selectors-runtime-owner.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

`rg -n "fenced|PLATFORM_LIMITED|CLEARED_UNVERIFIED|acknowledgePlatformLimitedRisk|Force clear" src shared README.md` must return nothing; remove any leftovers. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client test/unit/shared --config config/vitest/vitest.config.ts && pnpm run typecheck && pnpm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add -A src shared README.md test/unit/client
git commit -m "refactor(client): remove force-clear and fenced-recovery UI now that every stop is confirmed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 29: Sidebar marker for agents running in the background and stopping (and the live "stopping" owner frame)

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`SessionRuntimeOwner.transition` `:1257-1294` gains `"stopping"`), `shared/ws-protocol.ts` (`:1865-1893` transition union gains `'stopping'`)
- Modify: `crates/freshell-ws/src/unit_lifecycle.rs` (`stop_terminal_unit`: right after `begin_unit_stop`, broadcast one `session.runtimeOwner{ownerKind: "terminal", transition: "stopping", epoch, generation, operationId}` per key that was NOT already stopping — this is not one of the Gone-only publications)
- Modify: `src/store/freshAgentTypes.ts` (transition union + `'stopping'`), `src/store/freshAgentSlice.ts` (`applyRuntimeOwner` `:676-695` folds it), `src/lib/fresh-agent-ws.ts` (`foldReadyRuntimeOwners` maps replay `stopping` → `'stopping'`), `src/store/selectors/runtimeOwner.ts` (`'stopping'` is in-progress)
- Modify: `src/store/selectors/sidebarSelectors.ts` (`buildSessionItems` `:172+`: `agentState: 'background' | 'stopping' | undefined` — `'stopping'` when the session's owner record transition is `'stopping'`; else `'background'` when `isRunning && !hasTab`)
- Modify: `src/components/Sidebar.tsx` (`SidebarItem` `:1150-1205`: render the marker next to the title, following the remote-ring pattern `:52-56`, `:1161-1170`, `:1182-1184`: an `aria-hidden` icon with `data-agent-state`, an `sr-only` text, a tooltip line; memo comparator `areSidebarItemPropsEqual` `:1087-1117` includes `agentState`)
- Modify: `docs/index.html` (sidebar mock `:690-700`: one `.sb-item` row gets the background marker; CSS for `.sb-agent-state` near `:159`)
- Test: `test/unit/client/components/SidebarItem.agent-state.test.tsx` (new), `test/unit/client/store/selectors/sidebarSelectors.test.ts`, `test/unit/client/store/freshAgentSlice.runtime-owner.test.ts`; in `crates/freshell-ws/tests/unit_kill.rs` add `a_stopping_owner_frame_precedes_the_vacant_one`

**Interfaces:**
- Consumes: Task 12 (`stop_terminal_unit`), Task 28 (client folds without `fenced`).
- Produces:
  ```ts
  const AGENT_STATE_COPY = {
    background: { tooltip: 'Running in background', srOnly: '(running in background)' },
    stopping: { tooltip: 'Stopping…', srOnly: '(stopping)' },
  } as const
  export type SidebarAgentState = keyof typeof AGENT_STATE_COPY
  ```
  Icons: `background` → lucide `Play` (`h-3 w-3 text-muted-foreground`), `stopping` → lucide `Loader2` (`h-3 w-3 animate-spin text-muted-foreground`). No other UI.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/client/components/SidebarItem.agent-state.test.tsx` (setup copied from `SidebarItem.remote-status.test.tsx`):

```tsx
it('a running session without an open tab shows the background marker with a screen-reader text', () => {
  renderSidebarItem({ item: makeItem({ isRunning: true, hasTab: false, agentState: 'background' }) })
  expect(screen.getByText('(running in background)')).toHaveClass('sr-only')
  expect(document.querySelector('[data-agent-state="background"]')).toHaveAttribute('aria-hidden', 'true')
})

it('a stopping session shows the stopping marker', () => {
  renderSidebarItem({ item: makeItem({ isRunning: true, hasTab: true, agentState: 'stopping' }) })
  expect(screen.getByText('(stopping)')).toHaveClass('sr-only')
})

it('an idle open or dead session shows no marker', () => {
  renderSidebarItem({ item: makeItem({ isRunning: false, hasTab: false }) })
  expect(document.querySelector('[data-agent-state]')).toBeNull()
})

it('the memo comparator re-renders on an agentState change', () => {
  const a = makeProps({ agentState: undefined })
  expect(areSidebarItemPropsEqual(a, { ...a, item: { ...a.item, agentState: 'stopping' } })).toBe(false)
})
```

`sidebarSelectors.test.ts`: `buildSessionItems` gives `agentState: 'background'` for `isRunning && !hasTab`, `'stopping'` when the owner record for that session has `transition: 'stopping'`, and `undefined` otherwise.

`unit_kill.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn a_stopping_owner_frame_precedes_the_vacant_one() {
    let h = UnitHarness::start(HarnessOpts::default()).await;
    let mut ws = h.connect().await;
    let tid = h.create_codex(&mut ws, "crq-sf", Some("t-sf")).await;
    h.send(&mut ws, kill(Some(&tid), "crq-sf", "rs")).await;
    let first = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "session.runtimeOwner" && f["sessionId"] == "t-sf").await.unwrap();
    assert_eq!(first["transition"], "stopping");
    let second = h.next_matching(&mut ws, Duration::from_secs(10), |f| f["type"] == "session.runtimeOwner" && f["sessionId"] == "t-sf").await.unwrap();
    assert_eq!(second["ownerKind"], "vacant");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/SidebarItem.agent-state.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/freshAgentSlice.runtime-owner.test.ts --config config/vitest/vitest.config.ts; cargo test -p freshell-ws --test unit_kill a_stopping_owner_frame_precedes_the_vacant_one --locked`

Expected: FAIL — no marker renders; `agentState` is never computed; the first owner frame is the vacant one.

- [ ] **Step 3: Add the minimal production implementation**

In `SidebarItem`, after the title `span` and the remote sr-only text:

```tsx
{item.agentState && (
  <>
    {item.agentState === 'stopping'
      ? <Loader2 aria-hidden="true" data-agent-state="stopping" className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
      : <Play aria-hidden="true" data-agent-state="background" className="h-3 w-3 shrink-0 text-muted-foreground" />}
    <span className="sr-only">{AGENT_STATE_COPY[item.agentState].srOnly}</span>
  </>
)}
```

and in the tooltip content a line `{item.agentState && <div className="text-muted-foreground">{AGENT_STATE_COPY[item.agentState].tooltip}</div>}`. Server: in `stop_terminal_unit`, for each `UnitStopKey { joined: false, .. }` returned by `begin_unit_stop`, call the existing `broadcast_owner_frame` (`identity_ownership.rs:804-837`) with `transition: "stopping"`.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/SidebarItem.agent-state.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/freshAgentSlice.runtime-owner.test.ts --config config/vitest/vitest.config.ts && cargo test -p freshell-ws --test unit_kill --locked`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Share the "non-color carrier" rendering (icon + sr-only + tooltip line) between the remote ring and the agent-state marker as a tiny `SidebarStatusCarrier` component inside `Sidebar.tsx`. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/SidebarItem.running-state.test.tsx test/unit/client/store --config config/vitest/vitest.config.ts && cargo test -p freshell-protocol --locked && pnpm run lint && pnpm run typecheck`

Expected: PASS (`SidebarItem.running-state.test.tsx:27-47`, which pinned "a detached running session renders exactly like a dead one", now asserts the background marker).

- [ ] **Step 7: Commit the task**

```bash
git add src crates/freshell-protocol crates/freshell-ws shared/ws-protocol.ts docs/index.html test/unit/client
git commit -m "feat(sidebar): marker for agents running in the background and stopping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Slice G — Logging, docs, end-to-end, contracts, platforms

### Task 30: Stop-event log schema end to end, HTTP request-line noise, and retention

**Files:**
- Modify: `crates/freshell-server/src/logging.rs` (`request_logging_middleware` `:424-455`: 2xx/3xx at `DEBUG` unless `duration_ms >= 1000` (then `INFO`); 4xx `WARN`, 5xx `ERROR` unchanged; schema doc `:27-29`; rotation sizes unchanged — 3 × 10 MiB already holds the cleanup window once request lines leave the default filter, which the retention test proves)
- Test: `crates/freshell-server/src/logging.rs` tests (new cases), `crates/freshell-server/tests/unit_log_schema.rs` (server binary)

**Interfaces:**
- Consumes: every `freshell_unit` event emitted by Tasks 2–23.
- Produces: nothing new; this task proves the schema. Measured basis for retention (from `plan-automation-activity-logging.md` §4.2): non-HTTP volume ≤ 76 KB/h peak, so the existing 3 × 10 MiB holds about two weeks — far above the 24-hour cleanup window — once HTTP 2xx lines (96.6% of today's volume) no longer reach the default `info` filter.

- [ ] **Step 1: Write the failing behavioral test**

In `logging.rs` tests (next to the rotation test `:537-580`):

```rust
#[tokio::test]
async fn a_successful_request_writes_no_info_line_but_a_client_error_still_warns() {
    let (dir, guard) = install_test_logging("info"); // the module's existing test-subscriber helper
    let app = axum::Router::new()
        .route("/ok", axum::routing::get(|| async { "ok" }))
        .route("/missing", axum::routing::get(|| async { axum::http::StatusCode::NOT_FOUND }))
        .layer(axum::middleware::from_fn(request_logging_middleware));
    for path in ["/ok", "/missing"] {
        let _ = tower::ServiceExt::oneshot(app.clone(), axum::http::Request::get(path).body(axum::body::Body::empty()).unwrap()).await;
    }
    drop(guard);
    let lines = read_jsonl(dir.path());
    assert!(!lines.iter().any(|l| l["msg"] == "http_request" && l["route"] == "/ok"), "2xx is DEBUG");
    assert!(lines.iter().any(|l| l["msg"] == "http_request" && l["route"] == "/missing" && l["level"] == "WARN"));
}

/// Retention covers the 24 h cleanup window at three times the measured peak
/// non-HTTP volume (76 KB/h, plan-automation-activity-logging.md §4.2): the
/// first line written must still be on disk after 24 h worth of lines.
#[test]
fn the_default_writer_retains_a_full_cleanup_window_of_unit_logs() {
    let dir = tempfile::tempdir().unwrap();
    let writer = RotatingJsonlWriter::new(dir.path().join(LOG_FILE_NAME), DEFAULT_MAX_BYTES, DEFAULT_MAX_BACKUPS);
    writer.write_line("{\"marker\":\"first\"}");
    let line = format!("{{\"pad\":\"{}\"}}", "x".repeat(400));
    let window_bytes: u64 = 3 * 76 * 1024 * 24;
    let mut written = 0u64;
    while written < window_bytes {
        writer.write_line(&line);
        written += line.len() as u64 + 1;
    }
    let all: String = std::fs::read_dir(dir.path()).unwrap().flatten()
        .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default()).collect();
    assert!(all.contains("\"marker\":\"first\""), "the oldest line of the window was rotated away");
}
```

(Use the helper names the module's existing tests use; `RotatingJsonlWriter::new` is `freshell_runtime_observability`'s constructor.)

`crates/freshell-server/tests/unit_log_schema.rs` (server binary, `FRESHELL_LOG_DIR` in the tempdir, Task 19's `support/server_proc.rs`):

```rust
#![cfg(target_os = "linux")]
#[path = "support/server_proc.rs"]
mod server_proc;

use std::time::Duration;

use serde_json::{json, Value};
use server_proc::*;

fn events(home: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(home.join("logs/rust-server.jsonl")).unwrap_or_default()
        .lines().filter_map(|l| serde_json::from_str(l).ok()).filter(|v: &Value| v["target"] == "freshell_unit").collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shift_x_and_a_reopen_log_the_full_keyed_sequence() {
    let home = tempfile::tempdir().unwrap();
    let mut s = start(home.path(), &[("FAKE_CODEX_APP_SERVER_BEHAVIOR", "{}"), ("FRESHELL_LOG_DIR", home.path().join("logs").to_str().unwrap())]);
    assert!(wait_for_health(s.port, &mut s.child, Duration::from_secs(30)).await);
    let (mut ws, tid) = create_resume(s.port, "crq-log", "t-log").await;
    send_json(&mut ws, &json!({"type": "terminal.kill", "terminalId": tid, "requestId": "rk", "createRequestId": "crq-log"})).await;
    send_json(&mut ws, &json!({"type": "terminal.create", "requestId": "crq-log2", "mode": "codex", "shell": "system", "restore": true,
        "sessionRef": {"provider": "codex", "sessionId": "t-log"}})).await;
    wait_for_message_type(&mut ws, "terminal.created", Duration::from_secs(20)).await.unwrap();
    let ev = events(home.path());
    let names: Vec<&str> = ev.iter().filter(|e| e["terminal_id"] == tid.as_str()).map(|e| e["event"].as_str().unwrap()).collect();
    let pos = |n: &str| names.iter().position(|x| *x == n).unwrap_or_else(|| panic!("{n} missing in {names:?}"));
    assert!(pos("unit.stop.requested") < pos("unit.stop.signal_sent"));
    assert!(pos("unit.stop.signal_sent") < pos("unit.stop.gone"));
    let gone = ev.iter().find(|e| e["event"] == "unit.stop.gone" && e["terminal_id"] == tid.as_str()).unwrap();
    assert_eq!(gone["level"], "INFO");
    assert_eq!(gone["lock_released"], true);
    assert!(gone["duration_ms"].as_u64().is_some());
    for key in ["unit_id", "provider", "session_id", "terminal_id", "operation_id"] {
        assert!(gone[key].as_str().is_some_and(|v| !v.is_empty()), "{key} keyed");
    }
    let requested = ev.iter().find(|e| e["event"] == "unit.stop.requested" && e["terminal_id"] == tid.as_str()).unwrap();
    assert_eq!((requested["reason"].as_str(), requested["mode"].as_str()), (Some("shift-x"), Some("force")));
    assert!(ev.iter().any(|e| e["event"] == "unit.start.waited" && e["session_id"] == "t-log"), "time spent waiting before the reopen");
    unsafe { libc::kill(s.child.id() as i32, libc::SIGKILL) };
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server --lib logging --locked; cargo build -p freshell-server --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test unit_log_schema --locked`

Expected: FAIL — the `/ok` request writes an INFO `http_request` line. (The retention test already passes with today's 3 × 10 MiB once HTTP noise is excluded — it is the regression guard for the retention requirement; the schema test passes once Tasks 2–15 are in, and is the end-to-end proof.)

- [ ] **Step 3: Add the minimal production implementation**

```rust
    let status = response.status();
    let duration_ms = started.elapsed().as_millis() as u64;
    if status.is_server_error() {
        tracing::error!(status = status.as_u16(), duration_ms, "http_request");
    } else if status.is_client_error() {
        tracing::warn!(status = status.as_u16(), duration_ms, "http_request");
    } else if duration_ms >= 1000 {
        tracing::info!(status = status.as_u16(), duration_ms, "http_request");
    } else {
        tracing::debug!(status = status.as_u16(), duration_ms, "http_request");
    }
```

with the schema doc updated ("2xx/3xx request lines are DEBUG unless slow; with them out of the default filter the 3 × 10 MiB rotation holds well over the 24 h cleanup window").

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server --lib logging --locked && FRESHELL_SERVER_BIN=$PWD/target/debug/freshell-server cargo test -p freshell-server --test unit_log_schema --test diag01_lifecycle_logging --test diag01_diag03_logging --locked`

Expected: PASS (`diag01_lifecycle_logging.rs:561-583` reads only 401/404 lines; `diag01_diag03_logging.rs:137-138` pins sizes through env, unaffected).

- [ ] **Step 5: Refactor while green**

No refactor needed beyond the doc update: the change is one branch and one constant.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server --locked`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server
git commit -m "fix(logging): successful request lines at debug; retention and end-to-end stop-event schema tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 31: Documentation — README for users, an agent doc for the repo

**Files:**
- Modify: `README.md` (new subsection under `## Usage` after "Fresh agents": "Closing tabs and stopping agents"; a note under the Keyboard Shortcuts table; `AGENTS.md`-style jargon avoided)
- Create: `docs/development/agent-units.md` (for agents working in the repo)
- Modify: `AGENTS.md` (one link line to `docs/development/agent-units.md` in the Architecture section; the PTY Lifecycle sentence "Configurable idle timeout (15 mins default)" becomes "Background panes that have been really idle for 24 hours are stopped (see docs/development/agent-units.md)")
- Test: none — documentation-only (AGENTS.md exempts doc changes from TDD). Verification is Step 6's link/command check.

**Interfaces:**
- Consumes: the user-visible behavior of Tasks 13, 20, 22, 25–29.
- Produces: README text (exact):

```markdown
### Closing tabs and stopping agents

A plain close (the tab's **×**, `Alt+W`, or a pane's **×**) hides the tab but leaves its agent running in the background. The sidebar marks agents that are running in the background, and reopening the tab (`Alt+Shift+T` / `Alt+H`) or clicking the session in the sidebar attaches to the same running agent. Reopening never stops anything.

To stop an agent, **Shift+click** the tab's or pane's **×**, or right-click the tab or pane and choose **Close and stop agent** (keyboard: focus the tab and press `Shift+F10`). Freshell stops the agent and everything it started — including commands it left running in the background — and closes the tab once the agent is confirmed gone, so you can reopen the same conversation right away. If stopping takes more than a few seconds, the tab shows **Stopping…** until it finishes.

To stop an agent that is running in the background, click it in the sidebar to open it, then Shift+click its **×** (or use **Close and stop agent**). Background agents that have been really idle for 24 hours — not working, nothing queued, and not waiting for you — are stopped automatically.

When another device stops an agent, that pane shows it as stopped instead of starting it again. If a conversation is open in another program (for example `codex` in a shell), Freshell tells you which program holds it.
```

and under the shortcuts table: "Shift+click a tab or pane **×** closes it and stops its agent; the context menu offers the same as **Close and stop agent**."

`docs/development/agent-units.md` sections (content written from this plan, exact headings): "What a unit is" (screen + agent main process + everything they start; Running/Stopping/Gone = owner registry Live/Stopping/Vacant), "Containment backends" (table: systemd-scope / linux-tag / windows-job / macos-tag, how each places, kills and detects empty; the `containment.backend` boot log line; the Codex managed-daemon exclusion rule), "The stop sequence" (Force: SIGINT → ≤1 s → kill unit → Gone → sweep; Graceful: SIGTERM → 5 s → force + warn; Gone = screen + main dead + lock released; unconfirmed at 5 s logs an error and keeps waiting), "Events" (every `freshell_unit` event with its fields), "Testing" (the exact commands from this plan's Test command reference, `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1` on hosts with a user manager, the sandbox degraded run, the env knobs `FRESHELL_TEST_HOOKS` + `FRESHELL_TEST_UNIT_GONE_DELAY_MS`, `FRESHELL_UNIT_IDLE_LIMIT_MS`, `FRESHELL_UNIT_IDLE_QUIET_MS`, and the realistic Codex fake's behavior keys), "Server restarts" (units are sibling slices of the server's unit; `KillMode=control-group` on the server unit is correct; Windows units do not outlive the server).

- [ ] **Step 1: Write the failing behavioral test**

Not applicable (documentation-only task; see Files).

- [ ] **Step 2: Run the test and verify the intended failure**

Not applicable.

- [ ] **Step 3: Add the minimal production implementation**

Write the README subsection and note exactly as above, the agent doc with the listed sections, and the two `AGENTS.md` edits.

- [ ] **Step 4: Run the focused test**

Run: `rg -n "Closing tabs and stopping agents" README.md && rg -n "agent-units.md" AGENTS.md && test -f docs/development/agent-units.md && echo docs-ok`

Expected: the three matches and `docs-ok`.

- [ ] **Step 5: Refactor while green**

Read both documents once end to end for plain language (no internal jargon in README: no "unit", "registry", "cgroup").

- [ ] **Step 6: Run impacted-test verification**

Every command the agent doc lists must run as written: execute each `cargo test …`/`scripts/sandbox-test.sh …` line from its Testing section once (they are the same commands Tasks 2–30 already ran green) and confirm the doc's env-knob names match the code (`rg -n "FRESHELL_UNIT_IDLE_LIMIT_MS|FRESHELL_TEST_UNIT_GONE_DELAY_MS|FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT" crates`).

Expected: every command passes; every knob is found in `crates/`.

- [ ] **Step 7: Commit the task**

```bash
git add README.md AGENTS.md docs/development/agent-units.md
git commit -m "docs: closing tabs vs stopping agents, background agents, and the agent-unit developer guide

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 32: Browser end-to-end on the cloud backend — realistic fake everywhere, the two skipped Codex specs restored, the new lifecycle spec

**Files:**
- Modify: `test/e2e-browser/fixtures/codex-dual-role.ts` (`installDualRoleCodexCli` writes a bash shim: `app-server` argv → `exec node <fake-codex-launcher.mjs> "$@"`; everything else → `exec node <terminalSource> "$@"` with `terminalEnv` exported; the "one direct process" comment is replaced by "the launcher and native run inside the pane's unit"); new `installRealisticCodexCli(binDir)` (TUI branch → `test/fixtures/coding-cli/codex-app-server/fake-codex-tui.mjs`)
- Modify: `test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts` (`:47-55`, `:124`) and `codex-terminal-restore-rust.spec.ts` (`~:57-64`): install via `installDualRoleCodexCli(binDir, <their terminal fake>)` instead of the terminal-only fake; the bounce spec's `test.fail(true, 'TERM-22: …')` stays only if the spec still fails for the TERM-22 reason after this work — if it now passes, the annotation is removed (the defect it recorded is fixed)
- Modify: `test/e2e-browser/playwright.cloud.config.ts` (`:51-53`: delete the "Requires codex binary" comment and both entries)
- Create: `test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts`
- Modify: `test/e2e-browser/helpers/server-fixture-support.ts` only if the new spec needs `FAKE_CODEX_MANIFEST_DIR` passed through to the server env (add it to the forwarded fake env list)

**Interfaces:**
- Consumes: everything user-visible (Tasks 13, 15, 17, 25–29).
- Produces: cloud-green evidence for: kill mid-turn then immediate reopen with no "open in another app"; plain close then reopen reattaches; right-click "Close and stop agent"; the sidebar background marker; plus the restored Codex specs and every Codex-touching spec under the realistic fake.

- [ ] **Step 1: Write the failing behavioral test**

`test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts` (fixtures/harness as in `handoff-two-device-rust.spec.ts`; selectors by role/name only):

```ts
import { test, expect } from '../helpers/fixtures.js'
import { installRealisticCodexCli } from '../fixtures/codex-dual-role.js'

test.describe('codex pane lifecycle', () => {
  test.use({ serverOptions: async ({ binDir }, use) => use({ env: { CODEX_CMD: await installRealisticCodexCli(binDir), FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1', FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ turnCompleteDelayMs: 60000 }) } }) })

  async function openCodexTab(page, harness) {
    await page.getByRole('button', { name: /new tab/i }).click()
    await page.getByRole('button', { name: /^codex$/i }).click()
    await expect.poll(() => harness.getTerminalBuffer()).toContain('FAKE_TUI_READY thread=')
  }

  test('kill mid-turn then reopen immediately: the conversation resumes, never "open in another app"', async ({ page, harness }) => {
    await openCodexTab(page, harness)
    await page.keyboard.type('turn go\n')
    const tab = page.locator('[data-context="tab"]').last()
    await tab.getByRole('button', { name: 'Close tab' }).click({ modifiers: ['Shift'] })
    await expect(tab).toHaveCount(0)
    await page.keyboard.press('Alt+Shift+T')
    await expect.poll(() => harness.getTerminalBuffer()).toContain('FAKE_TUI_READY thread=')
    await page.waitForTimeout(2000) // observe a while: the conflict line must never appear
    expect(await harness.getTerminalBuffer()).not.toContain('open in another app')
  })

  test('a plain close keeps the agent running, the sidebar marks it, and reopen reattaches', async ({ page, harness }) => {
    await openCodexTab(page, harness)
    const before = await harness.getActiveTerminalId()
    const tab = page.locator('[data-context="tab"]').last()
    await tab.getByRole('button', { name: 'Close tab' }).click()
    await expect(page.getByText('(running in background)')).toHaveCount(1)
    await page.keyboard.press('Alt+Shift+T')
    await expect.poll(() => harness.getActiveTerminalId()).toBe(before)
  })

  test('right-click "Close and stop agent" stops it', async ({ page, harness }) => {
    await openCodexTab(page, harness)
    const terminalId = await harness.getActiveTerminalId()
    const tab = page.locator('[data-context="tab"]').last()
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close and stop agent' }).click()
    await expect(tab).toHaveCount(0)
    await expect.poll(async () => (await harness.listTerminals()).some((t) => t.terminalId === terminalId && t.status === 'running')).toBe(false)
    await expect(page.getByText('(running in background)')).toHaveCount(0)
  })
})
```

(Use the harness methods that exist (`getTerminalBuffer`, the active-terminal reader from `getPaneLayout`, `/api/terminals` via the harness request helper); the a11y gate allows `[data-context=…]`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Commit the spec first (cloud runs need a clean tree), then:

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts`

Expected: FAIL only if an earlier task regressed — on a tree with Tasks 1–31 complete the new spec is expected to PASS on first run; its red state is demonstrated by running it once on the base commit: `R=/home/dan/code/freshell/.worktrees/codex-pane-lifecycle-e2e-red && git worktree add -b the-usual/codex-pane-lifecycle-e2e-red "$R" f5808f8c3 && cp test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts "$R"/test/e2e-browser/specs/ && cp test/e2e-browser/fixtures/codex-dual-role.ts "$R"/test/e2e-browser/fixtures/ && cp -r test/fixtures/coding-cli/codex-app-server/. "$R"/test/fixtures/coding-cli/codex-app-server/ && cd "$R" && pnpm install --frozen-lockfile && git add -A && git commit -m "tmp: red e2e on base (throwaway)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts` → FAIL (no "Close tab" accessible name, no "Close and stop agent" item, the reopen hits "open in another app"); then `cd /home/dan/code/freshell/.worktrees/codex-pane-lifecycle && git worktree remove --force "$R" && git branch -D the-usual/codex-pane-lifecycle-e2e-red`.

- [ ] **Step 3: Add the minimal production implementation**

Apply the fixture, spec and cloud-config changes listed under **Files** (no product code: the behavior comes from Tasks 1–31).

- [ ] **Step 4: Run the focused test**

Run (clean, committed tree): `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts test/e2e-browser/specs/codex-terminal-restore-rust.spec.ts`

Expected: PASS on the cloud backend with zero retries consumed.

- [ ] **Step 5: Refactor while green**

Move the repeated "open a Codex tab and wait for the TUI" steps into `test/e2e-browser/helpers/codex.ts` and use it from the three specs. Run `pnpm run test:e2e:a11y-gate`.

- [ ] **Step 6: Run impacted-test verification**

Every spec that installs a fake Codex now runs the realistic launcher + native, and every spec that closes tabs, kills panes, reopens, uses MCP kill verbs or the settings backup sentinel is impacted:

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium --shards=4 test/e2e-browser/specs/codex-pane-lifecycle-rust.spec.ts test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts test/e2e-browser/specs/codex-terminal-restore-rust.spec.ts test/e2e-browser/specs/codex-status-completeness-rust.spec.ts test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/restore-contract-wall-rust.spec.ts test/e2e-browser/specs/missed-owner-broadcast-stale-refusal-heal-rust.spec.ts test/e2e-browser/specs/sidebar-click-resume.spec.ts test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts test/e2e-browser/specs/turn-complete-restart-resume-rust.spec.ts test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts test/e2e-browser/specs/terminal-activity-rust.spec.ts test/e2e-browser/specs/compound-restart-rust.spec.ts test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts test/e2e-browser/specs/unified-agent-names-codex.spec.ts test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts test/e2e-browser/specs/mcp-bridge-rust.spec.ts test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/terminal-lifecycle.spec.ts test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts test/e2e-browser/specs/cfg03-backup-restore.spec.ts test/e2e-browser/specs/harness-14-server-clock.spec.ts test/e2e-browser/specs/terminal-stuck-rust.spec.ts && pnpm run test:e2e:a11y-gate`

Expected: PASS (cloud; zero-flake receipt). Then the full cloud e2e suite once: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --shards=4` → PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser
git commit -m "test(e2e): realistic Codex fake everywhere, restore the two cloud-skipped Codex specs, add the pane lifecycle spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 33: Opt-in real-Codex contract — SIGINT and SIGKILL release the writer lock and resume works

**Files:**
- Create: `test/integration/real/codex-lock-release.test.ts` (runs only under the documented opt-in `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, like the Amplifier contracts in the same directory; Linux, needs `codex` on PATH)

**Interfaces:**
- Consumes: the real Codex 0.162 CLI; A10 (an isolated, unauthenticated `CODEX_HOME` can `thread/start`; otherwise `FRESHELL_REAL_CODEX_HOME` points at an existing home and the test archives its thread at the end — `auth.json` is never copied or read).
- Produces: a contract that proves the two signals the stop sequence relies on, against the real binary.

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/integration/real/codex-lock-release.test.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

const codexHome = process.env.FRESHELL_REAL_CODEX_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codex-contract-'))
const owned: ChildProcess[] = []

function freePort(): number {
  const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

async function startAppServer(): Promise<{ child: ChildProcess; port: number }> {
  const port = freePort()
  const child = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: 'ignore' })
  owned.push(child)
  return { child, port }
}

async function rpc(port: number): Promise<(method: string, params: unknown) => Promise<any>> {
  let ws: WebSocket | undefined
  for (let i = 0; i < 100 && !ws; i++) {
    ws = await new Promise<WebSocket | undefined>((resolve) => { const s = new WebSocket(`ws://127.0.0.1:${port}`); s.once('open', () => resolve(s)); s.once('error', () => resolve(undefined)) })
    if (!ws) await new Promise((r) => setTimeout(r, 100))
  }
  if (!ws) throw new Error('app-server never listened')
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) } })
  const call = (method: string, params: unknown) => new Promise<any>((resolve) => { const n = ++id; pending.set(n, resolve); ws!.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params })) })
  await call('initialize', { clientInfo: { name: 'freshell-contract', version: '1' }, capabilities: { experimentalApi: true } })
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
  return call
}

function nativePid(port: number): number {
  const out = spawnSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8' }).stdout
  return Number(/pid=(\d+)/.exec(out)?.[1])
}

function lockHeld(thread: string): boolean {
  const file = path.join(codexHome, 'thread-writer-locks', `${thread}.lock`)
  if (!fs.existsSync(file)) return false
  const ino = String(fs.statSync(file).ino)
  return fs.readFileSync('/proc/locks', 'utf8').split('\n').some((l) => l.includes('FLOCK') && l.split(/\s+/)[5]?.endsWith(`:${ino}`))
}

async function untilDead(pid: number) {
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0) } catch { return } await new Promise((r) => setTimeout(r, 50)) }
  throw new Error(`pid ${pid} still alive`)
}

describe('real codex: the writer lock follows the native process', () => {
  afterAll(() => { for (const c of owned) c.kill('SIGKILL') })

  for (const signal of ['SIGINT', 'SIGKILL'] as const) {
    it(`${signal} to the native app-server releases the lock and a new app-server resumes`, async () => {
      const a = await startAppServer()
      const callA = await rpc(a.port)
      const started = await callA('thread/start', { cwd: os.tmpdir() })
      const thread = started.result.thread.id as string
      expect(lockHeld(thread)).toBe(true)
      const native = nativePid(a.port)
      process.kill(native, signal) // the native app-server this test spawned (via its launcher)
      await untilDead(native)
      expect(lockHeld(thread)).toBe(false)
      const b = await startAppServer()
      const callB = await rpc(b.port)
      const resumed = await callB('thread/resume', { threadId: thread, cwd: os.tmpdir() })
      expect(resumed.error).toBeUndefined()
      if (process.env.FRESHELL_REAL_CODEX_HOME) await callB('thread/archive', { threadId: thread })
      b.child.kill('SIGINT')
    }, 60_000)
  }
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

This contract guards external behavior Freshell relies on; it is expected to pass against Codex 0.162. Its red check is structural: run it once with the signal sent to the LAUNCHER pid (`a.child.pid`) instead of the native and `SIGKILL` — it must FAIL with `expected true to be false` (the orphaned native keeps the lock), demonstrating the test can detect the original defect. Then restore the native target.

Run: `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 pnpm run test:vitest run test/integration/real/codex-lock-release.test.ts --config config/vitest/vitest.config.ts`

Expected (launcher-target variant): FAIL as described; (native target): PASS.

- [ ] **Step 3: Add the minimal production implementation**

None (contract test only); keep the native-target version.

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 pnpm run test:vitest run test/integration/real/codex-lock-release.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (2 tests). Afterwards confirm nothing this test started is still running: `pgrep -af "codex app-server --listen ws://127.0.0.1"` shows none of the ports it used (the managed daemon `--managed-daemon` is never touched).

- [ ] **Step 5: Refactor while green**

No refactor needed (one self-contained contract file).

- [ ] **Step 6: Run impacted-test verification**

Run: `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 pnpm run test:vitest run test/integration/real/ --config config/vitest/vitest.config.ts`

Expected: PASS (the Amplifier contracts behave as before; Codex's passes).

- [ ] **Step 7: Commit the task**

```bash
git add test/integration/real/codex-lock-release.test.ts
git commit -m "test(contract): real Codex releases its writer lock on SIGINT/SIGKILL of the native process and resumes cleanly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 34: Windows desktop-app smoke (kill then reopen), cross-platform CI evidence, and the final full verification

**Files:**
- Create: `test/integration/electron/agent-unit-kill-reopen.test.ts` (runs in `config/vitest/vitest.electron-runtime.config.ts` against the packaged server inside the unpacked desktop app, exactly like `checkout-free-runtime.test.ts` (`:317-600`): same runtime root, free port, authenticated WebSocket, owned-child cleanup)

**Interfaces:**
- Consumes: everything; on Windows: Task 6 (job units), the fake's non-Linux lock no-op (Task 1).
- Produces: desktop-app evidence on `windows-2022` (and the same test on `macos-15-intel`, `macos-latest`, `ubuntu-latest`, since `test:electron:runtime` runs on all four).

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/integration/electron/agent-unit-kill-reopen.test.ts
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
// The helpers below are moved out of checkout-free-runtime.test.ts into
// test/integration/electron/runtime-helpers.ts (no behavior change there).
import { runtimeRoot, findFreePort, connectAuthenticatedWebSocket, waitForWebSocketMessage, stopOwnedChild, waitForJsonLine } from './runtime-helpers.js'

const repoFixtures = path.resolve(__dirname, '../../fixtures/coding-cli/codex-app-server')

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('desktop app: kill then reopen a Codex pane', () => {
  const owned: Array<ReturnType<typeof spawn>> = []
  afterAll(async () => { for (const c of owned) await stopOwnedChild(c) })

  it('stops the whole agent and reopens the same conversation without a conflict', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-unit-smoke-'))
    const manifests = path.join(home, 'manifests')
    const port = await findFreePort()
    const runtime = runtimeRoot()
    const serverBinary = path.join(runtime, 'bin', process.platform === 'win32' ? 'freshell-server.exe' : 'freshell-server')
    const launcher = path.join(repoFixtures, 'fake-codex-launcher.mjs')
    const tui = path.join(repoFixtures, 'fake-codex-tui.mjs')
    const dispatcher = path.join(home, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    fs.writeFileSync(dispatcher, process.platform === 'win32'
      ? `@echo off\r\necho %* | findstr /C:"app-server" >nul && (node "${launcher}" %*) || (node "${tui}" %*)\r\n`
      : `#!/bin/bash\nif [[ " $* " == *" app-server "* ]]; then exec node "${launcher}" "$@"; else exec node "${tui}" "$@"; fi\n`, { mode: 0o755 })
    const server = spawn(serverBinary, [], {
      env: { ...process.env, PORT: String(port), AUTH_TOKEN: 'smoke-token', HOME: home, USERPROFILE: home, FRESHELL_HOME: path.join(home, '.freshell'),
        CODEX_HOME: path.join(home, '.codex'), CODEX_CMD: dispatcher, FAKE_CODEX_MANIFEST_DIR: manifests, FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    owned.push(server)
    await waitForJsonLine(server, (l) => String(l.msg ?? '').includes('listening'))
    const ws = await connectAuthenticatedWebSocket(`http://127.0.0.1:${port}`)
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'crq-1', mode: 'codex', shell: 'system', sessionRef: { provider: 'codex', sessionId: 't-smoke' } }))
    const created = await waitForWebSocketMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'crq-1')
    const pids = () => fs.readdirSync(manifests).map((f) => JSON.parse(fs.readFileSync(path.join(manifests, f), 'utf8')).pid as number)
    const before = pids()
    expect(before.length).toBeGreaterThanOrEqual(2) // launcher + native
    ws.send(JSON.stringify({ type: 'terminal.kill', terminalId: created.terminalId, requestId: 'rk', createRequestId: 'crq-1' }))
    const killed = await waitForWebSocketMessage(ws, (m) => m.type === 'terminal.killed' && m.requestId === 'rk')
    expect(killed.success).toBe(true)
    for (const pid of before) expect(alive(pid), `pid ${pid} survived the kill`).toBe(false)
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'crq-2', mode: 'codex', shell: 'system', restore: true, sessionRef: { provider: 'codex', sessionId: 't-smoke' } }))
    const reopened = await waitForWebSocketMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'crq-2')
    expect(reopened.terminalId).not.toBe(created.terminalId)
    const output = await waitForWebSocketMessage(ws, (m) => m.type === 'terminal.output' && m.terminalId === reopened.terminalId && /FAKE_TUI_READY|open in another app/.test(m.data))
    expect(output.data).toContain('FAKE_TUI_READY thread=t-smoke')
  }, 120_000)
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

On the base commit the Windows build orphans the native on kill. Demonstrate the red state on the runner by dispatching the workflow on a throwaway branch made from `f5808f8c3` plus only this test file (`git switch -c the-usual/codex-pane-lifecycle-smoke-red f5808f8c3 && git checkout the-usual/codex-pane-lifecycle -- test/integration/electron/agent-unit-kill-reopen.test.ts test/integration/electron/runtime-helpers.ts test/fixtures/coding-cli/codex-app-server && git commit -m "test: red smoke (throwaway branch)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push -u origin HEAD && gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle-smoke-red`).

Expected: the `windows-2022` job FAILS at `pid … survived the kill`. Then delete that branch locally and on the remote (`git push origin --delete the-usual/codex-pane-lifecycle-smoke-red`).

- [ ] **Step 3: Add the minimal production implementation**

None beyond moving the shared helpers into `test/integration/electron/runtime-helpers.ts` (and importing them back into `checkout-free-runtime.test.ts`).

- [ ] **Step 4: Run the focused test**

Run: `git push origin the-usual/codex-pane-lifecycle && gh workflow run electron-build.yml --ref the-usual/codex-pane-lifecycle && sleep 5 && gh run watch "$(gh run list --workflow electron-build.yml --branch the-usual/codex-pane-lifecycle --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status`

Expected: PASS on `windows-2022`, `macos-15-intel`, `macos-latest`, `ubuntu-latest` (this test plus the containment suites from Tasks 6–7).

Additional real desktop check on DANDESKTOP (the user's Windows machine; builds only, never touching the running desktop app): follow `docs/development/windows-electron-build.md` Option A over `ssh dandesktop` into a fresh `C:\Users\dan\AppData\Local\Temp\freshell-unit-smoke` clone of the pushed branch, run `pnpm install --frozen-lockfile && pnpm run electron:build:win && pnpm run test:electron:runtime` there, and record the result in the run state. If DANDESKTOP is unreachable or its toolchain is missing, the `windows-2022` runner result is the evidence and the run state records why the second check was not possible.

- [ ] **Step 5: Refactor while green**

No refactor needed.

- [ ] **Step 6: Run impacted-test verification (the final full verification)**

This is the last task: the impacted set is everything.

Run, in order (committed clean tree):
1. `cargo fmt --all --check && cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`
2. `pnpm run lint && pnpm run typecheck`
3. `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY="codex-pane-lifecycle: final full gate" pnpm run check`
4. `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1 cargo test -p freshell-containment --locked && scripts/sandbox-test.sh "cargo test -p freshell-containment -p freshell-ws --locked"`
5. `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --shards=4 && pnpm run test:e2e:a11y-gate`
6. `gh workflow run rust-tests.yml --ref the-usual/codex-pane-lifecycle` and the `electron-build.yml` run above, both watched to success.
7. `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 pnpm run test:vitest run test/integration/real/ --config config/vitest/vitest.config.ts`

Expected: every step PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/integration/electron
git commit -m "test(electron): desktop-app smoke — kill a Codex pane, every process is gone, reopen resumes cleanly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Plan self-review notes (Stage 1)

- The `## User Request` block appears once, unchanged; every Explicit constraint and residual maps to a task and test in the traceability table.
- Temporary seams and the task that removes each: Task 2's non-Linux `Unsupported` bodies → Tasks 6–7 (Task 7 Step 5 checks none remain); Task 4's Windows `roots.rs` placeholder → deleted in Task 6; Task 12's minimal screen-exit decision (every unrequested screen exit ends the unit) → Task 17's full decision table; `AlreadyStopping` treated like `NotLive{Stopping}` (Task 8) → joined by the fresh-agent lanes in Task 23; `reap_owned_codex_sidecars` kept for freshcodex (Task 10) → deleted in Task 23; the Fenced state kept through Task 23 → deleted in Task 24 (server) and Task 28 (client).
- The only test hook in production code is the env-gated Gone-confirmation delay (`FRESHELL_TEST_HOOKS=1` + `FRESHELL_TEST_UNIT_GONE_DELAY_MS`); it delays the confirmation, never the kill, and exercises the real unconfirmed path (error log, record kept Stopping, tab Stopping…).
- No new waiting or detection polls: registry wakers, pidfd/kqueue/handle waits, inotify on `cgroup.events`, job completion ports, deadline timers and protocol notifications only. Test harnesses use bounded test-only waits; the pre-existing stale-start watchdog ticker and stuck-pane monitor are untouched.
- Hosts that cannot run a backend's tests: Windows/macOS suites run on `electron-build.yml` runners (Tasks 6, 7, 34); the systemd suite runs on garageserver with `FRESHELL_REQUIRE_SYSTEMD_CONTAINMENT=1` and on CI per A9; the Docker sandbox proves the degraded backend.
