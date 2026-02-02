import { z } from 'zod'
import fs from 'fs'
import { createInterface } from 'readline'
import type { CodingCliProvider } from './coding-cli/provider.js'
import type { CodingCliProviderName, NormalizedEvent, ProjectGroup } from './coding-cli/types.js'

export const SearchTier = {
  Title: 'title',
  UserMessages: 'userMessages',
  FullText: 'fullText',
} as const

export type SearchTierType = (typeof SearchTier)[keyof typeof SearchTier]

export const SearchMatchSchema = z.object({
  line: z.number(),
  text: z.string(),
  context: z.string().optional(),
})

export type SearchMatch = z.infer<typeof SearchMatchSchema>

export const SearchResultSchema = z.object({
  sessionId: z.string(),
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi']),
  projectPath: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  matchedIn: z.enum(['title', 'userMessage', 'assistantMessage', 'summary']),
  snippet: z.string().optional(),
  updatedAt: z.number(),
  createdAt: z.number().optional(),
  archived: z.boolean().optional(),
  cwd: z.string().optional(),
})

export type SearchResult = z.infer<typeof SearchResultSchema>

export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  tier: z.enum(['title', 'userMessages', 'fullText']).default('title'),
  limit: z.number().min(1).max(100).default(50),
  maxFiles: z.number().min(1).max(100_000).optional(),
})

export type SearchRequest = z.infer<typeof SearchRequestSchema>

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  tier: z.enum(['title', 'userMessages', 'fullText']),
  query: z.string(),
  totalScanned: z.number(),
  partial: z.boolean().optional(),
  partialReason: z.enum(['budget', 'io_error']).optional(),
})

export type SearchResponse = z.infer<typeof SearchResponseSchema>

export function searchTitleTier(
  projects: ProjectGroup[],
  query: string,
  limit = 50
): SearchResult[] {
  const q = query.toLowerCase()
  const results: SearchResult[] = []

  for (const project of projects) {
    for (const session of project.sessions) {
      const titleMatch = session.title?.toLowerCase().includes(q)
      const summaryMatch = session.summary?.toLowerCase().includes(q)

      if (titleMatch || summaryMatch) {
        const provider = (session.provider || 'claude') as CodingCliProviderName
        results.push({
          sessionId: session.sessionId,
          provider,
          projectPath: session.projectPath,
          title: session.title,
          summary: session.summary,
          matchedIn: titleMatch ? 'title' : 'summary',
          snippet: titleMatch ? session.title : session.summary,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
          archived: session.archived,
          cwd: session.cwd,
        })
      }
    }
  }

  results.sort(sortWithArchived)
  return results.slice(0, limit)
}

function sortWithArchived(a: SearchResult, b: SearchResult): number {
  const aArchived = !!a.archived
  const bArchived = !!b.archived
  if (aArchived !== bArchived) return aArchived ? 1 : -1
  return b.updatedAt - a.updatedAt
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        if (block?.type === 'thinking' && typeof block.thinking === 'string') return block.thinking
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function extractMessageText(obj: Record<string, unknown>): string | null {
  // Direct message string
  if (typeof obj.message === 'string') {
    return obj.message
  }
  // Nested message.content
  if (obj.message && typeof obj.message === 'object') {
    const msg = obj.message as Record<string, unknown>
    const content = msg.content
    return extractTextFromContent(content) || null
  }
  // Direct content field
  if (obj.content) {
    return extractTextFromContent(obj.content) || null
  }
  return null
}

export function extractUserMessages(content: string): string[] {
  const messages: string[] = []
  const lines = content.split(/\r?\n/).filter(Boolean)

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type !== 'user') continue

      const text = extractMessageText(obj)
      if (text) messages.push(text)
    } catch {
      // Skip malformed JSON
    }
  }

  return messages
}

export function extractAllMessages(content: string): string[] {
  const messages: string[] = []
  const lines = content.split(/\r?\n/).filter(Boolean)

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type !== 'user' && obj.type !== 'assistant') continue

      const text = extractMessageText(obj)
      if (text) messages.push(text)
    } catch {
      // Skip malformed JSON
    }
  }

  return messages
}

