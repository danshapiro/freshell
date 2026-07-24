# PLAN — Land windows-on-windows support within the TauriDebugVM

> ## SUPERSEDED 2026-07-10 — do not execute any phase of this plan
>
> This plan's premise — ALL execution on the TauriDebugVM via the vm-bridge — was
> rescinded on 2026-07-10 when the user moved the session back to DANDESKTOP WSL2
> (see `BLOCKER-2026-07-08-vm-session.md` addendum and `STATE.yaml`
> `constraints.vm_only`). The remaining matrix legs run on DANDESKTOP, which covers
> more of the matrix than this VM ever could (Chrome, WSL, legacy Electron, proven
> toolchain). The vm-bridge itself is DORMANT (see `port/vm-bridge/README.md`).
>
> **Kept because it holds salvageable intel** (adversarial records-audit verdict):
> - D9: the legacy Electron installer location —
>   `Freshell Setup 0.7.0.exe` under `.worktrees/electron-windows-native/release/`
>   (needed for the Electron matrix legs, wherever they run).
> - The VM capability inventory (Phase 0 / D5, D7, D8) and the share-performance
>   findings (D1: UNC builds hang; 55-min grep) — relevant to any future VM session.
> - §1 bridge command discipline — the operating manual if bridge mode is ever
>   deliberately revived.

**Written:** 2026-07-09. **Mode:** ARCHITECT output; this file is the phase-gated execution
plan driven step-by-step through the vm-bridge. **Authority stack:** `port/GOAL.md` (success
criteria), `port/HANDOFF.md` (queue §9, recipes §8), `port/machine/STATE.yaml` (state),
`port/machine/BLOCKER-2026-07-08-vm-session.md` (VM directive + inventory),
`port/vm-bridge/README.md` + `agent-console-vm.ps1` (bridge protocol).

**Definition of "windows-on-windows":** the native Windows Tauri shell
(`freshell-tauri.exe`) running against the native Windows `freshell-server.exe`
(app-bound AND remote/provisioning modes), plus every other GOAL §2 matrix leg this VM can
support, with the rest recorded ENV-LIMITED with proof (GOAL.md:22-33).

**Binding constraints (restated, non-negotiable):**
- ALL execution on the TauriDebugVM only; nothing runs on DANDESKTOP
  (BLOCKER-2026-07-08-vm-session.md:63-65; STATE.yaml:44-48).
- No-force-green: nothing claimed without executed proof (GOAL.md:37-44; HANDOFF.md:288).
- `server/`, `shared/`, `src/` byte-identical to reference at every commit (GOAL.md:48-49).
- Evidence conventions: screenshots + reports under `port/oracle/matrix/`, skeptical vision
  review mandatory (HANDOFF.md:226-235); commits carry the attribution block, push to
  `feat/rust-tauri-port`, no PR (HANDOFF.md:286-287).

---

