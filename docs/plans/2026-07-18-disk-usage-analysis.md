# Freshell Disk-Usage Analysis — Durable Efficiency Wins

**Date:** 2026-07-18
**Host:** WSL2 (Linux 6.6.87.2-microsoft-standard-WSL2)
**Root FS:** `/dev/sdd` — 492G total, **392G used, 75G avail (85%)** at time of measurement (post emergency `cargo clean` that freed ~72G).
**Method:** `du -sh` with timeouts, targeted at freshell-relevant trees. Read-only. No process touched. No files deleted.

> **Goal:** durable efficiency (things that REGROW), not one-off cleanup. Each recommendation targets ≥0.5 GB with **zero product functionality loss**. Any trade-off (slower cold build, reduced dep-level backtrace fidelity) is called out explicitly.

---

## 1. Measurements

### 1.1 Repo footprint — `/home/dan/code/freshell` = **25 G**

| Component | Size | Notes |
|---|---|---|
| `.git` (main, shared) | 71 M | Worktrees use `gitdir:` pointer files (verified) → **no `.git` duplication**. Good. |
| **node_modules (all worktrees)** | **~18 G** | **16 worktrees × ~1.1 G full copies** (npm, `package-lock.json`, not deduped). See below. |
| `target/` (Rust, rust-tauri-port only) | 396 M *now* | **~68 G steady-state** from history. Only rust-tauri-port has Rust crates; other worktrees are the Node product (no `target/`). |
| `dist/` (×~40 worktrees) | ~250 M total | 5–11 M each. Below 0.5 GB threshold individually; minor. |
| `test-results/` + `playwright-report/` | < 10 M total | KB–few MB each. Negligible. |

**node_modules duplication (the 18 G):** 16 worktrees each carry a full ~1.1 G copy:
`[main]`, codex-launch-leak-plan, codex-spawn-eagain-diagnostics, deflake-terminal-refresh, electron-windows-native, fix-codex-update-skip, fix-freshopencode-bouncer, fix-packaged-electron-runtime, fresh-agent-followups, fresh-agent-progressive-hydration, fresh-agent-transcript-contract, origin-main-smoke, rebuild, release-v0.7.5, renderer-recovery, rust-tauri-port. (Plus storage-maintenance-cleanup 361 M; the ~40 worktrees with only 368 K are partial/never-installed.) Package manager is **npm** (`package-lock.json` present, no `pnpm-lock.yaml`) → copies are **full duplicates, not hardlinks**.

### 1.2 Toolchain caches

| Path | Size | Freshell-relevant? | Notes |
|---|---|---|---|
| `~/.npm/_cacache` | **13 G** | Yes (heavy) | Global npm download cache; 44 worktrees' installs feed it. Pure cache — re-downloadable. |
| `~/.npm/_npx` | 3.0 G | Partial | npx package cache. |
| `~/.cache` (total) | 17 G | Mixed | freshell slices below; rest is other projects (uv 4.4 G, Cypress 1.6 G, gf-emsdk 1.5 G, superpowers 1.3 G, gf-creative-tools-cargo 1.1 G, directordeck-cypress 805 M, puppeteer 636 M, go-build 343 M…). |
| `~/.cache/ms-playwright` | 1.9 G | Yes | **3 chromium versions** (1200/1208/1217 ≈ 357/364/369 M) + 3 headless_shell (251/254/257 M) + ffmpeg 4.9 M. Only pinned **1217** is used. |
| `~/.cache/electron` | 422 M | Yes | Electron binary download cache. |
| `~/.cargo` | 1.8 G | Yes | `registry` 1.8 G (download cache), `bin` 51 M. |
| `~/.rustup` | 1.8 G | Yes | 1 toolchain (`stable-x86_64-unknown-linux-gnu`). Minimal/needed. |

### 1.3 Docker — images 14.72 G, volumes 1.369 G (build cache 0)

