# Parallel Agent Bug-Fix System — closed-loop quality at scale

**The problem this solves:** you have a codebase, a large supply of identical-model coding
agents, and a mandate: *find and fix the bugs to a high quality bar, with every fix
independently reviewed before it lands.* Agents are cheap and plentiful; trust is not. An
agent's claim — "found a bug," "fixed it," "looks good" — is worth nothing by itself.
This design turns claims into evidence at every stage, so N agents can run in parallel
without N agents' worth of human babysitting. Quality is the primary objective; speed is
second.

The principles below were measured in real multi-agent campaigns (lens-panel experiments,
capture-recapture data, build-contention incidents). They are stated here as general
rules, not anecdotes.

---

## 1. The golden thread: one proof test spans the whole loop

The single load-bearing idea: **a failing proof test — an executable test in the
project's own language and toolchain that fails against the current code — is the one
artifact that carries a defect through every stage.**

- **Detection** produces it: a finding *exists* only as a proof test that FAILS against
  current code. This rule alone is the noise filter — in calibration it reduced false
  alarms to near zero with no human triage.
- **Adjudication** validates it: the test is a *candidate* until an objective oracle (§2)
  confirms the behavior is actually wrong, not intended.
- **The fix** is defined by it: the fixer's acceptance criterion is mechanical — *this*
  test goes green and everything else stays green.
- **The fix-review** is anchored by it: the reviewer doesn't ask "is this nice code?" but
  "does this change make *this* proof pass for the *right* reason, matching expected
  behavior I derived myself?"
- **Integration** keeps it forever: the proof test lands with the fix as permanent
  regression coverage.

One artifact, zero translation loss between stages, and every gate becomes checkable by
machine rather than by vibes. Everything else in this design is scaffolding around this
thread.

## 2. The objective oracle: deciding bug-or-not without model judgment

An **oracle** is any mechanism that classifies a behavior as a defect *without asking a
model to judge*. Common oracles, roughly strongest-first:

- a proof test asserting an explicit, documented spec or contract clause
- a crash, panic, hang, or assertion failure
- a property/invariant violation (round-trip, idempotence, ordering, resource cleanup)
- a regression of an existing passing test
- schema/contract validation failure at a boundary
- a differential comparison against an alternate implementation — a prior version, a
  legacy port source, a competing library — *if the project happens to have one*. This is
  one plug-in oracle among several, never the backbone; where it exists it can also raise
  a bug's severity within the launch-time matrix (§3), since confirmed divergence from a
  trusted reference is strong evidence.

The oracle is load-bearing for two reasons: it de-judgments the two most expensive stages
(adjudication and fix-verification), and it is the **only check in the system that does
not share the model's blind spots** (§5). Each project configures the oracles it actually
has; where no strong oracle reaches a surface, adjudication falls back to an agent
tracing expected behavior from spec/docs with citations — the loop survives, just slower
and more judgment-bound.

## 3. Severity: a launch-time input

Severity is **configuration the user supplies at launch, not a law of the system**. What
counts as a bad bug depends entirely on what the code is for: an internet-exposed service
ranks security exposure at the top; an offline batch script may rank it near the bottom; a
rendering library may care most about silently incorrect output. One calibration campaign
deliberately excluded security from its ranking because the target's situation made it a
non-goal — the same category would head the matrix for an exposed service. No hardcoded
ordering survives contact with a second codebase, so this system does not have one.

**The severity matrix** — the bug categories that matter for *this* target and their
relative weight/ordering — **is a launch-time parameter.** Every downstream consumer
references this one matrix and defines no ranking of its own: lens-panel composition
(§7), the severity class assigned to each bug card at adjudication (§4), fix-queue
ordering and batching (§7, §8). This section is the single authority.

**If the user does not supply a matrix, the system asks — it never proceeds silently on a
default.** During the map stage, before any detection launches, the orchestrator inspects
whatever context it has — the codebase itself, its stated domain and purpose, its docs
and configuration, its dependencies, its exposure (a network-facing service? a security
tool? an internal script? a library other code consumes?) — and **proposes a tailored
matrix with a rationale for each ranking**, derived from that context rather than
boilerplate. The user confirms or adjusts; the run does not advance past map until the
matrix is ratified. This is a human gate at launch (§8).

**The default starting matrix** is the seed the orchestrator adapts from when building
its proposal — a starting point the user ratifies, never a silent fallback:

| Category | Typical contents |
|---|---|
| **security** | unauthorized access, data exposure, injection, privilege escalation |
| **crash / hang** | panics, deadlocks, unrecoverable states |
| **data loss / corruption** | anything that silently writes, drops, or mangles data |
| **incorrect behavior** | wrong results, contract violations, user-visible surprises |
| **resource / performance** | leaks, unbounded growth, degradation under load |
| **cosmetic** | formatting, messages, non-functional polish |

Security is deliberately in the default precisely *because* its weight varies most across
targets: it must be ranked explicitly per run — top for an exposed service, low for an
offline tool — never assumed high, and never omitted without the user saying so.

**Severity and confidence are orthogonal; priority is their product.** *Severity* is the
impact class a confirmed bug draws from the ratified matrix. *Confidence* is how sure the
system is the bug is real: detector convergence (independent lenses finding the same
cluster) plus oracle strength (§2). **Priority = severity (from the matrix) ×
confidence.** Any stage that orders work uses this product; no stage redefines either
axis.

## 4. The closed loop: stages and gates

Work flows through seven stages: **map → detect → adjudicate → fix → review-the-fix →
verify/regress → integrate**, with an evidence gate between each. The unit of work is a
**behavioral surface** — an endpoint, a module contract, a message type, a user flow,
however the target naturally decomposes — never a file, because defects cross files.

| Stage | Who | Gate artifact to ADVANCE | Bounce condition |
|---|---|---|---|
| **Map** | orchestrator, once | Surface registry entry: ID, spec/docs pointers, which oracles reach it — plus a **ratified severity matrix** (§3) before anything downstream launches | malformed or unreferenced surface; unratified matrix → the run does not proceed |
| **Detect** | lens agents, wide (§7) | Proof test that **compiles in the central combined build and FAILS**, uniquely namespaced so results self-attribute | doesn't compile → discard; passes → false alarm, logged |
| **Adjudicate** | oracle runs + tracer agents | **Bug card**: oracle evidence (or traced expected-behavior citation), severity class assigned from the launch-time matrix (§3), detector-convergence count | oracle refutes → close as not-a-bug; intent ambiguous → **human queue, never guessed** (§8) |
| **Fix** | fixer agent, own isolated workspace | Commit where the proof test **passes**, touched suites green — **checked centrally, never self-certified** — plus the fixer's own new tests | central check disagrees → exact failure fed back to the session; ~2 stalls → fresh session on the same workspace; ~3 strikes → split the ticket or escalate |
| **Review-the-fix** | independent cold agent (§5) | **Verdict with evidence**: independently derived expected behavior, judgment the diff achieves it, optionally extra probe tests. "LGTM" without evidence bounces the *review*, not the fix | REQUEST-CHANGES with concrete notes → back to fix |
| **Verify/regress** | orchestrator, serial (§6) | Applied onto the integration branch; proof test green + full touched suites green + oracle check clean where reachable | any regression → revert, bounce to fix with the failure |
| **Integrate** | orchestrator | Change landed with explicit scope; proof test now permanent; ledger updated | — |

**Bounces are normal, not exceptional.** Measured first-pass agent success is ~30%; the
recovery ladder — feed the exact failure back, then a fresh session on the same
workspace, then split or escalate — raises completion to ~90%. Budget for the loops.

One verification rule, paid for in incidents: **combine all agents' proof tests into a
single build under unique namespaces and attribute results by name.** Never run N
parallel builds sharing a build cache — stale cached artifacts will silently serve one
agent's binary to every other agent's run, and every result but one becomes fiction.

## 5. Independence with identical models

Every agent is the same model, so independence cannot come from *who* reviews — it must
be manufactured from *what each session knows and is asked*. Four rules, enforced by the
dispatcher, not by trust:

1. **Never author-reviews-own-work.** The review is always a fresh cold session sharing
   no context with the fixer's session. Cold start *is* the isolation mechanism.
2. **The reviewer never sees the fixer's rationale.** It gets the surface spec, the proof
   test, and the diff — not the fixer's notes, commit-message reasoning, or transcript.
   The diff must stand on its own.
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
**builds and verification are the expensive serial resource** (the "neck"). The
allocation follows:

- Agents hold no fixed roles; they **pull tickets from a queue** — a durable ledger,
  persisted on every append (appends left sitting in a workspace that automation may
  reset *will* be destroyed; this was learned the hard way).
- **Pull priority drains downstream first**: review > fix > adjudicate > detect. This
  bounds work-in-progress — quality-first means finishing what's in flight before finding
  more — while detection soaks up all remaining slots because it's nearly free.
