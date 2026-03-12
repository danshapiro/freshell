import { memo, useMemo, useSyncExternalStore } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToolPreview } from './tool-preview'
import ToolBlock from './ToolBlock'
import SlotReel from './SlotReel'

const STORAGE_KEY = 'freshell:toolStripExpanded'

/** Read the expanded preference from localStorage. */
function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function getServerSnapshot(): boolean {
  return false
}

function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

function setExpandedPreference(expanded: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(expanded))
    // Dispatch storage event for other tabs / useSyncExternalStore
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
  } catch {
    // localStorage unavailable; degrade gracefully
  }
}

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
  /** Index offset for this strip's completed tool blocks in the global sequence. */
  completedToolOffset?: number
  /** Completed tools at globalIndex >= this value get initialExpanded=true. */
  autoExpandAbove?: number
  /** When false, strip is locked to collapsed view (no expand chevron). Default true. */
  showTools?: boolean
}

function ToolStrip({ pairs, isStreaming, completedToolOffset, autoExpandAbove, showTools = true }: ToolStripProps) {
  const expandedPref = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const expanded = showTools && expandedPref

  const handleToggle = () => {
    setExpandedPreference(!expandedPref)
  }

  const hasErrors = pairs.some(p => p.isError)
  const allComplete = pairs.every(p => p.status === 'complete')
  const isSettled = allComplete && !isStreaming

  // Determine the current (latest active or last completed) tool for the reel
  const currentTool = useMemo(() => {
    // Find the last running tool, or fall back to the last tool
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (pairs[i].status === 'running') return pairs[i]
    }
    return pairs[pairs.length - 1] ?? null
  }, [pairs])

  const toolCount = pairs.length
  const settledText = `${toolCount} tool${toolCount !== 1 ? 's' : ''} used`

  // NOTE: ToolStrip is a borderless wrapper. In collapsed mode, the collapsed
  // row gets its own tool-colored left border (since no ToolBlock is visible).
  // In expanded mode, ToolBlocks render their own border-l-2 exactly as today,
  // producing two border levels (MessageBubble > ToolBlock) -- not three.

  return (
    <div
      role="region"
      aria-label="Tool strip"
      className="my-0.5"
    >
      {/* Collapsed view: single-line reel with tool-colored border + chevron */}
      {!expanded && (
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 text-xs min-w-0 border-l-2',
            hasErrors
              ? 'border-l-[hsl(var(--claude-error))]'
              : 'border-l-[hsl(var(--claude-tool))]',
          )}
        >
          {showTools && (
            <button
              type="button"
              onClick={handleToggle}
              className="shrink-0 p-0.5 hover:bg-accent/50 rounded transition-colors"
              aria-label="Toggle tool details"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          )}
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

      {/* Expanded view: toggle button + ToolBlock list (looks like today).
          No header text -- the user specified expanded mode shows "a list of
          tools run so far, with an expando to see each one", matching today.
          ToolBlocks provide their own border-l-2, so no border on the wrapper. */}
      {expanded && (
        <>
          <button
            type="button"
            onClick={handleToggle}
            className="ml-1.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent/50"
            aria-label="Toggle tool details"
          >
            <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
          </button>
          {pairs.map((pair, i) => {
            const globalIndex = (completedToolOffset ?? 0) + i
            const shouldAutoExpand = autoExpandAbove != null
              ? globalIndex >= autoExpandAbove && pair.status === 'complete'
              : false
            return (
              <ToolBlock
                key={pair.id}
                name={pair.name}
                input={pair.input}
                output={pair.output}
                isError={pair.isError}
                status={pair.status}
                initialExpanded={shouldAutoExpand}
              />
            )
          })}
        </>
      )}
    </div>
  )
}

export default memo(ToolStrip)
