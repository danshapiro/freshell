import fs from 'fs'
import { createInterface } from 'readline'
import type { CodingCliProvider } from '../coding-cli/provider.js'
import type { NormalizedEvent } from '../coding-cli/types.js'

export type SessionFileSearchMatch = {
  provider: string
  matchedIn: 'userMessage' | 'assistantMessage'
  snippet: string
}

export function extractSnippet(text: string, query: string, contextLength = 50): string {
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
  tier: 'userMessages' | 'fullText',
  signal?: AbortSignal,
): Promise<SessionFileSearchMatch | null> {
  const q = query.toLowerCase()

  let handle: fs.promises.FileHandle | null = null
  let stream: fs.ReadStream | null = null
  let reader: ReturnType<typeof createInterface> | null = null

  try {
    if (signal?.aborted) throw new Error('Session file search aborted')

    handle = await fs.promises.open(filePath, 'r')
    stream = handle.createReadStream({ encoding: 'utf-8' })
    reader = createInterface({ input: stream, crlfDelay: Infinity })

    const onAbort = () => {
      stream?.destroy()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const line of reader) {
        if (signal?.aborted) throw new Error('Session file search aborted')
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
      signal?.removeEventListener('abort', onAbort)
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