- **The orchestrator is not one of the N** and owns the neck: central verify/regress
  builds run strictly 1–2 chains at a time, with nothing else launching while a chain
  runs (overlapping build chains with live agents produced the worst load incident of the
  calibration campaigns).
- Early campaign the queue naturally skews toward detection; late campaign it inverts.
  Allocation follows ready work, not a plan.

Illustrative steady state at N=32: ~14 detection, ~3 adjudication, ~7 fixers (own
workspaces, builds serialized through a shared warm cache), ~5 cold fix-reviewers, ~1
oracle operator, ~2 recovery loops on stuck tickets.

## 7. Detection: diverse adversarial lenses, scheduled by convergence

**A panel of narrow, adversarial, single-question lenses beats broad review.** Measured
head-to-head, "review this for defects" was the *worst* performer; narrow lenses carried
the panel, and a small set of them reproduced everything the full panel found. A generic
starting panel:

- **breaker** — assume it's broken; construct inputs that make it fail
- **spec-clause** — enumerate every documented contract clause; prove each one holds
- **error-path** — wrong status/exception/error shape; failure handling; partial failures
- **invariant/property** — round-trips, idempotence, ordering, state and resource cleanup
- **boundary** — empty, huge, malformed, unicode, negative, concurrent inputs
- **resource/perf** — leaks, unbounded growth, blocking on hot paths

**The panel is parameterized by the launch-time severity matrix (§3).** Categories the
user weighted heavily get dedicated lenses; categories weighted low are dropped. If
security ranks high, a security/abuse lens (unauthorized access, injection, privilege
boundaries) joins the panel; if it ranks low, that slot goes to another lens. Likewise a
high resource/performance weight earns extra resource-lens slots. The list above is the
floor the matrix reshapes, not a fixed roster.

**Diversity beats repetition.** Replicating a lens mostly re-confirms known bugs;
*different* lenses find *different* bugs. Parallelism should mean many lenses and many
surfaces, not many reruns.

**Convergence is the scheduler.** Per surface: run one panel wave, dedupe findings into
clusters, compute overlap between lenses. "Done to depth" means a second,
differently-lensed wave adds ≤1 new cluster, or a capture-recapture estimate (e.g. Chao1
on the overlap counts) says ≥~80% of the estimable defect pool is found — typically ~2
waves. Then the detection budget moves on. Breadth across surfaces over depth on any one.

**Bug cards are ordered by priority = severity × confidence (§3):** the severity class
adjudication assigned from the user's ratified matrix, times confidence (detector
convergence plus oracle strength). Within whatever matrix the user ratified, generic
severity *raisers* apply: silent failure, anything that writes data, user-visible
contract violations — and, where a trusted alternate implementation exists, confirmed
divergence from it (§2). How *alarming* a bug sounds is not a ranking axis; the user's
ratified matrix is.

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
   presented in priority order (severity × confidence, §3), each batch carrying its proof
   tests, bug cards, and review verdicts — so human review is *reading evidence*, not
   re-deriving it.

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
  lens diversity; not eliminated. State the residual risk in the final report — don't
  paper over it.
- **Oracles can be expensive or noisy.** Differential and replay-style oracles need
  normalization of legitimately-variable output (timestamps, IDs, ports); if the noise
  floor drowns the signal, the oracle degrades into a hint generator. Measure before
  trusting.
- **Proof tests can encode the detector's misunderstanding.** Adjudication against an
  oracle exists precisely for this; the residual case (test and adjudicator wrong the
  same way) is the blind-spot risk again.
- **Orchestrator attention is the true scarce resource.** The queue, the mechanical
  gates, and evidence-carrying tickets all exist to keep humans and the orchestrator out
  of per-item judgment. If the loop needs constant babysitting, the design has failed
  regardless of agent count.
- **Intent ambiguity can flood the human queue** on codebases with lots of deliberate
  quirk. Batch by pattern, never one-by-one.

**Prototype first: the strongest objective oracle the target admits.** It is the
component that converts the two most judgment-heavy, orchestrator-expensive stages
(adjudication and fix-verification) into machine checks, the only check outside the
model's blind spots — and usually the component with the most unknown setup cost, which
is exactly why it goes first. Acceptance test: within about a day of setup, it should
re-confirm two already-known bugs and demonstrate a quiet noise floor. If it does, build
the loop around it. If it can't be made quiet, fall back to citation-based tracing for
adjudication — the loop survives, just slower and more judgment-bound.