## 0. Decisions (made here, once — do not re-litigate mid-run)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Build location: `C:\work\freshell` (VM-local NTFS).** Never run cargo/npm against `\\tsclient\...` / `C:\TauriVmShares\...`. | The share died mid-session once (14.5h hang) and a repo-wide grep over it took 55 min. Cargo does heavy stat/rename/mmap; UNC would be slow and hang-prone. |
| D2 | **Git strategy: `git clone --no-local --single-branch --no-tags --branch feat/rust-tauri-port` from the share's main repo** (`\\tsclient\Z\home\dan\code\freshell`) into `C:\work\freshell`, with `-c core.autocrlf=false -c core.filemode=false`. Fallback: robocopy file tree + `git init` (degraded; see Phase 1). | The worktree's `.git` file points at the Linux-absolute gitdir (`BLOCKER…:18-19`) — git in the worktree can never work on the VM. The main repo's `.git` is a real directory reachable via the share; `feat/rust-tauri-port` is a normal ref in it (HEAD @ `1c2c9c7d`, HANDOFF.md:8). `--no-local` streams one pack (single bounded transfer) instead of thousands of per-file copies. `autocrlf=false` is mandatory for the byte-identical purity invariant. |
| D3 | **Delivery: commit locally in `C:\work\freshell`, export `git bundle` files to the share** (`port/vm-bridge/outbound/`). No credentials ever placed on the VM; no direct push from the VM. The human applies bundles on the host. | The clone's `origin` is the share path (not GitHub); pushing to a non-bare repo whose branch is checked out in a worktree is refused; GitHub push would require secrets on the VM. Bundles are atomic, verifiable (`git bundle verify`), and land inside the agent-writable worktree. |
| D4 | **The human starts the bridge watcher in an ELEVATED PowerShell** (one-time decision). | VS Build Tools + Node MSI + `Add-MpPreference` need elevation; an elevated watcher removes every UAC-stall failure mode. The VM is a disposable debug VM under user `Admin`; GOAL §4's elevation ban protects the user's live host (DANDESKTOP), not this VM. |
| D5 | **Browsers: Edge (installed) via Playwright `channel:'msedge'` for the mirror-client harness.** Chrome is NOT installed; the Chrome×{WSL,Win} matrix cells stay claimed by the existing DANDESKTOP evidence (HANDOFF.md:130-137) and are recorded "not re-runnable on this VM (Chrome absent — `where.exe` proof)". Edge runs are labeled *supplementary*, never as the Chrome cell. | Zero browser download; Edge is Chromium; GOAL names Chrome specifically so we don't relabel. |
| D6 | **Packaging/signing: DEFERRED.** `bundle.active:false` stays (tauri.conf.json:25); we build the debug/release exe only. | GOAL §5 delivery = commits + reports + runbook (GOAL.md:56-67); no installer demanded. |
| D7 | **Coding CLIs (claude/codex/opencode/gemini): NOT installed on the VM.** Recorded ENV-LIMITED with `where.exe` proof per pane kind. | They need the user's API auth; secrets must not be copied to the VM. GOAL.md:30-31 sanctions exactly this. |
| D8 | **Server binary: reuse the proven cross-compiled `freshell-server.exe`** (x86_64-pc-windows-gnu, 15.5MB) copied from the share's `target/`, plus the prebuilt `dist/client`. Rebuild (MSVC) only if a shared crate changes; if so, note artifact provenance and rebuild BOTH binaries' evidence per HANDOFF.md:98-99. | It's the exact artifact the Win×Chrome 9/9 leg validated. Avoids blocking the matrix on a server rebuild. |
| D9 | **Legacy Electron leg: runnable.** `Freshell Setup 0.7.0.exe` exists at `\\tsclient\Z\home\dan\code\freshell\.worktrees\electron-windows-native\release\` — install it ON the VM (fresh profile ⇒ nothing to back up, still snapshot `%USERPROFILE%\.freshell` before/after). | Converts a would-be ENV-LIMITED cell into executed proof, per BLOCKER…:78-79 ("provisioned ON the VM"). |
| D10 | **WSL-server legs: stretch phase only** (optional Phase 8, requires `wsl --install` + possible reboot). If not attempted or failed: ENV-LIMITED with `wsl -l -v` proof. | Core windows-on-windows legs must not be hostage to a reboot-risky provisioning step. The Linux `target/release/freshell-server` ELF already exists on the share, so the leg is feasible if attempted. |

---

## 1. Bridge command discipline (applies to every phase)

- One logical action per file: `port/vm-bridge/inbox-vm/NNN-slug.cmd` (zero-padded NNN —
  the watcher sorts by name). Poll `outbox-vm/NNN-slug.out` for the `---RC=n---` trailer.
- **PowerShell 5.1 rules:** no `&&`/`||` chaining (use `;`); no PS7-only syntax; always
  full paths to executables (the watcher's PATH predates every install:
  `C:\Users\Admin\.cargo\bin\cargo.exe`, `C:\Program Files\nodejs\node.exe`, etc.).
- **Bounded inline, detached otherwise.** Anything that could exceed ~60s (cargo, npm,
  installers, servers, GUI apps) runs `Start-Process` detached with
  `-RedirectStandardOutput/-RedirectStandardError` to `C:\work\logs\NNN.{out,err}` and PID
  saved to `C:\work\logs\NNN.pid`; progress is polled with
  `Get-Process -Id (Get-Content ...pid) -ErrorAction SilentlyContinue` +
  `Get-Content ...err -Tail 10`. Never `Invoke-Expression` a long build inline (the watcher
  is sequential — one hung command bricks the bridge).
- **Env vars for detached processes** (PS 5.1 `Start-Process` has no `-Environment`): set
  `$env:X='...'` in the command, `Start-Process` (child inherits), then
  `Remove-Item Env:X`. For anything nontrivial, author a helper `.ps1` under
  `port/vm-bridge/scripts/` (agent-writable, committable), copy it to `C:\work\scripts\`
  via a bridge command, and run it from there (never execute long scripts off the share).
- **Hang triage:** if an `.out` hasn't appeared after 120s for a bounded command, first
  read `port/vm-bridge/alive-vm.txt` — stale timestamp ⇒ watcher/share down ⇒ STOP, report
  to the human; fresh timestamp ⇒ the command itself is stuck ⇒ next command
  `Stop-Process` it by name/PID.
- **State discipline:** after every phase gate, update `port/machine/STATE.yaml` +
  append to `port/machine/VM-PROGRESS.md` (create in Phase 0: one line per completed step,
  with outbox id). Any agent restart resumes from those two files.
- **Sync map (only these paths, never repo-root mirrors, NEVER `server/ shared/ src/`):**
  - docs/code authored by agent: share worktree → `C:\work\freshell` (robocopy per subpath)
    before each commit;
  - evidence produced on VM (`C:\work\evidence`, logs): → `C:\work\freshell\port\oracle\matrix\`
    (for commit) AND → share worktree `port\oracle\matrix\` (so the agent can read/vision-review);
  - bundles: `C:\work\bundles\*.bundle` → share `port/vm-bridge/outbound/`.
  - Robocopy always with bounded retry: `/R:1 /W:2 /NP`.

---

## Phase 0 — Bridge bring-up, smoke, inventory, evidence of ENV-LIMITs

**Objective:** a proven working execution loop + a signed capability inventory that later
ENV-LIMITED entries cite. **Est: 15 min.**

Prereq (human, on the VM, **elevated** PowerShell):
`powershell -NoProfile -ExecutionPolicy Bypass -File C:\TauriVmShares\rust-tauri-port\port\vm-bridge\agent-console-vm.ps1`

Steps (each = one inbox file):
1. `001-echo.cmd`: `Write-Output 'bridge-alive'; [Environment]::OSVersion.VersionString; whoami; $PSVersionTable.PSVersion.ToString()`
2. `002-elevation.cmd`: `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')` — must print True (D4).
3. `003-inventory.cmd`: `git --version; where.exe git node cargo rustup wsl claude codex opencode gemini 2>&1; Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'; wsl.exe -l -v 2>&1` — capture; this outbox file IS the ENV-LIMITED proof for CLI panes, Chrome, and WSL. Copy it to `port/oracle/matrix/vm-env-inventory.txt`.
4. `004-disk-net.cmd`: `Get-PSDrive C | Select-Object Used,Free; Invoke-WebRequest -UseBasicParsing -Method Head -TimeoutSec 15 https://static.rust-lang.org | Select-Object StatusCode` — need ≥ 30 GB free and outbound HTTPS.
5. `005-mkdirs.cmd`: `New-Item -ItemType Directory -Force -Path C:\work,C:\work\logs,C:\work\scripts,C:\work\evidence,C:\work\bundles,C:\work\dl,C:\work\scratch | Select-Object FullName`
6. `006-defender.cmd`: `Add-MpPreference -ExclusionPath 'C:\work'` (elevated; protects cargo perf and avoids first-run exe quarantine).
7. Create `port/machine/VM-PROGRESS.md`; record steps 1-6.

