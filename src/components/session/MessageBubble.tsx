import { cn } from '@/lib/utils'
import type { NormalizedEvent } from '@/lib/coding-cli-types'

interface MessageBubbleProps {
  event: NormalizedEvent
  className?: string
}

export function MessageBubble({ event, className }: MessageBubbleProps) {
  const isAssistant = event.type === 'message.assistant'
  const content = event.message?.content || ''

  return (
    <div
      className={cn(
        'rounded-lg px-4 py-3 max-w-[85%] whitespace-pre-wrap break-words',
        isAssistant ? 'bg-muted self-start' : 'bg-primary text-primary-foreground self-end',
        className
      )}
    >
      {content}
    </div>
  )
}
