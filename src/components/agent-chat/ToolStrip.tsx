import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToolPreview } from './tool-preview'
import ToolBlock from './ToolBlock'
import SlotReel from './SlotReel'

export interface ToolPair {
  id: string
  name: string
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  status: 'running' | 'complete'
}

interface ToolStripProps {
  pairs: ToolPair[]
  isStreaming: boolean
  /** When false, strip is locked to collapsed view (no expand chevron). Default true. */
  showTools?: boolean
}

function ToolStrip({ pairs, isStreaming, showTools = true }: ToolStripProps) {
  const [stripExpanded, setStripExpanded] = useState(showTools)
  useEffect(() => { setStripExpanded(showTools) }, [showTools])

  const handleToggle = () => {
    setStripExpanded(!stripExpanded)
  }

  const hasErrors = pairs.some(p => p.isError)
  const allComplete = pairs.every(p => p.status === 'complete')
  const isSettled = allComplete && !isStreaming

  const currentTool = useMemo(() => {
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (pairs[i].status === 'running') return pairs[i]
    }
    return pairs[pairs.length - 1] ?? null
  }, [pairs])

  const toolCount = pairs.length
  const settledText = `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`

  return (
    <div
      role="region"
      aria-label="Tool strip"
      className="my-0.5"
    >
      {!stripExpanded && (
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 text-xs min-w-0 border-l-2',
            hasErrors
              ? 'border-l-[hsl(var(--claude-error))]'
              : 'border-l-[hsl(var(--claude-tool))]',
          )}
        >
          <button
            type="button"
            onClick={handleToggle}
            className="shrink-0 p-0.5 hover:bg-accent/50 rounded transition-colors"
            aria-label="Toggle tool details"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
          <SlotReel
            toolName={isSettled ? null : (currentTool?.name ?? null)}
            previewText={
              isSettled
                ? null
                : (currentTool ? getToolPreview(currentTool.name, currentTool.input) : null)
            }
            settledText={settledText}
          />
        </div>
      )}

      {stripExpanded && (
        <>
          <button
            type="button"
            onClick={handleToggle}
            className="ml-1.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle tool details"
          >
            <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          </button>
          {pairs.map((pair) => (
            <ToolBlock
              key={pair.id}
              name={pair.name}
              input={pair.input}
              output={pair.output}
              isError={pair.isError}
              status={pair.status}
              initialExpanded={showTools}
            />
          ))}
        </>
      )}
    </div>
  )
}

export default memo(ToolStrip)
