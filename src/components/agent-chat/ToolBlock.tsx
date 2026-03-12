import { useState, memo, useMemo } from 'react'
import { ChevronRight, Loader2, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import DiffView from './DiffView'
import { getToolPreview } from './tool-preview'

interface ToolBlockProps {
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
  /** When true, tool block starts expanded (used for recent tools). Default: false. */
  initialExpanded?: boolean
}

/** Generate a short result summary (e.g. "143 lines", "5 matches", "error"). */
function getResultSummary(name: string, output?: string, isError?: boolean): string | null {
  if (!output) return null
  if (isError) return 'error'

  if (name === 'Read' || name === 'Result') {
    const lineCount = output.split('\n').length
    return `${lineCount} line${lineCount !== 1 ? 's' : ''}`
  }

  if (name === 'Grep' || name === 'Glob') {
    const matchCount = output.trim().split('\n').filter(Boolean).length
    return `${matchCount} match${matchCount !== 1 ? 'es' : ''}`
  }

  if (name === 'Bash') {
    const lineCount = output.split('\n').length
    if (lineCount > 3) return `${lineCount} lines`
    return 'done'
  }

  return 'done'
}

function ToolBlock({ name, input, output, isError, status, initialExpanded }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(initialExpanded ?? false)
  const preview = useMemo(() => getToolPreview(name, input), [name, input])
  const resultSummary = useMemo(
    () => status === 'complete' ? getResultSummary(name, output, isError) : null,
    [name, output, isError, status],
  )

  return (
    <div
      className={cn(
        'border-l-2 my-0.5 text-xs',
        isError
          ? 'border-l-[hsl(var(--claude-error))]'
          : 'border-l-[hsl(var(--claude-tool))]'
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-r px-2 py-0.5 text-left hover:bg-accent/50"
        aria-expanded={expanded}
        aria-label={`${name} tool call`}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span className="font-medium">{name}:</span>
        {preview && <span className="truncate text-muted-foreground font-mono">{preview}</span>}
        {resultSummary && (
          <span className={cn(
            'shrink-0 text-muted-foreground',
            isError && 'text-red-500'
          )}>
            ({resultSummary})
          </span>
        )}
        <span className="ml-auto shrink-0">
          {status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === 'complete' && !isError && <Check className="h-3 w-3 text-green-500" />}
          {status === 'complete' && isError && <X className="h-3 w-3 text-red-500" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-2 py-1 text-xs">
          {name === 'Edit' && input &&
            typeof input.old_string === 'string' &&
            typeof input.new_string === 'string' ? (
            <DiffView
              oldStr={input.old_string}
              newStr={input.new_string}
              filePath={typeof input.file_path === 'string' ? input.file_path : undefined}
            />
          ) : (
            <>
              {input && (
                <pre
                  className="whitespace-pre-wrap font-mono opacity-80 max-h-48 overflow-y-auto"
                  data-tool-input=""
                  data-tool-name={name}
                >
                  {name === 'Bash' && typeof input.command === 'string'
                    ? input.command
                    : JSON.stringify(input, null, 2)}
                </pre>
              )}
              {output && (
                <pre
                  className={cn(
                    'mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono',
                    isError ? 'text-red-500' : 'opacity-80'
                  )}
                  data-tool-output=""
                >
                  {output}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(ToolBlock)
