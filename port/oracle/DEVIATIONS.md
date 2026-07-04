# Deviation ledger — where the port INTENTIONALLY differs from the original

User directive: **fix bugs as found; do not replicate bug-for-bug.** Therefore
the port is behavior-equivalent to the original EXCEPT for the entries below.
The oracle whitelists exactly these diffs (by fingerprint); any *unlisted*
old-vs-new divergence is always a failure (a port defect to fix).

## Entry rules (enforced by the antagonist reviewer, not the implementer)

An entry may be added ONLY when the original is **objectively defective** — one
of: panics/crashes/errors, resource leak, violates the WS protocol schema,
contradicts documented behavior (AGENTS.md / docs / lab-notes), corrupts data,
or breaks an invariant the code itself asserts. Aesthetic preference is NOT a
defect and must be rejected as scope creep.

Every entry requires:
- **id**: DEV-NNNN
- **objective_defect**: which bar above, with evidence (`file:line`, error, or
  schema/doc citation)
- **original_behavior**: what freshell does today
- **port_behavior**: the corrected behavior
- **fingerprint**: how the differ recognizes this specific diff (tier + matcher)
- **pinning_test**: path to the new positive test asserting the fixed behavior
- **adjudicated_by**: antagonist-reviewer session id
- **status**: proposed | accepted | rejected

## Ledger

_No behavioral deviations accepted yet._

<!--
Template:

### DEV-0001 — <short title>
- objective_defect: <bar> — <evidence file:line>
- original_behavior: <...>
- port_behavior: <...>
- fingerprint: T<0-3> / <matcher>
- pinning_test: <path>
- adjudicated_by: <session id>
- status: proposed
-->

## Related non-behavioral fix (test infrastructure, already landed)

Not a behavioral deviation, recorded here for traceability only: the
`test:real:coding-cli-contracts` launcher set the wrong env var and was a silent
no-op; fixed on this branch with a regression test. This changed test tooling,
not freshell's runtime behavior, so it needs no oracle whitelist.
