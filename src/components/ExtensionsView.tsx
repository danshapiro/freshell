// Extension management page — shows installed extensions with enable/disable controls.

import { useAppSelector } from '@/store/hooks'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import type { ClientExtensionEntry } from '@shared/extension-types'
import type { AppView } from '@/components/Sidebar'
import { ArrowLeft, Puzzle, Server, Monitor, Terminal, ExternalLink } from 'lucide-react'

interface ExtensionsViewProps {
  onNavigate: (view: AppView) => void
}

function categoryIcon(category: ClientExtensionEntry['category']) {
  switch (category) {
    case 'server': return <Server className="w-4 h-4" />
    case 'client': return <Monitor className="w-4 h-4" />
    case 'cli': return <Terminal className="w-4 h-4" />
  }
}

function categoryLabel(category: ClientExtensionEntry['category']) {
  switch (category) {
    case 'server': return 'Server'
    case 'client': return 'Client'
    case 'cli': return 'CLI'
  }
}

function ExtensionCard({ ext }: { ext: ClientExtensionEntry }) {
  const isRunning = ext.category === 'server' && ext.serverRunning

  return (
    <div
      className="rounded-lg border border-border/40 bg-card p-4 flex flex-col gap-3"
      data-testid={`extension-card-${ext.name}`}
    >
      {/* Header: icon + name + version */}
      <div className="flex items-start gap-3">
        {ext.iconUrl ? (
          <img src={ext.iconUrl} alt="" className="w-10 h-10 rounded" />
        ) : (
          <div className="w-10 h-10 rounded bg-muted flex items-center justify-center text-muted-foreground">
            <Puzzle className="w-5 h-5" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate">{ext.label}</h3>
            <span className="text-xs text-muted-foreground shrink-0">v{ext.version}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{ext.description}</p>
        </div>
      </div>

      {/* Footer: category badge + status + details */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {categoryIcon(ext.category)}
            {categoryLabel(ext.category)}
          </span>
          {isRunning && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
              Running
            </span>
          )}
          {ext.picker?.shortcut && (
            <span className="text-xs text-muted-foreground" title="Keyboard shortcut in pane picker">
              <kbd className="rounded border border-border/40 px-1 py-0.5 text-[10px] font-mono">{ext.picker.shortcut}</kbd>
            </span>
          )}
        </div>
        {ext.url && (
          <a
            href={ext.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-label={`Open ${ext.label} homepage`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </div>
  )
}

export default function ExtensionsView({ onNavigate }: ExtensionsViewProps) {
  useEnsureExtensionsRegistry()

  const extensions = useAppSelector((s) => s.extensions.entries)

  const cliExts = extensions.filter((e) => e.category === 'cli')
  const serverExts = extensions.filter((e) => e.category === 'server')
  const clientExts = extensions.filter((e) => e.category === 'client')

  const groups = [
    { label: 'CLI Agents', exts: cliExts },
    { label: 'Server Extensions', exts: serverExts },
    { label: 'Client Extensions', exts: clientExts },
  ].filter((g) => g.exts.length > 0)

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border/30 px-3 py-4 md:px-6 md:py-5">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('settings')}
            className="rounded-md p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to settings"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Extensions</h1>
            <p className="text-sm text-muted-foreground">
              {extensions.length} extension{extensions.length !== 1 ? 's' : ''} installed
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-3 py-4 md:px-6 md:py-6 space-y-6">
          {extensions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Puzzle className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-lg font-medium">No extensions installed</p>
              <p className="text-sm mt-1">
                Drop a directory with a <code className="rounded bg-muted px-1 py-0.5 text-xs">freshell.json</code> into <code className="rounded bg-muted px-1 py-0.5 text-xs">~/.freshell/extensions/</code> and restart.
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  {group.label}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {group.exts.map((ext) => (
                    <ExtensionCard key={ext.name} ext={ext} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
