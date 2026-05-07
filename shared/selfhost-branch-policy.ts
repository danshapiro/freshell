export type SelfHostPolicyEnv = {
  FRESHELL_SELFHOST_BRANCH?: string
  SKIP_UPDATE_CHECK?: string
}

export type SelfHostBranchResult =
  | { ok: true; expectedBranch: string }
  | { ok: false; code: 'mirror-branch' | 'unexpected-branch' | 'unknown-branch'; message: string }

export function getExpectedSelfHostBranch(env: SelfHostPolicyEnv): string {
  const configured = env.FRESHELL_SELFHOST_BRANCH?.trim()
  if (!configured || configured === 'main') return 'dev'
  return configured
}

export function classifySelfHostBranch(input: {
  branch: string | undefined
  env: SelfHostPolicyEnv
}): SelfHostBranchResult {
  const expectedBranch = getExpectedSelfHostBranch(input.env)
  const branch = input.branch?.trim()

  if (!branch) {
    return {
      ok: false,
      code: 'unknown-branch',
      message: `Could not determine the current Git branch. Switch to '${expectedBranch}' before self-hosting.`,
    }
  }

  if (branch === 'main') {
    return {
      ok: false,
      code: 'mirror-branch',
      message: `Refusing to self-host from local 'main'. Local 'main' must mirror 'origin/main'. Switch to '${expectedBranch}' or set FRESHELL_SELFHOST_BRANCH.`,
    }
  }

  if (branch === expectedBranch) {
    return { ok: true, expectedBranch }
  }

  return {
    ok: false,
    code: 'unexpected-branch',
    message: `Refusing to self-host from '${branch}'. Expected '${expectedBranch}'. Set FRESHELL_SELFHOST_BRANCH only if the user explicitly chose another integration branch.`,
  }
}

export function shouldSkipSourceUpdateForBranch(input: {
  branch: string | undefined
  env: SelfHostPolicyEnv
}): boolean {
  if (input.env.SKIP_UPDATE_CHECK === 'true') return true
  const branch = input.branch?.trim()
  if (!branch) return true
  return branch !== 'main'
}
