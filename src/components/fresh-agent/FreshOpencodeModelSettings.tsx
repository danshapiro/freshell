import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { mergePaneContent } from '@/store/panesSlice'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import { getFreshAgentModelCapabilities } from '@/lib/api'
import {
  capFreshAgentModelSourceRows,
  filterFreshAgentModelCapabilitiesByQuery,
  groupFreshAgentModelCapabilitiesBySource,
  resolveFreshOpencodeCapabilityById,
} from '@/lib/fresh-agent-model-capabilities'
import {
  buildFreshOpencodeVisibleMru,
  loadFreshOpencodeModelMru,
  pruneFreshOpencodeModelMru,
  recordFreshOpencodeModelUse,
} from '@/lib/freshopencode-model-mru'
import { normalizeFreshAgentModel } from '@/lib/fresh-agent-registry'
import { cn } from '@/lib/utils'
import type {
  FreshAgentModelCapabilities,
  FreshAgentModelCapabilitiesResponse,
  FreshAgentModelCapability,
} from '@shared/fresh-agent-model-capabilities'

const MAX_RENDERED_MODEL_ROWS = 250

function getFocusable(container: HTMLElement): HTMLElement[] {
  const selectors = [
    'button',
    '[href]',
    'input',
    'select',
    'textarea',
    '[tabindex]:not([tabindex="-1"])',
  ]
  return Array.from(container.querySelectorAll<HTMLElement>(selectors.join(',')))
    .filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'))
}

function resolveEffectiveModel(
  content: FreshAgentPaneContent,
  providerDefaults?: { modelSelection?: { modelId: string } },
): string | undefined {
  const configured = content.model
    ?? content.modelSelection?.modelId
    ?? providerDefaults?.modelSelection?.modelId
  return normalizeFreshAgentModel(content.sessionType, content.provider, configured)
}

