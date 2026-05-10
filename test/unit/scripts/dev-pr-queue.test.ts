import { describe, expect, it } from 'vitest'
import {
  assembleDevQueue,
  assertAssemblePreconditions,
  buildDevQueuePlan,
  buildPrMetadataCommand,
  executeDevQueuePlan,
  loadPrMetadata,
  parsePrList,
  type DevQueuePr,
} from '../../../scripts/dev-pr-queue.js'

const pr = (input: Partial<DevQueuePr> & Pick<DevQueuePr, 'number'>): DevQueuePr => ({
  number: input.number,
  state: input.state ?? 'OPEN',
  isDraft: input.isDraft ?? false,
  baseRefName: input.baseRefName ?? 'main',
  headRefOid: input.headRefOid ?? `sha-${input.number}`,
  mergeStateStatus: input.mergeStateStatus ?? 'CLEAN',
  title: input.title ?? `PR ${input.number}`,
  labels: input.labels ?? [],
})

describe('dev PR queue planner', () => {
  it('parses explicit PR numbers', () => {
    expect(parsePrList('321,309,319')).toEqual([321, 309, 319])
  })

  it('rejects empty PR lists', () => {
    expect(() => parsePrList('')).toThrow('At least one PR number is required')
  })

  it('rejects malformed PR lists', () => {
    expect(() => parsePrList('321,nope')).toThrow('At least one PR number is required')
    expect(() => parsePrList('0')).toThrow('At least one PR number is required')
  })

  it('plans origin/main plus PR heads in the requested order', () => {
    const plan = buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [321, 309],
      prs: [pr({ number: 321 }), pr({ number: 309 })],
    })

    expect(plan.steps.map((step) => step.label)).toEqual([
      'fetch-origin-main',
      'reset-dev-to-origin-main',
      'fetch-pr-321',
      'merge-pr-321',
      'fetch-pr-309',
      'merge-pr-309',
    ])
  })

  it('uses no-ff merges so PR boundaries remain visible on dev', () => {
    const plan = buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [321],
      prs: [pr({ number: 321 })],
    })

    expect(plan.steps.find((step) => step.label === 'merge-pr-321')?.command).toEqual([
      'git',
      'merge',
      '--no-ff',
      '--no-edit',
      'refs/remotes/pr/321',
    ])
  })

  it('rejects missing metadata for requested PRs', () => {
    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [321],
      prs: [],
    })).toThrow('PR #321 was not found')
  })

  it('rejects draft PRs', () => {
    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [289],
      prs: [pr({ number: 289, isDraft: true })],
    })).toThrow('PR #289 is draft')
  })

  it('rejects closed PRs', () => {
    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [310],
      prs: [pr({ number: 310, state: 'CLOSED' })],
    })).toThrow('PR #310 is CLOSED, expected OPEN')
  })

  it('rejects PRs that do not target main', () => {
    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [310],
      prs: [pr({ number: 310, baseRefName: 'other' })],
    })).toThrow('PR #310 targets other, expected main')
  })

  it('rejects do-not-merge labels', () => {
    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [289],
      prs: [pr({ number: 289, labels: [{ name: 'do-not-merge' }] })],
    })).toThrow('PR #289 is labeled do-not-merge')
  })

  it('rejects superseded and approval-artifact labels', () => {
    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [310],
      prs: [pr({ number: 310, labels: [{ name: 'superseded' }] })],
    })).toThrow('PR #310 is labeled superseded')

    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [311],
      prs: [pr({ number: 311, labels: [{ name: 'approval-artifact-only' }] })],
    })).toThrow('PR #311 is labeled approval-artifact-only')

    expect(() => buildDevQueuePlan({
      originMain: 'origin-sha',
      requestedPrs: [312],
      prs: [pr({ number: 312, labels: [{ name: 'approval-artifact' }] })],
    })).toThrow('PR #312 is labeled approval-artifact')
  })

  it('builds gh commands for exact PR metadata', () => {
    expect(buildPrMetadataCommand(321)).toEqual([
      'gh',
      [
        'pr',
        'view',
        '321',
        '--repo',
        'danshapiro/freshell',
        '--json',
        'number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,title,labels',
      ],
    ])
  })

  it('loads explicit PR metadata through the injected runner', async () => {
    const calls: string[] = []
    const prs = await loadPrMetadata([321, 309], async (command, args) => {
      calls.push([command, ...args].join(' '))
      const number = Number(args[2])
      return JSON.stringify(pr({ number }))
    })

    expect(prs.map((item) => item.number)).toEqual([321, 309])
    expect(calls).toEqual([
      'gh pr view 321 --repo danshapiro/freshell --json number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,title,labels',
      'gh pr view 309 --repo danshapiro/freshell --json number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,title,labels',
    ])
  })

  it('reports invalid gh metadata clearly', async () => {
    await expect(loadPrMetadata([321], async () => 'not json')).rejects.toThrow(
      'Failed to parse gh metadata for PR #321',
    )
  })

  it('refuses assemble outside dev', async () => {
    await expect(assertAssemblePreconditions({
      getBranch: async () => 'feature/x',
      getStatus: async () => '',
    })).rejects.toThrow('Refusing to assemble dev from feature/x')
  })

  it('refuses assemble on an unknown branch', async () => {
    await expect(assertAssemblePreconditions({
      getBranch: async () => undefined,
      getStatus: async () => '',
    })).rejects.toThrow('Refusing to assemble dev from an unknown branch')
  })

  it('refuses assemble with a dirty worktree', async () => {
    await expect(assertAssemblePreconditions({
      getBranch: async () => 'dev',
      getStatus: async () => ' M package.json',
    })).rejects.toThrow('Refusing to reset dev with a dirty worktree')
  })

  it('stops on the first failed merge and reports the PR', async () => {
    const executed: string[] = []
    await expect(executeDevQueuePlan({
      originMain: 'origin-sha',
      steps: [
        { label: 'reset-dev-to-origin-main', command: ['git', 'reset', '--hard', 'origin-sha'] },
        { label: 'merge-pr-321', command: ['git', 'merge', '--no-ff', '--no-edit', 'refs/remotes/pr/321'] },
        { label: 'merge-pr-309', command: ['git', 'merge', '--no-ff', '--no-edit', 'refs/remotes/pr/309'] },
      ],
    }, async (_command, args) => {
      executed.push(args.join(' '))
      if (args.includes('refs/remotes/pr/321')) throw new Error('merge failed')
      return ''
    })).rejects.toThrow('PR #321 did not merge cleanly')

    expect(executed).toHaveLength(2)
  })

  it('stops on the first failed cherry-pick and reports the PR', async () => {
    await expect(executeDevQueuePlan({
      originMain: 'origin-sha',
      steps: [
        { label: 'cherry-pick-pr-321', command: ['git', 'cherry-pick', 'sha-321'] },
      ],
    }, async () => {
      throw new Error('conflict')
    })).rejects.toThrow('PR #321 did not cherry-pick cleanly')
  })

  it('reports non-merge command failures clearly', async () => {
    await expect(executeDevQueuePlan({
      originMain: 'origin-sha',
      steps: [
        { label: 'fetch-origin-main', command: ['git', 'fetch', 'origin', 'main'] },
      ],
    }, async () => {
      throw new Error('network unavailable')
    })).rejects.toThrow('Step fetch-origin-main failed: network unavailable')
  })

  it('validates metadata before resetting dev', async () => {
    const events: string[] = []
    await expect(assembleDevQueue({
      requestedPrs: [289],
      run: async (command, args) => {
        events.push([command, ...args].join(' '))
        if (args.join(' ') === 'rev-parse origin/main') return 'origin-sha'
        if (args.includes('view')) {
          return JSON.stringify(pr({ number: 289, labels: [{ name: 'do-not-merge' }] }))
        }
        return ''
      },
      getBranch: async () => 'dev',
      getStatus: async () => '',
    })).rejects.toThrow('PR #289 is labeled do-not-merge')

    expect(events.some((event) => event.includes('reset --hard'))).toBe(false)
  })

  it('assembles dev after preconditions and metadata validation', async () => {
    const events: string[] = []
    await assembleDevQueue({
      requestedPrs: [321],
      run: async (command, args) => {
        events.push([command, ...args].join(' '))
        if (args.join(' ') === 'rev-parse origin/main') return 'origin-sha'
        if (args.includes('view')) return JSON.stringify(pr({ number: 321 }))
        return ''
      },
      getBranch: async () => 'dev',
      getStatus: async () => '',
    })

    expect(events).toEqual([
      'git fetch origin main',
      'git rev-parse origin/main',
      'gh pr view 321 --repo danshapiro/freshell --json number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,title,labels',
      'git fetch origin main',
      'git reset --hard origin-sha',
      'git fetch origin +refs/pull/321/head:refs/remotes/pr/321',
      'git merge --no-ff --no-edit refs/remotes/pr/321',
    ])
  })
})
