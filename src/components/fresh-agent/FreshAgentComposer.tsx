import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Command, File, Folder, Loader2, Paperclip, Send, Square, X } from 'lucide-react'
import { api } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'
import { useCoarsePointer } from '@/lib/pointer'
import { cn } from '@/lib/utils'
import type { FreshAgentSlashCommand } from '@shared/fresh-agent-slash-commands'

export type FreshAgentAttachment = {
  /** Server-side saved path, present once uploaded. */
  path?: string
  name: string
  bytes: number
  status: 'uploading' | 'ready' | 'error'
  error?: string
}

type FreshAgentComposerProps = {
  disabled?: boolean
  /** State-aware input placeholder (starting / busy / ended / read-only). */
  placeholder?: string
  storageKey?: string
  /** Stable key for prompt history persistence (per session type). */
  historyKey?: string
  /** Working directory used to resolve @ file mentions. */
  cwd?: string
  /** Runtime provider, used to filter attachment types the model can read natively. */
  provider?: 'claude' | 'codex' | 'opencode'
  /** Messages queued while the agent is running (owned by the view). */
  queuedMessages?: readonly string[]
  onCancelQueued?: (index: number) => void
  onSend?: (value: string, attachmentPaths: string[]) => void
  /** `!command` shell escape; absent = feature hidden. */
  onShellCommand?: (command: string) => void
  onInterrupt?: () => void
  canInterrupt?: boolean
  commands?: readonly FreshAgentSlashCommand[]
  onCommand?: (command: FreshAgentSlashCommand, args: string) => void
  focusOnReady?: boolean
  thinking?: boolean
}

export type FreshAgentComposerHandle = {
  focus: () => void
  insertText: (text: string) => void
  appendText: (text: string) => void
}

type MenuMode = 'chat' | 'browse' | 'files'

type FileSuggestion = {
  path: string
  isDirectory: boolean
}

const HISTORY_LIMIT = 50
const TEXTUAL_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'bash',
  'sql', 'diff', 'patch', 'log',
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * Attachments land on disk and are referenced by path, so anything textual is
 * readable by every provider's file tools. Native media support is what varies.
 */
export function attachmentRejection(provider: string | undefined, filename: string): string | null {
  // Extensionless files (Makefile, Dockerfile, LICENSE…) are treated as text.
  if (!filename.includes('.')) return null
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (TEXTUAL_EXTENSIONS.has(ext)) return null
  if (IMAGE_EXTENSIONS.has(ext)) return null
  if (ext === 'pdf') {
    return provider === 'claude' ? null : `this model can’t read .pdf — remove it or switch model`
  }
  return `.${ext} isn’t supported — attach images, PDFs (claude), or text files`
}

function getCommandPrefix(value: string): string | null {
  if (!value.startsWith('/')) return null
  const withoutSlash = value.slice(1)
  if (/\s/.test(withoutSlash)) return null
  return withoutSlash.toLowerCase()
}

function parseSlashCommand(value: string): { name: string; args: string } | null {
  if (!value.startsWith('/')) return null
  const match = value.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1].toLowerCase(), args: match[2]?.trim() ?? '' }
}

/** Trailing `@token` (start-of-text or whitespace-preceded, no spaces inside). */
function getMentionToken(value: string): { start: number; token: string } | null {
  const match = value.match(/(^|\s)@([^\s@]*)$/)
  if (!match) return null
  const start = value.length - match[2].length - 1
  return { start, token: match[2] }
}

function relativizePath(path: string, cwd?: string): string {
  if (!cwd) return path
  const normalizedCwd = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  if (path === normalizedCwd) return '.'
  if (path.startsWith(`${normalizedCwd}/`)) return path.slice(normalizedCwd.length + 1)
  return path
}

