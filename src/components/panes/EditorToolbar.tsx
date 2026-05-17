import { useState, useRef, useEffect, type MutableRefObject } from 'react'
import { FolderOpen, Eye, Code, WrapText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { isAbsolutePath, joinPath } from '@/lib/path-utils'

export interface EditorToolbarProps {
  filePath: string | null
  onPathChange: (path: string) => void
  onPathSelect: (path: string) => void
  onOpenFilePicker: () => void
  suggestions: Array<{ path: string; isDirectory: boolean }>
  viewMode: 'source' | 'preview'
  onViewModeToggle: () => void
  showViewToggle: boolean
  defaultBrowseRoot?: string | null
  inputRef?: MutableRefObject<HTMLInputElement | null>
  wordWrap?: boolean
  onWordWrapToggle?: () => void
}

function withTrailingSeparator(value: string): string {
  if (value.endsWith('/') || value.endsWith('\\')) return value
  const separator = value.includes('\\') ? '\\' : '/'
  return `${value}${separator}`
}

export default function EditorToolbar({
  filePath,
  onPathChange,
  onPathSelect,
  onOpenFilePicker,
  suggestions,
  viewMode,
  onViewModeToggle,
  showViewToggle,
  defaultBrowseRoot,
  inputRef,
  wordWrap = true,
  onWordWrapToggle,
}: EditorToolbarProps) {
  const [inputValue, setInputValue] = useState(filePath || '')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const internalInputRef = useRef<HTMLInputElement | null>(null)
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  // Sync input value with filePath prop
  useEffect(() => {
    setInputValue(filePath || '')
  }, [filePath])

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !internalInputRef.current?.contains(event.target as Node)
      ) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInputValue(value)
    onPathChange(value)
    setShowSuggestions(true)
    setSelectedIndex(-1)
  }

  const handleSelectSuggestion = (suggestion: { path: string; isDirectory: boolean }) => {
    if (suggestion.isDirectory) {
      const nextValue = withTrailingSeparator(suggestion.path)
      setInputValue(nextValue)
      onPathChange(nextValue)
      setShowSuggestions(true)
      setSelectedIndex(-1)
      return
    }

    setInputValue(suggestion.path)
    onPathSelect(suggestion.path)
    setShowSuggestions(false)
    setSelectedIndex(-1)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'Enter') {
        const resolvedPath =
          defaultBrowseRoot && inputValue && !isAbsolutePath(inputValue)
            ? joinPath(defaultBrowseRoot, inputValue)
            : inputValue
        onPathSelect(resolvedPath)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1))
        break
      case 'Enter':
        e.preventDefault()
        if (selectedIndex >= 0) {
          handleSelectSuggestion(suggestions[selectedIndex])
        } else {
          const resolvedPath =
            defaultBrowseRoot && inputValue && !isAbsolutePath(inputValue)
              ? joinPath(defaultBrowseRoot, inputValue)
              : inputValue
          onPathSelect(resolvedPath)
          setShowSuggestions(false)
        }
        break
      case 'Escape':
        setShowSuggestions(false)
        setSelectedIndex(-1)
        break
    }
  }

  const handleFocus = () => {
    if (suggestions.length > 0) {
      setShowSuggestions(true)
    }
  }

  return (
    <div className="h-10 flex items-center gap-2 px-3 border-b border-border/30 bg-background">
      <div className="flex-1 relative">
        <Input
          ref={(node) => {
            internalInputRef.current = node
            if (inputRef) {
              inputRef.current = node
            }
          }}
          data-native-context="true"
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder="Enter file path..."
          className="h-8 text-sm"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute top-full left-0 right-0 mt-1 bg-background border border-border rounded-md shadow-lg max-h-60 overflow-y-auto z-50"
            data-testid="suggestions-dropdown"
          >
            {suggestions.map((suggestion, index) => {
              const suggestionPath = suggestion.path || ''
              const label = suggestion.isDirectory
                ? withTrailingSeparator(suggestionPath)
                : suggestionPath
              return (
              <button
                key={
                  suggestionPath
                    ? `${suggestionPath}-${suggestion.isDirectory ? 'dir' : 'file'}`
                    : `${index}-${suggestion.isDirectory ? 'dir' : 'file'}`
                }
                className={cn(
                  'w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors',
                  selectedIndex === index && 'bg-muted'
                )}
                onClick={() => handleSelectSuggestion(suggestion)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {label}
              </button>
              )
            })}
          </div>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenFilePicker}
        className="h-8"
        title="Open file picker"
      >
        <FolderOpen className="h-4 w-4" />
      </Button>
      {showViewToggle && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onViewModeToggle}
          title={viewMode === 'source' ? 'Preview' : 'Source'}
          aria-label={viewMode === 'source' ? 'Preview' : 'Source'}
        >
          {viewMode === 'source' ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
        </Button>
      )}
      {onWordWrapToggle && (
        <Button
          variant={wordWrap ? 'secondary' : 'ghost'}
          size="icon"
          onClick={onWordWrapToggle}
          title={wordWrap ? 'Disable line wrap' : 'Enable line wrap'}
          aria-label={wordWrap ? 'Disable line wrap' : 'Enable line wrap'}
        >
          <WrapText className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
