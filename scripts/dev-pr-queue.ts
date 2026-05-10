#!/usr/bin/env tsx

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const REPO = 'danshapiro/freshell'
const PR_JSON_FIELDS = 'number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,title,labels'
const EXCLUDED_LABELS = new Set([
  'do-not-merge',
  'superseded',
  'approval-artifact',
  'approval-artifact-only',
])

export type DevQueuePr = {
  number: number
  state: 'OPEN' | 'CLOSED' | string
  isDraft: boolean
  baseRefName: string
  headRefOid: string
  mergeStateStatus: string
  title: string
  labels: Array<{ name: string }>
}

export type DevQueuePlanStep = {
  label: string
  command: string[]
}

export type DevQueuePlan = {
  originMain: string
  steps: DevQueuePlanStep[]
}

export type DevQueueCommandRunner = (command: string, args: string[]) => Promise<string>

export function parsePrList(input: string): number[] {
  const prs = input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))

  if (prs.length === 0 || prs.some((number) => !Number.isInteger(number) || number <= 0)) {
    throw new Error('At least one PR number is required, formatted like 321,309,319.')
  }

  return prs
}

export function buildPrMetadataCommand(number: number): [string, string[]] {
  return [
    'gh',
    [
      'pr',
      'view',
      String(number),
      '--repo',
      REPO,
      '--json',
      PR_JSON_FIELDS,
    ],
  ]
}

export async function loadPrMetadata(
  numbers: number[],
  run: DevQueueCommandRunner,
): Promise<DevQueuePr[]> {
  const prs: DevQueuePr[] = []
  for (const number of numbers) {
    const [command, args] = buildPrMetadataCommand(number)
    const stdout = await run(command, args)
    try {
      prs.push(JSON.parse(stdout) as DevQueuePr)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to parse gh metadata for PR #${number}: ${message}`)
    }
  }
  return prs
}

function validatePrForDev(pr: DevQueuePr): void {
  if (pr.state !== 'OPEN') {
    throw new Error(`PR #${pr.number} is ${pr.state}, expected OPEN.`)
  }
  if (pr.isDraft) {
    throw new Error(`PR #${pr.number} is draft and is not pending for dev.`)
  }
  if (pr.baseRefName !== 'main') {
    throw new Error(`PR #${pr.number} targets ${pr.baseRefName}, expected main.`)
  }

  const excludedLabel = pr.labels.find((label) => EXCLUDED_LABELS.has(label.name.toLowerCase()))
  if (excludedLabel) {
    throw new Error(`PR #${pr.number} is labeled ${excludedLabel.name} and is not pending for dev.`)
  }
}

export function buildDevQueuePlan(input: {
  originMain: string
  requestedPrs: number[]
  prs: DevQueuePr[]
}): DevQueuePlan {
  const byNumber = new Map(input.prs.map((pr) => [pr.number, pr]))

  for (const number of input.requestedPrs) {
    const pr = byNumber.get(number)
    if (!pr) {
      throw new Error(`PR #${number} was not found.`)
    }
    validatePrForDev(pr)
  }

  const steps: DevQueuePlanStep[] = [
    { label: 'fetch-origin-main', command: ['git', 'fetch', 'origin', 'main'] },
    { label: 'reset-dev-to-origin-main', command: ['git', 'reset', '--hard', input.originMain] },
  ]

  for (const number of input.requestedPrs) {
    steps.push({
      label: `fetch-pr-${number}`,
      command: ['git', 'fetch', 'origin', `+refs/pull/${number}/head:refs/remotes/pr/${number}`],
    })
    steps.push({
      label: `merge-pr-${number}`,
      command: ['git', 'merge', '--no-ff', '--no-edit', `refs/remotes/pr/${number}`],
    })
  }

  return { originMain: input.originMain, steps }
}

export async function assertAssemblePreconditions(input: {
  getBranch: () => Promise<string | undefined>
  getStatus: () => Promise<string>
}): Promise<void> {
  const branch = await input.getBranch()
  if (branch !== 'dev') {
    throw new Error(`Refusing to assemble dev from ${branch ?? 'an unknown branch'}. Switch to dev first.`)
  }

  const status = await input.getStatus()
  if (status.trim()) {
    throw new Error('Refusing to reset dev with a dirty worktree. Commit, stash, or discard local changes first.')
  }
}

