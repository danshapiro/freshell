/**
 * Classifies a `cargo test` log for the auto_resume e2e certification against
 * the accepted Mechanism-B waiver (test-flake-hardening run — accepted
 * residual, kata kmbs owns the production fix).
 *
 * Mechanism B is the pre-existing production defect where the auto-resume hub
 * settles a crashed fresh-agent terminal with `terminal.status{exited}`
 * carrying `reason="no_resumable_identity"` and never attempts a recovery.
 * The certification loop may waive an iteration ONLY when every failure has
 * that exact signature. Anything else blocks.
 *
 * The waiver (exact shape, enforced here — delta-review r6):
 *
 *  1. The failing test names must ALL be members of HARNESSED_TESTS (the two
 *     instrumented auto_resume_e2e tests). Any other failure — even alongside
 *     a signature match — blocks.
 *  2. Each failing test's stdout section must contain an ignored-frames ring
 *     entry that IS a settle frame:
 *     `type="terminal.status"`, `status="exited"`,
 *     `reason="no_resumable_identity"`, AND a `tid` (terminalId). The tid is
 *     mandatory: without it the settle frame cannot be correlated to the
 *     crashed terminal and the waiver cannot apply.
 *  3. ONLY-signature (delta-r8): EVERY `terminal.status{exited}` entry in the
 *     ring must carry `reason="no_resumable_identity"` — any exited entry
 *     with a different or missing reason blocks, for any terminal.
 *  4. Replacement/recovery guards (delta-r7 wire shapes): within the same
 *     section, NO ring entry may carry `type="terminal.replaced"` whose
 *     `tid`/`oldTid`/`newTid` names a settled terminal (real TerminalReplaced
 *     frames carry `oldTerminalId`/`newTerminalId`, never `terminalId`), and
 *     NO `terminal.status` entry with `status="recovering"` may carry a
 *     settled tid — recovery activity for the crashed terminal is not
 *     Mechanism B as accepted. Replaced entries about OTHER terminals never
 *     block; a `terminal.replaced` carrying NO identifier fields at all is
 *     uncorrelatable and conservatively blocks.
 *  5. Stage gate (delta-r9): the failure must be at each test's FIRST ws
 *     wait (FIRST_WAIT_BY_TEST). A later-stage failure proves an earlier
 *     wait already consumed same-terminal recovery frames — recovery began,
 *     so the no-recovery signature cannot apply even if the final ring is
 *     clean. An unreadable stage blocks.
 *
 * The ring renders through Rust Debug (`{ignored:?}`) with escaped quotes, so
 * the log is normalized (ANSI stripped, `\"` → `"`) before parsing.
 *
 * Usage: tsx scripts/classify-resume-waiver.ts <logfile>
 *   exit 0 = waive (exact Mechanism-B signature on every failure)
 *   exit 1 = block (the run must be investigated, not waived)
 *   exit 2 = no failure found (the run was green; nothing to waive)
 */

import { readFileSync } from 'node:fs'

export type ResumeWaiverVerdict = 'waive' | 'block' | 'no-failure'

export interface ResumeWaiverClassification {
  verdict: ResumeWaiverVerdict
  evidence: string[]
}

/** The two instrumented auto_resume_e2e tests the waiver may ever cover. */
export const HARNESSED_TESTS = new Set([
  'crashing_agent_is_resumed_twice_then_settles_exited',
  'reconcile_after_replacement_attaches_to_the_new_terminal',
])

/**
 * Delta-r9 stage gate: the waiver covers ONLY a failure at each test's FIRST
 * ws wait. `wait_frame_matching` returns matched frames — only non-matching
 * ones reach the ring — so reaching a LATER wait proves an earlier wait
 * already consumed a same-terminal recovery frame; that cross-stage tail
 * violates the no-recovery signature even when the final ring looks clean.
 * The stage is the panic text's awaited-frame description (both panic arms
 * carry it). Every live mechanism-B receipt so far failed at the FIRST wait
 * (e.g. task2-certify run 7 at `terminal.status{recovering}`), so the gate
 * costs nothing on the real defect.
 */
export const FIRST_WAIT_BY_TEST: Record<string, string> = {
  crashing_agent_is_resumed_twice_then_settles_exited: 'terminal.status{recovering}',
  reconcile_after_replacement_attaches_to_the_new_terminal: 'terminal.replaced',
}

