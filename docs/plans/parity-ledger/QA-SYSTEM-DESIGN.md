# QA-and-Fix System Design — closed-loop parity quality at 32 agents

**fable, 2026-08-05.** Successor to `QA-PANEL-EXPERIMENT.md`. Everything below builds on
tonight's measured results (16-agent lens panel, proof-only rule, capture-recapture,
build-neck limits) — treated as established fact, not re-argued here.

**The mandate:** don't just find divergences from the Node reference — fix every confirmed
one to a high quality bar, with **every fix independently reviewed before it lands**. Last
night 31 items landed on tests+gates alone with zero independent code review. This design
exists to make that impossible to repeat. Quality is the primary objective; speed is second.

---

## 1. The golden thread: one proof test spans the whole loop

The single load-bearing idea: **a failing proof test is the one artifact that carries a
defect through every stage of the pipeline.**

- **Detection** produces it: a finding only exists as a Rust `#[cfg(test)]` test that FAILS
  against current code (tonight: 65/66 such tests were real, 1 false alarm — the rule *is*
  the noise filter).
- **Adjudication** validates it: the test is a *candidate* until its divergence from
  `server/*.ts` is confirmed (harness diff or traced reference code).
- **The fix** is defined by it: the fixer's acceptance criterion is mechanical — *this*
  test goes green, the touched suite stays green, the harness diff (where reachable) goes
  clean.
- **The fix-review** is anchored by it: the reviewer doesn't ask "is this nice code?" but
  "does this change make *this* proof pass for the *right* reason, matching the Node
  behavior I re-derived myself?"
- **Integration** keeps it forever: the proof test lands with the fix as permanent
  regression coverage.

One artifact, zero translation loss between stages, and every gate in the pipeline becomes
checkable by machine rather than by vibes. Everything else in this design is scaffolding
around that thread.

## 2. Pipeline overview (prose)

Work flows through seven stages: **map → detect → adjudicate → fix → review-the-fix →
verify/regress → integrate.** The unit of work is a *behavioral surface* — an endpoint, a
WS message type, a feature flow, with its `server/*.ts` reference — never a file, because
defects cross files (mkdir-500-vs-409 spanned router, path layer, and error mapping). For
this port the surfaces are pre-enumerated: the 235-item checklist plus the legacy handlers
*are* the map; the map stage just formalizes them into a registry.

Detection fans the proven 5-lens panel (breaker, spec-clause, error-shapes, panic,
boundary) across surfaces, wide and cheap. Adjudication converts candidates into confirmed
divergences via the differential harness where it reaches, and reference-tracing where it
doesn't. Confirmed divergences become fix tickets; fixes come back as diffs in their own
worktrees; an independent cold reviewer passes judgment with its own evidence; central
verification compiles and gates; the orchestrator integrates onto the single campaign
branch. Any stage can bounce work backward — a bounce is normal, not exceptional (first-pass
worker success is ~30%; the recovery loops are what get it to ~90%).

## 3. Stages and gates — the artifact that lets work advance

| Stage | Who | Gate artifact to ADVANCE | Bounce condition |
|---|---|---|---|
| **Map** | orchestrator (once) | Surface registry entry: ID, `server/*.ts` file:lines, checklist items, `harness-reachable?` flag | malformed / unreferenced surface |
| **Detect** | lens agents, wide | Proof test that **compiles in the central combined build and FAILS** — uniquely-namespaced module, attributed by module path | doesn't compile → discard; passes → false alarm, logged |
| **Adjudicate** | harness + tracer agents | **Divergence card**: Node behavior cite (harness diff or traced file:line), convergence count (≥2 lenses = high confidence), parity-impact rank | no confirmed Node divergence → close as "Rust-only quirk, not parity"; ambiguous intent → **human queue, never guessed** |
| **Fix** | fixer agent, own worktree | Commit where the proof test **passes**, touched-crate suite green (checked centrally, not self-certified), plus the fixer's own new tests | central build disagrees → exact failure fed back (`opencode run -c`); 2 timeouts → fresh session on the dirty worktree; ~3 strikes → split or escalate to orchestrator |
| **Review-the-fix** | independent cold agent | **Review verdict with evidence**: re-derived expected behavior from `server/*.ts` (with cites), judgment that the diff achieves it, optionally extra probe tests. "LGTM" without evidence auto-bounces the *review*, not the fix | REQUEST-CHANGES with concrete notes → back to fix stage |
| **Verify/regress** | orchestrator, serial | Cherry-pick onto integration branch; proof test green + full touched suites green + harness diff clean (if reachable) — **one build chain at a time** | any regression → revert, bounce to fix with the failure |
| **Integrate** | orchestrator | Commit landed with explicit pathspec; proof test now permanent; batch record updated | — |

