import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ChatComposerHandle {
  focus: () => void
}

interface ChatComposerProps {
  onSend: (text: string) => void
  onInterrupt: () => void
  disabled?: boolean
  isRunning?: boolean
  placeholder?: string
}

const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({ onSend, onInterrupt, disabled, isRunning, placeholder }, ref) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }), [])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onSend])

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
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [])

  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={disabled}
          placeholder={placeholder ?? 'Message Claude...'}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded border bg-background px-3 py-2 text-sm',
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
