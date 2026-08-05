# QA Panel Experiment — 16 parallel reviewers on one file (fable, 2026-08-05)

**Question:** how do you configure a swarm of identical-model review agents to reliably
find defects? The unit under test is the **instruction (review lens)**, not the agent
(all 16 are the same Kimi-K3 model, cold-started, building their own context).

**Target:** `crates/freshell-server/src/files.rs` — densest/riskiest single file from the
overnight campaign (FILE-01/02/03/06 landed here; security-sensitive path/sandbox code).

**Method:** 16 agents, 12 distinct lenses (broad ×3, parity ×2, breaker ×2, then
test-adequacy / security / anti-anchoring / error-shapes / boundary / concurrency /
spec-clause / free-hunt / panic ×1). Replicates on the top 3 lenses give a noise floor.
**Proof-only rule:** a finding counts ONLY as a Rust `#[cfg(test)]` proof test that FAILS
against current code (proving the defect) and would pass once fixed. No proof = not a finding.
Central verification compiled all 16 modules together (one build, unique module names) and
ran them; a failing test = candidate defect, a passing test = false alarm.

## Results

- 16/16 agents completed; **14 produced compiling proofs, 2 (both `parity` lens) did not**
  (non-compiling Rust — a real data point: that lens over-reached on API details).
- **66 verified proof tests → 65 failing (candidate defects) + 1 false alarm.**
- Dedupe → **17 distinct defect clusters** (13 found by ≥2 independent lenses, 4 singletons).
- Capture-recapture (Chao1) on the convergence: estimated true pool ≈ 42 defects, so this
  single-file panel surfaced **~40% of estimable defects** in one pass.

### Defect clusters by lens-convergence (higher = more independent confirmation)

**Ranking axis (REVISED):** this is a parity campaign, so clusters are ranked by
**confirmed divergence from the Node reference × user/feature-visibility**, NOT by security
severity. Security is explicitly not a primary consideration here; the three security-flavored
clusters are demoted to a separate "config-edge" tier below and are fix-only-if a real Node
divergence at low priority.

### Tier 1 — parity defects (the fix list), ranked by impact × lens-convergence

