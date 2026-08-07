# Parallel Agent Bug-Fix System — closed-loop quality at scale

**The problem this solves:** you have a codebase, a large supply of identical-model coding
agents, and a mandate: *find and fix the bugs to a high quality bar, with every fix
independently reviewed before it lands.* Agents are cheap and plentiful; trust is not — an
agent's claim that it found, fixed, or approved something is worth nothing by itself. This
design turns claims into evidence at every stage, so N agents can run in parallel without
N agents' worth of human babysitting. Quality is the primary objective; speed is second.

---

## 1. The golden thread: one proof test spans the whole loop

The single load-bearing idea: **a failing proof test — an executable test in the
project's own language and toolchain that fails against the current code — is the one
artifact that carries a defect through every stage.**

- **Detection** produces it: a finding *exists* only as a proof test that FAILS against
  current code. This rule is the noise filter — a claim either demonstrates itself or it
  is noise, and telling the two apart needs no human triage.
- **Adjudication** validates it: the test is a *candidate* until an objective oracle (§2)
  confirms the behavior is actually wrong rather than intended.
- **The fix** is defined by it: the fixer's acceptance criterion is mechanical — *this*
  test goes green and everything else stays green.
- **The fix-review** is anchored by it: the reviewer judges whether the change makes
  *this* proof pass for the *right* reason, matching expected behavior the reviewer
  derived independently.
- **Integration** keeps it forever: the proof test lands with the fix as permanent
  regression coverage.

One artifact, zero translation loss between stages, and every gate becomes
machine-checkable. Everything else in this design is scaffolding around this thread.

## 2. The objective oracle: deciding bug-or-not without model judgment

An **oracle** is any mechanism that classifies a behavior as a defect *without asking a
model to judge*: a deterministic, executable check whose verdict stands on its own.
Oracle *strength* is how directly the check asserts intended behavior — strongest when it
asserts an explicit, documented contract clause; weakest when it merely flags an anomaly
for tracing. Where the target has a trusted alternate implementation, differential
comparison against it is one optional plug-in oracle among whatever others the project
admits — never the backbone — and confirmed divergence from a trusted reference can raise
a bug's severity within the launch-time matrix (§3).

The oracle is load-bearing for two reasons: it removes model judgment from the two most
expensive stages (adjudication and fix-verification), and it is the **only check in the
system that does not share the model's blind spots** (§5). During map, configure the
strongest oracles the target admits. Where no oracle reaches a surface, adjudication
falls back to an agent tracing expected behavior from spec and docs with citations — the
loop survives, just slower and more judgment-bound.

## 3. Severity: a launch-time input

Severity is **configuration the user supplies at launch, not a law of the system**. What
counts as a bad bug depends entirely on what the code is for, and no hardcoded ordering
survives contact with a second codebase — so this system does not have one.

**The severity matrix** — the bug categories that matter for *this* target and their
relative weight and ordering — **is a launch-time parameter.** Every downstream consumer
references this one matrix and defines no ranking of its own: lens-panel composition
(§7), the severity class assigned to each bug card at adjudication (§4), fix-queue
ordering and batching (§7, §8). This section is the single authority.

**If the user does not supply a matrix, the system asks — it never proceeds silently on a
default.** During the map stage, before any detection launches, the orchestrator inspects
whatever context it has — the code, its stated purpose and domain, its docs and
configuration, its dependencies, its exposure — and **proposes a tailored matrix with a
rationale for each ranking**, derived from that context. The user confirms or adjusts;
the run does not advance past map until the matrix is ratified. This is a human gate at
launch (§8).

**The default starting matrix** is the seed the orchestrator adapts from when building
its proposal — a starting point the user ratifies, never a silent fallback:

1. security
2. crash / hang
3. data loss / corruption
4. incorrect behavior
5. resource / performance
6. cosmetic

**Severity and confidence are orthogonal; priority is their product.** *Severity* is the
impact class a confirmed bug draws from the ratified matrix. *Confidence* is how sure the
system is the bug is real: detector convergence (independent lenses finding the same
cluster) plus oracle strength (§2). **Priority = severity (from the matrix) ×
confidence.** Any stage that orders work uses this product; no stage redefines either
axis.

## 4. The closed loop: stages and gates

Work flows through seven stages: **map → detect → adjudicate → fix → review-the-fix →
verify/regress → integrate**, with an evidence gate between each. The unit of work is a
**behavioral surface** — a coherent unit of externally observable behavior with its own
spec, however the target naturally decomposes — never a file, because defects cross
files.

