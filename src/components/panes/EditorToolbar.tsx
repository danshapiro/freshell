import { useState, useCallback, useEffect } from 'react'
import { FolderOpen, Eye, Code } from 'lucide-react'

interface EditorToolbarProps {
  filePath: string
  onPathChange: (path: string) => void
  onOpenFile: () => void
  viewMode: 'source' | 'preview'
  onViewModeToggle: () => void
  showViewToggle: boolean
}

export default function EditorToolbar({
  filePath,
  onPathChange,
  onOpenFile,
  viewMode,
  onViewModeToggle,
  showViewToggle,
}: EditorToolbarProps) {
  const [inputValue, setInputValue] = useState(filePath)

  useEffect(() => {
    setInputValue(filePath)
  }, [filePath])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        onPathChange(inputValue)
      }
    },
    [inputValue, onPathChange]
  )

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-card">
      <button
        onClick={onOpenFile}
        className="p-1.5 rounded hover:bg-muted"
        title="Browse files"
        aria-label="Browse files"
      >
        <FolderOpen className="h-4 w-4" />
      </button>

      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Enter file path..."
        className="flex-1 h-8 px-3 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
      />

      {showViewToggle && (
        <button
          onClick={onViewModeToggle}
          className="p-1.5 rounded hover:bg-muted"
          title={viewMode === 'source' ? 'Show preview' : 'Show source'}
          aria-label={viewMode === 'source' ? 'Preview' : 'Source'}
        >
          {viewMode === 'source' ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
        </button>
      )}
    </div>
  )
}