function extractSnippet(text: string, query: string, contextLength = 50): string {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) return text.slice(0, 100)

  const start = Math.max(0, index - contextLength)
  const end = Math.min(text.length, index + query.length + contextLength)

  let snippet = text.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < text.length) snippet = snippet + '...'

  return snippet
}

export async function searchSessionFile(
  provider: CodingCliProvider,
  filePath: string,
  query: string,
  tier: 'userMessages' | 'fullText'
): Promise<Omit<SearchResult, 'sessionId' | 'projectPath' | 'updatedAt'> | null> {
  const q = query.toLowerCase()

  let handle: fs.promises.FileHandle | null = null
  let stream: fs.ReadStream | null = null
  let reader: ReturnType<typeof createInterface> | null = null

  try {
    handle = await fs.promises.open(filePath, 'r')
    stream = handle.createReadStream({ encoding: 'utf-8' })
    reader = createInterface({ input: stream, crlfDelay: Infinity })

    for await (const line of reader) {
      if (!line) continue

      let events: NormalizedEvent[] = []
      try {
        events = provider.parseEvent(line)
      } catch {
        continue
      }

      for (const event of events) {
        if (event.type !== 'message.user' && event.type !== 'message.assistant') continue
        if (tier === 'userMessages' && event.type !== 'message.user') continue

        const text = event.message?.content
        if (!text) continue

      if (text.toLowerCase().includes(q)) {
        return {
          provider: provider.name,
          matchedIn: event.type === 'message.user' ? 'userMessage' : 'assistantMessage',
          snippet: extractSnippet(text, query),
        }
      }
    }
  }
  } finally {
    reader?.close()
    stream?.destroy()
    if (handle) {
      await handle.close().catch(() => {})
    }
  }

  return null
}

export interface SearchSessionsOptions {
  projects: ProjectGroup[]
  providers: CodingCliProvider[]
  query: string
  tier: SearchTierType
  limit?: number
  maxFiles?: number
}

export async function searchSessions(
  options: SearchSessionsOptions
): Promise<SearchResponse> {
  const { projects, providers, query, tier, limit = 50, maxFiles } = options
  const providersByName = new Map<CodingCliProviderName, CodingCliProvider>(
    providers.map((provider) => [provider.name, provider])
  )

  // Tier 1: Title search (instant, metadata only)
  if (tier === SearchTier.Title) {
    const results = searchTitleTier(projects, query, limit)
    return {
      results,
      tier,
      query,
      totalScanned: projects.reduce((sum, p) => sum + p.sessions.length, 0),
      partial: false,
    }
  }

  // Tier 2 & 3: File-based search
  const results: SearchResult[] = []
  let totalScanned = 0
  let partial = false
  let partialReason: 'budget' | 'io_error' | undefined
  const markIoError = () => {
    partial = true
    if (partialReason !== 'budget') {
      partialReason = 'io_error'
    }
  }

  let budgetExceeded = false
  for (const project of projects) {
    for (const session of project.sessions) {
      if (maxFiles !== undefined && totalScanned >= maxFiles) {
        partial = true
        partialReason = 'budget'
        budgetExceeded = true
        break
      }

      totalScanned++

      const providerName = (session.provider || 'claude') as CodingCliProviderName
      const provider = providersByName.get(providerName)
      if (!provider) continue

      const sessionFile = session.sourceFile
      if (!sessionFile) continue

      const searchTier = tier === SearchTier.UserMessages ? 'userMessages' : 'fullText'
      let match: Omit<SearchResult, 'sessionId' | 'projectPath' | 'updatedAt'> | null = null
      try {
        match = await searchSessionFile(provider, sessionFile, query, searchTier)
      } catch {
        markIoError()
        continue
      }

      if (match) {
        results.push({
          sessionId: session.sessionId,
          provider: providerName,
          projectPath: session.projectPath,
          title: session.title,
          summary: session.summary,
          matchedIn: match.matchedIn!,
          snippet: match.snippet,
          updatedAt: session.updatedAt,
          createdAt: session.createdAt,
          archived: session.archived,
          cwd: session.cwd,
        })

        if (results.length >= limit) break
      }
    }
    if (results.length >= limit || budgetExceeded) break
  }

  // Sort by updatedAt descending
  results.sort(sortWithArchived)

  return {
    results,
    tier,
    query,
    totalScanned,
    partial,
    partialReason,
  }
}
