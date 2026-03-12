import { memo, useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { ChatContentBlock } from '@/store/agentChatTypes'
import { LazyMarkdown } from '@/components/markdown/LazyMarkdown'
import ToolStrip, { type ToolPair } from './ToolStrip'

/** Strip SDK-injected <system-reminder>...</system-reminder> tags from text. */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

type RenderGroup =
  | { kind: 'text'; block: ChatContentBlock; index: number }
  | { kind: 'thinking'; block: ChatContentBlock; index: number }
  | { kind: 'tools'; pairs: ToolPair[]; startIndex: number; toolGroupIndex: number }

interface MessageBubbleProps {
  speaker?: 'user' | 'assistant'
  role?: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp?: string
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
  /** When true, unpaired tool_use blocks show a spinner (they may still be running).
   *  When false (default), unpaired tool_use blocks show as complete — their results
   *  arrived in a later message. */
  isLastMessage?: boolean
  /** Index offset for this message's completed tool blocks in the global sequence. */
  completedToolOffset?: number
  /** Completed tools at globalIndex >= this value get initialExpanded=true. */
  autoExpandAbove?: number
}

function MessageBubble({
  speaker,
  role,
  content,
  timestamp,
  model,
  showThinking = true,
  showTools = true,
  showTimecodes = false,
  isLastMessage = false,
  completedToolOffset,
  autoExpandAbove,
}: MessageBubbleProps) {
  const resolvedSpeaker = speaker ?? role ?? 'assistant'
  // Build a map of tool_use_id -> tool_result for pairing
  const resultMap = useMemo(() => {
    const map = new Map<string, ChatContentBlock>()
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, block)
      }
    }
    return map
  }, [content])

  // Group content blocks into render groups: text, thinking, or contiguous tool runs.
  const groups = useMemo(() => {
    const result: RenderGroup[] = []
    let currentToolPairs: ToolPair[] | null = null
    let toolStartIndex = 0
    let toolGroupCount = 0

    const flushTools = () => {
      if (currentToolPairs && currentToolPairs.length > 0) {
        result.push({ kind: 'tools', pairs: currentToolPairs, startIndex: toolStartIndex, toolGroupIndex: toolGroupCount++ })
      }
      currentToolPairs = null
    }

    for (let i = 0; i < content.length; i++) {
      const block = content[i]

      if (block.type === 'tool_use' && block.name) {
        if (!currentToolPairs) {
          currentToolPairs = []
          toolStartIndex = i
        }
        // Look up the matching tool_result
        const resultBlock = block.id ? resultMap.get(block.id) : undefined
        const rawResult = resultBlock
          ? (typeof resultBlock.content === 'string' ? resultBlock.content : JSON.stringify(resultBlock.content))
          : undefined
        const resultContent = rawResult ? stripSystemReminders(rawResult) : undefined

        currentToolPairs.push({
          id: block.id || `tool-${i}`,
          name: block.name,
          input: block.input,
          output: resultContent,
          isError: resultBlock?.is_error,
          status: resultBlock ? 'complete' : isLastMessage ? 'running' : 'complete',
        })
        continue
      }

      if (block.type === 'tool_result') {
        // If we're in a tool group, skip (already consumed via resultMap pairing above).
        if (currentToolPairs) continue

        // If it has a matching tool_use elsewhere in this message, skip (already consumed)
        if (block.tool_use_id && content.some(b => b.type === 'tool_use' && b.id === block.tool_use_id)) {
          continue
        }

        // Orphaned result: render as standalone tool strip
        const raw = typeof block.content === 'string'
          ? block.content
          : block.content != null ? JSON.stringify(block.content) : ''
        const resultContent = raw ? stripSystemReminders(raw) : undefined
        result.push({
          kind: 'tools',
          pairs: [{
            id: block.tool_use_id || `orphan-${i}`,
            name: 'Result',
            output: resultContent,
            isError: block.is_error,
            status: 'complete',
          }],
          startIndex: i,
          toolGroupIndex: toolGroupCount++,
        })
        continue
      }

      // Non-tool block: flush any pending tool group
      flushTools()

      if (block.type === 'text' && block.text) {
        result.push({ kind: 'text', block, index: i })
      } else if (block.type === 'thinking' && block.thinking) {
        result.push({ kind: 'thinking', block, index: i })
      }
    }

    // Flush any trailing tool group
    flushTools()

    return result
  }, [content, resultMap, isLastMessage])

  // Check if any blocks will be visible after applying toggle filters.
  // Note: tool groups are unconditionally visible (collapsed summary always shows),
  // so showTools is intentionally absent from the dependency array. Only thinking
  // blocks are conditionally hidden via their toggle.
  const hasVisibleContent = useMemo(() => {
    return groups.some((group) => {
      if (group.kind === 'text') return true
      if (group.kind === 'thinking' && showThinking) return true
      if (group.kind === 'tools') return true
      return false
    })
  }, [groups, showThinking])

  // Track completed tool offset across tool groups for auto-expand
  const toolGroupOffsets = useMemo(() => {
    const offsets: number[] = []
    let offset = completedToolOffset ?? 0
    for (const group of groups) {
      if (group.kind === 'tools') {
        offsets.push(offset)
        offset += group.pairs.filter(p => p.status === 'complete').length
      }
    }
    return offsets
  }, [groups, completedToolOffset])

  if (!hasVisibleContent) return null

  return (
    <div
      className={cn(
        'max-w-prose pl-2.5 py-0.5 text-sm',
        resolvedSpeaker === 'user'
          ? 'border-l-[3px] border-l-[hsl(var(--claude-user))]'
          : 'border-l-2 border-l-[hsl(var(--claude-assistant))]'
      )}
      role="article"
      aria-label={`${resolvedSpeaker} message`}
    >
      {groups.map((group) => {
        if (group.kind === 'text') {
          if (resolvedSpeaker === 'user') {
            return <p key={group.index} className="whitespace-pre-wrap leading-5">{group.block.text}</p>
          }
          return (
            <div
              key={group.index}
              className="prose prose-sm dark:prose-invert max-w-none [&_h1]:my-2 [&_h2]:my-1.5 [&_h3]:my-1.5 [&_p]:my-1 [&_pre]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5"
            >
              <LazyMarkdown
                content={group.block.text!}
                fallback={<p className="whitespace-pre-wrap">{group.block.text}</p>}
              />
            </div>
          )
        }

        if (group.kind === 'thinking') {
          if (!showThinking) return null
          return (
            <details key={group.index} className="text-xs text-muted-foreground mt-0.5">
              <summary className="cursor-pointer select-none">
                Thinking ({group.block.thinking!.length.toLocaleString()} chars)
              </summary>
              <pre className="mt-0.5 whitespace-pre-wrap text-xs opacity-70">{group.block.thinking}</pre>
            </details>
          )
        }

        if (group.kind === 'tools') {
          const isStreaming = isLastMessage && group.pairs.some(p => p.status === 'running')
          return (
            <ToolStrip
              key={`tools-${group.startIndex}`}
              pairs={group.pairs}
              isStreaming={isStreaming}
              completedToolOffset={toolGroupOffsets[group.toolGroupIndex]}
              autoExpandAbove={autoExpandAbove}
              showTools={showTools}
            />
          )
        }

        return null
      })}

      {showTimecodes && (timestamp || model) && (
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {timestamp && (
            <time>{new Date(timestamp).toLocaleTimeString()}</time>
          )}
          {model && <span className="opacity-60">{model}</span>}
        </div>
      )}
    </div>
  )
}

export default memo(MessageBubble)
