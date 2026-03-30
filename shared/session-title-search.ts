export type TitleTierMetadata = {
  title?: string
  summary?: string
  firstUserMessage?: string
  cwd?: string
  projectPath?: string
}

export type TitleTierMatch = {
  matchedIn: 'title' | 'summary' | 'firstUserMessage'
  matchedValue: string
}

function includesQuery(value: string | undefined, normalizedQuery: string): value is string {
  return typeof value === 'string' && value.toLowerCase().includes(normalizedQuery)
}

export function getLeafDirectoryName(pathLike?: string): string | undefined {
  if (typeof pathLike !== 'string') return undefined

  const trimmed = pathLike.trim()
  if (!trimmed) return undefined

  const normalized = trimmed.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  if (!normalized || /^[A-Za-z]:$/.test(normalized)) return undefined

  const segments = normalized.split('/').filter(Boolean)
  return segments.at(-1)
}

export function matchTitleTierMetadata(
  metadata: TitleTierMetadata,
  query: string,
): TitleTierMatch | null {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return null

  const projectLeaf = getLeafDirectoryName(metadata.projectPath)
  const cwdLeaf = getLeafDirectoryName(metadata.cwd)
  const distinctCwdLeaf = cwdLeaf && cwdLeaf !== projectLeaf ? cwdLeaf : undefined

  const searchable: Array<[TitleTierMatch['matchedIn'], string | undefined]> = [
    ['title', metadata.title],
    ['title', projectLeaf],
    ['title', distinctCwdLeaf],
    ['summary', metadata.summary],
    ['firstUserMessage', metadata.firstUserMessage],
  ]

  const match = searchable.find(([, value]) => includesQuery(value, normalizedQuery))
  if (!match || !match[1]) return null

  return {
    matchedIn: match[0],
    matchedValue: match[1],
  }
}