| Item | Size | Freshell? | Notes |
|---|---|---|---|
| `freshell-sandbox:latest` | 6.59 G | **Yes — active/needed** | The test sandbox image. Do not remove. |
| Dangling `<none>` images | ~1.59 G reclaimable | Partly (old sandbox rebuild layers) | `docker system df` → 1.587 G reclaimable images. |
| Unused local volumes | 1.124 G reclaimable | Partly | 23 volumes, 6 active; freshell owns `freshell-sandbox-node-modules`, `freshell-sandbox-playwright-cache` (active). |
| Non-freshell images | ~8 G | No | libreoffice 3.73 G, onecli ×2, imagemagick 633 M, inbucket ×6, postgres, caddy, node, python — other projects. |

### 1.4 Product / runtime data — `~/.freshell` = **9.6 G**

| Path | Size | Rotation/cap? | Notes |
|---|---|---|---|
| `checkpoints/` | **6.9 G** | **No disk cap** | 25 bare-git checkpoint repos (~280 M avg). `CHECKPOINT_LIST_LIMIT=100` (`server/fresh-agent-extras-router.ts:72`) is a *display* limit for `git log`, **not** a retention/prune cap. Grows unbounded. **Product data.** |
| `tabs-registry/` | 2.5 G | No cap | `v1/objects` content-addressable store (git-like), unbounded; plus stale `manifest.json.invalid-*` forensic copies. **Product data.** |
| `logs/` | 217 M | **Yes** | `rotating-file-stream` with `maxFiles` caps (`server/logger.ts`). Already bounded. Fine. |
| `rust-session-cache.json` | 36 M | — | Parse/session cache (~22 M corpus noted OK). Fine. |
| config backups (`config.backup.json`, `config.pre-rust-tauri-*`) | < 300 K | — | Forensic copies. Negligible. |

### 1.5 QA staging + other

| Path | Size | Notes |
|---|---|---|
| `~/freshell-qa/home-real-staging` | **20 G** | Staging clone of a real home for parity bake-in. **User decides keep/delete** when bake-in ends. Biggest single reclaimable item on the box. |
| `~/freshell-qa/home-legacy` | 1.1 G | Legacy staging home. |
| `~/freshell-qa/home-rust` | 347 M | Rust-port staging home. |
| `/tmp` (freshell-attributable) | < 50 M | Big `/tmp` entries (claude-1000 1.8 G, task3-verify 1.4 G, gf-cad, ckm-gold, glowforge, directordeck, codex…) trace to **other projects**. Freshell `/tmp` entries are tiny `.txt` reports. **No meaningful freshell /tmp debris.** |

### 1.6 Session data — USER DATA, **not freshell's to touch**

