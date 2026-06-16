import fs from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const productionRuntimeRoots = ['src', 'server', 'shared'] as const

const runtimeExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])

const legacyRuntimeNeedles = [
  'agent-chat',
  'agentChat',
  'AgentChat',
  '/api/agent-chat',
  '/api/agent-sessions',
  'createAgentTimelineRouter',
] as const

type Finding = {
  file: string
  line?: number
  snippet?: string
  reason: string
}

type LegacyBoundaryAllowance = {
  file: string
  reason: string
  patterns: RegExp[]
}

type SourceLine = {
  line: string
  lineNumber: number
  legacyAllowance?: LegacyBoundaryAllowance
}

const legacyMigrationBoundaryAllowances: LegacyBoundaryAllowance[] = [
  {
    file: 'shared/fresh-agent.ts',
    reason: 'pane/content migration helper recognizes persisted legacy pane kind before normalizing to fresh-agent',
    patterns: [
      /^\s*if \(input\.kind !== 'agent-chat'\) \{$/,
    ],
  },
  {
    file: 'shared/settings.ts',
    reason: 'settings/config input migration reads and strips the legacy agentChat alias',
    patterns: [
      /^\s*return isRecord\(candidate\.agentChat\)$/,
      /^\s*\? candidate\.agentChat as LegacyFreshAgentSettingsInput$/,
      /^\s*const next = omitKeys\(raw, \['theme', 'uiScale', 'notifications', 'agentChat'\]\)$/,
    ],
  },
  {
    file: 'shared/session-contract.ts',
    reason: 'durable-state migration helper preserves old agent-chat records only long enough to normalize them',
    patterns: [
      /^export function migrateLegacyAgentChatDurableState\(\{$/,
    ],
  },
  {
    file: 'server/config-store.ts',
    reason: 'config input migration and patch rejection normalize old agentChat settings without exposing them live',
    patterns: [
      /^\s*const existingAgentChat = isRecord\(migrated\.agentChat\) \? \{ \.\.\.migrated\.agentChat \} : \{\}$/,
      /^\s*const existingProviders = isRecord\(existingAgentChat\.providers\) \? \{ \.\.\.existingAgentChat\.providers \} : \{\}$/,
      /^\s*existingAgentChat\.providers = existingProviders$/,
      /^\s*migrated\.agentChat = existingAgentChat$/,
      /^\s*delete \(migratedSettings as Record<string, unknown>\)\.agentChat$/,
      /^\s*&& Object\.prototype\.hasOwnProperty\.call\(patch, 'agentChat'\)$/,
      /^\s*const error = new Error\('agentChat settings have been migrated; use freshAgent'\)$/,
      /^\s*'Rejected legacy agentChat settings patch',$/,
    ],
  },
  {
    file: 'server/settings-router.ts',
    reason: 'settings route rejects legacy agentChat input at the boundary',
    patterns: [
      /^\s*if \(Object\.prototype\.hasOwnProperty\.call\(req\.body \|\| \{\}, 'agentChat'\)\) \{$/,
      /^\s*res\.status\(400\)\.json\(\{ error: 'agentChat settings have been migrated; use freshAgent' \}\)$/,
    ],
  },
  {
    file: 'server/tabs-registry/types.ts',
    reason: 'explicit legacy tab-registry kind constant is used only to normalize old records',
    patterns: [
      /^const LEGACY_AGENT_CHAT_PANE_KIND = 'agent-chat'$/,
    ],
  },
]

const sdkInternalFiles = new Set([
  'server/sdk-bridge.ts',
  'server/sdk-bridge-types.ts',
  'server/fresh-agent/sdk-events.ts',
])

const sdkInternalPrefixes = [
  'server/fresh-agent/adapters/',
]

function toRepoRelativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}

function readSourceSync(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function joinSourceName(...parts: string[]): string {
  return parts.join('')
}

function joinProtocolName(...parts: string[]): string {
  return parts.join('.')
}

async function collectRuntimeSourceFiles(): Promise<string[]> {
  const files: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        return
      }

      if (entry.isFile() && runtimeExtensions.has(path.extname(entry.name))) {
        files.push(entryPath)
      }
    }))
  }

  await Promise.all(productionRuntimeRoots.map((root) => walk(path.join(repoRoot, root))))
  return files.sort()
}

function includesLegacyNeedle(value: string): boolean {
  return legacyRuntimeNeedles.some((needle) => value.includes(needle))
}

