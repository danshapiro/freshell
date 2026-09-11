import { runVerification } from './runtime-verify.js'
import { pathToFileURL } from 'node:url'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV,
  parseFreshAgentQualificationModes,
} from './fresh-agent-qualification-selection.js'

export const FRESH_AGENT_QUALIFICATION_LIVE_ENV =
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE'

export function selectedFreshAgentModeFromArgs(args: readonly string[]): string {
  const values = args[0] === '--mode' ? args.slice(1) : args
  if (values.length !== 1) {
    throw new Error('usage: npm run test:runtime:fresh-agent-qualification -- --mode freshclaude|kilroy|freshcodex|freshopencode')
  }
  const selected = parseFreshAgentQualificationModes(values[0])
  if (selected.length !== 1) {
    throw new Error('fresh-agent qualification producer requires exactly one mode')
  }
  return selected[0]
}

export async function runSelectedFreshAgentQualification(args = process.argv.slice(2)): Promise<number> {
  const selected = selectedFreshAgentModeFromArgs(args)
  return runVerification({ only: ['fresh-agent-qualification'] }, { [FRESH_AGENT_QUALIFICATION_MODES_ENV]: selected })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runSelectedFreshAgentQualification()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
