import { cn } from '@/lib/utils'

const TOOLBAR_KEYS: Array<{ id: string; label: string; input: string }> = [
  { id: 'pipe', label: '|', input: '|' },
  { id: 'slash', label: '/', input: '/' },
  { id: 'tilde', label: '~', input: '~' },
  { id: 'up', label: '↑', input: '\u001b[A' },
  { id: 'down', label: '↓', input: '\u001b[B' },
  { id: 'left', label: '←', input: '\u001b[D' },
  { id: 'right', label: '→', input: '\u001b[C' },
  { id: 'f1', label: 'F1', input: '\u001bOP' },
  { id: 'f2', label: 'F2', input: '\u001bOQ' },
  { id: 'f3', label: 'F3', input: '\u001bOR' },
  { id: 'f4', label: 'F4', input: '\u001bOS' },
  { id: 'f5', label: 'F5', input: '\u001b[15~' },
  { id: 'f6', label: 'F6', input: '\u001b[17~' },
  { id: 'f7', label: 'F7', input: '\u001b[18~' },
  { id: 'f8', label: 'F8', input: '\u001b[19~' },
  { id: 'f9', label: 'F9', input: '\u001b[20~' },
  { id: 'f10', label: 'F10', input: '\u001b[21~' },
  { id: 'f11', label: 'F11', input: '\u001b[23~' },
  { id: 'f12', label: 'F12', input: '\u001b[24~' },
]

interface MobileTerminalToolbarProps {
  keyboardInsetPx: number
  onNewTab: () => void
  onSendKey: (input: string, id: string) => void
}

export function MobileTerminalToolbar({
  keyboardInsetPx,
  onNewTab,
  onSendKey,
}: MobileTerminalToolbarProps) {
  return (
    <div
      className="absolute inset-x-0 z-30 border-t border-border/40 bg-background/95 backdrop-blur-sm"
      style={{ bottom: `${keyboardInsetPx}px` }}
      data-testid="mobile-terminal-toolbar"
    >
      <div className="overflow-x-auto px-2 py-2 safe-area-bottom">
        <div className="inline-flex min-w-full items-center gap-2 pr-2">
          <button
            type="button"
            onClick={onNewTab}
            className={cn(
              'min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors',
              'border-emerald-800/30 bg-emerald-600 text-white hover:bg-emerald-500',
            )}
            aria-label="Create new tab"
          >
            + New Tab
          </button>
          {TOOLBAR_KEYS.map((key) => (
            <button
              key={key.id}
              type="button"
              className="min-h-11 min-w-11 rounded-md border border-border bg-muted px-2 text-xs font-medium transition-colors hover:bg-muted/70"
              onClick={() => onSendKey(key.input, key.id)}
              aria-label={`Send ${key.label}`}
            >
              {key.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