**Success:** all RCs 0; inventory captured; ≥30GB free; HTTPS 200.
**Abort:** no `.out` for `001` and `alive-vm.txt` stale ⇒ watcher not started/dead ⇒ report to human; no disk ⇒ ask human to grow the VHD.

---

## Phase 1 — VM-local repo + commit the stranded files (task A)

**Objective:** a real git repo on `C:\work` at `feat/rust-tauri-port`, with the stranded
`port/vm-bridge/`, `BLOCKER-2026-07-08-vm-session.md`, `STATE.yaml` (and this plan)
committed — discharging BLOCKER…:89-91. **Est: 20-40 min (share-bound clone).**

1. `010-clone.cmd` (detached; the pack transfer can take many minutes):
   ```powershell
   $env:GIT_TERMINAL_PROMPT='0'
   Start-Process -FilePath 'C:\Program Files\Git\cmd\git.exe' -ArgumentList @('clone','--no-local','--single-branch','--no-tags','--branch','feat/rust-tauri-port','-c','core.autocrlf=false','-c','core.filemode=false','//tsclient/Z/home/dan/code/freshell','C:\work\freshell') -RedirectStandardOutput C:\work\logs\010.out -RedirectStandardError C:\work\logs\010.err -PassThru | % Id | Set-Content C:\work\logs\010.pid
   ```
   Poll `010.err` tail. If UNC-form fails instantly, retry with `\\tsclient\Z\home\dan\code\freshell`.
   **Fallback (only if clone is impossible):** robocopy the share worktree file tree
   (excluding `target`, `node_modules`, `.git`) to `C:\work\freshell`, `git init`, commit a
   synthetic baseline. Consequence (record in STATE.yaml if taken): purity can no longer be
   checked by `git diff` against `1c2c9c7d`; instead robocopy the reference `server/ shared/ src/`
   from the share MAIN repo and byte-compare (`fc /b` sweep). Delivery degrades from bundle
   to `git format-patch`/raw diff. Avoid this path if at all possible.