| Stage | Who | Gate artifact to ADVANCE | Bounce condition |
|---|---|---|---|
| **Map** | orchestrator, once | Surface registry entry: ID, spec/docs pointers, which oracles reach it — plus a **ratified severity matrix** (§3) before anything downstream launches | malformed or unreferenced surface; unratified matrix → the run does not proceed |
| **Detect** | lens agents, wide (§7) | Proof test that **compiles in the central combined build and FAILS**, uniquely namespaced so results self-attribute | doesn't compile → discard; passes → false alarm, logged |
| **Adjudicate** | oracle runs + tracer agents | **Bug card**: oracle evidence (or traced expected-behavior citation), severity class assigned from the ratified matrix (§3), detector-convergence count | oracle refutes → close as not-a-bug; intent ambiguous → **human queue, never guessed** (§8) |
| **Fix** | fixer agent, own isolated workspace | Commit where the proof test **passes**, touched suites green — **checked centrally, never self-certified** — plus the fixer's own new tests | central check disagrees → exact failure fed back to the session; ~2 stalls → fresh session on the same workspace; ~3 strikes → split the ticket or escalate |
| **Review-the-fix** | independent cold agent (§5) | **Verdict with evidence**: independently derived expected behavior, judgment that the diff achieves it, optionally extra probe tests. "LGTM" without evidence bounces the *review*, not the fix | REQUEST-CHANGES with concrete notes → back to fix |
| **Verify/regress** | orchestrator, serial (§6) | Applied onto the integration branch; proof test green + full touched suites green + oracle check clean where reachable | any regression → revert, bounce to fix with the failure |
| **Integrate** | orchestrator | Change landed with explicit scope; proof test now permanent; ledger updated | — |

**Bounces are normal, not exceptional.** Expect roughly 30% first-pass success from agent
sessions; the recovery ladder — feed the exact failure back, then a fresh session on the
same workspace, then split or escalate — raises completion to roughly 90%. Budget for the
loops.

One verification rule: **combine all agents' proof tests into a single build under unique
namespaces and attribute results by test name.** N parallel builds sharing a build cache
will silently serve one agent's binary to every other agent's run, and every result but
one becomes fiction.

## 5. Independence with identical models

Every agent is the same model, so independence cannot come from *who* reviews — it must
be manufactured from *what each session knows and is asked*. Four rules, enforced by the
dispatcher, not by trust:

1. **Never author-reviews-own-work.** The review is always a fresh cold session sharing
   no context with the fixer's session. Cold start *is* the isolation mechanism.
2. **The reviewer never sees the fixer's rationale.** It gets the surface spec, the proof
   test, and the diff — nothing the fixer wrote about them. The diff must stand on its
   own.
3. **Anti-anchoring.** The reviewer writes down expected behavior — from spec, docs, or
   oracle — *before* opening the diff. An identical model that derives the answer
   independently and then compares is a genuinely different measurement from one that
   reads the fix first and rationalizes it.
4. **Lens rotation.** The review lens differs from the lens that detected the bug, so the
   fix is probed from an angle its origin story didn't cover.

**Honest limit:** identical models share blind spots. A behavior the model *cannot
conceive as wrong* will pass fixer, reviewer, and detection panel alike. Only a non-model
oracle (§2) escapes this — which is why the oracle is what you prototype first (§10).

## 6. Allocating N agents: work-stealing with a bounded build neck

The economics: **detection is cheap and wide** (remote inference, near-zero local cost);
**builds and verification are the expensive serial resource** — the neck. The allocation
follows:

- Agents hold no fixed roles; they **pull tickets from a queue** — a durable ledger
  persisted on every append and stored outside any workspace that automation may reset,
  because a reset destroys unpersisted appends.
- **Pull priority drains downstream first**: review > fix > adjudicate > detect. This
  bounds work-in-progress — quality-first means finishing what's in flight before finding
  more — while detection soaks up all remaining slots because it's nearly free.
- **The orchestrator is not one of the N** and owns the neck: central verify/regress
  builds run strictly 1–2 chains at a time, with nothing else launching while a chain
  runs — overlapping build chains alongside live agents saturates the host.
- Early in a campaign the queue naturally skews toward detection; late it inverts.
  Allocation follows ready work, not a plan.

## 7. Detection: diverse adversarial lenses, scheduled by convergence

