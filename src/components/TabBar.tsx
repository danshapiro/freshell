import { X, Plus, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, removeTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { useMemo, useState } from 'react'

function StatusIndicator({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <div className="relative">
        <Circle className="h-2 w-2 fill-success text-success" />
      </div>
    )
  }
  if (status === 'exited') {
    return <Circle className="h-2 w-2 text-muted-foreground/40" />
  }
  if (status === 'error') {
    return <Circle className="h-2 w-2 fill-destructive text-destructive" />
  }
  return <Circle className="h-2 w-2 text-muted-foreground/20 animate-pulse" />
}

export default function TabBar() {
  const dispatch = useAppDispatch()
  const { tabs, activeTabId } = useAppSelector((s) => s.tabs)

  const ws = useMemo(() => getWsClient(), [])

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  if (tabs.length === 0) return null

  return (
    <div className="h-10 flex items-center gap-1 px-2 border-b border-border/30 bg-background">
      <div className="flex items-center gap-0.5 overflow-x-auto flex-1 py-1">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex items-center gap-2 h-7 px-3 rounded-md text-sm cursor-pointer transition-all',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              onClick={() => dispatch(setActiveTab(tab.id))}
              onDoubleClick={() => {
                setRenamingId(tab.id)
                setRenameValue(tab.title)
              }}
            >
              <StatusIndicator status={tab.status} />

              {renamingId === tab.id ? (
                <input
                  className="bg-transparent outline-none w-32 text-sm"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => {
                    dispatch(updateTab({ id: tab.id, updates: { title: renameValue || tab.title } }))
                    setRenamingId(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="whitespace-nowrap max-w-[10rem] truncate text-xs">
                  {tab.title}
                </span>
              )}

              <button
                className={cn(
                  'ml-0.5 p-0.5 rounded transition-opacity',
                  active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
                )}
                title="Close (Shift+Click to kill)"
                onClick={(e) => {
                  e.stopPropagation()
                  if (tab.terminalId) {
                    ws.send({
                      type: e.shiftKey ? 'terminal.kill' : 'terminal.detach',
                      terminalId: tab.terminalId,
                    })
                  }
                  dispatch(removeTab(tab.id))
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>

      <button
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        title="New tab"
        onClick={() => dispatch(addTab({ mode: 'shell' }))}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