function collapseObviousStringFragmentSyntax(value: string): string {
  return value.replace(/[\s'"`+$\{\}()]/g, '')
}

function containsLegacyNeedle(value: string): boolean {
  if (includesLegacyNeedle(value)) {
    return true
  }

  const joinedFragments = collapseObviousStringFragmentSyntax(value)
  return legacyRuntimeNeedles.some((needle) => joinedFragments.includes(needle))
}

function legacyAllowanceFor(file: string, line: string): LegacyBoundaryAllowance | undefined {
  return legacyMigrationBoundaryAllowances.find((allowance) => (
    allowance.file === file
    && allowance.patterns.some((pattern) => pattern.test(line))
  ))
}

function isSdkInternalPath(file: string): boolean {
  return sdkInternalFiles.has(file) || sdkInternalPrefixes.some((prefix) => file.startsWith(prefix))
}

function formatWindowSnippet(lines: SourceLine[]): string {
  return lines
    .map(({ line }) => line.trim())
    .filter(Boolean)
    .join(' / ')
}

function buildSourceLines(file: string, contents: string): SourceLine[] {
  return contents
    .split(/\r?\n/)
    .map((line, index) => ({
      line,
      lineNumber: index + 1,
      legacyAllowance: legacyAllowanceFor(file, line),
    }))
}

function findMultilineLegacyRuntimeReferences(file: string, lines: SourceLine[], directLineNumbers: Set<number>): Finding[] {
  const findings: Finding[] = []
  const consumedLineNumbers = new Set<number>()
  const maxAdjacentLines = 5

  for (let start = 0; start < lines.length; start += 1) {
    if (consumedLineNumbers.has(lines[start].lineNumber)) {
      continue
    }

    for (let end = start + 1; end < Math.min(lines.length, start + maxAdjacentLines); end += 1) {
      const window = lines.slice(start, end + 1)
      if (window.some(({ lineNumber }) => directLineNumbers.has(lineNumber) || consumedLineNumbers.has(lineNumber))) {
        continue
      }

      const nonMigrationBoundaryText = window
        .map(({ line, legacyAllowance }) => legacyAllowance ? '' : line)
        .join('\n')
      if (!containsLegacyNeedle(nonMigrationBoundaryText)) {
        continue
      }

      findings.push({
        file,
        line: window[0].lineNumber,
        snippet: formatWindowSnippet(window),
        reason: 'legacy agent-chat runtime reference is split across adjacent lines outside an explicit migration boundary',
      })
      window.forEach(({ lineNumber }) => consumedLineNumbers.add(lineNumber))
      break
    }
  }

  return findings
}

function findLegacyRuntimeReferences(file: string, contents: string): Finding[] {
  const lines = buildSourceLines(file, contents)
  const directFindings = lines
    .flatMap(({ line, lineNumber, legacyAllowance }): Finding[] => {
      if (!containsLegacyNeedle(line) || legacyAllowance) {
        return []
      }

      return [{
        file,
        line: lineNumber,
        snippet: line.trim(),
        reason: 'legacy agent-chat runtime reference is not an explicit migration boundary',
      }]
    })
  const directLineNumbers = new Set(directFindings.flatMap(({ line }) => line ? [line] : []))
  const multilineFindings = findMultilineLegacyRuntimeReferences(file, lines, directLineNumbers)

  return [...directFindings, ...multilineFindings]
}

function findSdkPublicReferences(file: string, contents: string): Finding[] {
  if (isSdkInternalPath(file)) {
    return []
  }

  return contents
    .split(/\r?\n/)
    .flatMap((line, index): Finding[] => {
      if (!line.includes('sdk.')) {
        return []
      }

      return [{
        file,
        line: index + 1,
        snippet: line.trim(),
        reason: 'sdk.* protocol references belong only in server-internal SDK bridge/adapters',
      }]
    })
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file
      return [
        location,
        finding.reason,
        finding.snippet ? `  ${finding.snippet}` : undefined,
      ].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

describe('fresh-agent-only runtime architecture', () => {
  describe('legacy reference detection', () => {
    it('detects direct and obviously split legacy references', () => {
      const snippets = [
        "router.use('/api/agent-chat', router)",
        "router.use('/api/agent-' + 'chat', router)",
        "const kind = `agent-${'chat'}`",
        "const key = `agent${'Chat'}`",
        "const component = 'Agent' + 'Chat'",
        "const route = '/api/agent-' + 'sessions'",
        "const factory = 'createAgent' + 'TimelineRouter'",
      ]

      expect(snippets.map(containsLegacyNeedle)).toEqual(snippets.map(() => true))
    })

    it('preserves explicit migration-boundary allowances', () => {
      expect(findLegacyRuntimeReferences(
        'shared/settings.ts',
        "  return isRecord(candidate.agentChat)\n    ? candidate.agentChat as LegacyFreshAgentSettingsInput",
      )).toEqual([])
      expect(findLegacyRuntimeReferences(
        'server/settings-router.ts',
        "    res.status(400).json({ error: 'agentChat settings have been migrated; use freshAgent' })",
      )).toEqual([])
    })

    it('reports obfuscated legacy references outside migration boundaries', () => {
      expect(findLegacyRuntimeReferences(
        'src/live-runtime.ts',
        "router.use('/api/agent-' + 'chat', router)\nconst key = `agent${'Chat'}`",
      )).toMatchObject([
        {
          file: 'src/live-runtime.ts',
          line: 1,
          reason: 'legacy agent-chat runtime reference is not an explicit migration boundary',
        },
        {
          file: 'src/live-runtime.ts',
          line: 2,
          reason: 'legacy agent-chat runtime reference is not an explicit migration boundary',
        },
      ])
    })

    it('reports multiline obfuscated legacy references outside migration boundaries', () => {
      expect(findLegacyRuntimeReferences(
        'server/live-runtime.ts',
        [
          "router.use('/api/agent-' +",
          "  'chat', router)",
          'const key = `agent${',
          "  'Chat'",
          '}`',
        ].join('\n'),
      )).toMatchObject([
        {
          file: 'server/live-runtime.ts',
          line: 1,
          reason: 'legacy agent-chat runtime reference is split across adjacent lines outside an explicit migration boundary',
        },
        {
          file: 'server/live-runtime.ts',
          line: 3,
          reason: 'legacy agent-chat runtime reference is split across adjacent lines outside an explicit migration boundary',
        },
      ])
    })

    it('does not let migration-boundary lines trigger multiline findings', () => {
      expect(findLegacyRuntimeReferences(
        'server/config-store.ts',
        [
          '  const existingAgentChat = isRecord(migrated.agentChat) ? { ...migrated.agentChat } : {}',
          '  const existingProviders = isRecord(existingAgentChat.providers) ? { ...existingAgentChat.providers } : {}',
          '  existingAgentChat.providers = existingProviders',
          '  migrated.agentChat = existingAgentChat',
        ].join('\n'),
      )).toEqual([])
    })
  })

  it('keeps legacy agent-chat infrastructure out of production runtime source', async () => {
    const files = await collectRuntimeSourceFiles()
    const pathFindings = files
      .map(toRepoRelativePath)
      .filter(includesLegacyNeedle)
      .map((file): Finding => ({
        file,
        reason: 'production runtime file path contains a legacy agent-chat name',
      }))

    const contentFindings = (await Promise.all(files.map(async (filePath) => {
      const file = toRepoRelativePath(filePath)
      const contents = await readFile(filePath, 'utf8')
      return findLegacyRuntimeReferences(file, contents)
    }))).flat()

    expect(
      [...pathFindings, ...contentFindings],
      formatFindings([...pathFindings, ...contentFindings]),
    ).toEqual([])
  })

  it('does not keep a client-side codingcli create path', () => {
    const forbiddenFiles = [
      `src/store/${joinSourceName('coding', 'Cli', 'Thunks')}.ts`,
      `src/store/${joinSourceName('coding', 'Cli', 'Slice')}.ts`,
      `src/components/${joinSourceName('Session', 'View')}.tsx`,
      `src/components/session/${joinSourceName('Message', 'Bubble')}.tsx`,
      `src/components/session/${joinSourceName('Tool', 'Call', 'Block')}.tsx`,
      `src/components/session/${joinSourceName('Tool', 'Result', 'Block')}.tsx`,
    ]

    for (const relativePath of forbiddenFiles) {
      expect(fs.existsSync(path.join(repoRoot, relativePath))).toBe(false)
    }

    const storeSource = readSourceSync('src/store/store.ts')
    expect(storeSource).not.toContain(joinSourceName('coding', 'Cli', 'Reducer'))
    expect(storeSource).not.toContain('codingCli:')

    const tabBarSource = readSourceSync('src/components/TabBar.tsx')
    expect(tabBarSource).not.toContain(`from '@/store/${joinSourceName('coding', 'Cli', 'Slice')}'`)
    expect(tabBarSource).not.toContain(joinProtocolName('codingcli', 'kill'))

    const clientSources = [
      'src/components/TabContent.tsx',
      'src/components/TabBar.tsx',
      'src/store/tabsSlice.ts',
    ].map(readSourceSync).join('\n')
    expect(clientSources).not.toContain(joinProtocolName('codingcli', 'create'))
  })

  it('keeps SDK bridge protocol details out of public/browser-facing runtime source', async () => {
    const findings = (await Promise.all((await collectRuntimeSourceFiles()).map(async (filePath) => {
      const file = toRepoRelativePath(filePath)
      const contents = await readFile(filePath, 'utf8')
      return findSdkPublicReferences(file, contents)
    }))).flat()

    expect(findings, formatFindings(findings)).toEqual([])
  })
})
