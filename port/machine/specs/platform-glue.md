# Platform Glue — Ground-Truth Behavioral Specification

**Scope:** the OS-integration layer a Rust `freshell-platform` crate must reproduce so the port behaves
identically on **Linux**, **macOS**, **native Windows**, and **WSL2**: WSL↔Windows path conversion,
per-OS shell resolution, network bind/LAN/CORS, WSL port-forward, firewall detection/mutation, and
elevated-PowerShell execution.

**Source of truth = the CODE**, not docs. Every claim cites `file:line` in `.worktrees/rust-tauri-port`.
Where the code fixes/omits/duplicates something, it is flagged **[PORT RISK]**, **[DIVERGENCE]**, or
**[BUG?]** (a `DELIBERATE_FIX` candidate for the antagonist/ledger — per governance, never self-approved).

**Live-verification context.** This investigation ran on a **real WSL2 host** (`WSL_DISTRO_NAME=Ubuntu`,
`/proc/version` = `…6.6.87.2-microsoft-standard-WSL2…`, Windows host `DANDESKTOP`, WSL eth0
`172.30.149.249`). `powershell.exe` 5.1, `cmd.exe`, `wsl.exe`, `reg.exe`, `netsh.exe`, `ipconfig.exe`
are all reachable via interop. Every claim tagged **[LIVE ✓]** was executed read-only against this host.
macOS paths are **fixture-only** here (tagged **[MAC — fixture]**). No firewall/portproxy state was
mutated during this investigation (only `netsh … show`).

**Primary files**
- `server/path-utils.ts` (337 ln) — WSL↔Windows path conversion, sandbox path checks.
- `server/platform.ts` (118 ln) — `/proc/version`-based WSL detection, hostname, CLI availability. **(authoritative for network/firewall stack)**
- `server/platform-utils.ts` (150 ln) — **[DEAD CODE — imported by nobody]** duplicate of the shell helpers; see §2.0.
- `server/terminal-registry.ts` (4933 ln) — **live** shell resolution `74,870-1266` + bell writer `216-219`.
- `server/get-network-host.ts` (64 ln) — bind-host resolution.
- `server/bootstrap.ts` (394 ln) — LAN IP detection (incl. WSL `ipconfig.exe`), origin seeding.
- `server/network-manager.ts` (641 ln) — LAN binding, allowed-origins, remote-access status, rebind.
- `server/network-access.ts` (20 ln) — `isRemoteAccessEnabled`.
- `server/network-router.ts` (761 ln) — firewall/port-forward HTTP endpoints, confirmation-token flow.
- `server/wsl-port-forward.ts` (576 ln) — `netsh portproxy` + firewall script builders/plans.
- `server/firewall.ts` (164 ln) — firewall detection + command builders per platform.
- `server/elevated-powershell.ts` (30 ln) — `Start-Process -Verb RunAs`.
- `server/auth.ts` (83 ln), `server/request-ip.ts` (77 ln) — origin/loopback/token gate.
- Cross-ref: `port/machine/specs/terminal-core.md` §2.2/§9.2, `port/contract/nondeterministic-fields.md` (ports/paths).

---

## 0. Platform detection primitives — **the foundation (and a real divergence)**

There are **TWO independent WSL-detection regimes** in the codebase, used by different subsystems. A
faithful port must preserve both *behaviors*, and should record the disagreement as a **[BUG?]** to adjudicate.

### 0.1 Regime A — env-var based (drives the terminal-spawn stack)

`isWsl()` (`terminal-registry.ts:870-876`, byte-identical copy in `path-utils.ts:75-81` as
`isWslEnvironment`, and in the dead `platform-utils.ts:14-20`):

```ts
process.platform === 'linux' && (!!WSL_DISTRO_NAME || !!WSL_INTEROP || !!WSLENV)
```

- `isWindows()` = `process.platform === 'win32'` (`terminal-registry.ts` via `platform-utils.ts:6-8` semantics; live copy uses `process.platform==='win32'`).
- `isWindowsLike()` = `isWindows() || isWsl()` (`terminal-registry.ts:882-884`).
- **[LIVE ✓]** On this host `WSL_DISTRO_NAME=Ubuntu`, `WSL_INTEROP=/run/WSL/7812_interop`,
  `WSLENV=WT_SESSION:WT_PROFILE_ID:` → `isWsl()===true`.

### 0.2 Regime B — `/proc/version` based (drives network/firewall/port-forward)

`platform.ts` (imported by `wsl-port-forward.ts`, `firewall.ts`, `index.ts`, `bootstrap.ts`, `get-network-host.ts`, routers):
- `isWSL2()` `12-19`: `/proc/version` (lowercased) `.includes('wsl2') || .includes('microsoft-standard')`.
- `isWSL()` `25-32`: `/proc/version` `.includes('microsoft')` (matches WSL1 **and** WSL2).
- `detectPlatform()` `39-55`: non-linux → `process.platform`; linux+`/proc/version` has `microsoft|wsl` → `'wsl'`; else `process.platform`.
- **[LIVE ✓]** `/proc/version` contains `microsoft-standard-WSL2` → `isWSL2()===true` **and** `isWSL()===true`.