export function FreshOpencodeModelSettings({
  tabId,
  paneId,
  paneContent,
}: {
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
}) {
  const dispatch = useAppDispatch()
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType],
  )

  const cwdKey = paneContent.initialCwd ?? ''
  const activeModel = resolveEffectiveModel(paneContent, providerDefaults)

  const [response, setResponse] = useState<FreshAgentModelCapabilitiesResponse | undefined>(undefined)
  const [modalOpen, setModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const modalSearchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const capabilities: FreshAgentModelCapabilities | undefined = response?.ok ? response : undefined
  const unavailable = response?.ok === false

  useEffect(() => {
    let cancelled = false
    void getFreshAgentModelCapabilities('freshopencode', { cwd: paneContent.initialCwd })
      .then((result) => {
        if (cancelled) return
        setResponse(result)
        if (result.ok) {
          const currentModelId = paneContent.model
            ?? paneContent.modelSelection?.modelId
            ?? providerDefaults?.modelSelection?.modelId
          const currentModel = resolveFreshOpencodeCapabilityById(result, currentModelId)
          if (currentModel && cwdKey) {
            recordFreshOpencodeModelUse(currentModel, cwdKey)
          }
          if (cwdKey) {
            pruneFreshOpencodeModelMru(result, cwdKey)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResponse({
            ok: false,
            sessionType: 'freshopencode',
            runtimeProvider: 'opencode',
            status: 'unavailable',
            fetchedAt: Date.now(),
            models: [],
            error: { code: 'CAPABILITY_PROBE_FAILED', message: 'Catalog fetch failed' },
          })
        }
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneContent.initialCwd])

  useEffect(() => {
    if (!modalOpen) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setModalOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    const focusTimer = window.setTimeout(() => {
      modalSearchRef.current?.focus()
    }, 0)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.clearTimeout(focusTimer)
      previousFocusRef.current?.focus()
    }
  }, [modalOpen])

  const visibleMru = useMemo(() => {
    return buildFreshOpencodeVisibleMru({
      currentModelId: activeModel,
      cwdKey,
      entries: loadFreshOpencodeModelMru(),
      capabilities: unavailable ? undefined : capabilities,
      now: Date.now(),
      maxVisible: 4,
    })
  }, [activeModel, cwdKey, capabilities, unavailable])

  const filteredGroups = useMemo(() => {
    if (!capabilities) return []
    const grouped = groupFreshAgentModelCapabilitiesBySource(capabilities)
    return filterFreshAgentModelCapabilitiesByQuery(grouped, searchQuery)
  }, [capabilities, searchQuery])

  const { groups: cappedGroups, hiddenCount } = useMemo(
    () => capFreshAgentModelSourceRows(filteredGroups, MAX_RENDERED_MODEL_ROWS),
    [filteredGroups],
  )

  const handleSelect = (model: FreshAgentModelCapability) => {
    const nextEffort = model.supportedEffortLevels.includes(paneContent.effort ?? '')
      ? paneContent.effort
      : model.supportedEffortLevels.at(-1) ?? paneContent.effort
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        model: model.id,
        modelSelection: { kind: 'exact', modelId: model.id },
        effort: nextEffort,
      },
    }))
    void dispatch(saveServerSettingsPatch({
      freshAgent: {
        providers: {
          freshopencode: {
            modelSelection: { kind: 'exact', modelId: model.id },
            ...(nextEffort ? { effort: nextEffort } : {}),
          },
        },
      },
    }))
    if (cwdKey) {
      recordFreshOpencodeModelUse(model, cwdKey)
    }
    setModalOpen(false)
  }

  return (
    <div className="space-y-2">
      <span className="font-medium">Model</span>
      {!modalOpen && unavailable ? (
        <p className="text-[11px] text-muted-foreground">
          Model catalog unavailable. Try again later.
        </p>
      ) : null}
      {!modalOpen && visibleMru.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {visibleMru.map((item, index) => {
            const isCurrent = item.model.id === activeModel
            return (
              <button
                key={item.model.id}
                type="button"
                disabled={item.stale && unavailable}
                aria-label={isCurrent ? `Current model: ${item.model.displayName}` : `Use model: ${item.model.displayName}`}
                className={cn(
                  'rounded border border-border/60 px-2 py-1 text-[11px] transition-colors',
                  isCurrent ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  index === 3 && 'hidden sm:flex',
                )}
                onClick={() => handleSelect(item.model)}
              >
                {item.model.displayName}
              </button>
            )
          })}
        </div>
      ) : null}
      {!modalOpen && !unavailable ? (
        <input
          type="search"
          aria-label="Search enabled models"
          placeholder="Search enabled models"
          readOnly
          className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
          onFocus={() => setModalOpen(true)}
          onClick={() => setModalOpen(true)}
        />
      ) : null}
      {modalOpen ? createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/50 z-[60] p-4"
          onMouseDown={(e) => { e.stopPropagation(); setModalOpen(false) }}
          role="presentation"
          tabIndex={-1}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Choose Freshopencode model"
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== 'Tab') return
              const dialog = dialogRef.current
              if (!dialog) return
              const focusables = getFocusable(dialog)
              if (focusables.length === 0) {
                e.preventDefault()
                return
              }
              const first = focusables[0]
              const last = focusables[focusables.length - 1]
              const active = document.activeElement as HTMLElement | null
              if (e.shiftKey) {
                if (active === first || !dialog.contains(active)) {
                  e.preventDefault()
                  last.focus()
                }
              } else if (active === last) {
                e.preventDefault()
                first.focus()
              }
            }}
          >
            <div className="border-b border-border p-3">
              <input
                ref={modalSearchRef}
                type="search"
                aria-label="Filter enabled models"
                placeholder="Filter enabled models"
                value={searchQuery}
                className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="overflow-y-auto p-3 text-xs">
              {cappedGroups.map((group) => (
                <div key={group.source.id} className="mb-3 last:mb-0">
                  <h3 className="mb-1 font-medium text-muted-foreground">{group.source.displayName}</h3>
                  <div className="space-y-1">
                    {group.models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        aria-label={`Use model: ${model.displayName}`}
                        className={cn(
                          'flex w-full items-center gap-2 rounded border border-border/60 px-2 py-1 text-left transition-colors hover:bg-accent/50',
                          model.id === activeModel && 'bg-accent text-accent-foreground',
                        )}
                        onClick={() => handleSelect(model)}
                      >
                        <span>{model.displayName}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {hiddenCount > 0 ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Keep typing to narrow results
                </p>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

export default FreshOpencodeModelSettings
