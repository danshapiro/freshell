import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

export const TAB_RECENCY_RESOLUTION_MS = 60 * 1000

type TimestampCandidate = number | null | undefined

export function bucketTabRecencyAt(at: TimestampCandidate): number | undefined {
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return undefined
  return Math.floor(at / TAB_RECENCY_RESOLUTION_MS) * TAB_RECENCY_RESOLUTION_MS
}

export function collectTerminalPaneIds(node: PaneNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'leaf') {
    return node.content.kind === 'terminal' ? [node.id] : []
  }
  return [
    ...collectTerminalPaneIds(node.children[0]),
    ...collectTerminalPaneIds(node.children[1]),
  ]
}

export function deriveTabRecencyAt(input: {
  tab: Pick<Tab, 'createdAt' | 'lastInputAt'>
  layout: PaneNode | undefined
  paneLastInputAt: Record<string, number | undefined>
}): number {
  const candidates: number[] = []
  for (const raw of [input.tab.createdAt, input.tab.lastInputAt]) {
    const bucket = bucketTabRecencyAt(raw)
    if (bucket !== undefined) candidates.push(bucket)
  }
  for (const paneId of collectTerminalPaneIds(input.layout)) {
    const bucket = bucketTabRecencyAt(input.paneLastInputAt[paneId])
    if (bucket !== undefined) candidates.push(bucket)
  }
  return candidates.length > 0 ? Math.max(...candidates) : 0
}
