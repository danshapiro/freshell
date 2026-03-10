import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getDraft, setDraft, clearDraft } from '@/lib/draft-store'

export interface ChatComposerHandle {
  focus: () => void
}

interface ChatComposerProps {
  paneId?: string
  onSend: (text: string) => void
  onInterrupt: () => void
  disabled?: boolean
  isRunning?: boolean
  placeholder?: string
  autoFocus?: boolean
}

const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({ paneId, onSend, onInterrupt, disabled, isRunning, placeholder, autoFocus }, ref) {
  const [text, setText] = useState(() => (paneId ? getDraft(paneId) : ''))
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const resizeTextarea = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  // Resync text state and textarea height if paneId changes (component reused for a different pane)
  const prevPaneIdRef = useRef(paneId)
  useEffect(() => {
    if (paneId !== prevPaneIdRef.current) {
      prevPaneIdRef.current = paneId
      setText(paneId ? getDraft(paneId) : '')
      requestAnimationFrame(() => {
        if (textareaRef.current) resizeTextarea(textareaRef.current)
      })
    }
  }, [paneId, resizeTextarea])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }), [])

  // Auto-focus when the textarea becomes enabled (disabled transitions false).
  // At mount the textarea may be disabled (status='creating'), so we watch
  // the `disabled` prop and focus once it goes falsy — if autoFocus was requested.
  const autoFocusFiredRef = useRef(false)
  const textareaCallbackRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
  }, [])

  useEffect(() => {
    if (!autoFocus || disabled || autoFocusFiredRef.current) return
    autoFocusFiredRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
      })
    })
  }, [disabled, autoFocus])

  // Sync draft store on every text change
  const handleTextChange = useCallback((value: string) => {
    setText(value)
    if (paneId) setDraft(paneId, value)
  }, [paneId])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    if (paneId) clearDraft(paneId)
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onSend, paneId])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && isRunning) {
      e.preventDefault()
      onInterrupt()
    }
  }, [handleSend, isRunning, onInterrupt])

  const handleInput = useCallback(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current)
  }, [resizeTextarea])

  // Restore textarea height when mounting with a saved draft
  useEffect(() => {
    if (text && textareaRef.current) {
      resizeTextarea(textareaRef.current)
    }
    // Only run on mount — text is intentionally excluded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="border-t px-3 py-2">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaCallbackRef}
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={disabled}
          placeholder={placeholder ?? 'Message Claude...'}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded border bg-background px-3 py-1.5 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring',
            'min-h-[36px] max-h-[200px]',
            'disabled:opacity-50'
          )}
          aria-label="Chat message input"
        />
        {isRunning ? (
          <button
            type="button"
            onClick={onInterrupt}
            className="p-2 rounded bg-red-600 text-white hover:bg-red-700"
            aria-label="Stop generation"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || !text.trim()}
            className="p-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
})

export default ChatComposer
