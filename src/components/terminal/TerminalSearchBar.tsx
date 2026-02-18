import { useEffect, useRef } from 'react'

type TerminalSearchBarProps = {
  query: string
  onQueryChange: (value: string) => void
  onFindNext: () => void
  onFindPrevious: () => void
  onClose: () => void
  resultIndex?: number
  resultCount?: number
}

export function TerminalSearchBar({
  query,
  onQueryChange,
  onFindNext,
  onFindPrevious,
  onClose,
  resultIndex,
  resultCount,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="absolute left-2 right-2 top-2 z-20 flex flex-col gap-2 rounded-md border border-border bg-background/95 p-2 shadow-md md:left-auto md:right-3 md:top-3 md:flex-row md:items-center">
      <input
        ref={inputRef}
        aria-label="Terminal search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) {
              onFindPrevious()
            } else {
              onFindNext()
            }
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        className="h-10 w-full rounded-md border border-border bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-border md:h-8 md:w-52"
      />
      {resultCount !== undefined && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {resultCount === 0 ? 'No results' : `${(resultIndex ?? 0) + 1} of ${resultCount}`}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Previous match"
          className="min-h-11 min-w-11 rounded-md px-2 text-xs md:h-8 md:min-h-0 md:min-w-0"
          onClick={onFindPrevious}
        >
          Prev
        </button>
        <button
          type="button"
          aria-label="Next match"
          className="min-h-11 min-w-11 rounded-md px-2 text-xs md:h-8 md:min-h-0 md:min-w-0"
          onClick={onFindNext}
        >
          Next
        </button>
        <button
          type="button"
          aria-label="Close search"
          className="min-h-11 min-w-11 rounded-md px-2 text-xs md:h-8 md:min-h-0 md:min-w-0"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  )
}
