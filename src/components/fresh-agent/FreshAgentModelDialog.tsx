import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { mergePaneContent } from '@/store/panesSlice'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import { getFreshAgentModelCapabilities } from '@/lib/api'
import {
  capFreshAgentModelSourceRows,
  filterFreshAgentModelCapabilitiesByQuery,
  getFreshAgentStaticModelCapabilities,
  groupFreshAgentModelCapabilitiesBySource,
  mergeClaudeModelCapabilities,
  type FreshAgentModelSourceGroup,
} from '@/lib/fresh-agent-model-capabilities'
import {
  buildFreshAgentVisibleMru,
  FRESH_AGENT_MODEL_MRU_MAX_ENTRIES,
  loadFreshAgentModelMru,
  pruneFreshAgentModelMru,
  recordFreshAgentModelLevelUse,
  recordFreshAgentModelUse,
  resolveFreshAgentModelLastUsedLevel,
  type FreshAgentModelMruProvider,
} from '@/lib/freshopencode-model-mru'
import {
  getEffectiveFreshAgentEffort,
  resolveEffectiveFreshAgentModel,
} from '@/lib/fresh-agent-registry'
import { cn } from '@/lib/utils'
import type {
  FreshAgentModelCapabilities,
  FreshAgentModelCapabilitiesResponse,
  FreshAgentModelCapability,
} from '@shared/fresh-agent-model-capabilities'
import { highestThinkingLevelId, orderThinkingLevelIds } from '@shared/fresh-agent-thinking-levels'

const MAX_RENDERED_MODEL_ROWS = 250

/** A right-column row: a real thinking level declared by the highlighted
 * model, or the single Default row (no variant) for models without levels. */
type LevelRow = { kind: 'level'; id: string } | { kind: 'default' }

type ModelRow = {
  key: string
  model: FreshAgentModelCapability
}

function levelRowsForModel(model: FreshAgentModelCapability): LevelRow[] {
  // Levels arrive pre-ordered from the server; order defensively client-side.
  const ordered = orderThinkingLevelIds(model.supportedEffortLevels)
  if (ordered.length === 0) return [{ kind: 'default' }]
  return ordered.map((id) => ({ kind: 'level', id }))
}

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

