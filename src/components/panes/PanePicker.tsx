import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, Globe, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppSelector } from '@/store/hooks'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { CODING_CLI_PROVIDER_CONFIGS, type CodingCliProviderConfig } from '@/lib/coding-cli-utils'
import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import freshclaudeIconUrl from '../../../assets/icons/freshclaude.svg'

export type PanePickerType = 'shell' | 'cmd' | 'powershell' | 'wsl' | 'browser' | 'editor' | 'claude-web' | CodingCliProviderName

interface PickerOption {
  type: PanePickerType
  label: string
  icon: typeof Terminal | null
  iconUrl?: string
  shortcut: string
}

const shellOption: PickerOption = { type: 'shell', label: 'Shell', icon: Terminal, shortcut: 'S' }

const windowsShellOptions: PickerOption[] = [
  { type: 'cmd', label: 'CMD', icon: Terminal, shortcut: 'C' },
  { type: 'powershell', label: 'PowerShell', icon: Terminal, shortcut: 'P' },
  { type: 'wsl', label: 'WSL', icon: Terminal, shortcut: 'W' },
]

const nonShellOptions: PickerOption[] = [
  { type: 'editor', label: 'Editor', icon: FileText, shortcut: 'E' },
  { type: 'browser', label: 'Browser', icon: Globe, shortcut: 'B' },
]

const CLI_SHORTCUTS: Record<string, string> = {
  claude: 'L',
  codex: 'X',
  opencode: 'O',
  gemini: 'G',
  kimi: 'K',
}

function cliConfigToOption(config: CodingCliProviderConfig): PickerOption {
  return {
    type: config.name,
    label: config.label,
    icon: config.iconUrl ? null : Terminal,
    iconUrl: config.iconUrl,
    shortcut: CLI_SHORTCUTS[config.name] ?? config.name[0].toUpperCase(),
  }
}

function isWindowsLike(platform: string | null): boolean {
  return platform === 'win32' || platform === 'wsl'
}

interface PanePickerProps {
  onSelect: (type: PanePickerType) => void
  onCancel: () => void
  isOnlyPane: boolean
  tabId?: string
  paneId?: string
}

export default function PanePicker({ onSelect, onCancel, isOnlyPane, tabId, paneId }: PanePickerProps) {
  const platform = useAppSelector((s) => s.connection?.platform ?? null)
  const availableClis = useAppSelector((s) => s.connection?.availableClis ?? {})
  const enabledProviders = useAppSelector((s) => s.settings?.settings?.codingCli?.enabledProviders ?? [])

  const options = useMemo(() => {
    // CLI options: only show if both available on system and enabled in settings
    const cliOptions = CODING_CLI_PROVIDER_CONFIGS
      .filter((config) => availableClis[config.name] && enabledProviders.includes(config.name))
      .map(cliConfigToOption)

    // Shell options depend on platform
    const shellOptions = isWindowsLike(platform) ? windowsShellOptions : [shellOption]

    // freshclaude option: only show if claude CLI is available and enabled
    const claudeWebOption: PickerOption[] = (availableClis['claude'] && enabledProviders.includes('claude'))
      ? [{ type: 'claude-web' as PanePickerType, label: 'freshclaude', icon: null, iconUrl: freshclaudeIconUrl, shortcut: 'A' }]
      : []

    // Order: CLIs, freshclaude, Editor, Browser, Shell(s)
    return [...cliOptions, ...claudeWebOption, ...nonShellOptions, ...shellOptions]
  }, [platform, availableClis, enabledProviders])

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [fading, setFading] = useState(false)
  const pendingSelection = useRef<PanePickerType | null>(null)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  const handleSelect = useCallback((type: PanePickerType) => {
    if (fading) return
    pendingSelection.current = type
    setFading(true)
  }, [fading])

  const handleTransitionEnd = useCallback(() => {
    if (pendingSelection.current) {
      onSelect(pendingSelection.current)
    }
  }, [onSelect])

  // Scoped keyboard shortcuts — only fires when this picker container has focus
  const handleContainerKeyDown = useCallback((e: React.KeyboardEvent) => {
    const key = e.key.toLowerCase()

    // Single-key shortcuts
    const option = options.find((o) => o.shortcut.toLowerCase() === key)
    if (option) {
      e.preventDefault()
      e.stopPropagation()
      handleSelect(option.type)
      return
    }

    // Escape to cancel (only if not only pane)
    if (e.key === 'Escape' && !isOnlyPane) {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }, [handleSelect, onCancel, isOnlyPane, options])

  const handleArrowNav = useCallback((e: React.KeyboardEvent, currentIndex: number) => {
    let nextIndex: number | null = null

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        nextIndex = (currentIndex + 1) % options.length
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        nextIndex = (currentIndex - 1 + options.length) % options.length
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        handleSelect(options[currentIndex].type)
        return
    }

    if (nextIndex !== null) {
      setFocusedIndex(nextIndex)
      buttonRefs.current[nextIndex]?.focus()
    }
  }, [handleSelect, options])

  // Auto-focus the container on mount so keyboard shortcuts work immediately
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const showHint = (index: number) => focusedIndex === index || hoveredIndex === index

  return (
    <div
      ref={containerRef}
      role="toolbar"
      aria-label="Pane type picker"
      tabIndex={0}
      className={cn(
        '@container h-full w-full flex items-center justify-center',
        'p-2 @[250px]:p-4 @[400px]:p-8',
        'transition-opacity duration-150 ease-out',
        'focus:outline-none',
        fading && 'opacity-0'
      )}
      data-context={ContextIds.PanePicker}
      data-tab-id={tabId}
      data-pane-id={paneId}
      onTransitionEnd={handleTransitionEnd}
      onKeyDown={handleContainerKeyDown}
    >
      <div className="flex flex-wrap justify-center gap-2 @[250px]:gap-4 @[400px]:gap-8">
        {options.map((option, index) => (
          <button
            key={option.type}
            ref={(el) => { buttonRefs.current[index] = el }}
            aria-label={option.label}
            onClick={() => handleSelect(option.type)}
            onKeyDown={(e) => handleArrowNav(e, index)}
            onFocus={() => setFocusedIndex(index)}
            onBlur={() => setFocusedIndex(null)}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            className={cn(
              'flex flex-col items-center gap-2 @[250px]:gap-3',
              'p-2 @[250px]:p-3 @[400px]:p-6 rounded-lg',
              'transition-all duration-150',
              'hover:opacity-100 focus:opacity-100 focus:outline-none',
              'opacity-50 hover:scale-105'
            )}
          >
            {option.iconUrl ? (
              <img
                src={option.iconUrl}
                alt={option.label}
                className="h-6 w-6 @[250px]:h-8 @[250px]:w-8 @[400px]:h-12 @[400px]:w-12"
              />
            ) : option.icon ? (
              <option.icon className="h-6 w-6 @[250px]:h-8 @[250px]:w-8 @[400px]:h-12 @[400px]:w-12" />
            ) : null}
            <span className="text-xs @[400px]:text-sm font-medium">{option.label}</span>
            <span className={cn(
              'shortcut-hint text-xs -mt-1 transition-opacity duration-150',
              showHint(index) ? 'opacity-40' : 'opacity-0'
            )}>
              {option.shortcut}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
