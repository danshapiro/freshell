import { memo, useMemo } from 'react'
import { diffLines } from 'diff'
import { cn } from '@/lib/utils'

interface DiffViewProps {
  oldStr: string
  newStr: string
  filePath?: string
}

function DiffView({ oldStr, newStr, filePath }: DiffViewProps) {
  const hunks = useMemo(() => diffLines(oldStr, newStr), [oldStr, newStr])

  const hasChanges = hunks.some(h => h.added || h.removed)

  if (!hasChanges) {
    return (
      <div role="figure" aria-label="diff view" className="text-xs text-muted-foreground italic py-1">
        No changes detected
      </div>
    )
  }

  // Build line-numbered output
  const lines: Array<{ type: 'added' | 'removed' | 'context'; text: string; lineNo: string }> = []
  let oldLine = 1
  let newLine = 1

  for (const hunk of hunks) {
    const hunkLines = hunk.value.replace(/\n$/, '').split('\n')
    for (const line of hunkLines) {
      if (hunk.removed) {
        lines.push({ type: 'removed', text: line, lineNo: String(oldLine++) })
      } else if (hunk.added) {
        lines.push({ type: 'added', text: line, lineNo: String(newLine++) })
      } else {
        lines.push({ type: 'context', text: line, lineNo: String(newLine) })
        oldLine++
        newLine++
      }
    }
  }

  return (
    <div
      role="figure"
      aria-label="diff view"
      className="text-xs font-mono overflow-x-auto"
      data-diff=""
      data-file-path={filePath}
    >
      {filePath && (
        <div className="text-muted-foreground px-2 py-0.5 border-b border-border/50">
          {filePath}
        </div>
      )}
      <div className="leading-relaxed">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'flex px-1',
              line.type === 'removed' && 'bg-red-500/10 text-red-400',
              line.type === 'added' && 'bg-green-500/10 text-green-400',
              line.type === 'context' && 'text-muted-foreground',
            )}
          >
            <span className="w-8 shrink-0 text-right pr-2 select-none opacity-50">
              {line.lineNo}
            </span>
            <span className="shrink-0 w-4 select-none">
              {line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(DiffView)
