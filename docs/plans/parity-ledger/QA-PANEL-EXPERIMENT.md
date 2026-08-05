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

| Lenses | Sev | Cluster |
|--------|-----|---------|
| 7 | high* | **Empty-string `allowedFilePaths` entry disables the whole sandbox** (`is_path_allowed` files.rs:733 — `[""]` passes the non-empty check, `""` prefix-matches every absolute path; Node `path.resolve("")` anchors to cwd). **ADJUDICATED REAL by reading code.** |
| 7 | med | mkdir on a path with a file as intermediate component returns 500, not 409/ENOTDIR |
| 6 | med | POSIX/native path lane never runs `sanitize_user_path_input` (quotes/padding survive) |
| 5 | high | symlink + `..` sandbox escape (comparison collapses `..` but the kernel op follows the real path; dangling-leaf symlink re-attached by literal name) |
| 5 | low | MIME/Content-Type table diverges from legacy `send` (.avif/.ico/.wav/unknown→octet) |
| 4 | low | completion suggestions sort byte-wise, not Node `localeCompare` |
| 4 | low | `~\` (backslash tilde) never expanded to `$HOME` |
| 4 | low | dot-segments not collapsed in validate-dir/complete display + mkdir strays |
| 3 | high | `/local-file` serves final-segment dotfiles (e.g. `.env`) with 200 |
| 2 | low | strong vs weak ETag shape |
| 1 | med | UNC not classified by `is_absolute_user_path` |
| 1 | · | 3 more singletons (write non-string→400, dup query key, relative-completion cwd anchor) |

\*severity shown is the modal agent label; the flagship is security-relevant regardless.

**Big caveat (honest):** a failing proof test is a *candidate* — it can also encode the
reviewer's own wrong expectation. Convergence is the confidence signal: 7 independent lenses
writing 7 independent failing tests for the same `""`-root behavior is very unlikely to be 7
identical misunderstandings, and I confirmed that one by reading the code. Low-severity
MIME/sort claims are more likely parity nitpicks of debatable validity and need per-item
adjudication before fixing. Full adjudication of all 65 is the follow-up.

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
