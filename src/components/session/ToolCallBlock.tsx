import { cn } from '@/lib/utils'
import type { NormalizedEvent } from '@/lib/coding-cli-types'

interface ToolCallBlockProps {
  tool: NonNullable<NormalizedEvent['toolCall']>
  className?: string
}

export function ToolCallBlock({ tool, className }: ToolCallBlockProps) {
  const inputStr =
    typeof tool.arguments === 'string' ? tool.arguments : JSON.stringify(tool.arguments ?? {}, null, 2)

  return (
    <div className={cn('rounded-md border bg-background/50 p-3 my-2', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">Tool</span>
        <span>{tool.name}</span>
      </div>
      <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words bg-muted/50 p-2 rounded">
        {inputStr}
      </pre>
    </div>
  )
}