Two verification rules carried over verbatim from tonight because they were paid for in
blood: **combine all proof modules into one build and attribute by module path** (never N
builds sharing a target — WSL2 serves stale binaries), and **at most 1–2 concurrent
build/verify chains, no new launches while a chain runs** (the load-148 incident).

## 4. Independence with identical models

Every agent is the same Kimi-K3. So independence cannot come from *who* reviews — it must
be manufactured from *what the reviewer knows and is asked*. Four structural rules,
enforced by the dispatcher, not by trust:

1. **Never author-reviews-own-work.** The ticket records the fixer's session ID; the review
   is always a **fresh cold session** (never `-c` off any session that touched the fix).
   Cold start is the isolation mechanism — a new session shares no context with the fixer.
2. **The reviewer never sees the fixer's rationale.** Review instructions contain: the
   surface spec, the proof test, the diff itself, and a pointer to the `server/*.ts`
   reference. They exclude the fixer's findings notes, commit-message reasoning, and
   session transcript. The diff must stand on its own.
3. **Anti-anchoring, validated tonight:** the reviewer is instructed to trace the Node
   reference and write down expected behavior **before** opening the diff. An identical
   model that derives the answer independently and *then* compares is a genuinely
   different measurement from one that reads the fix first and rationalizes it.
4. **Lens rotation:** the review lens differs from the lens that detected the bug (a
   breaker-found defect gets a spec-clause or error-shapes reviewer), so the fix is probed
   from an angle its own origin story didn't cover.

Honest limit: identical models share blind spots. A behavior the model *cannot conceive as
wrong* will pass fixer, reviewer, and lens panel alike. The differential harness is the
only truly model-independent check in the system — which is why it matters so much.

## 5. The differential harness — the objective adjudicator

Boot the legacy Node server and the Rust server side by side on scratch ports with matched
config, replay the same request to both, diff the responses (status, headers, body — after
normalizing legitimately-variable fields: dates, ETag values, ports, tokens). This turns
"does it match?" from a judgment call into a diff, at two points in the loop:

- **Adjudication:** a candidate proof test's divergence is confirmed or refuted by one
  replay — no human, no tracing session.
- **Fix verification:** after the fix, the same replay must diff clean. That's a stronger
  guarantee than the proof test alone (which encodes the *reviewer's* idea of Node
  behavior; the harness encodes *actual* Node behavior).

**Where it reaches:** request/response HTTP surfaces — files API, sessions CRUD, config,
auth shapes, error bodies, content-type/header behavior. Plausibly half or more of the
defect pool by tonight's evidence (mkdir 409, MIME table, ETag shape, dot-segment echo —
all harness-reachable).

**Where it can't reach:** WS message *ordering* and timing, PTY behavior (echo timing,
resize races), filesystem *side-effects* (what got created on disk vs. what the response
claims), long-lived stateful flows, and anything where Node itself is nondeterministic.
Those gaps are covered by the two things that already work: the lens panel with proof tests
(side-effects are assertable in a Rust test even when they're invisible in a response) and
reviewer reference-tracing with file:line cites as the adjudication fallback.

## 6. Scheduling detection: convergence as the meter

Capture-recapture is the detection scheduler. Per surface: run the 5-lens panel (wave 1),
dedupe into clusters, compute overlap. **"Done to depth"** for a surface means: a second,
differently-lensed wave adds ≤1 new cluster, or the Chao1 estimate says ≥~80% of the
estimable pool is found — typically ~2 waves. Then the detection budget *moves on* rather
than re-grinding a saturated surface. Tonight's single-file run caught ~40% in one pass and
the replicate data showed repetition adds nothing — so the schedule is: **diverse lenses per
wave, at most two waves per surface, breadth across surfaces over depth on any one.**
Surfaces are ordered by parity-impact (user/feature visibility × checklist weight), not by
how scary they sound — security is explicitly not the ranking axis.

## 7. Allocating 32 agents — work-stealing with a bounded neck

Agents don't get fixed roles; they pull from a ticket queue (a JSONL ledger in the
campaign worktree, committed on every append — we learned *that* lesson the hard way).
**Pull priority drains downstream first**: review-the-fix > fix > adjudicate > detect. That
bounds work-in-progress — quality-first means finishing what's in flight before finding
more — while detection soaks up all remaining slots because it's nearly free locally
(remote inference; 18-wide cost almost nothing tonight).

