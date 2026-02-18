import { useState, memo, useMemo } from 'react'
import { ChevronRight, Loader2, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import DiffView from './DiffView'

interface ToolBlockProps {
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
  /** When true, tool block starts expanded (used for recent tools). Default: false. */
  initialExpanded?: boolean
}

/** Generate a context-rich one-line preview for the tool header. */
function getToolPreview(name: string, input?: Record<string, unknown>): string {
  if (!input) return ''

  if (name === 'Bash') {
    // Prefer description over raw command
    if (typeof input.description === 'string') return input.description
    if (typeof input.command === 'string') return `$ ${input.command.slice(0, 120)}`
    return ''
  }

  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : ''
    return path ? `${pattern} in ${path}` : pattern
  }

  if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path
  }

  if (name === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern
  }

  if ((name === 'WebFetch' || name === 'WebSearch') && typeof input.url === 'string') {
    return input.url
  }

  return JSON.stringify(input).slice(0, 100)
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
        'border-l-2 my-1 text-xs',
        isError
          ? 'border-l-[hsl(var(--claude-error))]'
          : 'border-l-[hsl(var(--claude-tool))]'
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-2 py-1 text-left hover:bg-accent/50 rounded-r"
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
        <div className="px-2 py-1.5 border-t border-border/50 text-xs">
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
                    'whitespace-pre-wrap font-mono max-h-48 overflow-y-auto mt-1',
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
