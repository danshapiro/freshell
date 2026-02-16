import { useRef, useState, useCallback, useEffect, useMemo, type ChangeEvent } from 'react'
import { Editor } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import type { EditorPaneContent } from '@/store/paneTypes'
import EditorToolbar from './EditorToolbar'
import MarkdownPreview from './MarkdownPreview'
import { api } from '@/lib/api'
import { getFirstTerminalCwd } from '@/lib/pane-utils'
import { isAbsolutePath, joinPath } from '@/lib/path-utils'
import { copyText } from '@/lib/clipboard'
import { registerEditorActions } from '@/lib/pane-action-registry'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { createLogger } from '@/lib/client-logger'


const log = createLogger('EditorPane')

const AUTO_SAVE_DELAY = 5000

type TerminalInfo = {
  terminalId: string
  cwd?: string
}

type FileSuggestion = {
  path: string
  isDirectory: boolean
}

type FileSystemWritableFileStream = {
  write: (data: string | Blob) => Promise<void>
  close: () => Promise<void>
}

type FileSystemFileHandle = {
  name?: string
  getFile: () => Promise<File>
  createWritable?: () => Promise<FileSystemWritableFileStream>
}

type DebouncedFn<T extends (...args: any[]) => any> = ((...args: Parameters<T>) => void) & {
  cancel: () => void
}

function debounce<T extends (...args: any[]) => any>(func: T, wait: number): DebouncedFn<T> {
  let timeout: NodeJS.Timeout | null = null

  const debounced = ((...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }) as DebouncedFn<T>

  debounced.cancel = () => {
    if (timeout) clearTimeout(timeout)
    timeout = null
  }

  return debounced
}

const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  py: 'python',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  md: 'markdown',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
}

function detectLanguageFromPath(filePath: string | null): string {
  if (!filePath) return 'plaintext'
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'plaintext'
}

function isMarkdown(filePath: string | null, language: string | null): boolean {
  if (filePath) return filePath.toLowerCase().endsWith('.md')
  return (language || '').toLowerCase() === 'markdown'
}

function isHtml(filePath: string | null, language: string | null): boolean {
  if (filePath) {
    const lower = filePath.toLowerCase()
    return lower.endsWith('.htm') || lower.endsWith('.html')
  }
  return (language || '').toLowerCase() === 'html'
}

function isPreviewable(filePath: string | null, language: string | null): boolean {
  return isMarkdown(filePath, language) || isHtml(filePath, language)
}

function resolveViewMode(
  filePath: string | null,
  language: string | null
): 'source' | 'preview' {
  return isPreviewable(filePath, language) ? 'preview' : 'source'
}