| Lenses | Cluster (behavioral divergence from Node) |
|--------|-------------------------------------------|
| 7 | `mkdir` with a file as an intermediate component returns **500**, not **409/ENOTDIR** — API error-shape divergence |
| 6 | POSIX/native path lane never runs `sanitize_user_path_input` — **quotes/padding survive** into resolved+display paths |
| 5 | **MIME/Content-Type** table diverges from legacy `send` (`.avif`/`.ico`/`.wav`/unknown→octet) — wrong header users/tools see |
| 4 | **dot-segments not collapsed** in the `resolvedPath` echoed to the client (validate-dir/complete) + mkdir strays |
| 4 | completion suggestions **sort byte-wise**, not Node `localeCompare` — visible ordering divergence |
| 4 | `~\` (backslash tilde) **never expanded** to `$HOME` |
| 2 | **ETag shape**: strong (`"…"`) vs Node's weak form |
| 1 | **UNC** not classified by `is_absolute_user_path` |
| 1 | 3 singletons: write non-string content→400, duplicate `path` query key handling, relative-completion cwd anchor |

### Tier 2 — config-edge / security-flavored (DEMOTED; verify vs Node, low priority)

| Lenses | Cluster | Node-diff status |
|--------|---------|------------------|
| 3 | `/local-file` serves final-segment dotfiles (e.g. `.env`) with 200 | plausibly user-visible; keep, mid |
| 7 | Empty-string `allowedFilePaths` entry disables the sandbox (`is_path_allowed` files.rs:733) | **VERIFIED real divergence** — Node `resolvePathForSandboxComparison("")`→cwd (path-utils.ts:308) vs Rust→`/`. But requires a literal `""` config; **low priority** |
| 5 | symlink + `..` sandbox escape (comparison collapses `..`; kernel op follows real path) | likely real divergence; edge; low priority |

**Adjudication note (reframed):** for a parity goal the gate is *"does it diverge from
`server/*.ts`?"*, not *"is it exploitable?"*. I verified the empty-root cluster against
Node's `isPathAllowed` (path-utils.ts:308): it IS a divergence, but a config-edge one — which
is exactly why it drops from "fix first" to Tier 2. A failing proof test remains a *candidate*
until its Node divergence is confirmed; convergence (≥2 lenses) is the confidence signal.

## What this says about instructions (the actual experiment goal)

Per-lens score (verified slots), clusters found / unique-to-this-lens / false alarms:

| Lens | clusters | unique | false alarm | note |
|------|----------|--------|-------------|------|
| **breaker** (×2) | 7, 7 | 1, 1 | 0 | best raw yield; adversarial "make it fail" wins |
| **spec_clause** | 5 | **3** | 0 | most UNIQUE finds — checklist-clause enumeration hits blind spots others skip (UNC, cwd-anchor) |
| **free_hunt** | 5 | 0 | 0 | strong but fully covered by others |
| **parity** | 5 | 0 | 1 | + its two replicates FAILED TO COMPILE — lens over-reaches |
| **anti_anchor / boundary / error_shapes / panic** | 4 | 0–1 | 0 | solid mid-tier; error_shapes/panic each caught 1 unique |
| **broad** (×3) | 2, 3, — | 0 | 0 | weakest: unfocused review underperforms every narrow lens |
| **security / test_adequacy / concurrency** | 1–2 | 0 | 0 | narrow scopes; concurrency near-empty (little async surface here) |

**Findings about the process:**
1. **Narrow, adversarial lenses beat broad "review this."** The three `broad` replicates
   were the *worst* performers; `breaker` (assume it's broken, construct failing inputs) and
   `spec_clause` (enumerate every checklist clause, prove each) carried the panel.
2. **Diversity of lens > repetition of lens.** Replicates confirmed known defects but added
   almost no new clusters; different lenses found different defects. → "massively parallel QA"
   should mean **many different lenses**, not many reruns of one.
3. **The proof-only rule works as a false-alarm filter.** 65/66 failing tests, 1 false alarm,
   2 non-compiling proof sets auto-excluded — noise stayed low without human triage.
4. **Convergence is a usable confidence meter**, and capture-recapture turns "how many did we
   miss?" into a number (~40% caught here → a second differently-lensed wave is worth running).

### Minimal deployable panel (greedy set-cover over all 17 clusters)

**5 lenses reproduce 100% of what all 14 found:** `breaker` + `spec_clause` + `breaker`(2nd) +
`error_shapes` + `panic`. Practically: **breaker + spec_clause + error_shapes + panic + one
boundary/anti-anchor**, run per file. Drop `broad` entirely; keep `parity` only with a
"tests must compile — don't over-specify APIs" instruction fix.

## Recommended playbook (draft, pre-deployment)

- Per file under review: run **~5 narrow lenses** (breaker, spec-clause, error-shapes, panic,
  boundary), proof-only, one combined central verification build, dedupe by cluster.
- Treat ≥2-lens clusters as high-confidence; single-lens + low-severity as needs-adjudication.
- Use capture-recapture per file to decide whether a second wave is warranted (<~60% ⇒ yes).
- **Not yet deployed for real QA** — this validated the recipe on one file. Obvious next
  target: run the 5-lens panel across the rest of the campaign branch's 31 diffs, and
  adjudicate + fix the flagship empty-root sandbox bypass first (it's security-relevant).

## Reproduction / raw data
- Lenses: `/tmp/qa/slots/*/lens.txt`; per-agent findings: `w-qa-NN/findings.md` (branch `qa/NN`).
- Verified test results: `/tmp/qa/all_results.txt`; combined build: one file, unique modules.
