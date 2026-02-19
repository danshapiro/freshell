import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import type { ApiError } from '@/lib/api'
import { api } from '@/lib/api'
import { fuzzyMatch } from '@/lib/fuzzy-match'
import { rankCandidateDirectories } from '@/lib/tab-directory-preference'
import { cn } from '@/lib/utils'

type DirectoryPickerProps = {
  providerType: CodingCliProviderName | 'claude-web'
  providerLabel: string
  defaultCwd?: string
  tabDirectories?: string[]
  globalDefault?: string
  onConfirm: (cwd: string) => void
  onBack: () => void
}

type CompletionSuggestion = {
  path: string
  isDirectory: boolean
}

const PATH_INPUT_PATTERN = /^(['"])?([/~]|[a-zA-Z]:|\\\\|\\(?!\\))/

function dedupeDirectories(values: string[]): string[] {
  const next: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    next.push(trimmed)
  }
  return next
}

function isPathInput(value: string): boolean {
  return PATH_INPUT_PATTERN.test(value.trimStart())
}

function isApiError(error: unknown): error is ApiError {
  if (!error || typeof error !== 'object') return false
  const maybe = error as Partial<ApiError>
  return typeof maybe.status === 'number'
}

export default function DirectoryPicker({
  providerType,
  providerLabel,
  defaultCwd,
  tabDirectories,
  globalDefault,
  onConfirm,
  onBack,
}: DirectoryPickerProps) {
  const inputId = useId()
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const completionRequestIdRef = useRef(0)
  const validationRequestIdRef = useRef(0)
  const [inputValue, setInputValue] = useState(defaultCwd ?? '')
  const [candidates, setCandidates] = useState<string[]>(() => dedupeDirectories([defaultCwd || '']))
  const [pathSuggestions, setPathSuggestions] = useState<string[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  const pathMode = useMemo(() => isPathInput(inputValue), [inputValue])

  useEffect(() => {
    setInputValue(defaultCwd ?? '')
  }, [defaultCwd])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    let cancelled = false
    api.get<{ directories?: string[] }>('/api/files/candidate-dirs')
      .then((result) => {
        if (cancelled) return
        const raw = dedupeDirectories([...(result.directories || []), defaultCwd || ''])
        const ranked = rankCandidateDirectories(raw, tabDirectories ?? [], globalDefault)
        setCandidates(ranked)
      })
      .catch(() => {
        if (cancelled) return
        const fallback = dedupeDirectories([defaultCwd || ''])
        const ranked = rankCandidateDirectories(fallback, tabDirectories ?? [], globalDefault)
        setCandidates(ranked)
      })
    return () => {
      cancelled = true
    }
  }, [defaultCwd, tabDirectories, globalDefault])

  const fuzzySuggestions = useMemo(() => {
    if (pathMode) return []
    const query = inputValue.trim()
    if (!query) return candidates.slice(0, 15)

    return candidates
      .map((candidate) => ({ candidate, match: fuzzyMatch(query, candidate) }))
      .filter((entry): entry is { candidate: string; match: NonNullable<ReturnType<typeof fuzzyMatch>> } => !!entry.match)
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, 15)
      .map((entry) => entry.candidate)
  }, [pathMode, inputValue, candidates])

  useEffect(() => {
    if (!pathMode) {
      completionRequestIdRef.current += 1
      setPathSuggestions([])
      return
    }

    completionRequestIdRef.current += 1
    const requestId = completionRequestIdRef.current
    const prefix = inputValue.trim()
    if (!prefix) {
      setPathSuggestions([])
      return
    }

    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled || completionRequestIdRef.current !== requestId) return
      void Promise
        .resolve(api.get<{ suggestions?: CompletionSuggestion[] }>(
          `/api/files/complete?prefix=${encodeURIComponent(prefix)}&dirs=true`
        ))
        .then((result) => {
          if (cancelled || completionRequestIdRef.current !== requestId) return
          const directories = dedupeDirectories(
            (result?.suggestions || [])
              .filter((entry) => entry.isDirectory)
              .map((entry) => entry.path)
          )
          setPathSuggestions(directories.slice(0, 15))
        })
        .catch(() => {
          if (cancelled || completionRequestIdRef.current !== requestId) return
          setPathSuggestions([])
        })
    }, 200)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pathMode, inputValue])

  const suggestions = pathMode ? pathSuggestions : fuzzySuggestions

  useEffect(() => {
    if (suggestions.length === 0) {
      setActiveIndex(-1)
      return
    }
    setActiveIndex((prev) => (prev < 0 ? -1 : Math.min(prev, suggestions.length - 1)))
  }, [suggestions])

  const handleConfirm = useCallback(async (value?: string) => {
    const nextPath = (value ?? inputValue).trim()
    setInputValue(nextPath)
    if (!nextPath) {
      setError('directory not found')
      return
    }

    setError(null)
    setIsValidating(true)
    validationRequestIdRef.current += 1
    const validationId = validationRequestIdRef.current

    try {
      const result = await api.post<{ valid: boolean; resolvedPath?: string }>('/api/files/validate-dir', { path: nextPath })
      if (validationRequestIdRef.current !== validationId) return
      if (!result.valid) {
        setError('directory not found')
        return
      }
      onConfirm(result.resolvedPath || nextPath)
    } catch (error) {
      if (validationRequestIdRef.current !== validationId) return
      if (isApiError(error) && error.status === 403) {
        setError('path not allowed')
        return
      }
      setError('directory not found')
    } finally {
      if (validationRequestIdRef.current === validationId) {
        setIsValidating(false)
      }
    }
  }, [inputValue, onConfirm])

  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onBack()
      return
    }

    if (event.key === 'ArrowDown') {
      if (suggestions.length === 0) return
      event.preventDefault()
      setActiveIndex((prev) => (prev + 1) % suggestions.length)
      return
    }

    if (event.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      event.preventDefault()
      setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length)
      return
    }

    if (event.key === 'Tab') {
      if (suggestions.length === 0) return
      event.preventDefault()
      const suggestion = activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0]
      setInputValue(suggestion)
      setActiveIndex(activeIndex >= 0 ? activeIndex : 0)
      setError(null)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const selected = activeIndex >= 0 ? suggestions[activeIndex] : undefined
      void handleConfirm(selected || inputValue)
    }
  }, [activeIndex, handleConfirm, inputValue, onBack, suggestions])

  const hasSuggestions = suggestions.length > 0
  const activeDescendant = hasSuggestions && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined

  return (
    <div className="h-full w-full p-4 flex items-center justify-center">
      <div className="w-full max-w-3xl space-y-3" data-provider-type={providerType}>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={inputId} className="text-sm font-medium">
            Starting directory for {providerLabel}
          </label>
          <button
            type="button"
            onClick={onBack}
            className="text-xs px-2 py-1 rounded border hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Back
          </button>
        </div>

        <input
          id={inputId}
          ref={inputRef}
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value)
            setActiveIndex(-1)
            setError(null)
          }}
          onKeyDown={handleInputKeyDown}
          role="combobox"
          aria-expanded={hasSuggestions}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          className={cn(
            'w-full rounded border bg-background px-3 py-2 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring',
            error && 'border-red-500'
          )}
          placeholder="e.g. ~/projects/my-app"
          spellCheck={false}
        />

        {hasSuggestions ? (
          <ul
            id={listboxId}
            role="listbox"
            className="max-h-56 overflow-y-auto rounded border bg-background"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={`${suggestion}-${index}`}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setInputValue(suggestion)
                  setError(null)
                  void handleConfirm(suggestion)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  setInputValue(suggestion)
                  setError(null)
                  void handleConfirm(suggestion)
                }}
                className={cn(
                  'px-3 py-2 text-sm cursor-pointer',
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
                )}
              >
                {suggestion}
              </li>
            ))}
          </ul>
        ) : (
          <p aria-live="polite" className="rounded border bg-background px-3 py-2 text-xs text-muted-foreground">
            No suggestions
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
        {isValidating && (
          <p className="text-xs text-muted-foreground">Validating directory...</p>
        )}
      </div>
    </div>
  )
}
