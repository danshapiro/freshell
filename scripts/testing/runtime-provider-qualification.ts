import { runVerification } from './runtime-verify.js'
import { pathToFileURL } from 'node:url'

import {
  QUALIFICATION_PROVIDER_SELECTION_ENV,
  parseQualificationProviderSelection,
} from './provider-qualification-selection.js'


export function selectedProviderFromArgs(args: readonly string[]): string {
  const values = args[0] === '--provider' ? args.slice(1) : args
  if (values.length !== 1) {
    throw new Error('usage: npm run test:runtime:provider-qualification -- --provider claude|codex|opencode|amplifier')
  }
  const selected = parseQualificationProviderSelection(values[0])
  if (selected.length !== 1) {
    throw new Error('provider qualification producer requires exactly one provider')
  }
  return selected[0]
}

export async function runSelectedProviderQualification(args = process.argv.slice(2)): Promise<number> {
  const selected = selectedProviderFromArgs(args)
  return runVerification({ only: ['managed-provider-qualification'] }, { [QUALIFICATION_PROVIDER_SELECTION_ENV]: selected })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runSelectedProviderQualification()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