function readHistory(historyKey?: string): string[] {
  if (!historyKey || typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(historyKey)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function writeHistory(historyKey: string | undefined, entries: string[]) {
  if (!historyKey || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(historyKey, JSON.stringify(entries.slice(0, HISTORY_LIMIT)))
  } catch {
    // Persistence is best-effort; recall just won't survive a reload.
  }
}

function isTextEntryElement(value: Element | null): boolean {
  if (!(value instanceof HTMLElement)) return false
  return Boolean(value.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

/**
 * Raw binary upload. Deliberately NOT base64-in-JSON: the server's global
 * express.json caps JSON bodies at 1mb, so attachments ship as
 * application/octet-stream (which the JSON parser ignores) with the filename
 * in the query string. Auth header matches src/lib/api.ts's request().
 */
async function uploadAttachment(file: globalThis.File): Promise<{ path: string; bytes: number }> {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' })
  const token = getAuthToken()
  if (token) headers.set('x-auth-token', token)
  const res = await fetch(`/api/fresh-agent/attachments?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
    headers,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string; message?: string } | null
    throw new Error(data?.error || data?.message || `upload failed (${res.status})`)
  }
  return res.json() as Promise<{ path: string; bytes: number }>
}

export const FreshAgentComposer = forwardRef<FreshAgentComposerHandle, FreshAgentComposerProps>(function FreshAgentComposer({
  disabled = false,
  storageKey,
  historyKey,
  cwd,
  provider,
  queuedMessages = [],
  onCancelQueued,
  onSend,
  onShellCommand,
  onInterrupt,
  canInterrupt = false,
  commands = [],
  onCommand,
  placeholder,
  focusOnReady = false,
  thinking = false,
}, ref) {
  const [text, setText] = useState(() => {
    if (!storageKey || typeof window === 'undefined') return ''
    return window.sessionStorage.getItem(storageKey) ?? ''
  })
  const [menuMode, setMenuMode] = useState<MenuMode | null>(null)
  const [filter, setFilter] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [attachments, setAttachments] = useState<FreshAgentAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const historyRef = useRef<string[]>(readHistory(historyKey))
  const completionRequestIdRef = useRef(0)
  // On touch keyboards Enter inserts a newline; the Send button sends. A
  // paired hardware keyboard on a phone still gets Esc/ArrowUp shortcuts —
  // only the Enter-to-send gesture is gated on pointer coarseness.
  const coarsePointer = useCoarsePointer()

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    insertText: (value: string) => {
      setText((current) => (current ? `${current.replace(/\s$/, '')} ${value}` : value))
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    appendText: (value: string) => {
      if (disabled) return
      setText((current) => `${current}${value}`)
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
  }), [disabled])

  const chatPrefix = getCommandPrefix(text)
  const mention = useMemo(() => getMentionToken(text), [text])
  const isShellInput = onShellCommand !== undefined && text.startsWith('!')
  const activeFilter = menuMode === 'chat' ? (chatPrefix ?? '') : filter.toLowerCase()
  const visibleCommands = useMemo(() => {
    const normalizedFilter = activeFilter.replace(/^\//, '')
    return commands.filter((command) => command.name.includes(normalizedFilter))
  }, [activeFilter, commands])
  const menuLength = menuMode === 'files' ? fileSuggestions.length : visibleCommands.length

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return
    if (text) {
      window.sessionStorage.setItem(storageKey, text)
    } else {
      window.sessionStorage.removeItem(storageKey)
    }
  }, [storageKey, text])

  useEffect(() => {
    if (!focusOnReady || disabled) return
    const frame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const active = document.activeElement
      if (active && active !== document.body && active !== textarea && isTextEntryElement(active)) return
      textarea.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusOnReady, disabled])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(180, Math.max(40, textarea.scrollHeight))}px`
  }, [text])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [activeFilter, fileSuggestions])

  useEffect(() => {
    if (mention !== null) {
      setMenuMode('files')
      return
    }
    if (chatPrefix !== null && text.startsWith('/')) {
      setMenuMode('chat')
      return
    }
    if (menuMode === 'chat' || menuMode === 'files') {
      setMenuMode(null)
      setFileSuggestions([])
    }
  }, [chatPrefix, mention, menuMode, text])

  // Debounced @ mention completion against the files API, anchored at the
  // session cwd. Mirrors DirectoryPicker's request-id guard so stale responses
  // never clobber newer ones.
  useEffect(() => {
    if (mention === null) return
    completionRequestIdRef.current += 1
    const requestId = completionRequestIdRef.current
    let cancelled = false
    const base = cwd ? `${cwd.replace(/\/$/, '')}/` : ''
    const prefix = `${base}${mention.token}`
    const timer = setTimeout(() => {
      if (cancelled || completionRequestIdRef.current !== requestId) return
      void Promise
        .resolve(api.get<{ suggestions?: FileSuggestion[] }>(
          `/api/files/complete?prefix=${encodeURIComponent(prefix)}`
        ))
        .then((result) => {
          if (cancelled || completionRequestIdRef.current !== requestId) return
          setFileSuggestions((result?.suggestions ?? []).slice(0, 15))
        })
        .catch(() => {
          if (cancelled || completionRequestIdRef.current !== requestId) return
          setFileSuggestions([])
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cwd, mention])

  useEffect(() => {
    if (menuMode === 'browse') {
      requestAnimationFrame(() => filterRef.current?.focus())
    }
  }, [menuMode])

  const closeMenu = useCallback(() => {
    setMenuMode(null)
    setFilter('')
    setHighlightedIndex(0)
    setFileSuggestions([])
  }, [])

  const pushHistory = useCallback((value: string) => {
    const next = [value, ...historyRef.current.filter((entry) => entry !== value)].slice(0, HISTORY_LIMIT)
    historyRef.current = next
    writeHistory(historyKey, next)
    setHistoryIndex(-1)
  }, [historyKey])

  const executeCommand = useCallback((command: FreshAgentSlashCommand, args = '') => {
    // /new must stay reachable when the session is dead and the composer is
    // disabled — it's the way out of an ended session.
    if (disabled && command.action !== 'new') return
    onCommand?.(command, args)
    pushHistory(args ? `/${command.name} ${args}` : `/${command.name}`)
    setText('')
    closeMenu()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [closeMenu, disabled, onCommand, pushHistory])

  const executeSlashText = useCallback((value: string): boolean => {
    const parsed = parseSlashCommand(value)
    if (!parsed) return false
    const command = commands.find((entry) => (
      entry.name === parsed.name || entry.aliases?.includes(parsed.name)
    ))
    if (!command) return false
    executeCommand(command, parsed.args)
    return true
  }, [commands, executeCommand])

  const insertFileSuggestion = useCallback((suggestion: FileSuggestion) => {
    if (mention === null) return
    const relative = relativizePath(suggestion.path, cwd)
    const insertion = suggestion.isDirectory ? `${relative}/` : `${relative} `
    const replaceStart = suggestion.isDirectory ? mention.start + 1 : mention.start
    setText((value) => `${value.slice(0, replaceStart)}${insertion}`)
    if (!suggestion.isDirectory) {
      closeMenu()
    }
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [closeMenu, cwd, mention])

  const addFiles = useCallback((files: Iterable<globalThis.File>) => {
    for (const file of files) {
      const rejection = attachmentRejection(provider, file.name)
      if (rejection) {
        setAttachments((current) => [...current, {
          name: file.name,
          bytes: file.size,
          status: 'error',
          error: rejection,
        }])
        continue
      }
      const placeholder: FreshAgentAttachment = { name: file.name, bytes: file.size, status: 'uploading' }
      setAttachments((current) => [...current, placeholder])
      void uploadAttachment(file)
        .then((result) => {
          setAttachments((current) => current.map((entry) => (
            entry === placeholder ? { ...entry, status: 'ready', path: result.path } : entry
          )))
        })
        .catch((error: unknown) => {
          setAttachments((current) => current.map((entry) => (
            entry === placeholder
              ? { ...entry, status: 'error', error: error instanceof Error ? error.message : 'upload failed' }
              : entry
          )))
        })
    }
  }, [provider])

  const sendText = useCallback(() => {
    const trimmed = text.trim()
    if (disabled) return
    if (isShellInput && trimmed.length > 1) {
      onShellCommand?.(trimmed.slice(1).trim())
      pushHistory(trimmed)
      setText('')
      closeMenu()
      return
    }
    const readyAttachments = attachments.filter((entry) => entry.status === 'ready' && entry.path)
    if (!trimmed && readyAttachments.length === 0) return
    if (attachments.some((entry) => entry.status === 'uploading')) return
    if (trimmed.startsWith('/') && executeSlashText(trimmed)) return
    onSend?.(trimmed, readyAttachments.map((entry) => entry.path as string))
    if (trimmed) pushHistory(trimmed)
    setAttachments((current) => current.filter((entry) => entry.status === 'error'))
    setText('')
    closeMenu()
  }, [attachments, closeMenu, disabled, executeSlashText, isShellInput, onSend, onShellCommand, pushHistory, text])

  const recallHistory = useCallback((direction: 1 | -1): boolean => {
    const history = historyRef.current
    if (history.length === 0) return false
    if (direction === 1) {
      const next = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(next)
      setText(history[next])
      return true
    }
    if (historyIndex < 0) return false
    const next = historyIndex - 1
    setHistoryIndex(next)
    setText(next < 0 ? '' : history[next])
    return true
  }, [historyIndex])

  const handleMenuKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!menuMode) return false
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(index + 1, Math.max(menuLength - 1, 0)))
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.max(index - 1, 0))
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      requestAnimationFrame(() => textareaRef.current?.focus())
      return true
    }
    if (event.key === 'Enter' || (event.key === 'Tab' && menuMode === 'files')) {
      if (menuMode === 'files') {
        event.preventDefault()
        const selected = fileSuggestions[highlightedIndex]
        if (selected) insertFileSuggestion(selected)
        return true
      }
      event.preventDefault()
      const selected = visibleCommands[highlightedIndex]
      if (selected) {
        if (menuMode === 'chat') {
          const executed = executeSlashText(text.trim())
          if (!executed) executeCommand(selected)
        } else {
          executeCommand(selected)
        }
      }
      return true
    }
    if (event.key === 'Tab' && menuMode === 'chat') {
      event.preventDefault()
      const selected = visibleCommands[highlightedIndex]
      if (selected) {
        setText(`/${selected.name} `)
        closeMenu()
      }
      return true
    }
    return false
  }, [
    closeMenu,
    executeCommand,
    executeSlashText,
    fileSuggestions,
    highlightedIndex,
    insertFileSuggestion,
    menuLength,
    menuMode,
    text,
    visibleCommands,
  ])

  return (
    <form
      className="fresh-agent-composer relative border-t border-border/60 p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] sm:pb-3"
      onSubmit={(event) => {
        event.preventDefault()
        sendText()
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
      }}
    >
      {menuMode && menuLength > 0 ? (
        <div
          className="absolute bottom-full left-3 mb-2 w-[min(420px,calc(100%-1.5rem))] overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-lg"
          role="menu"
          aria-label={menuMode === 'files' ? 'File suggestions' : 'Slash commands'}
        >
          {menuMode === 'browse' ? (
            <div className="border-b border-border/60 p-2">
              <input
                ref={filterRef}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={handleMenuKeyDown}
                className="w-full rounded border border-border/70 bg-background px-2 py-1 text-sm outline-none"
                aria-label="Filter slash commands"
                placeholder="Filter commands..."
              />
            </div>
          ) : null}
          <div className="max-h-[45vh] overflow-auto overscroll-contain py-1 sm:max-h-72">
            {menuMode === 'files' ? fileSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.path}
                type="button"
                role="menuitem"
                className={[
                  'flex min-h-[2.75rem] w-full items-center gap-2 px-3 py-1.5 text-left text-sm sm:min-h-0',
                  index === highlightedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                ].join(' ')}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => insertFileSuggestion(suggestion)}
              >
                {suggestion.isDirectory
                  ? <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  : <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                <span className="truncate font-mono text-xs">{relativizePath(suggestion.path, cwd)}</span>
              </button>
            )) : visibleCommands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="menuitem"
                className={[
                  'flex min-h-[2.75rem] w-full flex-col justify-center px-3 py-2 text-left text-sm sm:min-h-0',
                  index === highlightedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                ].join(' ')}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => executeCommand(command)}
              >
                <span className="font-medium">/{command.name}</span>
                <span className="text-xs text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-3 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
            <span>Arrow keys navigate</span>
            <span>Enter {menuMode === 'files' ? 'inserts' : 'runs'}</span>
            {menuMode === 'chat' ? <span>Tab completes</span> : null}
            {menuMode === 'files' ? <span>Tab inserts</span> : null}
          </div>
        </div>
      ) : null}

      {queuedMessages.length > 0 ? (
        <div className="mb-2 space-y-1" role="list" aria-label="Queued messages">
          {queuedMessages.map((message, index) => (
            <div
              key={`${index}-${message.slice(0, 16)}`}
              role="listitem"
              className="flex items-center gap-2 rounded-md border border-dashed border-border/70 px-2 py-1 text-xs text-muted-foreground"
            >
              <span className="shrink-0">queued</span>
              <span className="min-w-0 flex-1 truncate">{message}</span>
              {onCancelQueued ? (
                <button
                  type="button"
                  className="-m-2 shrink-0 p-2 hover:text-destructive sm:m-0 sm:p-0"
                  aria-label={`Remove queued message ${index + 1}`}
                  onClick={() => onCancelQueued(index)}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5" role="list" aria-label="Attachments">
          {attachments.map((attachment, index) => (
            <span
              key={`${attachment.name}-${index}`}
              role="listitem"
              className={cn(
                'inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs',
                attachment.status === 'error'
                  ? 'border-destructive/60 text-destructive'
                  : 'border-border/70 text-muted-foreground',
              )}
              title={attachment.error ?? attachment.path ?? attachment.name}
            >
              {attachment.status === 'uploading' ? <Loader2 className="h-3 w-3 animate-spin" aria-label="uploading" /> : null}
              <span className="truncate">{attachment.name}</span>
              {attachment.status === 'error' ? <span className="truncate">— {attachment.error}</span> : null}
              <button
                type="button"
                className="-m-2 shrink-0 p-2 hover:text-destructive sm:m-0 sm:p-0"
                aria-label={`Remove attachment ${attachment.name}`}
                onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div
        className="mb-2 flex h-[0.5em] justify-center"
        aria-hidden="true"
        data-state={thinking ? 'active' : 'idle'}
        data-testid="fresh-agent-thinking-bar"
      >
        <div
          className={cn(
            'h-full w-[80%] overflow-hidden rounded-sm bg-muted/50 transition-opacity duration-150',
            thinking ? 'opacity-100' : 'opacity-0',
          )}
        >
          <div className="fresh-agent-thinking-gradient h-full w-2/5" />
        </div>
      </div>

      <div className="fresh-agent-composer-row">
        <textarea
          ref={textareaRef}
          name="message"
          aria-label="Chat message input"
          disabled={disabled}
          rows={1}
          value={text}
          placeholder={placeholder ?? (disabled ? 'Read-only session' : 'Send a message — / commands, @ files, ! shell')}
          className={cn(
            // text-base at small sizes prevents iOS Safari's zoom-on-focus.
            'max-h-44 min-h-[44px] flex-1 resize-none rounded-md border border-border/70 bg-background px-3 py-2 text-base outline-none sm:min-h-[40px] sm:text-sm',
            isShellInput && 'border-warning/60 font-mono',
          )}
          onChange={(event) => {
            setText(event.target.value)
            setHistoryIndex(-1)
          }}
          onPaste={(event) => {
            if (event.clipboardData?.files?.length) {
              event.preventDefault()
              addFiles(event.clipboardData.files)
            }
          }}
          onKeyDown={(event) => {
            if (handleMenuKeyDown(event)) return
            if (event.key === 'ArrowUp' && (text === '' || historyIndex >= 0)) {
              if (recallHistory(1)) {
                event.preventDefault()
                return
              }
            }
            if (event.key === 'ArrowDown' && historyIndex >= 0) {
              if (recallHistory(-1)) {
                event.preventDefault()
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !coarsePointer) {
              event.preventDefault()
              sendText()
            }
            if (event.key === 'Escape' && canInterrupt) {
              event.preventDefault()
              onInterrupt?.()
            }
          }}
        />
        <div className="fresh-agent-composer-actions">
          <button
            type="button"
            disabled={disabled}
            className="fresh-agent-composer-action inline-flex h-11 w-11 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:w-9"
            aria-label="Attach files"
            title="Attach files — images, PDFs (claude), and text files"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onInterrupt}
            disabled={!canInterrupt}
            tabIndex={canInterrupt ? undefined : -1}
            aria-hidden={canInterrupt ? undefined : true}
            className={cn(
              'fresh-agent-composer-action inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-background text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:w-10',
              !canInterrupt && 'invisible',
            )}
            aria-label="Stop"
          >
            <Square className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={commands.length === 0}
            className="fresh-agent-composer-action inline-flex h-11 w-11 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:w-9"
            aria-label="Slash commands"
            onClick={() => {
              setMenuMode((mode) => mode === 'browse' ? null : 'browse')
              setFilter('')
            }}
          >
            <Command className="h-4 w-4" />
          </button>
          <button
            type="submit"
            disabled={disabled}
            className="fresh-agent-composer-action inline-flex h-11 w-11 items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:w-10"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-hidden
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </form>
  )
})
