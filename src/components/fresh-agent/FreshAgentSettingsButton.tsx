import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings } from 'lucide-react'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { mergePaneContent } from '@/store/panesSlice'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import {
  FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE,
  getEffectiveFreshAgentEffort,
  normalizeFreshAgentEffort,
  resolveEffectiveFreshAgentModel,
  resolveFreshAgentType,
} from '@/lib/fresh-agent-registry'
import { getFreshAgentModelCapabilities } from '@/lib/api'
import {
  FRESH_AGENT_MODEL_CATALOG_UNAVAILABLE_NOTICE,
  mergeClaudeSelectorOptions,
} from '@/lib/fresh-agent-model-capabilities'
import type { FreshAgentModelOption } from '@shared/fresh-agent-models'
import { cn } from '@/lib/utils'
import {
  DEFAULT_FRESH_AGENT_STYLE,
  FRESH_AGENT_STYLE_VALUES,
  normalizeFreshAgentStyle,
  type FreshAgentStyle,
} from '@shared/settings'
import { FreshAgentModelDialog } from './FreshAgentModelDialog'
import type {
  FreshAgentRuntimeProvider,
  FreshAgentSessionType,
} from '@shared/fresh-agent'
import type {
  FreshAgentModelCapabilitiesResponse,
} from '@shared/fresh-agent-model-capabilities'

type PermissionModeOption = { value: string; label: string; description?: string }

/**
 * Permission modes per runtime provider. 'plan' maps to the Claude SDK's
 * read-only research mode; codex modes mirror its approval policies.
 */
const PERMISSION_MODES_BY_PROVIDER: Record<string, PermissionModeOption[]> = {
  claude: [
    { value: 'default', label: 'Default (ask)' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'bypassPermissions', label: 'Bypass permissions' },
    { value: 'plan', label: 'Plan mode (read-only)', description: 'Research and propose; no edits until approved.' },
  ],
  codex: [
    { value: 'untrusted', label: 'Ask for untrusted commands' },
    { value: 'on-request', label: 'On request' },
    { value: 'on-failure', label: 'On failure' },
    { value: 'never', label: 'Never ask', description: 'Commands still follow the session’s file and network access limits.' },
  ],
}

function makeUnavailableCapabilitiesResponse(
  sessionType: FreshAgentSessionType,
  runtimeProvider: FreshAgentRuntimeProvider,
): FreshAgentModelCapabilitiesResponse {
  return {
    ok: false,
    sessionType,
    runtimeProvider,
    status: 'unavailable',
    fetchedAt: Date.now(),
    models: [],
    error: { code: 'CAPABILITY_PROBE_FAILED', message: 'Catalog fetch failed' },
  }
}

/**
 * Effort after a model switch in the simple selector: keep the current pane
 * effort when the SELECTED row's own levels include it, otherwise take the
 * row's declared defaultEffort (then first level). A row declaring no levels
 * clears the pane effort — never fabricate a clamp from the static default
 * model's table. (Only called for rows present in the merged selector list;
 * rows absent entirely keep the shared static-table normalizer.)
 */