export function FreshAgentModelDialog({
  open,
  onClose,
  onCatalogUnavailable,
  tabId,
  paneId,
  paneContent,
}: {
  open: boolean
  onClose: () => void
  onCatalogUnavailable?: () => void
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
}) {
  const dispatch = useAppDispatch()
  const sessionType = paneContent.sessionType
  const mruProvider: FreshAgentModelMruProvider = sessionType
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[sessionType],
  )
  const cwdKey = paneContent.initialCwd ?? ''
  const effectiveModelId = resolveEffectiveFreshAgentModel(paneContent, providerDefaults)
  const effectiveEffort = getEffectiveFreshAgentEffort(paneContent, providerDefaults)

  const reactId = useId()
  const modelsListId = `${reactId}-models`
  const levelsListId = `${reactId}-levels`

  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const probeKey = `${sessionType}:${cwdKey}`
  const [probeResult, setProbeResult] = useState<{
    key: string
    response: FreshAgentModelCapabilitiesResponse
  }>()
  const probe = probeResult?.key === probeKey ? probeResult.response : undefined
  const [probing, setProbing] = useState(false)
  const [query, setQuery] = useState('')
  const [activeColumn, setActiveColumn] = useState<'models' | 'levels'>('models')
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | undefined>(undefined)
  const [highlightedLevelIndex, setHighlightedLevelIndex] = useState(0)
  const [recentModels, setRecentModels] = useState<FreshAgentModelCapability[]>([])

  // freshopencode + the claude providers (freshclaude/kilroy): probe the
  // cwd-scoped live catalog each time the dialog opens (the settings popover
  // makes the same call; the server caches it for 5 minutes). freshcodex
  // never probes — its static table is synchronously known.
  useEffect(() => {
    if (!open || sessionType === 'freshcodex') return
    let cancelled = false
    setProbeResult(undefined)
    setProbing(true)
    void getFreshAgentModelCapabilities(sessionType, { cwd: paneContent.initialCwd })
      .then((result) => {
        if (!cancelled) setProbeResult({ key: probeKey, response: result })
      })
      .catch(() => {
        if (cancelled) return
        setProbeResult({ key: probeKey, response: {
          ok: false,
          sessionType,
          runtimeProvider: paneContent.provider,
          status: 'unavailable',
          fetchedAt: Date.now(),
          models: [],
          error: { code: 'CAPABILITY_PROBE_FAILED', message: 'Catalog fetch failed' },
        } })
      })
      .finally(() => {
        if (!cancelled) setProbing(false)
      })
    return () => { cancelled = true }
  }, [open, sessionType, paneContent.provider, paneContent.initialCwd, probeKey])

  const staticCapabilities = useMemo(() => getFreshAgentStaticModelCapabilities(sessionType), [sessionType])
  const capabilities = useMemo<FreshAgentModelCapabilities | undefined>(() => sessionType === 'freshopencode'
    ? (probe?.ok ? probe : undefined)
    : paneContent.provider === 'claude' && staticCapabilities
      ? mergeClaudeModelCapabilities(staticCapabilities, probe?.ok === true ? probe : undefined)
      : staticCapabilities, [sessionType, paneContent.provider, staticCapabilities, probe])
  // Catalog-unavailable stays opencode-only: claude panes degrade to their
  // static rows (the same fallback the settings popover uses) instead of
  // closing with the unavailable notice.
  const catalogUnavailable = sessionType === 'freshopencode' && !probing && probe?.ok === false

  // Catalog-unavailable: never open an empty dialog — close and let the
  // caller surface the shared "Model catalog unavailable — try again" notice.
  useEffect(() => {
    if (!open || !catalogUnavailable) return
    onCatalogUnavailable?.()
    onClose()
  }, [open, catalogUnavailable, onCatalogUnavailable, onClose])

  const lastUsedLevelFor = useCallback((modelId: string): string | undefined => {
    if (!mruProvider || !cwdKey) return undefined
    return resolveFreshAgentModelLastUsedLevel(mruProvider, { modelId, cwdKey })
  }, [mruProvider, cwdKey])

  // Reconfirming the current model preserves its current level. Other models
  // use the last chosen level, then their highest available level.
  const preselectLevelIndex = useCallback((rows: LevelRow[], modelId: string): number => {
    if (modelId === effectiveModelId) {
      const currentIndex = rows.findIndex((row) => row.kind === 'level' && row.id === effectiveEffort)
      if (currentIndex >= 0) return currentIndex
    }
    const lastUsed = lastUsedLevelFor(modelId)
    if (lastUsed) {
      const index = rows.findIndex((row) => row.kind === 'level' && row.id === lastUsed)
      if (index >= 0) return index
    }
    return rows.length - 1
  }, [effectiveEffort, effectiveModelId, lastUsedLevelFor])

  // Reset only when opening or changing panes, never when an asynchronous
  // catalog arrives while the user is typing or choosing a level.
  useEffect(() => {
    setQuery('')
    setActiveColumn('models')
    setHighlightedRowKey(undefined)
    setHighlightedLevelIndex(0)
  }, [open, paneId, cwdKey, sessionType])

  useEffect(() => {
    if (!open || !capabilities) return
    let recent: FreshAgentModelCapability[] = []
    if (mruProvider && cwdKey) {
      const existing = loadFreshAgentModelMru(mruProvider)
      const current = capabilities.models.find((model) => model.id === effectiveModelId)
      // Claude's small static list needs no duplicate Recent row until the
      // user has chosen a model. A partial/fallback catalog must never erase
      // previously chosen live models.
      if (current && (paneContent.provider !== 'claude' || existing.length > 0)) {
        recordFreshAgentModelUse(mruProvider, current, cwdKey)
      }
      if (paneContent.provider !== 'claude' || probe?.ok) {
        pruneFreshAgentModelMru(mruProvider, capabilities, cwdKey)
      }
      recent = buildFreshAgentVisibleMru(mruProvider, {
        currentModelId: effectiveModelId,
        cwdKey,
        entries: loadFreshAgentModelMru(mruProvider),
        capabilities,
        maxVisible: FRESH_AGENT_MODEL_MRU_MAX_ENTRIES,
      }).map((item) => item.model)
    }
    setRecentModels(recent)
  }, [open, capabilities, mruProvider, cwdKey, effectiveModelId, paneContent.provider, probe])

  // Focus management: Escape cancels (capture phase, ahead of parent
  // popovers/views); previous focus is restored on close.
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
      previousFocusRef.current?.focus()
    }
  }, [open, onClose])

  // Autofocus the search box once the catalog is PRESENT: the input is
  // `disabled` while the freshopencode probe is in flight, and focus() on a
  // disabled element is a silent no-op — a mount-time-only timer would lose
  // the race and leave focus on whatever opened the dialog.
  const hasCapabilities = Boolean(capabilities)
  useEffect(() => {
    if (!open || !hasCapabilities) return
    const focusTimer = window.setTimeout(() => {
      searchRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [open, hasCapabilities])

  const { groups, hiddenCount } = useMemo(() => {
    if (!capabilities) return { groups: [] as FreshAgentModelSourceGroup[], hiddenCount: 0 }
    const grouped = groupFreshAgentModelCapabilitiesBySource(capabilities)
    return capFreshAgentModelSourceRows(
      filterFreshAgentModelCapabilitiesByQuery(grouped, query),
      MAX_RENDERED_MODEL_ROWS,
    )
  }, [capabilities, query])

  // The Recent group passes through the same query filter as a pseudo-group,
  // so typing filters the whole left column.
  const recentGroup = useMemo(() => {
    if (recentModels.length === 0) return [] as FreshAgentModelCapability[]
    return filterFreshAgentModelCapabilitiesByQuery(
      [{ source: { id: 'recent', displayName: 'Recent' }, models: recentModels }],
      query,
    )[0]?.models ?? []
  }, [recentModels, query])

  const flatModelRows = useMemo(() => {
    const rows: ModelRow[] = []
    for (const model of recentGroup) {
      rows.push({ key: `recent:${model.id}`, model })
    }
    for (const group of groups) {
      for (const model of group.models) {
        rows.push({ key: `catalog:${model.id}`, model })
      }
    }
    return rows
  }, [recentGroup, groups])

  // The highlighted model row: the user's staged selection while it stays
  // visible, else the pane's effective current model, else the first row.
  const highlightedRow = flatModelRows.find((row) => row.key === highlightedRowKey && highlightedRowKey !== undefined)
    ?? flatModelRows.find((row) => row.model.id === effectiveModelId)
    ?? flatModelRows[0]
  const highlightedModel = highlightedRow?.model
  const levelRows: LevelRow[] = highlightedModel ? levelRowsForModel(highlightedModel) : []
  // The level highlight is user-set only when the highlighted model row is
  // user-set (selectModelRow stages both together); the derived initial
  // highlight uses the preselection rule directly.
  const highlightedIsUserStaged = Boolean(
    highlightedRowKey && highlightedRow && highlightedRow.key === highlightedRowKey,
  )
  const resolvedLevelIndex = highlightedIsUserStaged
    ? Math.min(highlightedLevelIndex, Math.max(levelRows.length - 1, 0))
    : (highlightedModel ? preselectLevelIndex(levelRows, highlightedModel.id) : 0)
  const highlightedLevelRow = levelRows[resolvedLevelIndex]
  const highlightedLevelLabel = !highlightedLevelRow
    ? ''
    : highlightedLevelRow.kind === 'default' ? 'Default' : highlightedLevelRow.id
  const highlightedIsCurrentModel = highlightedModel?.id === effectiveModelId
  const highlightedLastUsedLevel = highlightedModel ? lastUsedLevelFor(highlightedModel.id) : undefined
  const highlightedHighestLevel = highlightedModel
    ? highestThinkingLevelId(highlightedModel.supportedEffortLevels)
    : undefined

  const selectModelRow = useCallback((row: ModelRow) => {
    setHighlightedRowKey(row.key)
    setHighlightedLevelIndex(preselectLevelIndex(levelRowsForModel(row.model), row.model.id))
    setActiveColumn('models')
  }, [preselectLevelIndex])

  const moveModelHighlight = useCallback((delta: 1 | -1) => {
    if (flatModelRows.length === 0 || !highlightedRow) return
    const currentIndex = Math.max(flatModelRows.indexOf(highlightedRow), 0)
    const nextIndex = Math.min(Math.max(currentIndex + delta, 0), flatModelRows.length - 1)
    selectModelRow(flatModelRows[nextIndex])
  }, [flatModelRows, highlightedRow, selectModelRow])

  const moveLevelHighlight = useCallback((delta: 1 | -1) => {
    if (levelRows.length === 0) return
    // Moving levels stages the (possibly derived) model row too, so the
    // level selection becomes user-driven rather than preselection-derived.
    if (highlightedRow && !highlightedIsUserStaged) setHighlightedRowKey(highlightedRow.key)
    setHighlightedLevelIndex(Math.min(Math.max(resolvedLevelIndex + delta, 0), levelRows.length - 1))
  }, [levelRows.length, highlightedRow, highlightedIsUserStaged, resolvedLevelIndex])

  const commit = useCallback(() => {
    if (!capabilities || !highlightedModel || !highlightedLevelRow) return
    const model = highlightedModel
    // The Default row stages NO level: pane effort clears, and the provider
    // default effort clears (patch normalization maps it to a server-side
    // delete). On the wire that means no variant — opencode applies the
    // model's own provider-side default.
    const level = highlightedLevelRow.kind === 'level' ? highlightedLevelRow.id : undefined
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        model: model.id,
        modelSelection: { kind: 'exact', modelId: model.id },
        // Stamp the display name known at pick time so the status-strip chip
        // shows the label even for catalog-only ids — never a raw id while a
        // history window restore or a probe is still settling. A catalog row
        // whose displayName IS the id (e.g. opencode's no-name fallback) is
        // not a display name at all: stamp nothing, and the strip's probe must
        // keep looking.
        ...(model.displayName && model.displayName !== model.id
          ? { modelLabel: { modelId: model.id, label: model.displayName } }
          : {}),
        effort: level,
        // Claude providers stamp the switched-to row's known levels (static
        // or probed) so post-commit effort normalization clamps against THEM
        // — the same idiom the settings popover's radio commit uses. An
        // empty stamp is deliberate: the selected model declares no levels.
        ...(paneContent.provider === 'claude'
          ? { modelEffortLevels: model.supportsEffort ? [...model.supportedEffortLevels] : [] }
          : {}),
      },
    }))
    void dispatch(saveServerSettingsPatch({
      freshAgent: {
        providers: {
          [sessionType]: {
            modelSelection: { kind: 'exact', modelId: model.id },
            effort: level,
          },
        },
      },
    }))
    if (mruProvider && cwdKey) {
      recordFreshAgentModelUse(mruProvider, model, cwdKey)
      if (level) recordFreshAgentModelLevelUse(mruProvider, { modelId: model.id, level, cwdKey })
    }
    onClose()
  }, [capabilities, highlightedModel, highlightedLevelRow, mruProvider, dispatch, tabId, paneId, sessionType, cwdKey, paneContent.provider, onClose])

  const canCommit = Boolean(capabilities && highlightedModel && highlightedLevelRow)

  const activeDescendant = activeColumn === 'models'
    ? (highlightedRow ? `${modelsListId}-option-${flatModelRows.indexOf(highlightedRow)}` : undefined)
    : (highlightedLevelRow ? `${levelsListId}-option-${resolvedLevelIndex}` : undefined)

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (activeColumn === 'models') moveModelHighlight(1)
      else moveLevelHighlight(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (activeColumn === 'models') moveModelHighlight(-1)
      else moveLevelHighlight(-1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setActiveColumn('models')
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setActiveColumn('levels')
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    }
  }

  if (!open) return null
  if (catalogUnavailable) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => { event.stopPropagation(); onClose() }}
      role="presentation"
      tabIndex={-1}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Model and thinking level"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const dialog = dialogRef.current
          if (!dialog) return
          const focusables = getFocusable(dialog)
          if (focusables.length === 0) {
            event.preventDefault()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement as HTMLElement | null
          if (event.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              event.preventDefault()
              last.focus()
            }
          } else if (active === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="border-b border-border p-3">
          <input
            ref={searchRef}
            type="search"
            role="searchbox"
            aria-label="Filter models"
            aria-controls={`${modelsListId} ${levelsListId}`}
            aria-activedescendant={activeDescendant}
            placeholder="Filter models"
            value={query}
            disabled={!capabilities}
            className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
        </div>
        {!capabilities ? (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Loading model catalog…
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 overflow-y-auto p-3 text-xs sm:grid-cols-[1.4fr_1fr]">
            <ul id={modelsListId} role="listbox" aria-label="Models" className="min-w-0 space-y-1">
              {recentGroup.length > 0 ? (
                <li role="presentation" className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Recent
                </li>
              ) : null}
              {recentGroup.map((model) => renderModelOption(model, `recent:${model.id}`))}
              {groups.map((group) => (
                <Fragment key={group.source.id}>
                  <li role="presentation" className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.source.displayName}
                  </li>
                  {group.models.map((model) => renderModelOption(model, `catalog:${model.id}`))}
                </Fragment>
              ))}
              {hiddenCount > 0 ? (
                <li role="presentation" className="px-2 pt-1 text-[11px] text-muted-foreground">
                  Keep typing to narrow results
                </li>
              ) : null}
            </ul>
            <ul
              id={levelsListId}
              role="listbox"
              aria-label={`Thinking levels for ${highlightedModel?.displayName ?? ''}`}
              className="min-w-0 space-y-1 border-border/60 sm:border-l sm:pl-3"
            >
              {levelRows.map((row, index) => {
                const label = row.kind === 'default' ? 'Default' : row.id
                const isCurrentLevel = Boolean(highlightedIsCurrentModel && (
                  row.kind === 'default' ? effectiveEffort === undefined : row.id === effectiveEffort
                ))
                const annotation = isCurrentLevel
                  ? 'current'
                  : row.kind === 'level' && row.id === highlightedLastUsedLevel
                    ? 'last used'
                    : row.kind === 'level' && row.id === highlightedHighestLevel
                      ? 'highest'
                      : undefined
                const isHighlighted = row === highlightedLevelRow
                const stageLevel = () => {
                  if (highlightedRow && !highlightedIsUserStaged) setHighlightedRowKey(highlightedRow.key)
                  setHighlightedLevelIndex(index)
                  setActiveColumn('levels')
                }
                return (
                  <li
                    key={label}
                    id={`${levelsListId}-option-${index}`}
                    role="option"
                    aria-selected={isHighlighted}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={stageLevel}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      stageLevel()
                    }}
                    className={cn(
                      'flex min-h-[2.25rem] cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors sm:min-h-0',
                      isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    <span>{label}</span>
                    {isCurrentLevel ? <span aria-hidden="true">●</span> : null}
                    {annotation && annotation !== 'current' ? (
                      <span className="ml-auto text-[11px] text-muted-foreground">{annotation}</span>
                    ) : null}
                    {annotation === 'current' ? <span className="sr-only">current</span> : null}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border p-3">
          <p className="mr-auto text-[11px] text-muted-foreground">
            ↑↓ move · ←→ switch column · Enter = OK · Esc = cancel · applies from your next message · becomes your default
          </p>
          <button
            type="button"
            className="rounded border border-border px-3 py-1 text-xs hover:bg-accent/50"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCommit}
            className="rounded border border-border bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            onClick={commit}
          >
            {highlightedModel && highlightedLevelLabel
              ? `Use ${highlightedModel.displayName} · ${highlightedLevelLabel}`
              : 'Use model'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )

  function renderModelOption(model: FreshAgentModelCapability, key: string) {
    const rowIndex = flatModelRows.findIndex((row) => row.key === key)
    const isHighlighted = highlightedRow?.key === key
    const isCurrent = model.id === effectiveModelId
    const sourceName = key.startsWith('recent:') ? model.source?.displayName : undefined
    return (
      <li
        key={key}
        id={`${modelsListId}-option-${rowIndex}`}
        role="option"
        data-group={key.startsWith('recent:') ? 'recent' : 'catalog'}
        aria-selected={isHighlighted}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => selectModelRow({ key, model })}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          selectModelRow({ key, model })
        }}
        className={cn(
          'flex min-h-[2.25rem] cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors sm:min-h-0',
          isHighlighted ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        )}
      >
        <span className="min-w-0 truncate">
          <span className={cn(isCurrent && 'font-semibold')}>{model.displayName}</span>
          {sourceName ? <span className="text-muted-foreground"> · {sourceName}</span> : null}
        </span>
        {isCurrent ? (
          <>
            <span aria-hidden="true" className="ml-auto text-[9px]">●</span>
            <span className="sr-only">current</span>
          </>
        ) : null}
      </li>
    )
  }
}

export default FreshAgentModelDialog
