# /goal — freshell Rust + Tauri Port: Definition of Done

These are **success criteria, not process**. The work (branch `feat/rust-tauri-port` in
`/home/dan/code/freshell/.worktrees/rust-tauri-port`) is DONE when every criterion below is
simultaneously true and **evidenced** (test output, screenshots, committed reports). How you
get there is up to you; `port/HANDOFF.md` documents the current state and proven recipes.

## 1. Functional equivalence (the port IS freshell)

- The Rust server, the retained React frontend (byte-identical `src/`), and the Tauri desktop
  shell together behave **indistinguishably from the original** Node/Electron freshell for
  every user-observable behavior, on this machine, except where a difference is an adjudicated
  bug-fix or documented environment limit.
- All four oracle tiers pass deterministically, `original ≡ rust`: T0 handshake deep-equal;
  T1 terminal bytes byte-identical (incl. the batch tier's UTF-16 offsets); T2 live coding-CLI
  turns for opencode, codex, and claude (cheapest models) meeting all invariants + structural
  baselines; T3 e2e reproducing the original's **exact** pass/fail profile. Mutation validation
  still catches 100% of planted divergences (the oracle must remain able to bite).

## 2. The full client × server matrix works (with proof)

- For every cell of {**Rust server on WSL**, **Rust server on Windows** (native .exe)} ×
  {**Chrome**, **legacy Electron Freshell.exe**, **Tauri app**}: the client connects and
  reaches a ready UI, and **every pane kind available on that server** — CMD, PowerShell,
  WSL/bash, each *installed* coding CLI (claude, codex, opencode, gemini as present on that
  side), Editor, Browser — demonstrably works: a real command executes with asserted output
  (or the CLI's real interactive UI paints), captured in a **screenshot that survives a
  skeptical visual review** (correct cwd in prompts, real UI text, no blank panes, no error
  toasts, no auth walls).
- Cells or pane kinds impossible on this host are recorded as **ENV-LIMITED with proof**
  (e.g. `where.exe` shows opencode absent on Windows) — never silently skipped, never faked.
- **Interchange:** the same client switches between both servers using the user's existing
  legacy auth token, with no reconfiguration beyond the URL.

## 3. Defects: fixed, never replicated, never hidden

- Every defect found is **fixed in the port** (never reproduced bug-for-bug), each fix carries
  a regression test, and any original-vs-port behavior difference is either fixed or
  **adjudicated in `port/oracle/DEVIATIONS.md`** by an adversarial review — no self-approved
  deviations, no weakened oracle assertions, no force-greened tests.
- The flagged **CLI argv fidelity gap** (MCP injection, notification args, opencode control
  endpoint, resume/model/sandbox args) is closed to reference-faithful argv (golden-tested)
  — or explicitly adjudicated as a deviation — with at least one live turn per CLI proving
  the enhanced launch still works.

## 4. Purity and safety (inviolable)

- `server/`, `shared/`, and `src/` are **byte-identical to the reference** (`git diff` empty)
  at every commit.
- The user's live environment is undisturbed: port **:3001 and the processes on it are never
  bound or killed**; no mutating `netsh`/firewall/elevated command ever executes against the
  host; any user config temporarily touched (e.g. the Electron app's desktop config) is backed
  up and restored; zero orphaned processes remain; user transcript stores are read-only.
- Live model spend stays minimal: cheapest models, single-digit calls per validation run.

## 5. Delivery

- Everything is committed and pushed to `feat/rust-tauri-port` (attribution block on every
  commit). **No PR is opened; `main` is untouched.**
- `port/oracle/EQUIVALENCE-REPORT.md`, `port/machine/STATE.yaml`, and `port/HANDOFF.md` are
  updated to final state, including the completed matrix table (screenshot paths per cell) and
  an **honest** enumeration of everything that remains outside this host's reach (macOS,
  live elevated-Windows mutation, the 8 e2e specs that are red on the pristine original,
  anything ENV-LIMITED). An understated true report beats an overstated one.
- The runbook works: a fresh reader can start either server, connect any of the three clients
  with the legacy token, and see every shell type function — using only committed files and
  the recipes in `port/HANDOFF.md`.
