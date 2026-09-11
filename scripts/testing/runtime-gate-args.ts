/** Direct deterministic runtime scenarios; no release/certification mode. */
export type GatePhase = 'phase-1' | 'phase-2' | 'phase-3' | 'phase-4' | 'phase-5'
export const GATE_PHASES: GatePhase[] = ['phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5']
export const GATE_USAGE = 'usage: npm run test:runtime -- gate <phase-1|phase-2|phase-3|phase-4|phase-5> --require-live [--case P5-G06] [--list]'
export type ParsedGateArgs = { phase: GatePhase; only?: string; list: boolean } | { error: string; exitCode: 1 | 2 }
export function parseGateArgs(args: string[]): ParsedGateArgs {
  if (args[0] !== 'gate' || !GATE_PHASES.includes(args[1] as GatePhase)) return { error: GATE_USAGE, exitCode: 1 }
  let live = false, list = false
  let only: string | undefined
  for (let i=2;i<args.length;i++) {
    if (args[i] === '--require-live' && !live) live = true
    else if (args[i] === '--list' && !list) list = true
    else if (args[i] === '--case' && !only && /^P[1-5]-G\d{2}$/.test(args[i+1] ?? '')) only = args[++i]
    else return { error: GATE_USAGE, exitCode: 1 }
  }
  if (!live && !list) return { error: 'Docker scenarios require explicit --require-live; nothing was run.', exitCode: 2 }
  return { phase: args[1] as GatePhase, ...(only ? { only } : {}), list }
}