interface EditorPaneProps {
  paneId: string
  tabId: string
  filePath: string | null
  language: string | null
  readOnly?: boolean
  content: string
  viewMode?: 'source' | 'preview'
}

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly = false,
  content,
  viewMode = 'source',
}: EditorPaneProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const defaultCwd = useAppSelector((s) => s.settings.settings.defaultCwd)
  const mountedRef = useRef(true)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null)
  const autoSaveTimer = useRef<NodeJS.Timeout | null>(null)
  const pendingContent = useRef<string>(content)

  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [editorValue, setEditorValue] = useState(content)
  const [currentLanguage, setCurrentLanguage] = useState<string | null>(language)
  const [currentViewMode, setCurrentViewMode] = useState<'source' | 'preview'>(viewMode)
  const [terminalCwds, setTerminalCwds] = useState<Record<string, string>>({})
  const [filePickerMessage, setFilePickerMessage] = useState<string | null>(null)

  const firstTerminalCwd = useMemo(
    () => (layout ? getFirstTerminalCwd(layout, terminalCwds) : null),
    [layout, terminalCwds]
  )
  const showPreviewToggle = useMemo(
    () => isPreviewable(filePath, currentLanguage),
    [filePath, currentLanguage]
  )
  const editorLanguage = currentLanguage || 'plaintext'
  const defaultBrowseRoot = firstTerminalCwd || defaultCwd || null
  const isHtmlPreview = isHtml(filePath, currentLanguage)
  const showEmptyState = !filePath && !editorValue

  const resolvePath = useCallback((pathValue: string | null): string | null => {
    if (!pathValue) return null
    if (!isAbsolutePath(pathValue) && defaultBrowseRoot) {
      return joinPath(defaultBrowseRoot, pathValue)
    }
    return pathValue
  }, [defaultBrowseRoot])

  useEffect(() => {
    setEditorValue(content)
    pendingContent.current = content
  }, [content])

  useEffect(() => {
    setCurrentLanguage(language)
  }, [language])

  useEffect(() => {
    setCurrentViewMode(viewMode)
  }, [viewMode])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!layout) {
      setTerminalCwds({})
      return
    }

    let cancelled = false

    const fetchTerminalCwds = async () => {
      try {
        const terminals = await api.get<TerminalInfo[]>('/api/terminals')
        if (cancelled) return
        const nextMap: Record<string, string> = {}
        if (Array.isArray(terminals)) {
          for (const terminal of terminals) {
            if (terminal.terminalId && terminal.cwd) {
              nextMap[terminal.terminalId] = terminal.cwd
            }
          }
        }
        setTerminalCwds(nextMap)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        log.error(
          JSON.stringify({
            severity: 'error',
            event: 'editor_terminal_list_fetch_failed',
            error: message,
          })
        )
        setTerminalCwds({})
      }
    }

    fetchTerminalCwds()

    return () => {
      cancelled = true
    }
  }, [layout])

  useEffect(() => {
    if (!filePickerMessage) return
    const timer = setTimeout(() => setFilePickerMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [filePickerMessage])

  function handleEditorMount(editor: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor
    editor.focus()
  }

  const debouncedPathChange = useMemo(
    () =>
      debounce(async (path: string) => {
        if (!mountedRef.current) return

        if (!path.trim()) {
          setSuggestions([])
          return
        }

        try {
          let url = `/api/files/complete?prefix=${encodeURIComponent(path)}`
          if (!isAbsolutePath(path) && defaultBrowseRoot) {
            url += `&root=${encodeURIComponent(defaultBrowseRoot)}`
          }
          const response = await api.get<{ suggestions?: FileSuggestion[] }>(url)
          if (!mountedRef.current) return
          setSuggestions(response?.suggestions || [])
        } catch (err) {
          if (!mountedRef.current) return
          const message = err instanceof Error ? err.message : String(err)
          log.error(
            JSON.stringify({
              severity: 'error',
              event: 'editor_autocomplete_failed',
              error: message,
            })
          )
          setSuggestions([])
        }
      }, 300),
    [defaultBrowseRoot]
  )

  useEffect(() => {
    return () => {
      debouncedPathChange.cancel()
    }
  }, [debouncedPathChange])

  const handlePathChange = useCallback(
    (path: string) => {
      debouncedPathChange(path)
    },
    [debouncedPathChange]
  )

  const updateContent = useCallback(
    (updates: Partial<{
      filePath: string | null
      language: string | null
      content: string
      readOnly: boolean
      viewMode: 'source' | 'preview'
    }>) => {
      const nextContent: EditorPaneContent = {
        kind: 'editor',
        filePath: updates.filePath !== undefined ? updates.filePath : filePath,
        language: updates.language !== undefined ? updates.language : currentLanguage,
        readOnly: updates.readOnly !== undefined ? updates.readOnly : readOnly,
        content: updates.content !== undefined ? updates.content : editorValue,
        viewMode: updates.viewMode !== undefined ? updates.viewMode : currentViewMode,
      }

      dispatch(
        updatePaneContent({
          tabId,
          paneId,
          content: nextContent,
        })
      )
    },
    [dispatch, tabId, paneId, filePath, currentLanguage, readOnly, editorValue, currentViewMode]
  )

  const handlePathSelect = useCallback(
    async (path: string) => {
      if (!path.trim()) return

      fileHandleRef.current = null
      const resolvedPath =
        defaultBrowseRoot && !isAbsolutePath(path) ? joinPath(defaultBrowseRoot, path) : path

      if (mountedRef.current) setIsLoading(true)
      try {
        const response = await api.get<{
          content: string
          language?: string
          filePath?: string
        }>(`/api/files/read?path=${encodeURIComponent(resolvedPath)}`)

        const resolvedFilePath = response.filePath || resolvedPath
        const resolvedLanguage = response.language || detectLanguageFromPath(resolvedFilePath)
        const nextViewMode = resolveViewMode(resolvedFilePath, resolvedLanguage)

        updateContent({
          filePath: resolvedFilePath,
          language: resolvedLanguage,
          content: response.content,
          viewMode: nextViewMode,
        })

        if (!mountedRef.current) return

        setEditorValue(response.content)
        setCurrentLanguage(resolvedLanguage)
        setCurrentViewMode(nextViewMode)
        pendingContent.current = response.content

        if (editorRef.current) {
          const model = editorRef.current.getModel()
          if (model) {
            const monaco = (window as any).monaco
            if (monaco?.editor?.setModelLanguage) {
              monaco.editor.setModelLanguage(model, resolvedLanguage)
            }
          }
        }

        setSuggestions([])
      } catch (err) {
        if (!mountedRef.current) return
        const message = err instanceof Error ? err.message : String(err)
        log.error(
          JSON.stringify({
            severity: 'error',
            event: 'editor_file_load_failed',
            error: message,
          })
        )
      } finally {
        if (mountedRef.current) setIsLoading(false)
      }
    },
    [defaultBrowseRoot, updateContent]
  )

  // Auto-fetch file content on mount if filePath is set but content is empty.
  // This handles restoration from localStorage where content is stripped to save space.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    if (filePath && !content) {
      restoredRef.current = true
      handlePathSelect(filePath)
    }
  }, [filePath, content, handlePathSelect])

  const handleFileInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      if (!file) return

      fileHandleRef.current = null
      setIsLoading(true)
      try {
        let fileContent: string
        if (typeof file.text === 'function') {
          fileContent = await file.text()
        } else {
          fileContent = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(new Error('Failed to read file'))
            reader.onload = () => resolve(String(reader.result || ''))
            reader.readAsText(file)
          })
        }

        const detectedLanguage = detectLanguageFromPath(file.name)
        const nextViewMode = resolveViewMode(null, detectedLanguage)

        updateContent({
          filePath: null,
          language: detectedLanguage,
          readOnly: false,
          content: fileContent,
          viewMode: nextViewMode,
        })

        setEditorValue(fileContent)
        setCurrentLanguage(detectedLanguage)
        setCurrentViewMode(nextViewMode)
        pendingContent.current = fileContent

        if (editorRef.current) {
          const model = editorRef.current.getModel()
          if (model) {
            const monaco = (window as any).monaco
            if (monaco?.editor?.setModelLanguage) {
              monaco.editor.setModelLanguage(model, detectedLanguage)
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(
          JSON.stringify({
            severity: 'error',
            event: 'editor_file_picker_failed',
            error: message,
          })
        )
      } finally {
        setIsLoading(false)
      }
    },
    [updateContent]
  )

  const handleOpenFilePicker = useCallback(async () => {
    const picker = (window as Window & {
      showOpenFilePicker?: (options?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>
    }).showOpenFilePicker

    if (!picker) {
      setFilePickerMessage('Native file picker is unavailable. Use the path field instead.')
      log.warn(
        JSON.stringify({
          severity: 'warn',
          event: 'editor_file_picker_unavailable',
        })
      )
      const input = fileInputRef.current
      if (input) {
        input.value = ''
        input.click()
      }
      return
    }

    setIsLoading(true)
    try {
      const handles = await picker({ multiple: false })
      const handle = handles?.[0]
      if (!handle) return

      fileHandleRef.current = handle
      const file = await handle.getFile()
      const resolvedName = handle.name || file.name

      let fileContent: string
      if (typeof file.text === 'function') {
        fileContent = await file.text()
      } else {
        fileContent = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(new Error('Failed to read file'))
          reader.onload = () => resolve(String(reader.result || ''))
          reader.readAsText(file)
        })
      }

      const detectedLanguage = detectLanguageFromPath(resolvedName)
      const nextViewMode = resolveViewMode(resolvedName, detectedLanguage)

      updateContent({
        filePath: resolvedName || null,
        language: detectedLanguage,
        readOnly: false,
        content: fileContent,
        viewMode: nextViewMode,
      })

      setEditorValue(fileContent)
      setCurrentLanguage(detectedLanguage)
      setCurrentViewMode(nextViewMode)
      pendingContent.current = fileContent

      if (editorRef.current) {
        const model = editorRef.current.getModel()
        if (model) {
          const monaco = (window as any).monaco
          if (monaco?.editor?.setModelLanguage) {
            monaco.editor.setModelLanguage(model, detectedLanguage)
          }
        }
      }

      setSuggestions([])
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        JSON.stringify({
          severity: 'error',
          event: 'editor_file_picker_failed',
          error: message,
        })
      )
      setFilePickerMessage('Unable to open the native file picker.')
    } finally {
      setIsLoading(false)
    }
  }, [updateContent])

  const scheduleAutoSave = useCallback(
    (value: string) => {
      if (readOnly) return
      if (!filePath && !fileHandleRef.current) return

      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current)
      }

      autoSaveTimer.current = setTimeout(async () => {
        try {
          const handle = fileHandleRef.current
          if (handle?.createWritable) {
            const writable = await handle.createWritable()
            await writable.write(value)
            await writable.close()
            return
          }

          if (filePath) {
            const resolved = resolvePath(filePath)
            if (!resolved) return
            await api.post('/api/files/write', {
              path: resolved,
              content: value,
            })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error(
            JSON.stringify({
              severity: 'error',
              event: 'editor_autosave_failed',
              error: message,
            })
          )
        }
      }, AUTO_SAVE_DELAY)
    },
    [filePath, readOnly, resolvePath]
  )

  const performSave = useCallback(async () => {
    if (readOnly) return
    if (!filePath && !fileHandleRef.current) return
    const value = pendingContent.current
    try {
      const handle = fileHandleRef.current
      if (handle?.createWritable) {
        const writable = await handle.createWritable()
        await writable.write(value)
        await writable.close()
        return
      }
      if (filePath) {
        const resolved = resolvePath(filePath)
        if (!resolved) return
        await api.post('/api/files/write', {
          path: resolved,
          content: value,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        JSON.stringify({
          severity: 'error',
          event: 'editor_manual_save_failed',
          error: message,
        })
      )
    }
  }, [filePath, readOnly, resolvePath])

  const openSystemViewer = useCallback(async (reveal: boolean) => {
    const resolved = resolvePath(filePath)
    if (!resolved) return
    try {
      await api.post('/api/files/open', { path: resolved, reveal })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        JSON.stringify({
          severity: 'error',
          event: 'editor_open_external_failed',
          error: message,
        })
      )
    }
  }, [filePath, resolvePath])

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const newValue = value ?? ''
      setEditorValue(newValue)
      pendingContent.current = newValue
      updateContent({ content: newValue })
      scheduleAutoSave(newValue)
    },
    [updateContent, scheduleAutoSave]
  )

  const handleToggleViewMode = useCallback(() => {
    const nextMode = currentViewMode === 'source' ? 'preview' : 'source'
    setCurrentViewMode(nextMode)
    updateContent({ viewMode: nextMode })
  }, [currentViewMode, updateContent])

  useEffect(() => {
    return registerEditorActions(paneId, {
      cut: () => editorRef.current?.getAction('editor.action.clipboardCutAction')?.run(),
      copy: () => editorRef.current?.getAction('editor.action.clipboardCopyAction')?.run(),
      paste: () => editorRef.current?.getAction('editor.action.clipboardPasteAction')?.run(),
      selectAll: () => editorRef.current?.getAction('editor.action.selectAll')?.run(),
      saveNow: performSave,
      togglePreview: handleToggleViewMode,
      copyPath: async () => {
        const resolved = resolvePath(filePath)
        if (resolved) await copyText(resolved)
      },
      revealInExplorer: () => openSystemViewer(true),
      openWithSystemViewer: () => openSystemViewer(false),
    })
  }, [paneId, performSave, handleToggleViewMode, filePath, resolvePath, openSystemViewer])

  return (
    <div
      className="h-full w-full flex flex-col"
      data-testid="editor-pane"
      data-context={ContextIds.Editor}
      data-pane-id={paneId}
      data-tab-id={tabId}
    >
      <div className="flex items-center border-b border-border">
        <div className="flex-1">
          <EditorToolbar
            filePath={filePath}
            onPathChange={handlePathChange}
            onPathSelect={handlePathSelect}
            onOpenFilePicker={handleOpenFilePicker}
            suggestions={suggestions}
            viewMode={currentViewMode}
            onViewModeToggle={handleToggleViewMode}
            showViewToggle={showPreviewToggle}
            defaultBrowseRoot={defaultBrowseRoot}
            inputRef={pathInputRef}
          />
        </div>
      </div>
      {filePickerMessage && (
        <div className="px-3 py-1 text-xs text-muted-foreground" role="status">
          {filePickerMessage}
        </div>
      )}
      <div className="flex-1 relative">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
            <div className="text-sm text-muted-foreground">Loading file...</div>
          </div>
        )}
        {showEmptyState ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
              onClick={() => pathInputRef.current?.focus()}
            >
              Open File
            </button>
            <span className="text-sm">or start typing to create a scratch pad</span>
          </div>
        ) : currentViewMode === 'preview' && showPreviewToggle ? (
          isHtmlPreview ? (
            <iframe
              title="HTML preview"
              className="h-full w-full border-0"
              sandbox=""
              srcDoc={editorValue}
            />
          ) : (
            <MarkdownPreview content={editorValue} language="markdown" />
          )
        ) : (
          <Editor
            height="100%"
            language={editorLanguage}
            value={editorValue}
            theme="vs-dark"
            onMount={handleEditorMount}
            onChange={handleEditorChange}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              readOnly,
            }}
          />
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        data-testid="file-input"
        onChange={handleFileInputChange}
      />
    </div>
  )
}
