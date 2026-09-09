/** Keep progressive implementation gates distinct from final release certification. */
import type { GateMode } from './provider-certification.js'
import { GATE_PHASES, type GatePhase } from './runtime-gate-args.js'

export type PhaseCertificationScope = {
  required: boolean
  gateId: string
  caseIds: string[]
  artifactNames: string[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function names(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((name) => typeof name !== 'string' || !name.trim())
    || new Set(value).size !== value.length) throw new Error(`${label} must be a nonempty unique string set`)
  return value as string[]
}

export function certificationScopeForPhase(
  certification: unknown,
  phase: GatePhase,
  mode: GateMode,
): PhaseCertificationScope {
  const contract = record(certification, 'certification contract')
  const modeContract = record(record(contract.modes, 'certification modes')[mode], 'certification mode')
  const firstPhase = modeContract.cumulative_phase
  if (!GATE_PHASES.includes(firstPhase as GatePhase)) throw new Error('certification phase is not implemented')
  if (typeof modeContract.id !== 'string' || !modeContract.id.trim()) throw new Error('certification gate id is missing')
  const caseIds = names(contract.provider_certification_case_ids, 'certification case IDs')
  const artifactNames = names(contract.required_artifacts, 'certification artifacts')
  const required = GATE_PHASES.indexOf(phase) >= GATE_PHASES.indexOf(firstPhase as GatePhase)
  return {
    required,
    gateId: required ? modeContract.id : phase,
    caseIds: required ? [...caseIds] : [],
    artifactNames: required ? [...artifactNames] : [],
  }
}
