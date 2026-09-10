import fs from 'node:fs'

import {
  validateFreshAgentQualificationReceipt,
  type FreshAgentQualificationRow,
} from './fresh-agent-qualification-receipt.js'
import {
  freshAgentReleaseScopeViolations,
  releasedFreshAgentModes,
  type CapabilityManifest,
} from './provider-certification.js'

export const PHASE3_FRESH_AGENT_RECEIPT_ENV = 'FRESHELL_RUNTIME_PHASE3_FRESH_AGENT_RECEIPT'
export const PHASE5_FRESH_AGENT_RECEIPT_ENV = 'FRESHELL_RUNTIME_PHASE5_FRESH_AGENT_RECEIPT'

export type ReleasedFreshAgentReceiptInput = {
  manifest: CapabilityManifest
  repoRoot: string
  candidateSha: string
  runtimeImage: string
  raw: string | undefined
  envName: string
}

/**
 * Resolve only release-enabled fresh modes. Disabled modes neither borrow a
 * terminal-provider row nor become an implied PASS. If a receipt is supplied
 * while every mode is disabled, reject it so a cumulative summary cannot
 * accidentally count preliminary qualification as release certification.
 */
export function releasedFreshAgentReceiptRows(
  input: ReleasedFreshAgentReceiptInput,
): FreshAgentQualificationRow[] {
  const structural = freshAgentReleaseScopeViolations(input.manifest, [])
  if (structural.length) throw new Error(`fresh-agent release scope is invalid: ${structural.join('; ')}`)
  const enabled = releasedFreshAgentModes(input.manifest).map((row) => row.mode)
  if (enabled.length === 0) {
    if (isSuppliedReceipt(input.raw)) {
      const receipt = readReceipt(input.raw!, input.envName)
      const passed = Array.isArray(receipt?.rows)
        ? receipt.rows.map((row: any) => row?.mode).filter((mode: unknown): mode is string => typeof mode === 'string')
        : []
      const violations = freshAgentReleaseScopeViolations(input.manifest, passed)
      if (violations.length) throw new Error(violations.join('; '))
      throw new Error(`${input.envName} was supplied even though no fresh-agent mode is enabled in release scope`)
    }
    return []
  }
  if (!isSuppliedReceipt(input.raw)) {
    throw new Error(`${input.envName} is required for release-enabled fresh modes: ${enabled.join(',')}`)
  }
  const receipt = readReceipt(input.raw!, input.envName)
  const validated = validateFreshAgentQualificationReceipt({
    repoRoot: input.repoRoot,
    candidateSha: input.candidateSha,
    expectedRuntimeImage: input.runtimeImage,
    receipt,
  })
  const passed = validated.rows.map((row) => row.mode)
  const violations = freshAgentReleaseScopeViolations(input.manifest, passed)
  if (violations.length) throw new Error(violations.join('; '))
  if (JSON.stringify(passed) !== JSON.stringify(enabled)) {
    throw new Error(`fresh-agent receipt modes ${JSON.stringify(passed)} do not exactly match release scope ${JSON.stringify(enabled)}`)
  }
  return validated.rows
}

function isSuppliedReceipt(raw: string | undefined): boolean {
  if (!raw?.trim()) return false
  if (raw.trim().startsWith('{')) return true
  try { return fs.statSync(raw).isFile() } catch { return false }
}

function readReceipt(raw: string, envName: string): any {
  try {
    return JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'))
  } catch (error) {
    throw new Error(`${envName} is not valid JSON or a readable JSON path: ${String(error)}`)
  }
}
