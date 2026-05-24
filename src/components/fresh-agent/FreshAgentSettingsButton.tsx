import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch } from '@/store/hooks'
import { mergePaneContent } from '@/store/panesSlice'
import {
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  getFreshAgentThinkingOptions,
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
} from '@/lib/fresh-agent-registry'
import { cn } from '@/lib/utils'

function getEffectiveFreshAgentModel(content: FreshAgentPaneContent): string | undefined {
  return normalizeFreshAgentModel(content.sessionType, content.provider, content.model)
}

function getEffectiveFreshAgentEffort(content: FreshAgentPaneContent): string | undefined {
  return normalizeFreshAgentEffort(content.sessionType, content.provider, getEffectiveFreshAgentModel(content), content.effort)
}

export function FreshAgentSettingsButton({
  tabId,
  paneId,
  paneContent,
}: {
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
}) {
  const dispatch = useAppDispatch()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const activeModel = getEffectiveFreshAgentModel(paneContent)
  const modelOptions = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[paneContent.sessionType] ?? []
  const modelValue = activeModel ?? ''
  const thinkingOptions = getFreshAgentThinkingOptions(paneContent.sessionType, paneContent.provider, activeModel)
  const thinkingValue = getEffectiveFreshAgentEffort(paneContent) ?? ''
  const settingsDisabled = paneContent.status === 'running' || paneContent.status === 'compacting'

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100 sm:h-4 sm:w-4',
          open && 'bg-background/50 opacity-100',
        )}
        title="Agent settings"
        aria-label="Agent settings"
        aria-expanded={open}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <Settings className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-border bg-card p-3 text-xs text-foreground shadow-lg"
          role="dialog"
          aria-label="Agent settings"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="space-y-3">
            {modelOptions.length > 0 ? (
              <label className="block space-y-1">
                <span className="font-medium">Model</span>
                <select
                  aria-label="Model"
                  className="w-full rounded border border-border/70 bg-background px-2 py-1 text-xs"
                  value={modelValue}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    const nextModel = event.target.value
                    const nextEffort = normalizeFreshAgentEffort(
                      paneContent.sessionType,
                      paneContent.provider,
                      nextModel,
                      paneContent.effort,
                    )
                    dispatch(mergePaneContent({
                      tabId,
                      paneId,
                      updates: { model: nextModel, effort: nextEffort },
                    }))
                  }}
                >
                  {modelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {thinkingOptions.length > 0 ? (
              <label className="block space-y-1">
                <span className="font-medium">Thinking</span>
                <select
                  aria-label="Thinking level"
                  className="w-full rounded border border-border/70 bg-background px-2 py-1 text-xs"
                  value={thinkingValue}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    dispatch(mergePaneContent({
                      tabId,
                      paneId,
                      updates: { effort: event.target.value },
                    }))
                  }}
                >
                  {thinkingOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default FreshAgentSettingsButton