> **[BUG? / PORT RISK #A — detection split]** Regime A (env vars) and Regime B (`/proc/version`) can
> **disagree**: a WSL2 process launched with a scrubbed environment (systemd unit, `env -i`, some
> service managers) has `isWsl()===false` (Regime A → treats it as pure Linux for shell spawn) but
> `isWSL2()===true` (Regime B → still does WSL port-forward). The reference tolerates this because the
> two subsystems are independent. The Rust port should expose **one** `Platform` enum
> (`Linux|Macos|Windows|Wsl1|Wsl2`) computed once, but must reproduce that a `cmd`/`powershell` terminal
> request still routes to Windows interop *only when env-var WSL is detected*, while firewall/port-forward
> keys off `/proc/version`. Consolidating naively will change behavior in the scrubbed-env case →
> ledger it as `DELIBERATE_FIX` if you unify.

### 0.3 Other detectors
- `detectHostName()` `platform.ts:75-82`: on WSL, `powershell.exe -NoProfile -Command $env:COMPUTERNAME`
  (3 s timeout) else `os.hostname()`. **[LIVE ✓]** returns `DANDESKTOP`.
- `detectAvailableClis()` `platform.ts:107-118`: `where.exe` (win32) / `which` (else) per CLI, env-var
  override (`CLAUDE_CMD`, `CODEX_CMD`, `OPENCODE_CMD`, `GEMINI_CMD`, `KIMI_CMD`).
- `hasWslDistributions()` `path-utils.ts:158-174`: **native-Windows only** — `reg.exe query
  HKCU\…\Lxss` (2 s), cached, to avoid triggering the Windows-Store WSL-install dialog that bare
  `wsl.exe` would pop. **[LIVE ✓]** the `Lxss` key exists here (returns `NatIpAddress 172.30.149.249`).

---

## 1. WSL ↔ Windows path conversion (`path-utils.ts`)

### 1.1 Flavor detection & sanitization
- `sanitizeUserPathInput()` `24-30`: trims, then strips a single pair of wrapping quotes (`WRAPPED_QUOTES_RE` `15`).
- `detectUserPathFlavor()` `32-46` → `'windows' | 'posix' | 'native'` via three regexes (`11-14`):
  - `WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:([\\/]|$)/` — `C:`, `D:\`, `c:/`.
  - `WINDOWS_UNC_PREFIX_RE = /^\\\\[^\\]+\\[^\\]+/` — `\\server\share`.
  - `WINDOWS_ROOTED_PREFIX_RE = /^\\(?!\\)/` — single leading backslash `\foo`.
  - `POSIX_ABSOLUTE_PREFIX_RE = /^\//` → `'posix'`; else `'native'`.
- `~` / `~/` / `~\` expand via `os.homedir()` (`normalizeUserPath` `58-63`).
- Resolution uses the flavor-matched `path` module: `path.win32.resolve` / `path.posix.resolve` / `path.resolve` (`66-72`).

### 1.2 Mount-prefix derivation (`getWslMountPrefix`, `path-utils.ts:83-91`)
- If `WSL_WINDOWS_SYS32` set: normalize `\`→`/`, strip trailing `/`, match `^(.*)/[a-zA-Z]/Windows/System32$` → capture prefix; else `/mnt`.
- **[LIVE ✓]** `WSL_WINDOWS_SYS32` is **unset** here → default `/mnt`.
- **[DIVERGENCE — duplicate with different regex]** The dead `platform-utils.ts:57-68` `getWslMountPrefix`
  matches `^(.*)/[a-zA-Z]/` (looser) — do **not** port that one.

### 1.3 WSL-drive-path → Windows path (`convertWslDrivePathToWindowsPath`, `97-116`)
Rule: `sanitize`, `\`→`/`, match `^{mountPrefix}/([a-zA-Z])(?:/(.*))?$`. Then `drive = LETTER:`,
`rest = match.replace(/\//g,'\\')`. Result `DRIVE:\rest` (or `DRIVE:\` when no rest).
- **[LIVE ✓]** confirmed against `wslpath -w`: `/mnt/d/foo/bar → D:\foo\bar`, `/mnt/c → C:\`. Freshell's
  regex reproduces `wslpath`'s output for the drive-mount case exactly.

### 1.4 Windows path → WSL path (`convertWindowsPathToWslPath`, `118-148`)
- POSIX-absolute input (`/…`) → `undefined` early (`124`) — avoids `path.win32.resolve` turning `/home/x`
  into `C:\home\x` on native Windows (false positive). **[PORT RISK]** replicate this guard exactly.
- `path.win32.resolve` then match `^([a-zA-Z]):(?:\\(.*))?$` → `${mountPrefix}/${driveLower}[/rest]`
  (`rest = \`→`/`). **[LIVE ✓]** `D:\a\b → /mnt/d/a/b`, `C:\Users\dan → /mnt/c/Users/dan` (matches `wslpath -u`).
- UNC `\\wsl(.localhost)?\<distro>\rest` (`136-145`): **only in WSL env**, and only when `<distro>`
  case-insensitively equals `WSL_DISTRO_NAME` (else `undefined`); returns `/rest` (or `/`).
  **[LIVE ✓]** `wslpath -w /home/dan` = `\\wsl.localhost\Ubuntu\home\dan` — the inverse this handles.

### 1.5 Native-Windows async fallback to `wsl.exe` (`convertWslPathToWindows`, `176-206`)
Only when `process.platform==='win32'` and input starts `/`:
1. Try `convertWslDrivePathToWindowsPath` (mount-mapped, sync). If hit, return.
2. If `!hasWslDistributions()` (reg.exe probe) → `undefined` (avoid Store dialog).
3. Else `execFile('wsl.exe', ['wslpath','-w', posixPath], {windowsHide, timeout:1500})`, `path.win32.normalize(stdout.trim())`.
4. **Promise-cached** in `wslPathToWindowsCache` (Map, LRU-ish evict at `WSL_PATH_TO_WINDOWS_CACHE_MAX_ENTRIES=256`, `16-18,200-205`).
- **[PORT RISK]** This path is **native-Windows-only** and **not live-verifiable from WSL** (we ARE the
  WSL side). Rust port: gate on `cfg!(windows)`; the cache + Store-dialog avoidance are behavioral, not cosmetic.

### 1.6 Filesystem-path resolution dispatch (`toFilesystemPath[Sync]`, `208-245`)
- `flavor==='windows'` → `resolveWindowsFlavorPath` (`208-215`): win32 → `path.win32.resolve`; WSL → try `convertWindowsPathToWslPath` else `path.win32.resolve`.
- `flavor==='posix'` → sync: on win32 try `convertWslDrivePathToWindowsPath`; async: on win32 try `convertWslPathToWindows`; else `path.posix.resolve`.
- `flavor==='native'` → `path.resolve`.
- Consumers: `isReachableDirectory[Sync]` (`251-271`), `resolveUserPath` (`247-249`), `getDefaultCwd`/`launch-cwd` (terminal spawn cwd).

### 1.7 Sandbox path containment (`isPathAllowed`, `308-337`)
- No/empty `allowedRoots` → allow-all (`309-311`).
- `resolvePathForSandboxComparison` (`291-301`): normalize → `toFilesystemPathSync` → `path.resolve` →
  `fs.realpathSync` (symlink-resolved; falls back to non-realpath on error) → trim trailing separators.
- **Case-insensitive compare on win32 only** (`.toLowerCase()`, `314-316,320-322`).
- Match iff `target === root` **or** `target.startsWith(root + path.sep)` (directory-boundary safe, `324-327`).
- **[PORT RISK]** symlink realpath + win32 case-fold are security-load-bearing; a Rust port using raw
  string prefix compares would allow symlink/`..`/case escapes. Use `std::fs::canonicalize` + `cfg!(windows)` case-fold.

---

## 2. Shell resolution by platform (the terminal-spawn stack)

### 2.0 **[BUG? / FIDELITY — which copy is live]**
`getWindowsExe`, `resolveShell`, `getSystemShell`, `getWindowsDefaultCwd`, `isWsl`, `isWindowsLike`,
`isLinuxPath`, `ShellType` exist **twice**: in `platform-utils.ts` and privately in `terminal-registry.ts`.
**`platform-utils.ts` is imported by NOBODY** (verified: `grep "from './platform-utils'"` → 0 hits).
**The authoritative, executed copies are in `terminal-registry.ts`.** Port from `terminal-registry.ts`,
**not** `platform-utils.ts`. The two `getWindowsDefaultCwd` differ materially (see §2.4) — porting the
wrong one is a latent defect. Treat `platform-utils.ts` as dead and ledger its removal separately.

### 2.1 `ShellType` and `resolveShell` (`terminal-registry.ts:74, 949-965`)
`ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'`.
- **native Windows** (`950-953`): `'system' → 'cmd'`; others pass through.
- **WSL** (`954-961`): `'system'` **and** `'wsl'` → `'system'` (Linux shell); `'cmd'`/`'powershell'` pass through (interop).
- **macOS/Linux non-WSL** (`962-964`): everything → `'system'`.

### 2.2 The spawn matrix (`buildSpawnSpec`, `1059-1266`) — exact `file` / `args` / `cwd` / `env` per OS

Returns `{ file, args, cwd, mcpCwd, env }`; PTY spawns `pty.spawn(file, args, {name:'xterm-256color', cols, rows, cwd, env})` (`terminal-core.md §2`). Guard: unknown mode → `UnknownTerminalModeError` (`1073-1075`).

| Platform | requested | `mode:'shell'` result | Evidence |
|---|---|---|---|
| **Linux/macOS** (non-WSL) | any→system | `file=getSystemShell()`, `args=['-l']`, `cwd=resolveUnixShellCwd(cwd)` | `1250-1255` |
| **native Windows** | system→cmd | `file='cmd.exe'`, `args=['/K']`, `cwd = isLinuxPath(cwd)?undefined:cwd` | `1177-1200` |
| **native Windows** | powershell | `file=POWERSHELL_EXE||'powershell.exe'`, `args=['-NoLogo']` | `1211-1232` |
| **native Windows** | Linux `cwd` present | **force `wsl`** (`forceWsl`, `1130`) → WSL branch | `1130-1173` |
| **WSL** | system/wsl | Linux shell `getSystemShell()` `args=['-l']` (`inWslWithLinuxShell`, `1125`) | `1123-1256` |
| **WSL** | cmd | `file="${WSL_WINDOWS_SYS32||/mnt/c/Windows/System32}/cmd.exe"`, `args=['/K', 'cd /d <winCwd>']`, **proc cwd `undefined`** | `1177-1200` |
| **WSL** | powershell | `file=".../WindowsPowerShell/v1.0/powershell.exe"`, `args=['-NoLogo','-NoExit','-Command','Set-Location -LiteralPath <winCwd>']`, proc cwd `undefined` | `1212-1232` |
| **native Windows** | `WINDOWS_SHELL` env default | when `effectiveShell==='system'`, `windowsMode = (WINDOWS_SHELL||'wsl').toLowerCase()` | `1132-1137` |

Windows-from-Windows `wsl` mode (`1141-1172`): `file = WSL_EXE||'wsl.exe'`; optional `-d WSL_DISTRO`;
`--cd <linuxCwd>` (convert win→wsl if needed, `1148-1149`); shell → `--exec bash -l`.
**Note:** the WSL branch is skipped when already inside WSL (`isWindows() && …`, `1130`).

### 2.3 `getWindowsExe` (`terminal-registry.ts:891-901`)
- native Windows: `cmd.exe`; powershell → `POWERSHELL_EXE || 'powershell.exe'`.
- WSL: `${WSL_WINDOWS_SYS32 || '/mnt/c/Windows/System32'}/cmd.exe`; powershell → `POWERSHELL_EXE ||
  '${systemRoot}/WindowsPowerShell/v1.0/powershell.exe'`. **[LIVE ✓]** both resolved paths exist & are executable here.

### 2.4 `getWindowsDefaultCwd` — **the two copies differ** (port the live one)
- **LIVE (`terminal-registry.ts:923-942`):** win32 → `os.homedir()`; WSL → `resolveWindowsShellCwd(USERPROFILE)`
  if set (`929-932`), else `path.win32.resolve(HOMEDRIVE+HOMEPATH)` (`934-937`), else `path.win32.resolve((SYSTEMDRIVE||'C:')+'\\')` (`940-941`).
- **DEAD (`platform-utils.ts:78-98`):** converts `USERPROFILE` via a private regex to `/mnt/<d>/…`, else `${mountPrefix}/c`. **Do not port.**
- **[LIVE ✓]** here `USERPROFILE` is **unset in the WSL env** (Windows env has `C:\Users\dan`, not exported)
  → the live copy would fall to `HOMEDRIVE`/`HOMEPATH` (also unset) → `C:\` root. This is exercisable.

### 2.5 `getSystemShell` (`terminal-registry.ts:971-989`)
`$SHELL` if set & `fs.existsSync`; else macOS → `/bin/zsh`→`/bin/bash`→`/bin/sh`; Linux → `/bin/bash`→`/bin/sh`.
**[PORT RISK — T1 determinism]** filesystem probing order must match or Linux golden boot bytes differ.

### 2.6 Arg quoting / escaping (Windows only; `terminal-registry.ts:997-1057`)
- `escapeCmdExe` `1001-1012`: `^`→`^^` (first), then `&|<>`→`^x`, `%`→`%%`, `"`→`\"`.
- `quoteCmdArg` `1014-1044`: MS backslash-before-quote doubling rule + `%`→`%%`.
- `quotePowerShellLiteral` `1050-1052`: wrap in `'…'`, `'`→`''`.
- `buildCmdCommand` / `buildPowerShellCommand` (`1046-1057`). **[PORT RISK]** these must be byte-exact for
  coding-CLI launch lines; a naive Rust quoter changes the child command string → observable divergence.

### 2.7 Environment (see `terminal-core.md §2.4`) — strip-list + forced `LANG/LC_ALL/TERM/COLORTERM` (`1083-1105`).

### 2.8 Bell writer (platform notification, **not PTY-core**) — `terminal-registry.ts:216-219`
Claude "Stop" hook command: **Windows** = a `powershell.exe … AppendAllText('\\.\CONOUT$', BEL)` one-liner
with `[Console]::Out/Err` fallbacks; **unix** = `sh -lc "printf '\a' > /dev/tty …"`. Coding-CLI concern;
`freshell-platform` exposes it but shell-mode PTYs never emit it.

---

## 3. Network: bind, LAN, CORS/origin, ports, phone/QR

### 3.1 Bind-host resolution (`get-network-host.ts:27-64`) — **order matters**
1. `dotenv.config()` **inside** the fn (not module top-level; bootstrap must patch `.env` first — comment `22-26`).
2. `FRESHELL_BIND_HOST` override: **only** `'0.0.0.0'` or `'127.0.0.1'` honored (E2E/CI) (`35-38`).
3. **`isWSL()` (Regime B, `/proc/version`) → always `'0.0.0.0'`** (`42`) — so the Windows host browser can
   reach the WSL2 server. Documented as "basic WSL2 functionality, not remote access." **[LIVE ✓]** this host → `0.0.0.0`.
4. Else read `~/.freshell/config.json` `settings.network.host` (whitelist `0.0.0.0|127.0.0.1`, else `127.0.0.1`);
   if `!configured` and `HOST` env ∈ {`0.0.0.0`,`127.0.0.1`} use `HOST` (`44-57`).
5. On any error: `HOST` env fallback else `127.0.0.1` (`58-63`).

Applied at `index.ts:911` → `server.listen(port, bindHost)` (`921`). `getFreshellConfigDir` = `FRESHELL_HOME || ~/.freshell` (`freshell-home.ts`).

### 3.2 Port allocation
- Server port: `PORT` env (validated 1–65535) else **`3001`** (`wsl-port-forward.ts:174-179`, `DEFAULT_PORT=3001`).
- Dev companion port added only when `NODE_ENV!=='production'` (`getRequiredPorts` `173-192`).
- Ephemeral/child ports are OS-assigned via `net.createServer().listen(0)` (extension-manager `389`, local-port `22`, port-forward `130`) — **nondeterministic**, normalize per `nondeterministic-fields.md:76-81` (`<PORT:n>`).

### 3.3 LAN IP detection (`bootstrap.ts`)
- `detectLanIps()` `182-193` / `detectLanIpsAsync()` `198-207`: **in WSL**, query the **Windows host's**
  physical adapters via `ipconfig.exe` (`getWindowsHostIps[Async]` `113-145`, path `/mnt/c/Windows/System32/ipconfig.exe`,
  parse `parseWindowsHostIps` `62-85` — skip `vEthernet|WSL|Docker|VirtualBox|VMware` adapters). Fall back to `os.networkInterfaces()` if empty.
- Ranking `scoreLanIp` `36-60`: `192.168.*`=100, `10.[0-10].*`=90, other `10.*`=50, `172.16-31.*`=80
  (Docker `172.17.*`=0, VPN `/32`=1, else 10). **[LIVE ✓]** WSL `hostname -I` returns Docker-heavy
  `172.x` set; the `ipconfig.exe` path is why phone-access advertises the *real* LAN IP, not WSL's virtual NAT IP.

### 3.4 Allowed-origins & the security model — **[DIVERGENCE — origin is advisory-only]**
- **No Express `cors()` middleware exists** (verified: `grep cors server/` → only `isOriginAllowed`). CORS is *not* enforced HTTP-side.
- HTTP gate = **auth token** (`httpAuthMiddleware` `auth.ts:36-52`): `x-auth-token` header or `freshell-auth`
  cookie, `timingSafeCompare`; `/api/health` exempt. Startup refuses weak/short tokens (`validateStartupSecurity` `15-27`, ≥16 chars).
- WS gate (`ws-handler.ts:1096-1121`): Origin is **logged, never rejected** — "auth token is the real security
  gate" (VPNs strip Origin, mobile omits it). Loopback (`isLoopbackAddress` `auth.ts:75-83`) skips the check entirely.
- `ALLOWED_ORIGINS` is **auto-managed** by NetworkManager (`buildAllowedOrigins` `network-manager.ts:599-626`):
  loopback origins for `port`(+`devPort`), plus `http://<lanIp>:<port>` for each LAN IP when effectiveHost `0.0.0.0`.
  User extras via `EXTRA_ALLOWED_ORIGINS` (legacy `ALLOWED_ORIGINS` custom entries migrated, `232-263`).
  Written to `process.env.ALLOWED_ORIGINS` (`632`). `parseAllowedOrigins` fallback list `auth.ts:54-67`.
- **[PORT RISK]** The Rust port must **replicate advisory-only origin handling** — do *not* "harden" it into
  a rejecting CORS layer (that would break VPN/mobile clients and diverge). If hardening is desired → `DELIBERATE_FIX` + ledger + antagonist sign-off.

### 3.5 Remote-access model (`network-access.ts`, `network-manager.ts`)
- `isRemoteAccessEnabled(network, effectiveHost, firewallPlatform)` `network-access.ts:6-19`: `host==='0.0.0.0'`→true;
  `wsl2`→**false** (WSL always binds 0.0.0.0 for host access, so that alone isn't "remote"); else `!configured && effectiveHost==='0.0.0.0'`.
- `getStatus()` `network-manager.ts:282-398`: uses the **actual** `server.address()` (not config) for `effectiveHost`
  (`294-302`); probes `isPortReachable(lanIp, port)` (`305-323`); computes `remoteAccessEnabled/Requested/NeedsRepair`,
  firewall `commands`, and `accessUrl = http://<lanIp|localhost>:<port>/?token=<AUTH_TOKEN>` (`370-375`).
- Hot-rebind on host change (`configure`→`rebind` `400-534`): `server.close()` then `listen(port, newHost)` with
  rollback-to-old-host on failure; WS handler `prepareForRebind`/`resumeAfterRebind`. WSL never rebinds (`hostChanged` false for wsl2, `413`).

### 3.6 Phone access / QR
- **Server side (in scope):** produces `accessUrl` + `lanIps` via `getStatus()`; startup banner (`startup-banner.ts`,
  `index.ts:925-973`) prints local vs "visit from anywhere" URL; `resolveVisitPort` chooses advertised port; `HIDE_STARTUP_TOKEN` strips the token from the printed URL.
- **Client side (OUT of `freshell-platform` scope):** `QrCode`/`ShareQrCode` React components render a QR **from
  `accessUrl`** (`src/components/SetupWizard.tsx:91,504`, `src/App.tsx:81,1667`; `NetworkQuickAccess.tsx:26`).
  QR encoding is a pure, portable client concern (moves to the Tauri webview) — the server crate only supplies `accessUrl`.

---

## 4. WSL port-forward (`wsl-port-forward.ts`) — netsh portproxy + firewall

### 4.1 What it runs & when
Never at startup automatically. Computed **lazily** by `network-manager.getStatus()` (`334`) and the
`/network/configure-firewall` + `/network/disable-remote-access` endpoints (`network-router.ts:277,352,381`).
Actual mutation happens **only after** an explicit client confirmation → elevated PowerShell (§6).

### 4.2 Reads (read-only, **[LIVE ✓]** here)
- WSL IP `getWslIpAsync` `141-171`: `ip -4 addr show eth0` → first `inet` (IPv4 regex); fallback `hostname -I`
  first non-`172.17.*` IPv4. **[LIVE ✓]** `eth0` → `172.30.149.249`.
- Existing portproxy `getExistingPortProxyRulesAsync` `221-232`: `NETSH_PATH interface portproxy show v4tov4`,
  parsed by `parsePortProxyRules` `121-139` (regex `^([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)`, keep `listenAddr==='0.0.0.0'`).
  **[LIVE ✓]** returned real rules incl. `0.0.0.0  3001  172.30.149.249  3001` (the live freshell).
- Existing firewall ports `getExistingFirewallPortsAsync` `254-270`: `netsh advfirewall firewall show rule
  name=FreshellLANAccess`, `parseFirewallRulePorts` `238-252` (`LocalPort:` line, comma-split). Missing-rule
  detection = exit 1 + empty stderr + 0 parsed ports (`isMissingFirewallRuleResult` `106-110`). **[LIVE ✓]** rule
  `FreshellLANAccess` exists & `Enabled: Yes`.
- `NETSH_PATH = '/mnt/c/Windows/System32/netsh.exe'` (`8`) — hardcoded full path (bare `netsh` not on WSL PATH).

### 4.3 Managed-ports persistence
- WSL: `~/.freshell/wsl-managed-remote-access-ports.json` (`getManagedWslPortsPath` `59-61`), `{ports:[…]}`
  normalized/sorted (`persistManagedWslRemoteAccessPorts` `194-209`, clear on empty).
- Windows: per-instance sha256(`cwd::port`) file under `${FRESHELL_HOME||~/.freshell}/windows-managed-remote-access-ports/<digest>.json`
  (`network-manager.ts:66-137`, atomic temp+rename).

### 4.4 Idempotency & script generation
- `needsPortForwardingUpdate` `302-317`: missing rule OR wrong `connectAddress`(≠wslIp) OR wrong `connectPort`.
- `needsFirewallUpdate` `278-283`: any required port absent (extra ports tolerated → avoids needless UAC).
- Plan `buildWslPortForwardingPlan` `428-475`: computes stale owned/managed/firewall ports, chooses
  `scriptKind: 'full' | 'firewall-only'`, returns `status: not-wsl2|disabled|error|noop|ready`.
- `buildPortForwardingScript` `324-351` (semicolon-joined, order = delete-then-add):
  - per cleanup port: `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=<p> 2>\$null`
  - per port: `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=<p> connectaddress=<wslIp> connectport=<p>`
  - `netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\$null`
  - `netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow protocol=tcp localport=<p,p,…> profile=private`
- `buildFirewallOnlyScript` `289-296`, `buildPortForwardingTeardownScript` `357-369` (delete portproxy + firewall rule).
- `normalizeScriptForElevatedPowerShell` `396-398`: unescapes `\$`→`$` right before elevation (the `2>\$null`
  survives `sh` interpolation, then is normalized for PowerShell). **[PORT RISK]** this double-escape dance must be reproduced.
- Env kill-switch `FRESHELL_DISABLE_WSL_PORT_FORWARD` ∈ {`1`,`true`,`yes`} (`371-375`).
- **Rule name `FreshellLANAccess` has no spaces** (deliberate — `344`, avoids nested-quote escaping).
- **[SAFETY]** portproxy/firewall `add`/`delete` are **mutating & elevated** — do NOT run during QA without a
  disposable Windows host; only `show` is safe here. The live host already has real rules (do-not-touch).

---

## 5. Firewall detection & commands (`firewall.ts`)

### 5.1 Detection (`detectFirewall` `107-127`, per `process.platform` + Regime-B WSL2)
| Platform | Probe | active test |
|---|---|---|
| linux (non-WSL2) | `ufw status` then `firewall-cmd --state` | `Status: active` / `running` (`38-66`) |
| **linux WSL2** / win32 | `netsh advfirewall show currentprofile state` | `/\bON\b/i` (`81-104`) |
| darwin **[MAC — fixture]** | `defaults read /Library/Preferences/com.apple.alf globalstate` | `parseInt>0` (`68-79`) |
| other | — | `linux-none`, inactive |
- `netshCmd`: WSL2 → `/mnt/c/Windows/System32/netsh.exe`, native Windows → `netsh` (`88-90`).
- `FirewallPlatform = 'linux-ufw'|'linux-firewalld'|'linux-none'|'macos'|'windows'|'wsl2'`. **[LIVE ✓]** here →
  `wsl2`, `active:true` (Private+Public State ON).
- `tryExec` `27-34`: 5 s timeout, returns `null` on any failure (all detectors degrade to inactive).

### 5.2 Suggested commands (`firewallCommands` `129-163`) — data, not executed here
- `linux-ufw`: `sudo ufw allow <p>/tcp` (per port).
- `linux-firewalld`: `sudo firewall-cmd --add-port=<p>/tcp … --permanent && sudo firewall-cmd --reload`.
- `macos` **[MAC — fixture]**: `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node) && … --unblockapp $(which node)` (app-level; can't scope to a port — comment `140-142`).
- `windows`: `netsh advfirewall firewall add rule name="Freshell (port <p>)" dir=in action=allow protocol=TCP localport=<p> profile=private`.
- `wsl2`: `[]` (handled by `wsl-port-forward.ts`).
- Native-Windows managed rules use per-port name `Freshell (port <p>)` (`network-manager.ts:56-58,159-187`), distinct from WSL's single `FreshellLANAccess`.

---

## 6. Elevated PowerShell (`elevated-powershell.ts` + `network-router.ts`)

### 6.1 Mechanism (`elevated-powershell.ts:11-30`)
`buildElevatedPowerShellArgs(script)`: `script.replace(/'/g,"''")`, then
`['-Command', "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '<escaped>'"]`.
`spawnElevatedPowerShell(command, script, cb)` = `execFile(command, args, {timeout:120_000})`.
- `-Verb RunAs` triggers the Windows **UAC** prompt; `-Wait` blocks until the elevated child exits.
- `command` is `powershell.exe` (native Windows path) or `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` (WSL2), chosen at the call site (`network-router.ts:561-562,705-706`).

### 6.2 Confirmation-token flow (`network-router.ts`) — two-phase, never auto-elevates
1. Client POSTs `/network/configure-firewall` (or `/disable-remote-access`) → server computes a plan; if a
   mutating action is needed returns `issueConfirmation(action)` with a fresh `randomUUID` `confirmationToken`
   + `WINDOWS_ELEVATION_CONFIRMATION` UX copy (`218-228,28-33`).
2. Client re-POSTs with `confirmElevation:true` + matching `confirmationToken`; server **re-derives the plan
   under a lock** (`acquireConfirmedRepairLock` `246-262`, `confirmedRepairInFlight`), consumes the token, then
   `startElevatedRepair` (`150-216`) spawns elevated PowerShell, `verifySuccess` re-checks the plan is now
   `noop`, `onSuccess` persists managed ports / applies settings.
- Request schema `ConfigureFirewallRequestSchema` `23-26` (`.strict()`), 409 if a repair is already in flight.
- Actions: `windows-repair | windows-disable | wsl2-repair | wsl2-disable` (`50`).

### 6.3 Failure modes
- Spawn failure → `child.on('error')` logs `spawnFailedLog`, releases lock (`208-211`).
- UAC decline / non-zero exit → `err` branch logs `failedLog`, lock released, **no state persisted** (verify never runs).
- 120 s timeout kills the wait. `verifySuccess` throwing → logged as failure, settings not applied.
- **[PORT RISK]** Native-Windows-only + interactive UAC ⇒ **not automatable in CI**; QA must fixture the
  plan/script strings and (optionally) do a **manual** elevated run on a disposable Windows box.

---

## 7. What is invokable from THIS WSL2 host vs mac-only / native-Windows-only

| Capability | Command | This WSL2 host | Notes |
|---|---|---|---|
| WSL2 detection | `/proc/version`, env vars | **[LIVE ✓]** | both regimes true |
| `wslpath` conversion | `wslpath -w/-u`, `wsl.exe wslpath` | **[LIVE ✓]** | validated §1.3/1.4 rules |
| Windows hostname | `powershell.exe $env:COMPUTERNAME` | **[LIVE ✓]** | `DANDESKTOP` |
| WSL IP | `ip -4 addr show eth0` | **[LIVE ✓]** | `172.30.149.249` |
| Windows LAN IPs | `ipconfig.exe` | **[LIVE ✓]** | physical-adapter parse works |
| Firewall state (read) | `netsh.exe advfirewall show currentprofile state` | **[LIVE ✓]** | `ON`/`ON` |
| Portproxy (read) | `netsh.exe interface portproxy show v4tov4` | **[LIVE ✓]** | shows live rules |
| Firewall rule (read) | `netsh.exe advfirewall firewall show rule name=…` | **[LIVE ✓]** | `FreshellLANAccess` present |
| WSL-distro probe | `reg.exe query …\Lxss` | **[LIVE ✓]** | key exists |
| cmd/powershell exe presence | file stat | **[LIVE ✓]** | all 4 exes executable |
| **Portproxy/firewall MUTATE** | `netsh … add/delete` | **⚠ REACHABLE but DO-NOT-RUN** | elevated + touches live host; fixture only |
| **Elevated PowerShell (UAC)** | `Start-Process -Verb RunAs` | **✗ not automatable** | interactive UAC; manual only |
| **native-Windows path fallback** | `convertWslPathToWindows` win32 branch | **✗** (we're the WSL side) | fixture on native Windows |
| **macOS firewall / zsh defaults** | `defaults read …alf`, `/bin/zsh` probe | **✗ [MAC — fixture]** | no macOS host reachable |
| Linux ufw/firewalld | `ufw status`, `firewall-cmd` | **partial** | not installed in this distro → `null` path |

---

## 8. Port risk callouts & Rust crate mapping

**Crate strategy (`freshell-platform`):** pure Rust; shell out via `std::process::Command` / `tokio::process`
(matching `execFile` semantics: arg vectors, no shell, timeouts via `tokio::time::timeout`). No JS sidecar
needed — every external call here is a plain subprocess (`netsh.exe`, `ipconfig.exe`, `wsl.exe`, `reg.exe`,
`powershell.exe`, `ufw`, `firewall-cmd`, `ip`, `hostname`, `defaults`). Optional `windows-rs`/`windows` crate
**not required** (all Windows integration is via the same CLI tools the reference uses); prefer CLI parity to
keep the oracle diff aligned. `is-wsl`-equivalent is a 3-line `/proc/version` read — implement inline, don't add a dep.

**Top 3 places most likely to diverge / need per-OS conditional code:**

1. **The WSL-detection split (§0.2 [BUG?]).** Env-var WSL (shell spawn) vs `/proc/version` WSL2
   (network/firewall). *Mitigation:* compute a single `Platform` once but expose both predicates; add a
   fixture test that scrubs env in a WSL2 image and asserts each subsystem's historical choice. Decide
   unify-vs-preserve with the antagonist (ledger `DELIBERATE_FIX` if unified).

2. **netsh script string generation + escaping (§4.4).** The `2>\$null` → `normalizeScriptForElevatedPowerShell`
   `\$`→`$` two-step, semicolon join, delete-then-add ordering, single-quote doubling in
   `buildElevatedPowerShellArgs`, and spaceless `FreshellLANAccess` name are all byte-load-bearing (they feed
   an elevated shell). *Mitigation:* golden-string tests over `buildPortForwardingScript` /
   `buildElevatedPowerShellArgs` outputs — diff exact strings, don't re-run elevation.

3. **Windows/WSL cwd juggling + arg quoting (§2.2/2.6).** `procCwd:undefined` + in-command `cd /d` /
   `Set-Location -LiteralPath`, UNC avoidance, `isLinuxPath` gating, `quoteCmdArg` backslash rule,
   `getWindowsDefaultCwd` fallback chain (and porting the **live** copy, not the dead one). *Mitigation:*
   table-driven `buildSpawnSpec` fixtures across `{linux,macos,win,wsl}×{system,cmd,powershell,wsl}×{linux cwd, win cwd, none}`.

**Also conditional / OS-gated:** `path-utils` win32-only `wsl.exe` fallback + reg-probe (§1.5); firewall
detector branches (§5.1); macOS ALF app-level rule (§5.2, fixture); loopback/case-fold in sandbox compare (§1.7).

---

## Rust port acceptance checklist

`LV?` = live-verifiable from **this WSL2 host** (yes / no / partial / mac-fixture / win-fixture).

| # | Behavior | Assertion | Evidence | LV? |
|---|---|---|---|---|
| P1 | `isWsl` (env) vs `isWSL/isWSL2` (`/proc/version`) computed with exact source semantics | unit: env/procversion matrix → each predicate | `terminal-registry:870`, `platform:12-32` | **yes** |
| P2 | `detectHostName` uses `powershell.exe $env:COMPUTERNAME` on WSL | returns Windows hostname | `platform:57-82` | **yes** (`DANDESKTOP`) |
| P3 | `convertWslDrivePathToWindowsPath` rules (`/mnt/d/x`→`D:\x`, `/mnt/c`→`C:\`) | golden vs `wslpath -w` | `path-utils:97-116` | **yes** |
| P4 | `convertWindowsPathToWslPath` (drive + wsl UNC + POSIX-guard) | golden vs `wslpath -u` + UNC distro-match | `path-utils:118-148` | **yes** |
| P5 | native-Windows `wsl.exe wslpath -w` fallback + reg Store-dialog guard + LRU cache | mock/fixture on Windows | `path-utils:158-206` | **win-fixture** |
| P6 | `isPathAllowed` realpath + win32 case-fold + dir-boundary | symlink-escape + case tests | `path-utils:291-337` | **partial** (posix live; win case win-fixture) |
| P7 | `buildSpawnSpec` matrix: file/args/cwd/env per (OS×shell×cwd) | table-driven golden | `terminal-registry:1059-1266` | **partial** (linux/wsl live; native-win/mac fixture) |
| P8 | Port the **live** `getWindowsDefaultCwd`/`getWindowsExe`/`getSystemShell` (not `platform-utils.ts`) | behavior matches `terminal-registry` copies | `terminal-registry:891-989` | **partial** |
| P9 | cmd/PowerShell arg quoting byte-exact | golden strings | `terminal-registry:997-1057` | **yes** (pure) |
| P10 | Bind host: `FRESHELL_BIND_HOST` > WSL→0.0.0.0 > config > HOST > 127.0.0.1 | unit over env/config | `get-network-host:27-64` | **yes** |
| P11 | Port selection `PORT||3001`, dev port only non-prod | unit | `wsl-port-forward:173-192` | **yes** |
| P12 | LAN IP: WSL→`ipconfig.exe` physical adapters, else `os` ifaces; `scoreLanIp` ranking | golden vs live ipconfig | `bootstrap:36-207` | **yes** |
| P13 | Origin handling **advisory-only** (never reject); token is the gate; loopback bypass | WS accepts bad Origin + valid token; rejects bad token | `ws-handler:1096-1121`, `auth:36-83` | **yes** |
| P14 | `ALLOWED_ORIGINS` auto-build (loopback + LAN×ports); `EXTRA_ALLOWED_ORIGINS` extras | unit over host/lanIps | `network-manager:599-632` | **yes** |
| P15 | `accessUrl` = `http://<lanIp|localhost>:<port>/?token=…`; QR is client-side from it | status shape | `network-manager:370-375` | **yes** |
| P16 | `isRemoteAccessEnabled` (wsl2→false-unless-0.0.0.0-configured) | unit truth table | `network-access:6-19` | **yes** |
| P17 | Hot-rebind close→listen(newHost) with rollback; WSL never rebinds | integration on loopback | `network-manager:400-534` | **partial** (loopback live) |
| P18 | WSL IP detect `ip eth0` → `hostname -I` fallback (skip 172.17) | live compare | `wsl-port-forward:141-171` | **yes** (`172.30.149.249`) |
| P19 | Parse `portproxy show` / firewall `show rule` (missing-rule = exit1+empty) | golden vs live netsh | `wsl-port-forward:106-139,238-270` | **yes** (read) |
| P20 | Port-forward **plan** logic (needs-update, stale, full vs firewall-only, noop) | unit over rule/port sets | `wsl-port-forward:278-475` | **yes** (pure) |
| P21 | Script builders byte-exact incl. `2>\$null`→`$null` normalize, delete-then-add, spaceless rule | golden strings | `wsl-port-forward:289-398` | **yes** (pure) |
| P22 | Managed-ports persistence (WSL json / Windows per-instance sha256, atomic) | round-trip | `wsl-port-forward:59-219`, `network-manager:66-137` | **yes** |
| P23 | Firewall detection branches (ufw/firewalld/netsh ON/OFF/macos) | fixture per platform + live netsh | `firewall:38-127` | **partial** (wsl2 live; mac/ufw fixture) |
| P24 | `firewallCommands` strings per platform | golden | `firewall:129-163` | **yes** (pure) |
| P25 | Elevated PS arg build (`Start-Process -Verb RunAs -Wait`, `'`→`''`) | golden string | `elevated-powershell:11-30` | **yes** (build); **no** (actual UAC run) |
| P26 | Confirmation-token two-phase flow (issue→confirm→lock→verify→persist), 409 on in-flight | integration with stubbed spawn | `network-router:150-758` | **yes** (spawn stubbed) |
| P27 | **Actual** elevated netsh mutate (portproxy/firewall add/delete) | manual elevated run | `network-router` + `wsl-port-forward` | **win-fixture / manual** (⚠ do-not-run on live host) |
| P28 | macOS firewall / zsh default-shell probing | fixture | `firewall:68-79`, `terminal-registry:978-981` | **mac-fixture** |
| P29 | `FRESHELL_DISABLE_WSL_PORT_FORWARD` / `HIDE_STARTUP_TOKEN` / `POWERSHELL_EXE` / `WSL_EXE` / `WINDOWS_SHELL` env overrides honored | unit | `wsl-port-forward:371-375`, `index:928`, `terminal-registry:893,1137,1142` | **yes** |

**Do-not-implement / out of scope for `freshell-platform`:** QR image encoding (client/webview), the coding-CLI
bell-writer semantics (exposed but shell PTYs never emit it), and `platform-utils.ts` (dead duplicate — remove, don't port).

---

## Top 3 fidelity / verification risks (summary)

1. **WSL-detection split (§0.2).** Two regimes (env vs `/proc/version`) that can disagree in scrubbed-env
   WSL2. Highest chance of a silent behavioral change if the port "cleans it up." Adjudicate + ledger.
2. **Elevated, mutating Windows paths are not CI-verifiable (§4.4/§6/P27).** `netsh add/delete` + UAC
   `Start-Process -Verb RunAs` can't be exercised safely here (would touch the live `DANDESKTOP` firewall,
   which is do-not-touch). Confidence rests on **golden-string** parity for scripts/args plus a **manual**
   elevated run on a disposable Windows host — flag for Phase-4 QA as fixture-only.
3. **Dead-duplicate trap (§2.0/§2.4).** `platform-utils.ts` shadows the live `terminal-registry.ts` shell
   helpers and its `getWindowsDefaultCwd` differs. Porting the wrong copy yields a subtle, T1-invisible cwd
   defect on Windows/WSL. The port must source from `terminal-registry.ts` and delete `platform-utils.ts`.
