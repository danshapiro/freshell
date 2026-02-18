import { memo, useState, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ChatMessage } from '@/store/claudeChatTypes'
import MessageBubble from './MessageBubble'

interface CollapsedTurnProps {
  userMessage: ChatMessage
  assistantMessage: ChatMessage
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
}

function makeSummary(userMsg: ChatMessage, assistantMsg: ChatMessage): string {
  // Truncate user text
  const userTextBlock = userMsg.content.find(b => b.type === 'text' && b.text)
  let userText = userTextBlock?.text?.trim().replace(/\n/g, ' ') ?? '(no text)'
  if (userText.length > 40) {
    userText = userText.slice(0, 37) + '...'
  }

  // Count assistant blocks
  const toolCount = assistantMsg.content.filter(b => b.type === 'tool_use').length
  const textCount = assistantMsg.content.filter(b => b.type === 'text').length

  const parts: string[] = []
  if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`)
  if (textCount) parts.push(`${textCount} msg${textCount > 1 ? 's' : ''}`)

  const responseSummary = parts.length ? parts.join(', ') : 'empty'
  return `${userText} → ${responseSummary}`
}

function CollapsedTurn({
  userMessage,
  assistantMessage,
  showThinking = true,
  showTools = true,
  showTimecodes = false,
}: CollapsedTurnProps) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(
    () => makeSummary(userMessage, assistantMessage),
    [userMessage, assistantMessage],
  )

  if (expanded) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={true}
          aria-label="Collapse turn"
        >
          <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          <span className="font-mono opacity-70">{summary}</span>
        </button>
        <MessageBubble
          role={userMessage.role}
          content={userMessage.content}
          timestamp={userMessage.timestamp}
          showThinking={showThinking}
          showTools={showTools}
          showTimecodes={showTimecodes}
        />
        <MessageBubble
          role={assistantMessage.role}
          content={assistantMessage.content}
          timestamp={assistantMessage.timestamp}
          model={assistantMessage.model}
          showThinking={showThinking}
          showTools={showTools}
          showTimecodes={showTimecodes}
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      aria-expanded={false}
      aria-label="Expand turn"
    >
      <ChevronRight className="h-3 w-3 shrink-0 transition-transform" />
      <span className="font-mono truncate">{summary}</span>
    </button>
  )
}

export default memo(CollapsedTurn)
