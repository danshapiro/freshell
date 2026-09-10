import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV,
  parseFreshAgentQualificationModes,
} from './fresh-agent-qualification-selection.js'

export const FRESH_AGENT_QUALIFICATION_LIVE_ENV =
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE'
const SPEC = 'test/e2e-browser/specs/runtime-fresh-agent-qualification-rust.spec.ts'

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

export function runSelectedFreshAgentQualification(args = process.argv.slice(2)): void {
  const mode = selectedFreshAgentModeFromArgs(args)
  execFileSync('npm', [
    'run', 'test:e2e:local', '--', '--project=rust-chromium', SPEC,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [FRESH_AGENT_QUALIFICATION_LIVE_ENV]: '1',
      [FRESH_AGENT_QUALIFICATION_MODES_ENV]: mode,
    },
    stdio: 'inherit',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSelectedFreshAgentQualification()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
