import { useRef, useState, useCallback, useEffect, useMemo, type ChangeEvent } from 'react'
import { Editor } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { getSystemPrefersDark } from '@/lib/theme-utils'
import { updatePaneContent } from '@/store/panesSlice'
import type { EditorPaneContent } from '@/store/paneTypes'
import EditorToolbar from './EditorToolbar'
import MarkdownPreview from './MarkdownPreview'
import { api, isTransientRequestFailure } from '@/lib/api'
import { getFirstTerminalCwd } from '@/lib/pane-utils'
import { isAbsolutePath, joinPath } from '@/lib/path-utils'
import { copyText } from '@/lib/clipboard'
import { registerEditorActions } from '@/lib/pane-action-registry'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { createLogger } from '@/lib/client-logger'


const log = createLogger('EditorPane')

function useMonacoTheme(): 'vs-dark' | 'vs' {
  const theme = useAppSelector((s) => s.settings.settings.theme)
  const isDark =
    theme === 'dark' ? true : theme === 'light' ? false : getSystemPrefersDark()
  return isDark ? 'vs-dark' : 'vs'
}

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
  wordWrap?: boolean
}

export default function EditorPane({
  paneId,
  tabId,
  filePath,
  language,
  readOnly = false,
  content,
  viewMode = 'source',
  wordWrap = true,
}: EditorPaneProps) {
  const dispatch = useAppDispatch()
  const monacoTheme = useMonacoTheme()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const defaultCwd = useAppSelector((s) => s.settings.settings.defaultCwd)
  // The disk-sync poll (below) only makes sense while the server is reachable.
  // Gating on the WS-derived connection status means an expected server restart
  // pauses polling instead of hammering a dead endpoint and flooding the logs.
  const connectionStatus = useAppSelector((s) => s.connection.status)
  // Latest-value mirror so async catch handlers can re-check connectivity as of
  // *now* (the effect closure's value may be stale if the server died mid-poll).
  // Written during render rather than in an effect deliberately: effects run
  // after paint, and that wider window let handlers read a stale 'ready' after
  // the WS had already observed a disconnect. The write is idempotent, so
  // StrictMode double-renders are harmless.
  const connectionStatusRef = useRef(connectionStatus)
  connectionStatusRef.current = connectionStatus
  // Failures that are expected during a server outage: the request failed
  // transiently (unreachable / gateway 502-504 / aborted), or the WS has
  // already observed the disconnect. Applies ONLY to server API calls — never
  // to local File System Access writes, which don't involve the server.
  const isExpectedOutageFailure = useCallback(
    (err: unknown) => isTransientRequestFailure(err) || connectionStatusRef.current !== 'ready',
    []
  )
  const editorFontSize = useAppSelector((s) => s.settings.settings.terminal?.fontSize) ?? 16
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

  const lastSavedContent = useRef<string>(content)
  const lastKnownMtime = useRef<string | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const [conflictState, setConflictState] = useState<{
    diskContent: string
    diskMtime: string
  } | null>(null)

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
        setTerminalCwds({})
        // A transient transport/gateway failure (server unreachable/restarting)
        // is expected — don't log it as an error.
        if (isTransientRequestFailure(err)) return
        const message = err instanceof Error ? err.message : String(err)
        log.error(
          JSON.stringify({
            severity: 'error',
            event: 'editor_terminal_list_fetch_failed',
            error: message,
          })
        )
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
          setSuggestions([])
          // A transient transport/gateway failure (server unreachable/restarting)
          // is expected — don't log it as an error.
          if (isTransientRequestFailure(err)) return
          const message = err instanceof Error ? err.message : String(err)
          log.error(
            JSON.stringify({
              severity: 'error',
              event: 'editor_autocomplete_failed',
              error: message,
            })
          )
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
      wordWrap: boolean
    }>) => {
      const nextContent: EditorPaneContent = {
        kind: 'editor',
        filePath: updates.filePath !== undefined ? updates.filePath : filePath,
        language: updates.language !== undefined ? updates.language : currentLanguage,
        readOnly: updates.readOnly !== undefined ? updates.readOnly : readOnly,
        content: updates.content !== undefined ? updates.content : editorValue,
        viewMode: updates.viewMode !== undefined ? updates.viewMode : currentViewMode,
        wordWrap: updates.wordWrap !== undefined ? updates.wordWrap : wordWrap,
      }

      dispatch(
        updatePaneContent({
          tabId,
          paneId,
          content: nextContent,
        })
      )
    },
    [dispatch, tabId, paneId, filePath, currentLanguage, readOnly, editorValue, currentViewMode, wordWrap]
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
          modifiedAt?: string
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
        lastSavedContent.current = response.content
        lastKnownMtime.current = response.modifiedAt || null

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
        // A transient failure (server unreachable/restarting or gateway 5xx), or
        // one that coincided with the WS observing a disconnect, is expected —
        // don't surface it as an error. The disk-sync poll re-reads once the
        // connection is back; only genuinely unexpected failures are logged.
        if (isExpectedOutageFailure(err)) return
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
    [defaultBrowseRoot, updateContent, isExpectedOutageFailure]
  )

  // Auto-fetch file content on mount if filePath is set but content is empty.
  // This handles restoration from localStorage where content is stripped to save space.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    // Wait for the server to be reachable before restoring — a fetch against a
    // down/restarting server can only fail. Not marking restoredRef keeps the
    // restore pending; this effect re-runs when the connection becomes ready.
    if (connectionStatus !== 'ready') return
    if (filePath && !content) {
      restoredRef.current = true
      handlePathSelect(filePath)
    }
  }, [filePath, content, handlePathSelect, connectionStatus])

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
        const handle = fileHandleRef.current
        if (handle?.createWritable) {
          // Local File System Access write — the server plays no part here, so
          // failures (permissions, quota) are never outage-related: always log.
          try {
            const writable = await handle.createWritable()
            await writable.write(value)
            await writable.close()
            lastSavedContent.current = value
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
          return
        }

        if (!filePath) return
        const resolved = resolvePath(filePath)
        if (!resolved) return
        try {
          const saveResult = await api.post<{ success: boolean; modifiedAt?: string }>('/api/files/write', {
            path: resolved,
            content: value,
          })
          lastKnownMtime.current = saveResult?.modifiedAt || null
          lastSavedContent.current = value
        } catch (err) {
          // Expected while the server is restarting: stay silent. While the
          // pane stays mounted the edit is kept in pendingContent, and the
          // reconnect effect below re-schedules this save once the connection
          // returns (further typing re-schedules it too).
          if (isExpectedOutageFailure(err)) return
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
    [filePath, readOnly, resolvePath, isExpectedOutageFailure]
  )

  // Retry a pending (unsaved) edit once the connection returns — but only after
  // confirming the file did NOT change on disk during the outage. If it did,
  // stay hands-off: the disk-sync poll raises the conflict UI within one tick
  // and the user decides. Without this stat guard, the retried write could race
  // the poll and silently overwrite external changes (e.g. a git checkout that
  // happened while the server was down).
  // Local File System Access files are excluded: their writes never touch the
  // server, so an outage cannot have failed them.
  useEffect(() => {
    if (connectionStatus !== 'ready') return
    if (fileHandleRef.current) return
    if (conflictState) return
    if (pendingContent.current === lastSavedContent.current) return
    if (!filePath) return
    const resolved = resolvePath(filePath)
    if (!resolved) return

    let cancelled = false
    void (async () => {
      try {
        const statResult = await api.get<{ exists: boolean; modifiedAt: string | null }>(
          `/api/files/stat?path=${encodeURIComponent(resolved)}`
        )
        if (cancelled || !mountedRef.current) return
        // Disk changed while we were away: leave it to the poll's conflict flow.
        if (statResult.exists && statResult.modifiedAt !== lastKnownMtime.current) return
        scheduleAutoSave(pendingContent.current)
      } catch {
        // Transient failure right after reconnect: leave the edit pending; the
        // next keystroke or reconnect re-triggers this path.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connectionStatus, conflictState, filePath, resolvePath, scheduleAutoSave])

  const performSave = useCallback(async () => {
    if (readOnly) return
    if (!filePath && !fileHandleRef.current) return
    const value = pendingContent.current
    const handle = fileHandleRef.current
    if (handle?.createWritable) {
      // Local File System Access write — never outage-related: always log.
      try {
        const writable = await handle.createWritable()
        await writable.write(value)
        await writable.close()
        lastSavedContent.current = value
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
      return
    }
    if (!filePath) return
    const resolved = resolvePath(filePath)
    if (!resolved) return
    try {
      const saveResult = await api.post<{ success: boolean; modifiedAt?: string }>('/api/files/write', {
        path: resolved,
        content: value,
      })
      lastKnownMtime.current = saveResult?.modifiedAt || null
      lastSavedContent.current = value
    } catch (err) {
      // Same policy as autosave: a transient failure during an outage is
      // expected and the pending edit is retried on reconnect.
      if (isExpectedOutageFailure(err)) return
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        JSON.stringify({
          severity: 'error',
          event: 'editor_manual_save_failed',
          error: message,
        })
      )
    }
  }, [filePath, readOnly, resolvePath, isExpectedOutageFailure])

  const openInEditor = useCallback(async (reveal: boolean) => {
    const resolved = resolvePath(filePath)
    if (!resolved) return

    // Read cursor position from Monaco editor
    const position = editorRef.current?.getPosition()

    try {
      await api.post('/api/files/open', {
        path: resolved,
        reveal,
        line: position?.lineNumber,
        column: position?.column,
      })
    } catch (err) {
      // A transient failure while the server is unreachable is expected — the
      // user can retry once it's back; only unexpected failures are logged.
      if (isExpectedOutageFailure(err)) return
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        JSON.stringify({
          severity: 'error',
          event: 'editor_open_external_failed',
          error: message,
        })
      )
    }
  }, [filePath, resolvePath, isExpectedOutageFailure])

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

  const handleToggleWordWrap = useCallback(() => {
    const next = !wordWrap
    updateContent({ wordWrap: next })
  }, [wordWrap, updateContent])

  const handleReloadFromDisk = useCallback(() => {
    if (!conflictState) return
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = null
    }
    setEditorValue(conflictState.diskContent)
    pendingContent.current = conflictState.diskContent
    lastSavedContent.current = conflictState.diskContent
    lastKnownMtime.current = conflictState.diskMtime
    updateContent({ content: conflictState.diskContent })
    setConflictState(null)
  }, [conflictState, updateContent])

  const handleKeepLocal = useCallback(() => {
    if (!conflictState) return
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = null
    }
    lastKnownMtime.current = conflictState.diskMtime
    setConflictState(null)
    scheduleAutoSave(pendingContent.current)
  }, [conflictState, scheduleAutoSave])

  useEffect(() => {
    if (!filePath) return
    if (fileHandleRef.current) return
    // Pause disk-sync polling while the server is known-unreachable (e.g. a
    // restart). There is nothing to sync from a server that is down, and polling
    // it only produces transport failures. Polling resumes automatically when
    // the connection returns to 'ready' (this effect re-runs on that change).
    if (connectionStatus !== 'ready') return

    const poll = async () => {
      if (!mountedRef.current) return
      if (conflictState) return

      const resolved = resolvePath(filePath)
      if (!resolved) return

      try {
        const statResult = await api.get<{
          exists: boolean
          size: number | null
          modifiedAt: string | null
        }>(`/api/files/stat?path=${encodeURIComponent(resolved)}`)

        if (!mountedRef.current) return

        if (!statResult.exists || !statResult.modifiedAt) return
        if (statResult.modifiedAt === lastKnownMtime.current) return

        const wasClean = pendingContent.current === lastSavedContent.current
        const response = await api.get<{
          content: string
          language?: string
          filePath?: string
          modifiedAt?: string
        }>(`/api/files/read?path=${encodeURIComponent(resolved)}`)

        if (!mountedRef.current) return

        const stillClean = pendingContent.current === lastSavedContent.current
        if (wasClean && stillClean) {
          setEditorValue(response.content)
          pendingContent.current = response.content
          lastSavedContent.current = response.content
          lastKnownMtime.current = response.modifiedAt || null

          updateContent({
            content: response.content,
          })
        } else {
          if (autoSaveTimer.current) {
            clearTimeout(autoSaveTimer.current)
            autoSaveTimer.current = null
          }
          setConflictState({
            diskContent: response.content,
            diskMtime: response.modifiedAt || statResult.modifiedAt!,
          })
        }
      } catch (err) {
        // Expected during a restart/outage: either the request failed transiently
        // (server unreachable / gateway 502-504), or the server died mid-poll and
        // the WS has since observed the disconnect. Stay silent in both cases.
        // Only a genuinely unexpected failure while still connected is logged
        // (e.g. a bug processing the response — that must surface, not be eaten).
        if (isExpectedOutageFailure(err)) return
        const message = err instanceof Error ? err.message : String(err)
        log.error(
          JSON.stringify({
            severity: 'error',
            event: 'editor_stat_poll_failed',
            error: message,
          })
        )
      }
    }

    pollIntervalRef.current = setInterval(poll, 3000)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [filePath, resolvePath, conflictState, updateContent, connectionStatus, isExpectedOutageFailure])

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
      revealInExplorer: () => openInEditor(true),
      openInEditor: () => openInEditor(false),
    })
  }, [paneId, performSave, handleToggleViewMode, filePath, resolvePath, openInEditor])

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
            wordWrap={wordWrap}
            onWordWrapToggle={handleToggleWordWrap}
          />
        </div>
      </div>
      {filePickerMessage && (
        <div className="px-3 py-1 text-xs text-muted-foreground" role="status">
          {filePickerMessage}
        </div>
      )}
      {conflictState && (
        <div
          className="flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-sm"
          role="alert"
          data-testid="editor-conflict-banner"
        >
          <span className="flex-1 text-yellow-700 dark:text-yellow-400">
            File changed on disk
          </span>
          <button
            className="rounded px-2 py-1 text-xs font-medium bg-yellow-500/20 hover:bg-yellow-500/30"
            onClick={handleReloadFromDisk}
            aria-label="Reload file from disk"
          >
            Reload
          </button>
          <button
            className="rounded px-2 py-1 text-xs font-medium bg-muted hover:bg-muted/80"
            onClick={handleKeepLocal}
            aria-label="Keep local changes"
          >
            Keep Mine
          </button>
        </div>
      )}
      <div className="flex-1 relative min-h-0 overflow-hidden">
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
            <MarkdownPreview content={editorValue} />
          )
        ) : (
          <Editor
            height="100%"
            language={editorLanguage}
            value={editorValue}
            theme={monacoTheme}
            onMount={handleEditorMount}
            onChange={handleEditorChange}
            options={{
              minimap: { enabled: false },
              fontSize: editorFontSize,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              readOnly,
              wordWrap: wordWrap ? 'on' : 'off',
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