const ANSI = /\[[0-9;]*m/g

interface RingEntry {
  raw: string
  attrs: Record<string, string>
}

function normalizeLog(raw: string): string {
  return raw.replace(ANSI, '').replace(/\\"/g, '"')
}

/** Caml cargo "failures:\n    <name>\n ..." summary block(s) → name set. */
function parseFailureNames(log: string): Set<string> {
  const names = new Set<string>()
  for (const m of log.matchAll(/^failures:\n((?:    \S[^\n]*\n)+)/gm)) {
    for (const line of m[1].split('\n')) {
      const name = line.trim()
      if (name && !name.startsWith('test result:')) names.add(name)
    }
  }
  return names
}

/** The per-failing-test stdout section between cargo's `---- name stdout ----`
 * header and the next `---- ... ----` header / failures summary / EOF. */
function extractStdoutSection(log: string, testName: string): string | null {
  const header = `---- ${testName} stdout ----`
  const start = log.indexOf(header)
  if (start < 0) return null
  const body = log.slice(start + header.length)
  const nextHeader = body.search(/^---- \S/m)
  const failuresTail = body.search(/^failures:$/m)
  let end = body.length
  if (nextHeader >= 0) end = Math.min(end, nextHeader)
  if (failuresTail >= 0) end = Math.min(end, failuresTail)
  return body.slice(0, end)
}

/** Ring entries: chunks split on `type="` boundaries, attrs parsed per chunk. */
function parseRingEntries(section: string): RingEntry[] {
  const entries: RingEntry[] = []
  const chunks = section.split(/(?=type="[a-z._-]+")/)
  for (const chunk of chunks) {
    if (!chunk.startsWith('type="')) continue
    const attrs: Record<string, string> = {}
    for (const am of chunk.matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[am[1]] = am[2]
    }
    // Entries are ring items separated by `", "` — truncate each chunk at it.
    const boundary = chunk.indexOf('", "')
    const raw = boundary < 0 ? chunk : chunk.slice(0, boundary)
    entries.push({ raw, attrs })
  }
  return entries
}

/** The awaited-frame description from the helper's panic, i.e. the stage at
 * which the test failed. Both panic arms carry it: the catch-all arm prints
 * `stream ended while waiting for {what}: {other:?}; ignored frames …` and
 * the deadline arm prints `{what} never arrived before the deadline; …`. */
function parseFailStage(section: string): string | null {
  const m =
    section.match(/stream ended while waiting for (.+?): .+?; ignored frames/) ??
    section.match(/([^\n]+?) never arrived before the deadline/)
  return m ? m[1].trim() : null
}

function blockOut(evidence: string[], why: string): ResumeWaiverClassification {
  evidence.push(`BLOCK: ${why}`)
  return { verdict: 'block', evidence }
}

export function classifyResumeWaiver(rawLog: string): ResumeWaiverClassification {
  const log = normalizeLog(rawLog)
  const evidence: string[] = []

  const names = parseFailureNames(log)
  if (names.size === 0) {
    if (/^test result: FAILED/m.test(log)) {
      return blockOut(evidence, 'log reports FAILED but no parseable `failures:` list — cannot establish the waiver scope')
    }
    evidence.push('no failed tests in log — nothing to waive')
    return { verdict: 'no-failure', evidence }
  }

  for (const name of names) {
    if (!HARNESSED_TESTS.has(name)) {
      return blockOut(evidence, `failing test \`${name}\` is outside the harnessed auto_resume_e2e pair — the waiver cannot cover it`)
    }
  }

  for (const name of names) {
    const section = extractStdoutSection(log, name)
    if (section === null) {
      return blockOut(evidence, `no \`---- ${name} stdout ----\` section — cannot verify the settle-frame signature`)
    }

    // delta-r9: stage gate BEFORE ring inspection (see FIRST_WAIT_BY_TEST).
    const stage = parseFailStage(section)
    if (!stage) {
      return blockOut(evidence, `\`${name}\`: cannot read the failure stage from the panic text — the waiver requires a first-wait failure`)
    }
    const firstWait = FIRST_WAIT_BY_TEST[name]
    if (stage !== firstWait) {
      return blockOut(
        evidence,
        `\`${name}\` failed waiting for "${stage}" — the waiver covers only the first ws wait ("${firstWait}"); a later stage proves an earlier wait already consumed same-terminal recovery frames`,
      )
    }

    const entries = parseRingEntries(section)

    const settles = entries.filter((e) =>
      e.attrs.type === 'terminal.status' &&
      e.attrs.status === 'exited' &&
      e.attrs.reason === 'no_resumable_identity',
    )
    if (settles.length === 0) {
      const reasons = entries
        .filter((e) => e.attrs.type === 'terminal.status' && e.attrs.status === 'exited')
        .map((e) => e.attrs.reason ?? '<none>')
      return blockOut(
        evidence,
        `\`${name}\`: no ignored-frames ring settle with reason="no_resumable_identity"` +
          (reasons.length ? ` (observed exited reasons: ${reasons.join(', ')})` : ' (no exited status frames in ring at all)'),
      )
    }
    const settleTids = settles.map((e) => e.attrs.tid)
    if (settleTids.some((t) => !t)) {
      return blockOut(evidence, `\`${name}\`: settle frame lacks terminalId — cannot correlate the settle to the crashed terminal`)
    }

    // delta-r8: the accepted signature is ONLY — every terminal.status{exited}
    // entry in the ring must carry reason="no_resumable_identity". A mixed
    // sequence (the waived reason alongside any other reason — or a
    // reason-less exited entry, which addition #5 already blocks — for ANY
    // terminal in the ring) is not Mechanism B as accepted.
    const foreignSettle = entries.find(
      (e) =>
        e.attrs.type === 'terminal.status' &&
        e.attrs.status === 'exited' &&
        e.attrs.reason !== 'no_resumable_identity',
    )
    if (foreignSettle) {
      return blockOut(
        evidence,
        `\`${name}\`: ring contains an exited settle with reason="${foreignSettle.attrs.reason ?? '<missing>'}" (tid=${foreignSettle.attrs.tid ?? '<none>'}) alongside the waivered signature — the accepted signature is ONLY no_resumable_identity settles`,
      )
    }

    evidence.push(`${name}: settle frame(s) ${settles.map((e) => e.raw).join(' | ')}`)

    for (const tid of settleTids) {
      // delta-r7: `terminal.replaced` carries oldTerminalId/newTerminalId,
      // NOT terminalId. The ring renders all three (tid / oldTid / newTid);
      // a replacement blocks when any of them names the settled terminal —
      // checking only `tid` would let a real recovery tail be waived.
      const replaced = entries.find(
        (e) =>
          e.attrs.type === 'terminal.replaced' &&
          (e.attrs.tid === tid || e.attrs.oldTid === tid || e.attrs.newTid === tid),
      )
      if (replaced) {
        return blockOut(evidence, `\`${name}\`: terminal.replaced observed for the settled terminal (${tid}) — recovery DID happen; not Mechanism B`)
      }
      const recovering = entries.find(
        (e) => e.attrs.type === 'terminal.status' && e.attrs.tid === tid && e.attrs.status === 'recovering',
      )
      if (recovering) {
        return blockOut(evidence, `\`${name}\`: terminal.status{recovering} observed for the settled terminal (${tid}) — a recovery attempt began; not Mechanism B`)
      }
    }

    // Conservative: a terminal.replaced carrying NO identifier fields at all
    // cannot be correlated either way, so it cannot be certified unrelated.
    const orphanReplaced = entries.find(
      (e) =>
        e.attrs.type === 'terminal.replaced' &&
        !e.attrs.tid &&
        !e.attrs.oldTid &&
        !e.attrs.newTid,
    )
    if (orphanReplaced) {
      return blockOut(evidence, `\`${name}\`: terminal.replaced entry carries no terminal identifiers — uncorrelatable, cannot be waived`)
    }
  }

  evidence.push(`every failure (${[...names].join(', ')}) matches the exact Mechanism-B signature — waiver applies`)
  return { verdict: 'waive', evidence }
}

function main(): void {
  const logPath = process.argv[2]
  if (!logPath) {
    console.error('usage: tsx scripts/classify-resume-waiver.ts <cargo-test-log>')
    process.exit(64)
  }
  const { verdict, evidence } = classifyResumeWaiver(readFileSync(logPath, 'utf8'))
  for (const line of evidence) console.log(line)
  console.log(`verdict: ${verdict}`)
  process.exit(verdict === 'waive' ? 0 : verdict === 'block' ? 1 : 2)
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main()
}