**A panel of narrow, adversarial, single-question lenses beats broad review.** A model
given one sharp question probes deeper than one asked to be generally vigilant, and
different questions surface different defects — so each detection agent gets exactly one
lens. The starting panel:

- **breaker** — assume the surface is broken; construct the input that proves it
- **spec-clause** — enumerate every documented contract clause; prove each one holds
- **error-path** — prove failure handling, including partial failure, matches the contract
- **invariant** — prove the properties the surface must preserve actually hold
- **boundary** — probe the extremes and edge conditions of every input
- **resource** — prove resource use is bounded, released, and steady under load

**The panel is parameterized by the ratified severity matrix (§3).** Categories the user
weighted heavily get dedicated lenses; categories weighted low lose their slots to lenses
that serve the matrix. The panel above is the floor the matrix reshapes, not a fixed
roster.

**Diversity beats repetition.** Replicating a lens mostly re-confirms known bugs;
*different* lenses find *different* bugs. Parallelism means many lenses across many
surfaces, not many reruns.

**Convergence is the scheduler.** Per surface: run one panel wave, dedupe findings into
clusters, compute overlap between lenses. "Done to depth" means a second,
differently-lensed wave adds ≤1 new cluster, or a capture-recapture estimate over the
lens-overlap counts puts the found fraction of the estimable defect pool at ≥~80%. Then
the detection budget moves on — breadth across surfaces over depth on any one.

**Bug cards are ordered by priority = severity × confidence, both defined once in §3.**
How alarming a bug sounds is not a ranking axis; the ratified matrix is.

## 8. Where the human sits

Four places, no more:

1. **Severity ratification at launch.** If the user supplied no severity matrix, the run
   pauses on the orchestrator's context-derived proposal (§3) until the user confirms or
   adjusts it. Nothing downstream runs against an unratified matrix.
2. **Approval gates.** All work accumulates on a single integration branch; nothing
   merges to a protected branch, and nothing ships, without explicit human approval.
3. **Intent calls.** When adjudication confirms a behavior is surprising but cannot tell
   whether it is *intended*, the ticket surfaces with its bug card for a human yes/no.
   The system never guesses intent. Batch these by pattern so they don't swamp the queue.
4. **Batch review.** Fixed-and-reviewed changes are grouped per surface (5–10 fixes) and
   presented in priority order (§3), each batch carrying its proof tests, bug cards, and
   review verdicts — so human review is *reading evidence*, not re-deriving it.

## 9. Success metric

**Coverage-to-convergence with evidence — not throughput.** The campaign is done when:
every registered surface has been detected to saturation (convergence rule met, estimate
recorded); every confirmed bug has a proof test that went failing→passing, an independent
fix-review PASS with cited evidence, and a clean oracle check where one reaches; and the
intent-ambiguous residue is enumerated for human decision. "We landed N fixes" is
explicitly not the metric — N fixes without the evidence chain is exactly the failure
mode this design exists to prevent.

## 10. Honest risks, and what to prototype first

- **Correlated blind spots** (one model everywhere). Mitigated by non-model oracles and
  lens diversity; not eliminated. State the residual risk in the final report rather than
  papering over it.
- **Oracles can be expensive or noisy.** Differential and replay-style oracles need
  normalization of legitimately-variable output; if the noise floor drowns the signal,
  the oracle degrades into a hint generator. Measure the noise floor before trusting the
  verdicts.
- **Proof tests can encode the detector's misunderstanding.** Adjudication against an
  oracle exists precisely for this; the residual case (test and adjudicator wrong the
  same way) is the blind-spot risk again.
- **Orchestrator attention is the true scarce resource.** The queue, the mechanical
  gates, and evidence-carrying tickets all exist to keep humans and the orchestrator out
  of per-item judgment. If the loop needs constant babysitting, the design has failed
  regardless of agent count.
- **Intent ambiguity can flood the human queue** on codebases with much deliberate quirk.
  Batch by pattern, never one-by-one.

**Prototype first: the strongest objective oracle the target admits.** It converts the
two most judgment-heavy, orchestrator-expensive stages (adjudication and
fix-verification) into machine checks, it is the only check outside the model's blind
spots, and it usually carries the most unknown setup cost — which is exactly why it goes
first. Acceptance test: within about a day of setup, it should re-confirm two
already-known bugs and demonstrate a quiet noise floor. If it does, build the loop around
it. If it cannot be made quiet, fall back to citation-based tracing for adjudication (§2)
— the loop survives, just slower and more judgment-bound.
