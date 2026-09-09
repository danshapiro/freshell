/**
 * Argument parsing for the cumulative managed-runtime gate.
 *
 * Kept separate from `runtime-gate.ts` because that module runs the gate on
 * import; the parsing rules must stay unit-testable without touching Docker.
 */
import type { GateMode } from './provider-certification.js'

export type GatePhase = 'phase-1' | 'phase-2' | 'phase-3' | 'phase-4' | 'phase-5'

export const GATE_PHASES: GatePhase[] = ['phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5']

export const GATE_USAGE =
  'usage: npm run test:runtime -- gate <phase-1|phase-2|phase-3|phase-4|phase-5|landing> [--mode landing|production] --require-live'

export type ParsedGateArgs =
  | { phase: GatePhase; mode: GateMode }
  | { error: string; exitCode: 1 | 2 }

/**
 * `gate landing` is sugar for the cumulative phase-5 body in landing mode.
 * Every other target defaults to production mode, so an operator who forgets
 * the flag gets the strict gate rather than the permissive one.
 */
export function parseGateArgs(args: string[]): ParsedGateArgs {
  if (args[0] !== 'gate') return { error: GATE_USAGE, exitCode: 1 }
  const target = args[1]
  let phase: GatePhase
  let mode: GateMode = 'production'
  if (target === 'landing') {
    phase = 'phase-5'
    mode = 'landing'
  } else if (GATE_PHASES.includes(target as GatePhase)) {
    phase = target as GatePhase
  } else {
    return { error: GATE_USAGE, exitCode: 1 }
  }
  let requireLive = false
  let explicitMode = false
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--require-live' && !requireLive) {
      requireLive = true
    } else if (option === '--mode' && !explicitMode) {
      const value = args[++index]
      if (value !== 'landing' && value !== 'production') return { error: GATE_USAGE, exitCode: 1 }
      mode = value
      explicitMode = true
    } else {
      // Unknown or repeated options are errors, not ignored instructions.
      // In particular, do not accept two contradictory --mode values.
      return { error: GATE_USAGE, exitCode: 1 }
    }
  }
  if (!requireLive) {
    return {
      error: `BLOCKED: ${target} may only pass through the live Docker/IPC gate; add --require-live.`,
      exitCode: 2,
    }
  }
  return { phase, mode }
}