Illustrative steady state, mid-campaign:

| Lane | Agents | Local cost |
|---|---|---|
| Detection (5-lens panels across ~3 surfaces) | 14 | ~zero (remote inference) |
| Adjudication (harness replays + reference tracing) | 3 | light |
| Fixers (own worktrees, shared warm CARGO_TARGET_DIR for *their* builds, serialized) | 7 | moderate |
| Fix-reviewers (cold, evidence-producing) | 5 | ~zero |
| Harness operator (keeps Node+Rust scratch pair alive, runs replays) | 1 | light |
| Recovery loops (resume/fresh-session on stuck tickets) | 2 | ~zero |

The **orchestrator is not one of the 32** and owns the neck: central verify/regress builds,
strictly 1–2 chains, nothing else launching while a chain runs. Early campaign skews ~24
detection / 8 rest; late campaign inverts. The queue makes the shift automatic — allocation
follows ready work, not a plan.

## 8. Where the human sits

Three places, no more: (1) **PR approval** — everything lands on the single integration
branch; no PR, no push to main, without explicit approval, per repo rules. (2) **Intent
calls** — when adjudication confirms a divergence but can't tell whether it's *intentional*
(Rust deliberately improved on Node), the ticket is surfaced with its divergence card for a
human yes/no; the system never guesses intent. (3) **Batch review** — confirmed+fixed+
reviewed changes are grouped into review-ready units per surface (5–10 fixes each), each
batch carrying its proof tests, divergence cards, and review verdicts, so human review is
reading evidence, not re-deriving it.

## 9. Success metric

**Coverage-to-convergence with evidence — not throughput.** The campaign is done when:
every registered surface is detected to saturation (two-wave convergence rule met, Chao1
recorded); every confirmed divergence has a proof test that went failing→passing, an
independent fix-review PASS with cited evidence, and a clean harness diff where reachable;
and the intent-ambiguous residue is enumerated for human decision. "We landed N fixes" is
explicitly not the metric — N fixes without the evidence chain is last night's gap wearing
a new hat.

## 10. Honest risks, and what to prototype first

- **Correlated blind spots** (one model everywhere). Mitigated by the harness (model-free)
  and lens diversity; not eliminated. Residual risk is real and should be stated in the
  final report, not papered over.
- **Harness setup may be expensive or noisy.** Node and Rust must boot with *matched*
  config; responses carry legitimately-variable fields needing normalization; auth quirks
  (X-Auth-Token) differ. If normalization noise drowns the signal, the harness degrades
  from "objective oracle" to "hint generator."
- **Proof tests can encode reviewer misunderstanding.** Adjudication against the actual
  reference exists precisely for this; the residual case (test and adjudicator wrong the
  same way) is the correlated-blind-spot risk again.
- **Orchestrator attention is the true scarce resource** (tonight's clearest lesson). The
  queue, the mechanical gates, and evidence-carrying tickets all exist to keep the human
  and the orchestrator out of per-item judgment. If the loop still needs constant
  babysitting, the design has failed regardless of agent count.
- **Intentional-divergence ambiguity** could swamp the human queue if the Rust port
  deliberately improved many behaviors. Batch these by pattern, not one-by-one.

**Prototype first: the differential harness.** Pressure-tested, the prior holds — it is the
only component that converts the two most judgment-heavy, orchestrator-expensive stages
(adjudication and fix-verification) into machine-checkable diffs, and the only check not
sharing the model's blind spots. It is also the component with the most unknown setup cost,
which is exactly why it goes first: boot both servers on scratch ports, replay ~20 requests
across one surface (files API — richest confirmed defect pool), measure the noise floor and
normalization effort, and re-verify two known clusters (mkdir 500-vs-409, MIME table) as
the acceptance test. If it confirms both in under a day of setup, build the loop around it.
If it can't be made quiet, fall back to reference-tracing adjudication — the loop survives,
just slower and more judgment-bound.
