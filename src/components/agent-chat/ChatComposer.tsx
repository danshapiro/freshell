import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getDraft, setDraft, clearDraft } from '@/lib/draft-store'
import { useAppDispatch } from '@/store/hooks'
import { switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { getTabSwitchShortcutDirection } from '@/lib/tab-switch-shortcuts'
import { useInputHistory } from '@/hooks/useInputHistory'
import { useMobile } from '@/hooks/useMobile'

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
  shouldFocusOnReady?: boolean
}

function isOnFirstLine(textarea: HTMLTextAreaElement): boolean {
  const textBefore = textarea.value.substring(0, textarea.selectionStart)
  return !textBefore.includes('\n')
}

function isOnLastLine(textarea: HTMLTextAreaElement): boolean {
  const textAfter = textarea.value.substring(textarea.selectionStart)
  return !textAfter.includes('\n')
}

const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({ paneId, onSend, onInterrupt, disabled, isRunning, placeholder, autoFocus, shouldFocusOnReady }, ref) {
  const dispatch = useAppDispatch()
  const isMobile = useMobile()
  const [text, setText] = useState(() => (paneId ? getDraft(paneId) : ''))
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const { navigateUp, navigateDown, push, reset } = useInputHistory(paneId)

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
      reset()
      requestAnimationFrame(() => {
        if (textareaRef.current) resizeTextarea(textareaRef.current)
      })
    }
  }, [paneId, resizeTextarea, reset])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }), [])

  // Focus when the textarea becomes enabled (disabled transitions false).
  // At mount the textarea may be disabled (status='creating'), so we watch
  // the `disabled` prop and focus once it goes falsy when requested.
  const focusOnReadyFiredRef = useRef(false)
  const focusRequested = shouldFocusOnReady ?? autoFocus ?? false
  const textareaCallbackRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
  }, [])

  useEffect(() => {
    if (!focusRequested || disabled || focusOnReadyFiredRef.current) return
    focusOnReadyFiredRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
      })
    })
  }, [disabled, focusRequested])

  // Sync draft store on every text change
  const handleTextChange = useCallback((value: string) => {
    setText(value)
    if (paneId) setDraft(paneId, value)
  }, [paneId])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    push(trimmed)
    onSend(trimmed)
    setText('')
    if (paneId) clearDraft(paneId)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onSend, paneId, push])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    const tabDir = getTabSwitchShortcutDirection(e)
    if (tabDir) {
      e.preventDefault()
      e.stopPropagation()
      dispatch(tabDir === 'next' ? switchToNextTab() : switchToPrevTab())
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
      return
    }
    if (e.key === 'Escape' && isRunning) {
      e.preventDefault()
      onInterrupt()
      return
    }
    if (e.key === 'ArrowUp' && textareaRef.current && isOnFirstLine(textareaRef.current)) {
      const next = navigateUp(text)
      if (next !== null) {
        e.preventDefault()
        setText(next)
        if (paneId) setDraft(paneId, next)
      }
      return
    }
    if (e.key === 'ArrowDown' && textareaRef.current && isOnLastLine(textareaRef.current)) {
      const next = navigateDown(text)
      if (next !== null) {
        e.preventDefault()
        setText(next)
        if (paneId) setDraft(paneId, next)
      }
      return
    }
  }, [dispatch, handleSend, isRunning, onInterrupt, navigateUp, navigateDown, text, paneId])

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
    <div className={cn('border-t py-2', isMobile ? 'px-2' : 'px-3')}>
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
            'flex-1 resize-none rounded border bg-background px-3 text-sm',
            'focus:outline-none focus:ring-2 focus:ring-ring',
            'disabled:opacity-50',
            isMobile ? 'py-2.5 min-h-11 max-h-[200px]' : 'py-1.5 min-h-[36px] max-h-[200px]',
          )}
          aria-label="Chat message input"
        />
        {isRunning ? (
          <button
            type="button"
            onClick={onInterrupt}
            className={cn(
              'rounded bg-red-600 text-white hover:bg-red-700',
              isMobile ? 'p-2.5 min-h-11 min-w-11' : 'p-2',
            )}
            aria-label="Stop generation"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled || !text.trim()}
            className={cn(
              'rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50',
              isMobile ? 'p-2.5 min-h-11 min-w-11' : 'p-2',
            )}
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
