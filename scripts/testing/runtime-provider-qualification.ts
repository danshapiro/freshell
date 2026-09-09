import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import {
  QUALIFICATION_PROVIDER_SELECTION_ENV,
  parseQualificationProviderSelection,
} from './provider-qualification-selection.js'

const LIVE_ENV = 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE'
const SPEC = 'test/e2e-browser/specs/runtime-managed-provider-qualification-rust.spec.ts'

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

export function runSelectedProviderQualification(args = process.argv.slice(2)): void {
  const provider = selectedProviderFromArgs(args)
  execFileSync('npm', [
    'run', 'test:e2e:local', '--', '--project=rust-chromium', SPEC,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [LIVE_ENV]: '1',
      [QUALIFICATION_PROVIDER_SELECTION_ENV]: provider,
    },
    stdio: 'inherit',
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSelectedProviderQualification()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
