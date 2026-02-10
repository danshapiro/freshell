import path from 'path'
import type { TerminalMode, TerminalRegistry } from './terminal-registry.js'
import type { CodingCliSession, CodingCliProviderName, TokenSummary } from './coding-cli/types.js'
import {
  resolveGitRepoRoot,
  resolveGitCheckoutRoot,
  resolveGitBranchAndDirty,
} from './coding-cli/utils.js'

type TerminalProvider = Exclude<TerminalMode, 'shell'>

type TerminalListRecord = ReturnType<TerminalRegistry['list']>[number]

export type TerminalMeta = {
  terminalId: string
  cwd?: string
  checkoutRoot?: string
  repoRoot?: string
  displaySubdir?: string
  branch?: string
  isDirty?: boolean
  provider?: TerminalProvider
  sessionId?: string
  tokenUsage?: TokenSummary
  updatedAt: number
}

type GitMetadataResolvers = {
  resolveCheckoutRoot: (cwd: string) => Promise<string>
  resolveRepoRoot: (cwd: string) => Promise<string>
  resolveBranchAndDirty: (cwd: string) => Promise<{ branch?: string; isDirty?: boolean }>
}

function isTerminalProvider(mode: TerminalMode): mode is TerminalProvider {
  return mode !== 'shell'
}

function normalizePathForDisplay(value?: string): string | undefined {
  if (!value) return undefined
  return value.replace(/[\\/]+$/, '')
}

function deriveDisplaySubdir(cwd?: string, checkoutRoot?: string): string | undefined {
  const source = normalizePathForDisplay(checkoutRoot) || normalizePathForDisplay(cwd)
  if (!source) return undefined
  const base = path.basename(source)
  return base || source
}

function tokenUsageEquals(a?: TokenSummary, b?: TokenSummary): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedTokens === b.cachedTokens &&
    a.totalTokens === b.totalTokens &&
    a.contextTokens === b.contextTokens &&
    a.modelContextWindow === b.modelContextWindow &&
    a.compactThresholdTokens === b.compactThresholdTokens &&
    a.compactPercent === b.compactPercent
  )
}

function terminalMetaEquals(a: TerminalMeta, b: TerminalMeta): boolean {
  return (
    a.terminalId === b.terminalId &&
    a.cwd === b.cwd &&
    a.checkoutRoot === b.checkoutRoot &&
    a.repoRoot === b.repoRoot &&
    a.displaySubdir === b.displaySubdir &&
    a.branch === b.branch &&
    a.isDirty === b.isDirty &&
    a.provider === b.provider &&
    a.sessionId === b.sessionId &&
    tokenUsageEquals(a.tokenUsage, b.tokenUsage)
  )
}

export class TerminalMetadataService {
  private byTerminalId = new Map<string, TerminalMeta>()
  private readonly now: () => number
  private readonly git: GitMetadataResolvers

  constructor(opts?: {
    now?: () => number
    git?: Partial<GitMetadataResolvers>
  }) {
    this.now = opts?.now ?? (() => Date.now())
    this.git = {
      resolveCheckoutRoot: opts?.git?.resolveCheckoutRoot ?? resolveGitCheckoutRoot,
      resolveRepoRoot: opts?.git?.resolveRepoRoot ?? resolveGitRepoRoot,
      resolveBranchAndDirty: opts?.git?.resolveBranchAndDirty ?? resolveGitBranchAndDirty,
    }
  }

  list(): TerminalMeta[] {
    return Array.from(this.byTerminalId.values())
  }

  async seedFromTerminal(record: TerminalListRecord): Promise<TerminalMeta | undefined> {
    const provider = isTerminalProvider(record.mode) ? record.mode : undefined
    const sessionId = provider ? record.resumeSessionId : undefined
    return this.upsert(record.terminalId, {
      cwd: record.cwd,
      provider,
      sessionId,
    })
  }

  associateSession(
    terminalId: string,
    provider: CodingCliProviderName,
    sessionId: string,
  ): TerminalMeta | undefined {
    const current = this.byTerminalId.get(terminalId)
    if (!current) return undefined

    const next: TerminalMeta = {
      ...current,
      provider,
      sessionId,
    }

    return this.commitIfChanged(next)
  }

  async applySessionMetadata(terminalId: string, session: CodingCliSession): Promise<TerminalMeta | undefined> {
    const current = this.byTerminalId.get(terminalId)
    if (!current) return undefined

    const next = await this.enrichFromCwd({
      ...current,
      provider: session.provider,
      sessionId: session.sessionId,
      cwd: session.cwd ?? current.cwd,
      branch: session.gitBranch ?? current.branch,
      isDirty: session.isDirty ?? current.isDirty,
      tokenUsage: session.tokenUsage ?? current.tokenUsage,
    })

    return this.commitIfChanged(next)
  }

  remove(terminalId: string): boolean {
    return this.byTerminalId.delete(terminalId)
  }

  private async upsert(
    terminalId: string,
    patch: {
      cwd?: string
      provider?: TerminalProvider
      sessionId?: string
    },
  ): Promise<TerminalMeta | undefined> {
    const current = this.byTerminalId.get(terminalId)
    const seeded: TerminalMeta = {
      terminalId,
      cwd: patch.cwd ?? current?.cwd,
      provider: patch.provider ?? current?.provider,
      sessionId: patch.sessionId ?? current?.sessionId,
      branch: current?.branch,
      isDirty: current?.isDirty,
      tokenUsage: current?.tokenUsage,
      updatedAt: current?.updatedAt ?? this.now(),
    }

    const next = await this.enrichFromCwd(seeded)
    return this.commitIfChanged(next)
  }

  private async enrichFromCwd(meta: TerminalMeta): Promise<TerminalMeta> {
    const cwd = meta.cwd
    if (!cwd) {
      return {
        ...meta,
        checkoutRoot: undefined,
        repoRoot: undefined,
        displaySubdir: undefined,
      }
    }

    const [checkoutRoot, repoRoot, gitBranchAndDirty] = await Promise.all([
      this.git.resolveCheckoutRoot(cwd),
      this.git.resolveRepoRoot(cwd),
      this.git.resolveBranchAndDirty(cwd),
    ])

    return {
      ...meta,
      checkoutRoot,
      repoRoot,
      displaySubdir: deriveDisplaySubdir(cwd, checkoutRoot),
      branch: meta.branch ?? gitBranchAndDirty.branch,
      isDirty: meta.isDirty ?? gitBranchAndDirty.isDirty,
    }
  }

  private commitIfChanged(nextWithoutTimestamp: TerminalMeta): TerminalMeta | undefined {
    const previous = this.byTerminalId.get(nextWithoutTimestamp.terminalId)
    if (previous && terminalMetaEquals(previous, nextWithoutTimestamp)) {
      return undefined
    }

    const next = {
      ...nextWithoutTimestamp,
      updatedAt: this.now(),
    }

    this.byTerminalId.set(next.terminalId, next)
    return next
  }
}
