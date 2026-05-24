import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Command } from 'lucide-react'
import type { FreshAgentSlashCommand } from '@shared/fresh-agent-slash-commands'

type FreshAgentComposerProps = {
  disabled?: boolean
  onSend?: (value: string) => void
  commands?: readonly FreshAgentSlashCommand[]
  onCommand?: (command: FreshAgentSlashCommand, args: string) => void
}

type MenuMode = 'chat' | 'browse'

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

export function FreshAgentComposer({
  disabled = false,
  onSend,
  commands = [],
  onCommand,
}: FreshAgentComposerProps) {
  const [text, setText] = useState('')
  const [menuMode, setMenuMode] = useState<MenuMode | null>(null)
  const [filter, setFilter] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)

  const chatPrefix = getCommandPrefix(text)
  const activeFilter = menuMode === 'chat' ? (chatPrefix ?? '') : filter.toLowerCase()
  const visibleCommands = useMemo(() => {
    const normalizedFilter = activeFilter.replace(/^\//, '')
    return commands.filter((command) => command.name.includes(normalizedFilter))
  }, [activeFilter, commands])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [activeFilter])

  useEffect(() => {
    if (chatPrefix !== null && text.startsWith('/')) {
      setMenuMode('chat')
      return
    }
    if (menuMode === 'chat') {
      setMenuMode(null)
    }
  }, [chatPrefix, menuMode, text])

  useEffect(() => {
    if (menuMode === 'browse') {
      requestAnimationFrame(() => filterRef.current?.focus())
    }
  }, [menuMode])

  const closeMenu = useCallback(() => {
    setMenuMode(null)
    setFilter('')
    setHighlightedIndex(0)
  }, [])

  const executeCommand = useCallback((command: FreshAgentSlashCommand, args = '') => {
    if (disabled) return
    onCommand?.(command, args)
    setText('')
    closeMenu()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [closeMenu, disabled, onCommand])

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

  const sendText = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    if (trimmed.startsWith('/') && executeSlashText(trimmed)) return
    onSend?.(trimmed)
    setText('')
    closeMenu()
  }, [closeMenu, disabled, executeSlashText, onSend, text])

  const handleMenuKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!menuMode) return false
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(index + 1, Math.max(visibleCommands.length - 1, 0)))
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
    if (event.key === 'Enter') {
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
    highlightedIndex,
    menuMode,
    text,
    visibleCommands,
  ])

  return (
    <form
      className="relative border-t border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        sendText()
      }}
    >
      {menuMode && visibleCommands.length > 0 ? (
        <div
          className="absolute bottom-full left-3 mb-2 w-[min(420px,calc(100%-1.5rem))] overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-lg"
          role="menu"
          aria-label="Slash commands"
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
          <div className="max-h-72 overflow-auto py-1">
            {visibleCommands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="menuitem"
                className={[
                  'flex w-full flex-col px-3 py-2 text-left text-sm',
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
            <span>Enter runs</span>
            {menuMode === 'chat' ? <span>Tab completes</span> : null}
          </div>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          name="message"
          aria-label="Chat message input"
          disabled={disabled}
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (handleMenuKeyDown(event)) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              sendText()
            }
          }}
          placeholder={disabled ? 'Read-only session' : 'Send a message'}
          className="min-h-[52px] flex-1 resize-none rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none"
        />
        <button
          type="button"
          disabled={disabled || commands.length === 0}
          className="rounded-md border border-border/70 p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Slash commands"
          onClick={() => {
            if (disabled) return
            setMenuMode((mode) => mode === 'browse' ? null : 'browse')
            setFilter('')
          }}
        >
          <Command className="h-4 w-4" />
        </button>
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </form>
  )
}