`~/.amplifier` 49 G, `~/.codex` 15 G, `~/.local/share/opencode` 5.5 G, `~/.claude` 2.3 G. Freshell reads these to index sessions but **does not write** into them (freshell's own writes go to `~/.freshell` only). No redundant freshell-authored data found there. Listed for completeness; excluded from recommendations.

---

## 2. Findings ranked by durable GB (freshell-attributable, zero functionality loss)

| # | Win | Durable GB | Regrows if ignored? | Functionality impact | Effort |
|---|---|---|---|---|---|
| 1 | Rust dev-profile tuning (kill dep debuginfo) | **~25–40 G** (vs 68 G baseline) | Yes — every rebuild | None to product; minor: shallower backtraces *inside deps* | 1 config block |
| 2 | node_modules dedup across worktrees (pnpm/store) | **~15 G** | Yes — each `npm install` | None if migrated correctly | Process change (validate) |
| 3 | npm cache prune + cadence (`_cacache`/`_npx`) | **~11–14 G** | Yes — grows forever | None (re-download on demand) | Cadence/cron |
| 4 | Playwright stale-browser prune | **~1.2 G** | Yes — each PW bump | None (only pinned version used) | 1 command + cadence |
| 5 | Docker dangling image/volume prune | **~1.6 G** (up to 2.7 G) | Yes — each sandbox rebuild | None (removes unreferenced only) | Cadence |
| — | *(product-side, user policy)* checkpoints retention | up to ~6 G | Yes — unbounded | **Trade-off: loses old checkpoints** — needs product decision | Feature |
| — | *(product-side, user policy)* tabs-registry GC | up to ~2 G | Yes — unbounded | Needs GC of unreferenced objects — careful | Feature |
| — | *(user decision)* `freshell-qa/home-real-staging` | 20 G | No | Delete when bake-in ends | 1 `rm` (user) |

---

## 3. Recommendations (exact changes)

### WIN 1 — Rust dev-profile tuning · ~25–40 G durable · **THE elephant**

**Root cause:** `.worktrees/rust-tauri-port/Cargo.toml` has **zero `[profile]` sections** (verified — `grep -c profile` = 0). The default dev profile compiles the *entire* dependency tree — including the very large `freshell-tauri` tree — with `debug = true` (full DWARF) and `incremental = true`. Dependency debuginfo is typically **40–60% of a large Tauri `target/`**. That is why steady-state is ~68 G.

**Change** — add to `.worktrees/rust-tauri-port/Cargo.toml` (workspace root):

```toml
# --- Disk/debuginfo tuning: dependency debug symbols are the target/ elephant ---
[profile.dev]
# Keep file:line in YOUR backtraces; drop full variable-level DWARF.
debug = "line-tables-only"
# Linux: keep debug info out of the rlibs (smaller, less incremental churn).
split-debuginfo = "unpacked"

[profile.dev.package."*"]
# Dependencies: no debuginfo at all. You almost never step into them.
debug = false
```

**Estimated saving:** ~40–60% of 68 G → **~25–40 G durable** (steady-state target drops to ~30–40 G).
**Functionality impact:** **None to the product.** Trade-off (call it out): backtraces *inside third-party crates* lose variable-level detail; your own crates keep `file:line`. `cargo build`/`test` output is byte-identical in behavior. First rebuild after the change recompiles once.

**Sub-win 1b — don't build `freshell-tauri` for routine commands.** With `members = ["crates/*"]` and no `default-members`, a bare `cargo build`/`cargo test` at the root compiles the huge Tauri crate every time. If routine dev/CI doesn't need the GUI crate, add:

```toml
[workspace]
# ...existing...
default-members = [
  "crates/freshell-server", "crates/freshell-ws", "crates/freshell-api",
  "crates/freshell-sessions", "crates/freshell-terminal", "crates/freshell-protocol",
  "crates/freshell-platform", "crates/freshell-codex", "crates/freshell-freshagent",
  "crates/freshell-opencode",
  # freshell-tauri intentionally excluded from default set
]
```

Then Tauri only compiles under explicit `cargo build -p freshell-tauri`. **Trade-off:** you must name the crate when you do want it. Cuts a large slice of `target/` for everyday work. *(Adjust the member list to match what routine test runs actually need — validate before adopting.)*

### WIN 2 — node_modules dedup across worktrees · ~15 G durable

**Measured:** 16 worktrees × ~1.1 G = **~18 G**, full duplicates under npm. A content-addressable store (pnpm) collapses this to **one ~1.1 G store + hardlinks**, so N worktrees cost ~1.1 G + small deltas instead of N × 1.1 G.

**Option A (structural, biggest win):** migrate installs to **pnpm** (`pnpm import` from `package-lock.json`, then `pnpm install`; pnpm's global store hardlinks into each `node_modules`).
- **Saving:** ~15 G durable and it *scales* — every new worktree stops adding 1.1 G.
- **Functionality impact:** must be **zero**, but is **not guaranteed by the config alone** — native modules (node-pty) and electron packaging need a validation pass under pnpm's non-flat layout. **Effort: high (migration + CI + validate). Do not adopt blind.**

**Option B (zero-risk, smaller):** keep npm; treat `node_modules` in **inactive/merged worktrees** as disposable — they regrow only on demand via `npm ci`. This needs the user's deletion call (out of scope here) but is the safe durable hygiene: don't `npm install` in a worktree until it's active again.

**Recommendation:** pursue Option A as the durable structural fix, gated behind a functional validation of node-pty + electron builds. Until then, Option B hygiene.

### WIN 3 — npm cache prune + cadence · ~11–14 G durable

**Measured:** `~/.npm/_cacache` = **13 G**, `_npx` = 3 G. Pure download cache; content-addressable; **re-downloaded on demand**.

**Change (safe, immediate):**
```bash
npm cache verify        # dedupe/GC integrity (reclaims cruft, keeps valid entries)
# or full reset (regrows): npm cache clean --force
```
**Durable cadence** — a weekly job (npm has no native size cap):
```bash
# ~/.config/systemd or cron, weekly:
npm cache verify && npm cache clean --force
```
**Saving:** keep steady-state ~1–2 G → **~11 G durable.**
**Functionality impact:** **None.** Trade-off: the *next* install after a clean is slower (re-fetch). Nothing breaks.

### WIN 4 — Playwright stale-browser prune · ~1.2 G durable

**Measured:** chromium **1200 + 1208** (357 + 364 M) and their headless shells (251 + 254 M) are stale; only **1217** is pinned/used.

**Change:**
```bash
# From a worktree with the pinned @playwright/test installed:
npx playwright uninstall          # removes browsers not required by current install
# (or, explicitly, prune old version dirs under ~/.cache/ms-playwright)
```
**Durable cadence:** after each Playwright bump, run `npx playwright install <pinned>` then `npx playwright uninstall` to drop the previous version.
**Saving:** **~1.2 G** (regrows ~0.6 G per skipped-prune version bump).
**Functionality impact:** **None** — Playwright resolves only the pinned browser build.

### WIN 5 — Docker dangling prune · ~1.6 G (up to 2.7 G) durable

**Measured:** `docker system df` → 1.587 G reclaimable images (dangling), 1.124 G reclaimable volumes. Dangling `<none>` images are old `freshell-sandbox` rebuild layers.

**Change (safe — dangling only):**
```bash
docker image prune -f          # removes ONLY unreferenced (dangling) images — safe
```
**Volumes (review first — the prune is global):**
```bash
docker volume ls -f dangling=true   # inspect BEFORE pruning; other projects share this daemon
docker volume prune                 # only after confirming none are needed
```
**Durable cadence:** run `docker image prune -f` after each `freshell-sandbox` rebuild.
**Saving:** ~1.6 G (images) immediately; up to 2.7 G with reviewed volume prune.
**Functionality impact:** **None** — `freshell-sandbox:latest` and its active volumes are referenced and untouched by `image prune`. Do **not** run `docker system prune -a` (would remove the 6.59 G sandbox image and force a costly rebuild).

### Product-side (measure + flag — user/product decision, not auto-safe)

- **checkpoints 6.9 G:** no disk retention cap exists (only a display limit). A product-level retention policy (keep last K, or age-out) would durably bound this. **Trade-off: deleting checkpoints loses that history** — needs product decision, not a silent cleanup.
- **tabs-registry 2.5 G:** unbounded object store + stale `.invalid` manifests. A GC pass over unreferenced objects is a real durable win but must be implemented carefully against the live registry.
- **`freshell-qa/home-real-staging` 20 G:** single biggest reclaimable item. **Keep or delete is a one-line user decision** once parity bake-in concludes. Not freshell's to auto-remove.
- **logs (217 M) already rotation-capped** — no action. **parse/session cache (~22–36 M)** — fine, no action.

---

## 4. Summary — Top 5 durable wins

| Rank | Win | Est. durable GB | Effort | Product impact |
|---|---|---|---|---|
| 1 | Rust dev-profile tuning (drop dep debuginfo; optional `default-members` to skip Tauri) | **~25–40 G** | 1 config block | None (shallower dep-internal backtraces only) |
| 2 | node_modules dedup via pnpm store across 16 worktrees | **~15 G** | Process change + validate | None if migrated correctly |
| 3 | npm cache prune + weekly cadence (`_cacache` 13 G + `_npx` 3 G) | **~11 G** | Cron/one-liner | None (slower next install) |
| 4 | Playwright stale-browser prune (keep pinned only) | **~1.2 G** | 1 command + cadence | None |
| 5 | Docker dangling image prune after sandbox rebuilds | **~1.6 G** | Cadence | None |

**Conservative total (top 5): ~54 G durable** (headline range ~50–70 G). Plus **~20 G** one-time from the QA staging clone whenever the user retires it, and up to **~8 G** more from product-side checkpoint/registry retention policies (require product decisions with explicit history trade-offs).

**The single highest-leverage change is WIN 1:** ~6 lines in `rust-tauri-port/Cargo.toml` reclaims the majority of the 68 G that the emergency `cargo clean` will otherwise watch regrow.
