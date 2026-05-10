#!/usr/bin/env tsx

import { execFile } from 'child_process'
import { promisify } from 'util'
import { pathToFileURL } from 'url'
import { classifySelfHostBranch, type SelfHostPolicyEnv } from '../shared/selfhost-branch-policy.js'

const execFileAsync = promisify(execFile)

export type LaunchBranchValidation =
  | { ok: true; branch: string }
  | { ok: false; message: string }

export async function getCurrentGitBranch(cwd: string = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export async function validateLaunchBranch(input: {
  env: SelfHostPolicyEnv
  getBranch?: () => Promise<string | undefined>
}): Promise<LaunchBranchValidation> {
  const branch = await (input.getBranch ?? (() => getCurrentGitBranch()))()
  const result = classifySelfHostBranch({ branch, env: input.env })
  if (result.ok === true) return { ok: true, branch: branch ?? result.expectedBranch }
  return { ok: false, message: result.message }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (command !== 'validate-launch') {
    console.error('Usage: tsx scripts/selfhost-branch.ts validate-launch')
    return 2
  }

  const result = await validateLaunchBranch({ env: process.env })
  if (result.ok === false) {
    console.error(result.message)
    return 1
  }

  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