2. `011-verify.cmd`: `Set-Location C:\work\freshell; & 'C:\Program Files\Git\cmd\git.exe' log -1 --format='%H %s'; & 'C:\Program Files\Git\cmd\git.exe' status --porcelain | Measure-Object -Line` — expect HEAD `1c2c9c7d…`, clean tree.
3. `012-identity.cmd`: `git config user.name 'Amplifier Agent (TauriDebugVM)'; git config user.email 'amplifier-agent@users.noreply.github.com'` (in `C:\work\freshell`).
4. `013-sync-stranded.cmd`: robocopy from share worktree → clone:
   `port\vm-bridge` (files incl. this session's scripts dir), `port\machine\BLOCKER-2026-07-08-vm-session.md`, `port\machine\STATE.yaml`, `port\machine\PLAN-2026-07-09-vm-windows-on-windows.md`, `port\machine\VM-PROGRESS.md`. (`/R:1 /W:2`; per-path, no mirror.)
5. `014-purity-commit.cmd`: `git diff --name-only -- server/ shared/ src/` (MUST be empty; HANDOFF.md:281-282) then `git add port/vm-bridge port/machine/... ; git commit -F C:\work\scripts\msg-014.txt` (message authored by agent in `port/vm-bridge/scripts/msg-014.txt`, copied over; ends with the attribution block per HANDOFF.md:287).
6. `015-bundle.cmd`: `git bundle create C:\work\bundles\frtp-2026-07-09-a.bundle 1c2c9c7d..feat/rust-tauri-port; git bundle verify C:\work\bundles\frtp-2026-07-09-a.bundle` then robocopy to share `port/vm-bridge/outbound/`.
7. Copy `freshell-server.exe` (share `target\x86_64-pc-windows-gnu\release\`) → `C:\work\bin\`, and share `dist\client` → `C:\work\client\` (robocopy, bounded retry); `Unblock-File C:\work\bin\freshell-server.exe`.

**Success:** clone at `1c2c9c7d`; stranded files committed locally; verified bundle sitting in
`port/vm-bridge/outbound/`; server exe + SPA staged locally.
**Host note (document in VM-PROGRESS):** the share worktree holds identical *uncommitted*
copies of the stranded files; when the human applies the bundle, git may refuse to overwrite
those untracked-but-identical files — `git stash -u` or delete-and-checkout resolves it.
**Abort:** clone fails both syntaxes AND fallback robocopy stalls repeatedly ⇒ share unhealthy ⇒ stop, report.

---

## Phase 2 — Toolchain provisioning ON the VM (task B)

**Objective:** rustup + MSVC Build Tools + Node LTS installed and verified. Tauri v2 on
Windows requires the MSVC toolchain (the GNU cross setup in `.cargo/config.toml` served the
*server* exe only; WRY/WebView2 builds are MSVC-land). **Est: 30-60 min wall, ~6-8 GB disk.**

1. `020-rustup-dl.cmd`: `Invoke-WebRequest -UseBasicParsing https://win.rustup.rs/x86_64 -OutFile C:\work\dl\rustup-init.exe -TimeoutSec 300`
2. `021-rustup.cmd` (detached, poll): `C:\work\dl\rustup-init.exe -y --default-toolchain stable-x86_64-pc-windows-msvc --profile minimal` (~1.5 GB, 3-5 min; per-user, no elevation needed).
   Verify: `022-rust-verify.cmd`: `& "$env:USERPROFILE\.cargo\bin\cargo.exe" --version; & "$env:USERPROFILE\.cargo\bin\rustc.exe" -vV`
3. `023-vsbt-dl.cmd`: `Invoke-WebRequest -UseBasicParsing https://aka.ms/vs/17/release/vs_BuildTools.exe -OutFile C:\work\dl\vs_BuildTools.exe -TimeoutSec 600`
4. `024-vsbt.cmd` (detached; 15-30 min, ~2.5-4 GB):
   `Start-Process C:\work\dl\vs_BuildTools.exe -ArgumentList '--quiet','--wait','--norestart','--nocache','--add','Microsoft.VisualStudio.Workload.VCTools','--includeRecommended' -PassThru | % Id | Set-Content C:\work\logs\024.pid`
   Poll: process gone ⇒ verify `025-vsbt-verify.cmd`:
   `& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -products Microsoft.VisualStudio.Product.BuildTools -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath` (non-empty). RC 3010 = OK (reboot-pending; usually still usable — proceed, reboot only if link.exe fails).
5. `026-node.cmd`: primary `winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements` (detached); fallback: download the LTS x64 MSI from nodejs.org → `msiexec /i C:\work\dl\node.msi /qn` (detached). Verify `027`: `& 'C:\Program Files\nodejs\node.exe' --version; & 'C:\Program Files\nodejs\npm.cmd' --version`.
   *Why Node on the VM at all:* the mirror-client harness (Playwright) that pre-creates
   terminals and asserts buffers — required by the Tauri evidence pattern (HANDOFF.md:215-217,
   219-224). NOT needed for the oracle T-tiers here (those stay primary-host scope).
6. `028-harness.cmd` (detached): `New-Item -Type Directory -Force C:\work\harness; Set-Location C:\work\harness; $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1'; & 'C:\Program Files\nodejs\npm.cmd' init -y; & 'C:\Program Files\nodejs\npm.cmd' i playwright` — Edge channel means no browser download (D5).

**Success:** cargo/rustc (msvc host), vswhere hit, node+npm versions, playwright installed.
**Abort:** VS BT bootstrapper exits nonzero twice ⇒ capture `%TEMP%\dd_*.log` tails, stop, report (likely needs the human once).

---

## Phase 3 — Toolchain smoke (small before big)

**Objective:** prove the MSVC toolchain end-to-end on a cheap target before the 250-crate
build. **Est: 10-20 min.**

1. `030-smoke-build.cmd` (detached): `cargo build -p freshell-protocol` in `C:\work\freshell` (small dep graph; exercises linker).
2. `031-smoke-test.cmd` (detached): `cargo test -p freshell-platform` — also re-validates the spawn goldens on a real Windows host (they were only ever run on Linux/WSL).
**Success:** both green in logs. **Abort:** linker errors ⇒ Phase 2 step 4 incomplete (check 3010/reboot); do NOT proceed to Phase 4 until green.

---

## Phase 4 — Build `freshell-tauri.exe` (task C)

**Objective:** a runnable Windows Tauri shell binary. **Est: 30-90 min (first build, ~250
crates per HANDOFF.md:95); target dir ~5-8 GB.**

1. `040-tauri-build.cmd` (detached, poll every ~60s):
   `cargo build -p freshell-tauri` in `C:\work\freshell` (debug is sanctioned, HANDOFF.md:95).
2. Expected obstacles (fix → commit → resync → rebuild loop; all fixes are additive, never in `server/ shared/ src/`):
   - **Icon:** `bundle.icon` lists only `icons/icon.png` (tauri.conf.json:27). On Windows,
     tauri-build wants an `.ico` for the window/resource; if the build errs, generate
     `icons/icon.ico` from the PNG (PowerShell `System.Drawing` save-as-icon, or commit a
     32×32 ico) and add it to the icon array. Config-only change: allowed.
   - **`frontendDist:"frontend"`:** the `frontend/` dir exists in the crate (verified) — no
     action expected; if `generate_context!` complains, ensure it contains an `index.html`.
   - **bundle.active:false** (tauri.conf.json:25) is correct for D6 — we want the exe, not
     an installer.
   - **updater plugin placeholder pubkey** (tauri.conf.json:18): builds fine (updater is
     decision-gated in code per HANDOFF §3 "updater `Disarmed`"); if it panics at *runtime*
     on config parse, that's a finding — fix in `freshell-tauri` only.
3. `041-verify.cmd`: `Get-Item C:\work\freshell\target\debug\freshell-tauri.exe | Select-Object Length,LastWriteTime`
**Success:** exe exists; build log tail shows `Finished`. **Abort:** persistent WRY/WebView2 link errors ⇒ capture log, report (WebView2 runtime is confirmed installed, so this would be toolchain-level).

---

## Phase 5 — Leg W1: Tauri (app-bound) × native Windows server (task D1)

**Objective:** first-ever windows-on-windows proof: the Tauri shell spawns
`freshell-server.exe` itself, SPA loads, panes work, vision-verified screenshots.
**Est: 45-90 min.**

Precondition for all screenshot work: **the human's RDP session to the VM must be connected
and unlocked** (CopyFromScreen captures the interactive desktop; a disconnected/locked
session yields black frames). State this in VM-PROGRESS before starting.

1. Author `port/vm-bridge/scripts/launch-w1.ps1` (copy to `C:\work\scripts`): sets
   `$env:FRESHELL_SERVER_BIN='C:\work\bin\freshell-server.exe'`,
   `$env:FRESHELL_CLIENT_DIR='C:\work\client'`,
   `$env:FRESHELL_HOME='C:\work\scratch\home-w1'`, `$env:HOME=$env:FRESHELL_HOME`,
   then `Start-Process C:\work\freshell\target\debug\freshell-tauri.exe` (app-bound recipe
   HANDOFF.md:206-209; env passthrough to the spawned server is inherited). Scratch HOME
   must be a real dir, not %TEMP% (HANDOFF.md:186).
2. `050-launch.cmd`: run the script. `051-probe.cmd`: `Get-Process freshell-tauri,freshell-server | Select-Object Id,Name` + find the ephemeral port: `netstat -ano | Select-String 'LISTENING' | Select-String '127.0.0.1:3'`.
3. **Drive state via a mirror client** (you cannot Playwright the WebView — HANDOFF.md:215-217):
   the app-bound token is per-boot/generated, so the mirror must obtain it. Read the Tauri
   app-bound spawn env/logs for the token (it health-gates the URL `?token=<tok>`); if not
   externally recoverable, INVERT the leg: this is exactly what remote mode is for — do W2
   first, then re-run W1 asserting via desktop screenshots + the server's own request log.
   Decide at execution time; both orders are covered here.
4. Pane matrix for THIS server (available kinds only, GOAL.md:24-29): **CMD, PowerShell,
   Editor, Browser** (+ tabs overview). WSL pane and all coding-CLI panes: ENV-LIMITED,
   already proven by `vm-env-inventory.txt` (Phase 0). Create each pane, run a real command
   (`cd`, `Get-Location`, type in Editor, load example.com in Browser), assert output via
   mirror buffer where available.
5. Screenshots per pane: `port/vm-bridge/scripts/screenshot.ps1` —
   `Add-Type System.Windows.Forms,System.Drawing; CopyFromScreen(PrimaryScreen.Bounds) → C:\work\evidence\vm-tauri-appbound-<pane>.png`
   (probe-proven pattern, HANDOFF.md:232-235). Foreground first:
   `(New-Object -ComObject WScript.Shell).AppActivate('Freshell')`.
6. Sync PNGs → share + clone `port/oracle/matrix/`; **vision review** each (delegate,
   `model_role:"vision"`, md5-distinctness, cwd-in-prompt, no blank panes — HANDOFF.md:226-230).
7. Reap: `Stop-Process` the tauri exe; confirm the child server was reaped (no orphan
   `freshell-server` — the spawner's kill-on-exit is itself an assertion, Cargo.toml:73-75).
8. Write `port/oracle/matrix/vm-tauri-appbound-report.json` (pane→png→assert map); commit + bundle.

**Success criteria:** window paints the SPA; ≥4 pane kinds pass vision review; server child
reaped; report + screenshots committed. **Rollback/abort:** blank webview ⇒ capture
`C:\work\scratch\home-w1` logs + WebView2 version, file finding, try `--release` build once;
if the SPA never loads, halt the leg and fix before W2 (shared root cause likely).

---

## Phase 6 — Leg W2: Tauri (remote) × native Windows server — first live run of `provisioning.rs` (task D2)

**Objective:** validate the never-live-run remote mode (HANDOFF.md:246-250) against a
detached native Windows server. **Est: 45-120 min incl. fix loop.**

1. `060-server.cmd` (detached via `launch-server-w2.ps1`): env
   `PORT=3050; AUTH_TOKEN=<fresh scratch token>; FRESHELL_BIND_HOST=127.0.0.1; FRESHELL_CLIENT_DIR=C:\work\client; FRESHELL_HOME=C:\work\scratch\home-w2srv` →
   `Start-Process C:\work\bin\freshell-server.exe` with stdout/err logs. Scratch port range
   3030-3060 per HANDOFF.md:41 (no :3001 exists on this VM, but keep the discipline).
2. `061-health.cmd`: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3050/api/health -TimeoutSec 10` → expect the 7-field shape with `app:"freshell"` (HANDOFF.md:83, 186-187).
3. Pre-create terminals via the mirror client (Edge/Playwright, harness from Phase 2.6;
   adapt `run-matrix-win.mjs` → commit as `port/oracle/matrix/run-matrix-vm.mjs`, external
   server mode, `channel:'msedge'`, `?token=<tok>&e2e=1` harness trick HANDOFF.md:117-122).
4. `062-launch.cmd`: `FRESHELL_REMOTE_URL=http://127.0.0.1:3050`, `FRESHELL_TOKEN=<tok>` →
   `freshell-tauri.exe` (HANDOFF.md:210-211).
5. **Known suspect areas** (watch for exactly these, HANDOFF.md:249-250): URL join
   (trailing-slash/`?token` composition), webview nav timing (navigate before server-side
   session ready), token quoting (special chars — use a hex-only scratch token to isolate,
   then a second run with a `+/=`-bearing token if the first passes). Fix in
   `crates/freshell-tauri/src/provisioning.rs` + add unit tests; rebuild (Phase 4 pattern);
   re-run. Every fix: commit with test, purity check, bundle.
6. Panes + screenshots + vision review exactly as Phase 5 (`vm-tauri-remote-<pane>.png`,
   `vm-tauri-remote-report.json`).
7. **Interchange evidence** (GOAL.md:32-33 partial): the SAME server session viewed from
   the Edge mirror AND the Tauri window (tabs-sync mirroring, HANDOFF.md:216-217) —
   screenshot both showing the same tab set.
8. Reap server + app; verify no orphans.

**Success:** remote mode connects with zero or fixed-and-tested defects; panes vision-pass;
interchange shot captured. **Abort:** provisioning defect not fixable in ≤3 loop iterations ⇒
commit failing-state notes to `port/oracle/notes/vm-w2-provisioning.md`, continue to Phase 7
(don't block the campaign), leave STATE.yaml blocker.

---

## Phase 7 — Legacy Electron × native Windows server (D9) + ENV-LIMITED ledger (task D3)

**Objective:** execute the runnable remainder of HANDOFF queue item 3 on this VM; formally
record everything not runnable. **Est: 30-60 min.**

1. `070-install.cmd` (detached): copy `\\tsclient\Z\home\dan\code\freshell\.worktrees\electron-windows-native\release\Freshell Setup 0.7.0.exe` → `C:\work\dl\`; `Unblock-File`; run with `/S` (NSIS silent). Expect `%LOCALAPPDATA%\Programs\Freshell\Freshell.exe`. SmartScreen: mitigated by Unblock-File + Defender exclusion; if it still blocks, human clicks once (note in VM-PROGRESS).
2. Snapshot `%USERPROFILE%\.freshell` (fresh profile — likely absent) before provisioning; provision remote URL `http://127.0.0.1:3050` + scratch token via its desktop config (config shape per HANDOFF.md:251-257 — desktop.json); launch; screenshot; vision-verify; restore/remove config after.
3. This validates: legacy-Electron × **Windows Rust server** on-VM (the handshake predicate `/api/health` is already proven; this is the click-through — HANDOFF.md:251-253). Legacy-Electron × WSL server: ENV-LIMITED on this VM (no WSL distro) unless Phase 8 runs.
4. **ENV-LIMITED ledger** — write `port/oracle/matrix/VM-ENV-LIMITED.md`, one entry per cell/pane with proof pointer (`vm-env-inventory.txt` lines): Chrome×* (Chrome absent; cells remain covered by DANDESKTOP evidence), Tauri×WSL-server + Electron×WSL-server + WSL pane (no distro), claude/codex/opencode/gemini panes (CLIs absent, auth out of scope per D7), opencode-on-Windows (pre-existing, HANDOFF.md:136-137). Commit + bundle.

**Success:** Electron leg screenshots vision-pass OR a defect finding filed; ENV-LIMITED ledger committed. **Abort (leg only):** installer won't run silently and human unavailable ⇒ record ENV-LIMITED("installer blocked, proof: outbox 070") — honest per GOAL.md:30-31.

---## Phase 8 (OPTIONAL/STRETCH, requires explicit go-ahead) — WSL-server legs on the VM

**Objective:** convert the WSL-server ENV-LIMITEDs into executed proof. **Est: 1-2 h + possible reboot (needs human).**
1. `wsl --install -d Ubuntu` (elevated; may require reboot — schedule with the human; the bridge dies over a reboot, human restarts the watcher).
2. Copy the existing Linux ELF `target/release/freshell-server` + `dist/client` from the share into the distro FS; run on 127.0.0.1:3055; Windows→WSL localhost forwards (HANDOFF.md:202-203).
3. Tauri remote → `http://127.0.0.1:3055`; Electron likewise; WSL pane now also testable on the *Windows* server (wsl.exe gains a distro). Evidence pattern identical to Phases 5-7.
**Abort freely:** this phase is additive; failure leaves the ENV-LIMITED entries standing (they are already honest).

---

## Phase 9 — CLI argv fidelity: the VM-executable part (task E)

**Objective:** close the code+golden-test portion of HANDOFF queue item 4 (HANDOFF.md:258-265); explicitly scope out the live-turn proofs. **Est: 2-4 h.**

1. Read reference behavior from the share (read-only, targeted files): `server/terminal-registry.ts` (lines ~200-300) + `resolveCodingCliCommand` per HANDOFF.md:262-263. NEVER modify.
2. Implement faithful argv layering in `crates/freshell-platform/src/spawn.rs` + `freshell-ws` (MCP-config injection, notification args, opencode control endpoint, resume/model/sandbox args).
3. Golden-test argv against reference-derived expected strings: `cargo test -p freshell-platform -p freshell-ws` on the VM (toolchain from Phase 2). Bonus: these goldens now run on a REAL Windows host for the first time.
4. **Live one-turn-per-CLI proof (GOAL.md:41-44): NOT executable on this VM** (CLIs absent, D7). Record in the ledger + `VM-ENV-LIMITED.md`: "argv goldens green on Windows; live-launch proof pending a host with installed CLIs" — the in-code flag moves to the ledger only as *partially* resolved; do not overclaim.
5. Purity check, commit, bundle.

**Success:** goldens green in VM logs; honest ledger state. **Abort:** if reference reading over the share stalls (>2 min per file), copy the two specific reference files to C:\work first via robocopy, read locally.

---

## Phase 10 — Evidence consolidation + delivery (task F)

**Objective:** reports current, everything committed, bundles delivered. **Est: 30-60 min.**

1. Update `port/oracle/EQUIVALENCE-REPORT.md` — add "VM windows-on-windows addendum": matrix
   table rows for Tauri-appbound×WinSrv, Tauri-remote×WinSrv, Electron×WinSrv, with
   screenshot paths per cell (GOAL.md:60-64), plus the ENV-LIMITED table.
2. Update `port/HANDOFF.md` §9 (items 1-3 status) and §8 (add the VM recipes: bridge
   pattern, C:\work layout, launch scripts) — a fresh reader must be able to redo every leg
   from committed files (GOAL.md:65-67).
3. Update `port/machine/STATE.yaml`: blocker `ENV-VM-EXEC-2026-07-08` → RESOLVED (bridge),
   add `vm_evidence:` section, phase notes.
4. Final purity check (`git diff --name-only -- server/ shared/ src/` empty), final commit,
   final bundle → `port/vm-bridge/outbound/` + a `BUNDLE-MANIFEST.md` (bundle → contained
   commits → how the host applies: `git bundle verify <f>` then
   `git fetch <f> feat/rust-tauri-port:refs/heads/feat/rust-tauri-port` from the host repo,
   then the human pushes to origin — the push stays a human act per D3).

**Success:** docs+evidence committed; bundles verified; VM-PROGRESS closed out with an
honest "remains out of reach" list (macOS, live CLI turns, anything ENV-LIMITED).

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Share dies mid-session** (happened 2026-07-08; RDP drive redirection blocks forever, no error) | High | D1: everything runs on C:\work. Share touched only for: initial clone (Phase 1), doc sync, evidence sync-back, bundle drop — each a bounded robocopy `/R:1 /W:2`. If `alive-vm.txt` goes stale or a share op hangs: stop issuing commands, report. Work already on C:\work survives; resume from VM-PROGRESS.md. |
| **Long command wedges the sequential watcher** | High if careless | Bridge discipline §1: nothing >60s inline, ever. Detach + log + poll. One hung `Invoke-Expression` = bridge dead until human intervenes. |
| **Defender/SmartScreen quarantines or blocks first-run exes** (freshell-server.exe is an unsigned GNU cross-compile; Freshell Setup 0.7.0.exe unsigned NSIS) | Medium | Phase 0.6 `Add-MpPreference -ExclusionPath C:\work`; `Unblock-File` after every share copy; legacy installer fallback = one human click, recorded. |
| **PowerShell 5.1 syntax/behavior** (`&&` invalid, UTF-8 BOM on Set-Content, no `Start-Process -Environment`) | Certain if ignored | Rules codified in §1; helper scripts authored in-repo and reviewed before dispatch; env-inherit pattern for detached children. |
| **UAC stalls an installer invisibly** | Medium | D4: watcher runs elevated (human-confirmed in Phase 0.2). No `-Verb RunAs` anywhere. |
| **Screenshots black/empty** (RDP session disconnected or locked) | Medium | Precondition note at Phase 5; human keeps session connected during evidence phases; md5-distinctness check in vision review catches all-black frames. |
| **Cargo first-build very slow / disk exhaustion** | Medium | Phase 0 disk gate (≥30 GB); debug build only; single target dir; Defender exclusion. |
| **`provisioning.rs` live defects** (never live-run) | Expected | Phase 6 fix loop bounded at 3 iterations, then documented handoff — no force-green, no silent skip. |
| **VS Build Tools RC 3010 (reboot pending)** | Medium | Proceed; reboot only if link fails; reboot is a human-coordinated event (watcher restart). |
| **Clone-from-UNC quirks** | Medium | Two path syntaxes + `--no-local`; robocopy+init fallback with explicitly degraded purity/delivery semantics (documented before use). |
| **Session hang / agent restart** | Always possible | Every phase gate writes STATE.yaml + VM-PROGRESS.md; inbox ids are monotonic; any successor agent resumes by reading those two files + `outbox-vm/`. Small steps, one action per command file. |

## Explicitly out of scope on this VM (pre-declared, GOAL-honest)
macOS (GOAL ceiling); live coding-CLI turns (D7); Chrome cells (already proven on
DANDESKTOP, not re-runnable here — proof in inventory); oracle T0-T3 re-runs (primary-host
scope; nothing in these legs mutates server behavior — if a shared crate IS changed, flag
for a primary-host oracle re-run in HANDOFF before claiming equivalence); installer
packaging/signing (D6).