function effortForSwitchedModelRow(
  row: FreshAgentModelOption,
  currentEffort: string | undefined,
): string | undefined {
  const levels = row.thinkingEfforts
  if (!levels || levels.length === 0) return undefined
  if (currentEffort && levels.includes(currentEffort)) return currentEffort
  return row.defaultEffort ?? levels[0]
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
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType],
  )
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | undefined>(undefined)
  const [probedCapabilities, setProbedCapabilities] = useState<FreshAgentModelCapabilitiesResponse | undefined>(undefined)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)

  const activeModel = resolveEffectiveFreshAgentModel(paneContent, providerDefaults)
  const modelValue = activeModel ?? ''
  const isFreshopencode = paneContent.sessionType === 'freshopencode'
  // freshclaude/kilroy keep the simple radio list + Thinking dropdown, exactly
  // as before; freshopencode and freshcodex get the compact Model row that
  // opens the shared two-column dialog.
  const keepsSimpleModelList = paneContent.provider === 'claude'
  // claude providers: merge the probed catalog (aliases included) into the
  // static menu once the fetch resolves. freshcodex/freshopencode keep the
  // pure static table here (their Model row resolves names via the dialog).
  const staticModelOptions = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[paneContent.sessionType] ?? []
  const modelOptions = keepsSimpleModelList
    ? mergeClaudeSelectorOptions(
        probedCapabilities?.ok === true ? probedCapabilities : undefined,
        staticModelOptions,
      ).modelOptions
    : staticModelOptions
  const opensModelDialog = paneContent.sessionType === 'freshopencode' || paneContent.sessionType === 'freshcodex'

  // Simple-list path: thinking levels come from the merged selector rows, so
  // probed-only models use their own catalog levels instead of the static
  // table's default-model fallback. Static rows resolve identically to the
  // old getFreshAgentThinkingOptions call — for claude providers,
  // normalizeFreshAgentModel is the identity. Models in neither list
  // legitimately show no Thinking select.
  const thinkingOptions = keepsSimpleModelList
    ? (modelOptions.find((option) => option.value === activeModel)?.thinkingEfforts ?? [])
        .map((value) => ({ value, label: value }))
    : []
  const thinkingValue = getEffectiveFreshAgentEffort(paneContent, providerDefaults) ?? ''
  const descriptor = resolveFreshAgentType(paneContent.sessionType)
  const permissionModeVisible = descriptor?.settingsVisibility.permissionMode === true
  const permissionModes = permissionModeVisible
    ? PERMISSION_MODES_BY_PROVIDER[paneContent.provider] ?? []
    : []
  const permissionModeValue = paneContent.permissionMode
    ?? descriptor?.defaultPermissionMode
    ?? ''
  const settingsDisabled = paneContent.status === 'running' || paneContent.status === 'compacting'
  const styleValue = normalizeFreshAgentStyle(
    paneContent.style ?? providerDefaults?.style ?? DEFAULT_FRESH_AGENT_STYLE,
  )

  const opencodeCatalogUnavailable = isFreshopencode && probedCapabilities?.ok === false
  const modelDisplayName = isFreshopencode
    ? (probedCapabilities?.ok
        ? probedCapabilities.models.find((model) => model.id === activeModel)?.displayName ?? activeModel
        : activeModel)
    : (modelOptions.find((option) => option.value === activeModel)?.label ?? activeModel)
  const effortLabel = getEffectiveFreshAgentEffort(paneContent, providerDefaults) ?? 'Default'
  const modelRowLabel = `${modelDisplayName ?? 'Unknown model'} · ${effortLabel}`

  const closeModelDialog = useCallback(() => setModelDialogOpen(false), [])
  const close = useCallback(() => setOpen(false), [])
  const persistProviderDefaults = useCallback((defaults: {
    modelSelection?: { kind: 'exact'; modelId: string }
    defaultPermissionMode?: string
    effort?: string
    style?: FreshAgentStyle
  }) => {
    void dispatch(saveServerSettingsPatch({
      freshAgent: {
        providers: {
          [paneContent.sessionType]: defaults,
        },
      },
    }))
  }, [dispatch, paneContent.sessionType])

  // freshopencode + claude providers (freshclaude/kilroy): fetch the live
  // catalog when the popover opens. freshopencode renders display names and
  // reports catalog unavailability; claude providers merge the probed rows
  // (aliases included) into the simple radio list. Statics render instantly
  // either way — no loading gate.
  useEffect(() => {
    if (!open || (!isFreshopencode && !keepsSimpleModelList)) return
    let cancelled = false
    void getFreshAgentModelCapabilities(paneContent.sessionType, { cwd: paneContent.initialCwd })
      .then((result) => { if (!cancelled) setProbedCapabilities(result) })
      .catch(() => {
        if (!cancelled) {
          setProbedCapabilities(makeUnavailableCapabilitiesResponse(
            paneContent.sessionType,
            paneContent.provider,
          ))
        }
      })
    return () => { cancelled = true }
  }, [open, isFreshopencode, keepsSimpleModelList, paneContent.sessionType, paneContent.initialCwd])

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
          if (!open && buttonRef.current) {
            // The popover is portaled to document.body to escape the pane
            // header's overflow-hidden clip stripe; anchor it to the gear's
            // viewport rect (same 4px gap the old in-header mt-1 produced).
            const rect = buttonRef.current.getBoundingClientRect()
            setPopoverPos({
              top: rect.bottom + 4,
              right: Math.max(8, window.innerWidth - rect.right),
            })
          }
          setOpen((value) => !value)
        }}
      >
        <Settings className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
      </button>

      {open && popoverPos ? createPortal(
        <div
          ref={popoverRef}
          className="fixed z-50 w-[min(16rem,calc(100vw-1rem))] rounded-md border border-border bg-card p-3 text-xs text-foreground shadow-lg"
          style={{ top: popoverPos.top, right: popoverPos.right }}
          role="dialog"
          aria-label="Agent settings"
        >
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="font-medium">Style</span>
              <select
                aria-label="Style"
                className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                value={styleValue}
                onChange={(event) => {
                  const nextStyle = normalizeFreshAgentStyle(event.target.value)
                  dispatch(mergePaneContent({
                    tabId,
                    paneId,
                    updates: { style: nextStyle },
                  }))
                  persistProviderDefaults({ style: nextStyle })
                }}
              >
                {FRESH_AGENT_STYLE_VALUES.map((style) => (
                  <option key={style} value={style}>
                    {style === 'sans' ? 'Sans' : style === 'mono' ? 'Mono' : 'Serif'}
                  </option>
                ))}
              </select>
            </label>

            {keepsSimpleModelList && modelOptions.length > 0 ? (
              <fieldset className="space-y-1">
                <legend className="font-medium">Model</legend>
                <div className="space-y-1" role="radiogroup" aria-label="Model">
                  {modelOptions.map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        'flex min-h-[2.5rem] cursor-pointer items-center gap-2 rounded border border-border/60 px-2 py-1 transition-colors sm:min-h-0',
                        modelValue === option.value ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                        settingsDisabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                      )}
                    >
                      <input
                        type="radio"
                        className="h-3 w-3"
                        name={`fresh-agent-model-${tabId}-${paneId}`}
                        value={option.value}
                        checked={modelValue === option.value}
                        disabled={settingsDisabled}
                        onChange={() => {
                          const nextModel = option.value
                          // Clamp against the row actually being selected from
                          // the merged list (probed rows carry their own
                          // catalog levels). Unknown models — absent from the
                          // list entirely — keep the shared static-table
                          // normalizer, unchanged.
                          const nextRow = modelOptions.find((row) => row.value === nextModel)
                          const nextEffort = nextRow
                            ? effortForSwitchedModelRow(nextRow, paneContent.effort)
                            : normalizeFreshAgentEffort(
                                paneContent.sessionType,
                                paneContent.provider,
                                nextModel,
                                paneContent.effort,
                              )
                            dispatch(mergePaneContent({
                              tabId,
                              paneId,
                              updates: {
                                model: nextModel,
                                // Stamp the picked row's display label for the
                                // status-strip chip (id-paired; a later model
                                // change without a stamp can never mislabel).
                                // A label echoing the raw id is not a display
                                // name (e.g. opencode's no-name fallback): skip.
                                ...(nextRow && nextRow.label !== nextModel
                                  ? { modelLabel: { modelId: nextModel, label: nextRow.label } }
                                  : {}),
                                effort: nextEffort,
                              // Stamp the switched-to row's known levels
                              // (static or probed) so effort normalization
                              // clamps against THEM — never re-derived from
                              // the static table's default-model fallback for
                              // probed-only models. Absent row → field clears
                              // back to static-table normalization.
                              modelEffortLevels: nextRow?.thinkingEfforts
                                ? [...nextRow.thinkingEfforts]
                                : undefined,
                            },
                          }))
                          persistProviderDefaults({
                            modelSelection: { kind: 'exact', modelId: nextModel },
                            ...(nextEffort ? { effort: nextEffort } : {}),
                          })
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            {thinkingOptions.length > 0 ? (
              <label className="block space-y-1">
                <span className="font-medium">Thinking</span>
                <select
                  aria-label="Thinking level"
                  className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                  value={thinkingValue}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    const nextEffort = event.target.value
                    dispatch(mergePaneContent({
                      tabId,
                      paneId,
                      updates: { effort: nextEffort },
                    }))
                    persistProviderDefaults({ effort: nextEffort })
                  }}
                >
                  {thinkingOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {opensModelDialog ? (
              opencodeCatalogUnavailable ? (
                <div className="space-y-1">
                  <span className="font-medium">Model</span>
                  <p className="text-[11px] text-muted-foreground">
                    {FRESH_AGENT_MODEL_CATALOG_UNAVAILABLE_NOTICE}
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <span className="font-medium">Model</span>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded border border-border/70 px-2 py-1.5 text-left hover:bg-accent/50"
                    onClick={() => setModelDialogOpen(true)}
                  >
                    <span className="min-w-0 truncate">{modelRowLabel}</span>
                    <span className="shrink-0 text-muted-foreground">Change…</span>
                  </button>
                </div>
              )
            ) : null}

            {permissionModes.length > 0 ? (
              <label className="block space-y-1">
                <span className="font-medium">Permission mode</span>
                <select
                  aria-label="Permission mode"
                  className="min-h-[2.5rem] w-full rounded border border-border/70 bg-background px-2 py-1 text-base sm:min-h-0 sm:text-xs"
                  value={permissionModeValue}
                  disabled={settingsDisabled}
                  onChange={(event) => {
                    const nextPermissionMode = event.target.value
                    dispatch(mergePaneContent({
                      tabId,
                      paneId,
                      updates: { permissionMode: nextPermissionMode },
                    }))
                    persistProviderDefaults({ defaultPermissionMode: nextPermissionMode })
                  }}
                >
                  {permissionModes.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {permissionModes.find((option) => option.value === permissionModeValue)?.description ? (
                  <span className="block text-[11px] text-muted-foreground">
                    {permissionModes.find((option) => option.value === permissionModeValue)?.description}
                  </span>
                ) : null}
                <span className="block text-[11px] text-muted-foreground">
                  Applies from the next message.
                </span>
              </label>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}

      {opensModelDialog ? (
        <FreshAgentModelDialog
          tabId={tabId}
          paneId={paneId}
          paneContent={paneContent}
          open={modelDialogOpen}
          onClose={closeModelDialog}
        />
      ) : null}
    </div>
  )
}

export default FreshAgentSettingsButton