export async function executeDevQueuePlan(
  plan: DevQueuePlan,
  run: DevQueueCommandRunner,
): Promise<void> {
  for (const step of plan.steps) {
    try {
      await run(step.command[0], step.command.slice(1))
    } catch (error) {
      const mergePrMatch = step.label.match(/^merge-pr-(\d+)$/)
      if (mergePrMatch) {
        throw new Error(`PR #${mergePrMatch[1]} did not merge cleanly. Fix the PR branch, abort the merge, and rerun the dev queue.`)
      }

      const cherryPickPrMatch = step.label.match(/^cherry-pick-pr-(\d+)$/)
      if (cherryPickPrMatch) {
        throw new Error(`PR #${cherryPickPrMatch[1]} did not cherry-pick cleanly. Fix the PR branch, abort the cherry-pick, and rerun the dev queue.`)
      }

      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Step ${step.label} failed: ${message}`)
    }
  }
}

export async function assembleDevQueue(input: {
  requestedPrs: number[]
  run: DevQueueCommandRunner
  getBranch: () => Promise<string | undefined>
  getStatus: () => Promise<string>
}): Promise<void> {
  await assertAssemblePreconditions(input)
  await input.run('git', ['fetch', 'origin', 'main'])
  const originMain = await input.run('git', ['rev-parse', 'origin/main'])
  const prs = await loadPrMetadata(input.requestedPrs, input.run)
  const plan = buildDevQueuePlan({ originMain, requestedPrs: input.requestedPrs, prs })
  await executeDevQueuePlan(plan, input.run)
}

const runCommand: DevQueueCommandRunner = async (command, args) => {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8' })
    return stdout.trim()
  } catch (error) {
    if (error instanceof Error) {
      const details = error as Error & { stderr?: string; stdout?: string }
      const output = [details.stderr, details.stdout]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
        .join('\n')
      if (output) {
        throw new Error(output)
      }
      throw error
    }
    throw new Error(String(error))
  }
}

function printUsage(): void {
  console.log('Usage: tsx scripts/dev-pr-queue.ts plan --prs 321,309,319')
  console.log('       tsx scripts/dev-pr-queue.ts assemble --prs 321,309,319')
}

function parseCliPrList(argv: string[]): number[] {
  const prsFlagIndex = argv.indexOf('--prs')
  const prsValue = prsFlagIndex >= 0 ? argv[prsFlagIndex + 1] : ''
  return parsePrList(prsValue)
}

async function buildPlanForCli(requestedPrs: number[]): Promise<{
  plan: DevQueuePlan
  prs: DevQueuePr[]
}> {
  await runCommand('git', ['fetch', 'origin', 'main'])
  const originMain = await runCommand('git', ['rev-parse', 'origin/main'])
  const prs = await loadPrMetadata(requestedPrs, runCommand)
  const plan = buildDevQueuePlan({ originMain, requestedPrs, prs })
  return { plan, prs }
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    printUsage()
    return command ? 0 : 2
  }

  try {
    const requestedPrs = parseCliPrList(argv)

    if (command === 'plan') {
      const { plan, prs } = await buildPlanForCli(requestedPrs)
      for (const step of plan.steps) {
        console.log(`${step.label}: ${step.command.join(' ')}`)
      }
      console.log(`origin/main: ${plan.originMain}`)
      for (const pr of prs) {
        console.log(`PR #${pr.number}: ${pr.headRefOid}`)
      }
      return 0
    }

    if (command === 'assemble') {
      console.log('This will reset local dev to origin/main before applying PRs.')
      console.log('Refusing to continue unless current branch is dev and worktree is clean.')
      await assembleDevQueue({
        requestedPrs,
        run: runCommand,
        getBranch: async () => {
          const branch = await runCommand('git', ['branch', '--show-current'])
          return branch || undefined
        },
        getStatus: async () => runCommand('git', ['status', '--porcelain']),
      })
      console.log('Local dev has been reset to origin/main and updated with the requested PR heads.')
      return 0
    }

    console.error(`Unsupported command: ${command}`)
    printUsage()
    return 2
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    return 1
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
