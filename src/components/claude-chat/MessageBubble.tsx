import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import type { ChatContentBlock } from '@/store/claudeChatTypes'
import ToolBlock from './ToolBlock'

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp?: string
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
}

function MessageBubble({
  role,
  content,
  timestamp,
  model,
  showThinking = true,
  showTools = true,
  showTimecodes = false,
}: MessageBubbleProps) {
  // Pair tool_use blocks with their tool_result blocks for unified rendering.
  // This allows ToolBlock to show the tool name, input preview, AND result
  // summary in one place, instead of rendering them as separate blocks.
  const resultMap = useMemo(() => {
    const map = new Map<string, ChatContentBlock>()
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, block)
      }
    }
    return map
  }, [content])

  return (
    <div
      className={cn(
        'max-w-prose pl-3 py-1 text-sm',
        role === 'user'
          ? 'border-l-[3px] border-l-[hsl(var(--claude-user))]'
          : 'border-l-2 border-l-[hsl(var(--claude-assistant))]'
      )}
      role="article"
      aria-label={`${role} message`}
    >
      {content.map((block, i) => {
        if (block.type === 'text' && block.text) {
          if (role === 'user') {
            return <p key={i} className="whitespace-pre-wrap">{block.text}</p>
          }
          return (
            <div key={i} className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
            </div>
          )
        }

        if (block.type === 'thinking' && block.thinking) {
          if (!showThinking) return null
          return (
            <details key={i} className="text-xs text-muted-foreground mt-1">
              <summary className="cursor-pointer select-none">
                Thinking ({block.thinking.length.toLocaleString()} chars)
              </summary>
              <pre className="mt-1 whitespace-pre-wrap text-xs opacity-70">{block.thinking}</pre>
            </details>
          )
        }

        if (block.type === 'tool_use' && block.name) {
          if (!showTools) return null
          // Look up the matching tool_result to show as a unified block
          const result = block.id ? resultMap.get(block.id) : undefined
          const resultContent = result
            ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
            : undefined
          return (
            <ToolBlock
              key={block.id || i}
              name={block.name}
              input={block.input}
              output={resultContent}
              isError={result?.is_error}
              status={result ? 'complete' : 'running'}
            />
          )
        }

        if (block.type === 'tool_result') {
          if (!showTools) return null
          // Skip if already merged into a matching tool_use block above
          if (block.tool_use_id && content.some(b => b.type === 'tool_use' && b.id === block.tool_use_id)) {
            return null
          }
          // Render orphaned results (no matching tool_use) as standalone
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content)
          return (
            <ToolBlock
              key={block.tool_use_id || i}
              name="Result"
              output={resultContent}
              isError={block.is_error}
              status="complete"
            />
          )
        }

        return null
      })}

      {((showTimecodes && timestamp) || model) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          {showTimecodes && timestamp && (
            <time>{new Date(timestamp).toLocaleTimeString()}</time>
          )}
          {model && <span className="opacity-60">{model}</span>}
        </div>
      )}
    </div>
  )
}

export default memo(MessageBubble)
