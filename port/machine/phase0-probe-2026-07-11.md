# Phase-0 capability probe — 2026-07-11 (SurfaceBookPro9, WSL2)

Recorded per `port/HANDOFF.md` §3 / work-queue item 1. All commands run from
`/home/dan/code/freshell`, branch `feat/rust-tauri-port` @ `d20b4af1`.
Windows interop via absolute paths only (`WIN_*` shell-local vars; PATH untouched).

## Preflight gate status

| Gate | Status | Evidence |
|---|---|---|
| 1. Amplifier auth/config | COMPLETE (per handoff, 2026-07-11) | providers pass discovery; session running |
| 2. sudo toolchain phase | **COMPLETE** (done after handoff was written) | see toolchain probe below |
| 3. CLI credentials | claude: present · codex: present · opencode: **0 stored credentials** (env-resolved providers only — see notes) | probe below |

## Toolchain probe

```
cc                       /usr/bin/cc
make                     /usr/bin/make
pkg-config               /usr/bin/pkg-config
x86_64-w64-mingw32-gcc   /usr/bin/x86_64-w64-mingw32-gcc
convert                  /usr/bin/convert
tesseract                /usr/bin/tesseract
xdotool                  /usr/bin/xdotool
webkit2gtk-4.1: OK 2.52.3
gtk3: OK
node v24.12.0 · npm 11.6.2
rustc 1.97.0 (2d8144b78 2026-07-07)
targets: x86_64-pc-windows-gnu, x86_64-unknown-linux-gnu
.cargo/config.toml: windows-gnu linker wired (x86_64-w64-mingw32-gcc/ar)
playwright: Version 1.58.2 · ~/.cache/ms-playwright: chromium-1208, chromium_headless_shell-1208, ffmpeg-1011
GUI: DISPLAY=:0 WAYLAND=wayland-0 · WSLg-present
```

## Windows interop probe (absolute paths)

```
"$WIN_POWERSHELL" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'  → 5.1.26100.8655
"$WIN_POWERSHELL" CopyFromScreen capability (PrimaryScreen.Bounds.Width)     → 1440
```

## Coding CLIs

```
cli        wsl win   version (wsl)
claude      Y   Y    2.1.207 (Claude Code)
codex       Y   Y    codex-cli 0.144.1
opencode    Y   n    1.17.18
gemini      n   n    (out of porting scope)
```

- claude creds: `~/.claude/.credentials.json` present.
- codex auth: `~/.codex/auth.json` present (`Logged in using ChatGPT` per handoff).
- opencode: `opencode auth list` → `0 credentials` in `~/.local/share/opencode/auth.json`;
  environment-resolved providers: OpenAI (`OPENAI_API_KEY`), Anthropic (`ANTHROPIC_API_KEY`).
  `~/.config/opencode/opencode.jsonc` exists (umans provider config expected there).
  T2-opencode (umans-kimi-k2.7) auth will be proven at T2 time; if the leg cannot
  authenticate it will be escalated loudly per HANDOFF §3, not silently skipped.
- **ENV-LIMITED (proof):** `"$WIN_WHERE" opencode` → not found ⇒ Windows-side
  OpenCode legs are ENV-LIMITED. gemini absent both sides (out of scope anyway).

## Networking

```
WSL IP (eth0):     172.27.70.187
Windows host IP:   172.27.64.1   (WSL→Windows-process traffic)
:3001 listener:    none (no legacy freshell on this host — nothing to protect;
                   port rule 17870–17899 still applies)
```

## Conclusion

All preflight gates green enough to begin work-queue item 2 (re-green the
deterministic base). Windows-side opencode is the one ENV-LIMITED leg recorded
so far; opencode credential status is flagged for explicit verification at T2.
