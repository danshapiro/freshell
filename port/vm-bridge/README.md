# vm-bridge — execution bridge for a write-sandboxed agent session

> ## STATUS: DORMANT — do NOT start a watcher (2026-07-10)
>
> This bridge is retained as a **documented break-glass artifact only**, per the
> 2026-07-10 adversarial security review (verdict: ACCEPT for commit as dormant,
> with mandatory conditions — both applied, see "Security hardening" below).
> The blocker that motivated it (`ENV-VM-EXEC-2026-07-08`) is
> **RESOLVED-BY-RELOCATION**: on 2026-07-10 the user moved the session back to
> DANDESKTOP WSL2, where the agent has a working shell. Nothing here should run
> unless a future session is again write-sandboxed without command execution —
> and then only after re-reading the security notes below.

**Context (2026-07-08):** an Amplifier agent session was launched on the **TauriDebugVM**
(Windows 11, user `Admin`) with the worktree mounted read/write via `\\tsclient\Z` /
`C:\TauriVmShares\rust-tauri-port`. On that VM the agent has **no command execution**:

- The amplifier `bash` tool resolves `bash` → `C:\Windows\System32\bash.exe` (the WSL
  launcher). The VM has **no WSL distribution installed**, so every bash call fails with
  *"Windows Subsystem for Linux has no installed distributions."* The tool's cmd.exe
  fallback is unreachable while that stub exists, and Git Bash
  (`C:\Program Files\Git\bin\bash.exe`) cannot be selected (PATH/cwd are outside the
  agent's control).
- The VM's existing PowerShell bridge (`C:\Scripts\console-host.ps1` watching
  `C:\Scripts\console-inbox`) is outside the agent's write sandbox
  (`allowed_write_paths: ["."]` = this worktree only), so the agent cannot feed it.

The agent CAN read anywhere and write inside this worktree. These watcher scripts close
the loop: a human starts ONE of them; the agent then drops command files into the inbox
and reads results from the outbox.

## Start the VM watcher

> **SUPERSEDED DIRECTIVE.** The 2026-07-08 user directive recorded here ("the agent
> must operate ONLY on the TauriDebugVM; `agent-console-wsl.sh` must NOT be run; the
> agent must not execute anything on DANDESKTOP") was **rescinded by the user on
> 2026-07-10**: the session was brought back to DANDESKTOP WSL2 and execution there is
> sanctioned again. Supersession is also recorded in `port/machine/STATE.yaml`
> (`constraints.vm_only`) and `port/machine/BLOCKER-2026-07-08-vm-session.md`.
> One part survives on security grounds, re-scoped: see F2 under "Security hardening" —
> never run `agent-console-wsl.sh` while the worktree is shared to another machine.

On the TauriDebugVM (Windows PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TauriVmShares\rust-tauri-port\port\vm-bridge\agent-console-vm.ps1
```

## Protocol

| Side | Request (agent writes) | Response (agent reads) | Liveness |
|---|---|---|---|
| WSL | `inbox-wsl/<id>.cmd` → `bash -lc` | `outbox-wsl/<id>.out` (+ `---RC=n---`) | `alive-wsl.txt` |
| VM  | `inbox-vm/<id>.cmd` → `Invoke-Expression` | `outbox-vm/<id>.out` (+ `---RC=n---`) | `alive-vm.txt` |

**Write protocol (mandatory, anti-TOCTOU):** writers MUST create the request as
`<id>.tmp` in the inbox and then **rename** it to `<id>.cmd` (rename is atomic on the
same filesystem). The watchers only glob `*.cmd`, so a half-written file is never
executed. Never write `.cmd` files directly.

Long-running processes (servers) should be started detached (`nohup … &` /
`Start-Process`), since each watcher runs commands sequentially.

## Security hardening (2026-07-10 adversarial review — read before ever reviving this)

Both watchers execute **arbitrary text** dropped into their inbox (`Invoke-Expression` /
`bash -lc`). That is their stated purpose, but it creates three concrete hazards, now
mitigated as follows:

- **F1 — startup time-bomb (fixed in the scripts):** pre-existing inbox files used to
  execute the instant a watcher started. Both watchers now **quarantine** (move to
  `quarantine-<timestamp>/`, never execute) anything already present in the inbox at
  startup. A human should still eyeball the inbox before starting a watcher.
- **git-delivered RCE (fixed in `.gitignore`):** `port/vm-bridge/inbox-*/`,
  `outbox-*/`, `quarantine-*/`, `alive-*.txt`, and `outbound/` are gitignored at the
  worktree root. **Never commit an inbox file and never force-add past the ignore** — a
  committed `.cmd` would execute on checkout/pull on any machine with a live watcher.
  If a watcher is running, do not `git pull` into this worktree.
- **F2 — cross-machine escalation (procedural, survives the directive supersession):**
  the worktree is shared over RDP (`\\tsclient\Z`). Running `agent-console-wsl.sh` on
  DANDESKTOP while the share is mounted would let anything that can write files on the
  VM execute code on the real build host. **Never run the WSL watcher while the
  worktree is shared to another machine/VM**; unmount the share first.
- **F3 — partial-write race (protocol, above):** temp-then-rename is mandatory for
  writers; watchers glob only `*.cmd`.

Run a watcher only while deliberately supervising an agent session on this repo, and
only after the conditions above hold.

## Stop / clean up

Ctrl-C the watcher whenever the agent session ends. The scripts execute arbitrary
commands from their inbox folders — do not leave them running unsupervised. The
`inbox-*`/`outbox-*`/`quarantine-*`/`alive-*` artifacts are session scratch, gitignored,
and safe to delete.
