# BLOCKER — 2026-07-08 session: no command execution available (TauriDebugVM)

> ## ADDENDUM 2026-07-10 — RESOLVED-BY-RELOCATION; VM-only directive SUPERSEDED
>
> On 2026-07-10 the user brought the session back to **DANDESKTOP WSL2**, where the
> agent has a working shell. The **USER DIRECTIVE below ("operate ONLY on the
> TauriDebugVM; do not execute anything on DANDESKTOP") is rescinded** — do not obey
> it. Nothing was fixed ON the VM; the blocker is moot, not solved: if a session is
> ever again launched from that VM sandbox, every finding in this document still
> applies verbatim.
>
> Disposition of the staged unblock: `port/vm-bridge/` is retained **DORMANT** and was
> security-hardened per the 2026-07-10 adversarial review (inbox/outbox gitignored,
> startup quarantine, temp-then-rename protocol — see `port/vm-bridge/README.md`).
> Do not start a watcher. The companion
> `port/machine/PLAN-2026-07-09-vm-windows-on-windows.md` is SUPERSEDED (banner in
> place). Supersession is also recorded in `port/machine/STATE.yaml`
> (`constraints.vm_only`, `blockers[0].status`).

**Status:** RESOLVED-BY-RELOCATION (was: OPEN — mission could not advance past
documentation from that sandbox; see addendum above).
**Unblock staged:** `port/vm-bridge/` (one command for the operator — see below).
**Registered in:** `port/machine/STATE.yaml` → `blockers:` (per its own protocol).

## Where this session actually runs

Everything in `port/HANDOFF.md` assumes the agent runs on **DANDESKTOP WSL2** (the host
where all prior work, builds, oracle runs, and matrix legs were executed). This session
instead runs on the **TauriDebugVM**:

- Windows 11 (build 26200), user `Admin`, hostname = the "TauriDebugVM" of
  `C:\Scripts\console-host.ps1` ("TauriDebugVM - host-driven console").
- Worktree access is file-only, via RDP drive redirection `\\tsclient\Z\home\dan\code\...`
  and the VM share alias `C:\TauriVmShares\rust-tauri-port` (verified: writes through one
  alias appear through the other — same underlying host filesystem).
- `git` reports "not a repo" here (worktree `.git` file points at the Linux-absolute
  gitdir `/home/dan/code/freshell/.git/worktrees/rust-tauri-port`).

## Evidence chain (each item independently verified this session)

1. **bash tool dead.** Five separate invocations (`uname -a`, `dir`, `echo test123`,
   `echo hi`, `pwd`) all returned UTF-16 *"Windows Subsystem for Linux has no installed
   distributions."* (rc=1). Cause, from the mounted tool source
   (`~/.amplifier/cache/amplifier-module-tool-bash-*/amplifier_module_tool_bash/__init__.py:556-621`):
   on win32 it uses `shutil.which("bash")`, which resolves to
   `C:\Windows\System32\bash.exe` — the WSL launcher — and `C:\Program Files\WSL` exists
   with **zero distros installed**. Both its WSL and "Git Bash" exec paths therefore
   print the no-distro error; the cmd.exe fallback (line 589) is unreachable while
   System32's bash.exe exists.
2. **Git Bash exists but is unreachable.** `C:\Program Files\Git\bin\bash.exe` is
   installed, but `shutil.which` can only be steered via PATH or the process cwd; the
   agent can write to neither (see 3). A `bash.cmd` shim placed at the worktree root was
   provably NOT picked up (the WSL stub still won), i.e. the amplifier process cwd is a
   system directory, not the worktree. Shim removed after the test.
3. **Write sandbox = worktree only.** Session config (events.jsonl `session:config`):
   `tool-filesystem: allowed_write_paths: ["."]`, working_dir = the worktree. Verified:
   writes inside the worktree succeed (both aliases); writes to
   `C:\Scripts\console-inbox` (twice, via `write_file` AND `apply_patch`),
   `C:\Users\Admin\.amplifier`, `C:\Users\Admin\.local` are all denied
   ("not within allowed write paths").
4. **The VM's own PowerShell bridge is out of reach.** `C:\Scripts\console-host.ps1`
   (running pattern proven: `C:\Scripts\drive-status.txt` heartbeat updates every 15 s;
   outbox shows it executed commands on 2026-07-07) executes `C:\Scripts\console-inbox\*.cmd`
   — but item 3 blocks writing there.
5. **No other execution primitive.** `delegate`/`recipes`/skills run in-process with the
   same tool roster; no MCP servers are configured (`~/.amplifier/settings.yaml`,
   `registry.json`); modes (careful/explore/plan) only restrict tools; web tools are
   outbound HTTP only. There is no delete/exec side channel.

## Consequence

Every remaining acceptance criterion in `port/GOAL.md` requires process execution:
oracle tiers (node/vitest/cargo), matrix legs (launch Tauri/Electron/Chrome +
screenshots), CLI argv fidelity live proof, purity checks (`git diff`), and delivery
(`git commit/push`). **None of these can be performed from this sandbox.** Writing
unverifiable code or reports would violate the project's own no-force-green rules, so
this session stopped at documentation + unblock staging.

## Unblock playbook

**USER DIRECTIVE (2026-07-08, this session): the agent must operate ONLY on the
TauriDebugVM.** Running outside the VM caused failures; do NOT execute anything on
DANDESKTOP. This supersedes the earlier "run on DANDESKTOP WSL2" options.

Sanctioned unblock — on the TauriDebugVM:
`powershell -NoProfile -ExecutionPolicy Bypass -File C:\TauriVmShares\rust-tauri-port\port\vm-bridge\agent-console-vm.ps1`
(same pattern as the existing `C:\Scripts\console-host.ps1`, but watching a folder the
agent may write). Equivalent VM-only alternatives: relaunch amplifier with
`C:\Scripts\console-inbox` added to `allowed_write_paths`, or install a WSL distro on
the VM so the bash tool works.

VM capability inventory (read-only survey, this session): Windows server exe present via
the share (`target/x86_64-pc-windows-gnu/release/freshell-server.exe`, 15.5 MB) and
`dist/` present; Microsoft Edge + EdgeWebView installed; Git for Windows installed;
NO node, NO cargo/rustup, NO Chrome, NO legacy Freshell.exe (Electron) under the Admin
profile, NO WSL distro. Matrix cells that require what the VM lacks must be either
provisioned ON the VM or recorded ENV-LIMITED with proof — never executed off-VM.

## Footprint of this session (kept minimal, all inside the worktree)

- Added: `port/vm-bridge/{README.md, agent-console-wsl.sh, agent-console-vm.ps1}`,
  this file, and a `blockers:` entry in `port/machine/STATE.yaml`.
- Temporary probe files (3 tiny `.write-probe*` files, 1 `bash.cmd` shim) were created
  during diagnosis and **deleted** again via `apply_patch delete_file`.
- `server/`, `shared/`, `src/` untouched. No process started or killed; no user config
  touched; the user's `:3001` never contacted; zero live-model calls spent.
- NOT committed: git is unreachable from this sandbox. First agent with a working shell
  should `git add port/vm-bridge port/machine/BLOCKER-2026-07-08-vm-session.md
  port/machine/STATE.yaml` and commit with the standard attribution block.
