import { useMemo, useCallback, useRef, useEffect } from 'react'
import Editor from '@monaco-editor/react'
import { FileText } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import EditorToolbar from './EditorToolbar'
import MarkdownPreview from './MarkdownPreview'

function isPreviewable(filePath: string | null): boolean {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.htm') || lower.endsWith('.html')
}

function isMarkdown(filePath: string | null): boolean {
  if (!filePath) return false
  return filePath.toLowerCase().endsWith('.md')
}

function isHtml(filePath: string | null): boolean {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return lower.endsWith('.htm') || lower.endsWith('.html')
}

const AUTO_SAVE_DELAY = 5000

interface EditorPaneProps {
  paneId: string
  tabId: string
  filePath: string | null
  language: string | null
  readOnly: boolean
  content: string
  viewMode: 'source' | 'preview'
}

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly,
  content,
  viewMode,
}: EditorPaneProps) {
  const dispatch = useAppDispatch()
  const showViewToggle = useMemo(() => isPreviewable(filePath), [filePath])

  // Auto-save refs
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null)
  const pendingContent = useRef<string>(content)

  // Cleanup auto-save timer on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
      }
    }
  }, [])

  const scheduleAutoSave = useCallback(() => {
    // Don't auto-save scratch pads (no filePath) or read-only files
    if (!filePath || readOnly) return

    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
    }

    autoSaveTimer.current = setTimeout(async () => {
      try {
        const token = sessionStorage.getItem('auth-token') || ''
        await fetch('/api/files/write', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-auth-token': token,
          },
          body: JSON.stringify({
            path: filePath,
            content: pendingContent.current,
          }),
        })
      } catch (err) {
        console.error('Auto-save failed:', err)
      }
    }, AUTO_SAVE_DELAY)
  }, [filePath, readOnly])

  const updateContent = useCallback(
    (updates: Partial<{
      filePath: string | null
      language: string | null
      content: string
      viewMode: 'source' | 'preview'
    }>) => {
      dispatch(
        updatePaneContent({
          tabId,
          paneId,
          content: {
            kind: 'editor',
            filePath: updates.filePath !== undefined ? updates.filePath : filePath,
            language: updates.language !== undefined ? updates.language : language,
            readOnly,
            content: updates.content !== undefined ? updates.content : content,
            viewMode: updates.viewMode !== undefined ? updates.viewMode : viewMode,
          },
        })
      )
    },
    [dispatch, tabId, paneId, filePath, language, readOnly, content, viewMode]
  )

  const handleContentChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      pendingContent.current = value
      updateContent({ content: value })
      scheduleAutoSave()
    },
    [updateContent, scheduleAutoSave]
  )

  const loadFile = useCallback(
    async (path: string) => {
      try {
        const token = sessionStorage.getItem('auth-token') || ''
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, {
          headers: { 'x-auth-token': token },
        })
        if (!res.ok) {
          console.error('Failed to load file:', res.statusText)
          return
        }
        const data = await res.json()

        // Determine language from extension
        const ext = path.split('.').pop()?.toLowerCase()
        const langMap: Record<string, string> = {
          ts: 'typescript',
          tsx: 'typescriptreact',
          js: 'javascript',
          jsx: 'javascriptreact',
          md: 'markdown',
          json: 'json',
          html: 'html',
          htm: 'html',
          css: 'css',
          py: 'python',
        }

        // Determine default viewMode for previewable files
        const defaultViewMode = isMarkdown(path) || isHtml(path) ? 'preview' : 'source'

        updateContent({
          filePath: path,
          language: langMap[ext || ''] || null,
          content: data.content,
          viewMode: defaultViewMode,
        })
      } catch (err) {
        console.error('Failed to load file:', err)
      }
    },
    [updateContent]
  )

  const handlePathChange = useCallback(
    (path: string) => {
      if (path) {
        loadFile(path)
      } else {
        updateContent({ filePath: null })
      }
    },
    [loadFile, updateContent]
  )

  const handleOpenFile = useCallback(() => {
    // TODO: Native file picker
  }, [])

  const handleViewModeToggle = useCallback(() => {
    updateContent({ viewMode: viewMode === 'source' ? 'preview' : 'source' })
  }, [updateContent, viewMode])

  const showPreview = viewMode === 'preview' && showViewToggle

  const renderContent = () => {
    if (showPreview && isMarkdown(filePath)) {
      return <MarkdownPreview content={content} />
    }

    if (showPreview && isHtml(filePath)) {
      return (
        <iframe
          srcDoc={content}
          title="HTML Preview"
          className="w-full h-full border-0 bg-white"
          sandbox="allow-scripts"
        />
      )
    }

    return (
      <Editor
        height="100%"
        language={language || undefined}
        value={content}
        onChange={handleContentChange}
        options={{
          readOnly,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
        }}
        theme="vs-dark"
      />
    )
  }

  // Empty state
  if (!filePath && !content) {
    return (
      <div className="flex flex-col h-full w-full bg-background">
        <EditorToolbar
          filePath=""
          onPathChange={handlePathChange}
          onOpenFile={handleOpenFile}
          viewMode={viewMode}
          onViewModeToggle={handleViewModeToggle}
          showViewToggle={false}
        />
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
          <FileText className="h-12 w-12 opacity-50" />
          <button
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={handleOpenFile}
          >
            Open File
          </button>
          <span className="text-sm">or start typing to create a scratch pad</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full bg-background">
      <EditorToolbar
        filePath={filePath || ''}
        onPathChange={handlePathChange}
        onOpenFile={handleOpenFile}
        viewMode={viewMode}
        onViewModeToggle={handleViewModeToggle}
        showViewToggle={showViewToggle}
      />
      <div className="flex-1 min-h-0">{renderContent()}</div>
    </div>
  )
}
