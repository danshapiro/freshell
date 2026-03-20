// Settings page shell — tabbed navigation with section components.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  defaultSettings,
  mergeSettings,
  updateSettingsLocal,
} from '@/store/settingsSlice'
import {
  discardStagedServerSettingsPatch,
  saveServerSettingsPatch,
  stageServerSettingsPatchPreview,
} from '@/store/settingsThunks'
import type {
  LocalSettingsPatch,
  ServerSettingsPatch,
} from '@/store/types'
import type { AppView } from '@/components/Sidebar'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import { Puzzle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import AppearanceSettings from '@/components/settings/AppearanceSettings'
import WorkspaceSettings from '@/components/settings/WorkspaceSettings'
import SafetySettings from '@/components/settings/SafetySettings'
import AdvancedSettings from '@/components/settings/AdvancedSettings'

const SERVER_TEXT_SETTINGS_DEBOUNCE_MS = 500

const sections = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'safety', label: 'Safety' },
  { id: 'advanced', label: 'Advanced' },
] as const

type SectionId = typeof sections[number]['id']

export default function SettingsView({ onNavigate, onFirewallTerminal, onSharePanel }: { onNavigate?: (view: AppView) => void; onFirewallTerminal?: (cmd: { tabId: string; command: string }) => void; onSharePanel?: () => void } = {}) {
  useEnsureExtensionsRegistry()

  const dispatch = useAppDispatch()
  const rawSettings = useAppSelector((s) => s.settings.settings)
  const settings = useMemo(
    () => mergeSettings(defaultSettings, rawSettings || {}),
    [rawSettings],
  )
  const lastSavedAt = useAppSelector((s) => s.settings.lastSavedAt)

  const [activeSection, setActiveSection] = useState<SectionId>('appearance')
  const serverTextSaveTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Cleanup debounced saves on unmount
  useEffect(() => {
    return () => {
      const pendingServerTextKeys = Object.keys(serverTextSaveTimerRef.current)
      for (const timer of Object.values(serverTextSaveTimerRef.current)) {
        clearTimeout(timer)
      }
      for (const key of pendingServerTextKeys) {
        dispatch(discardStagedServerSettingsPatch(key))
      }
      serverTextSaveTimerRef.current = {}
    }
  }, [dispatch])

  const applyLocalSetting = useCallback((updates: LocalSettingsPatch) => {
    dispatch(updateSettingsLocal(updates))
  }, [dispatch])

  const applyServerSetting = useCallback((updates: ServerSettingsPatch) => {
    void dispatch(saveServerSettingsPatch(updates))
  }, [dispatch])

  const scheduleServerTextSettingSave = useCallback((key: string, updates: ServerSettingsPatch) => {
    dispatch(stageServerSettingsPatchPreview({ key, patch: updates }))
    if (serverTextSaveTimerRef.current[key]) {
      clearTimeout(serverTextSaveTimerRef.current[key])
    }
    serverTextSaveTimerRef.current[key] = setTimeout(() => {
      delete serverTextSaveTimerRef.current[key]
      void dispatch(saveServerSettingsPatch({
        patch: updates,
        stagedKey: key,
      }))
    }, SERVER_TEXT_SETTINGS_DEBOUNCE_MS)
  }, [dispatch])

  const sectionProps = {
    settings,
    applyLocalSetting,
    applyServerSetting,
    scheduleServerTextSettingSave,
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border/30 px-3 py-4 md:px-6 md:py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">
              {lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : 'Configure your preferences'}
            </p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-3 py-4 md:px-6 md:py-6 space-y-6">

          {/* Manage Extensions — prominent, always visible */}
          <button
            onClick={() => onNavigate?.('extensions')}
            className="w-full flex items-center justify-between rounded-lg border border-border/40 bg-card px-4 py-3 text-left hover:bg-muted/50 transition-colors"
            aria-label="Manage extensions"
          >
            <div className="flex items-center gap-3">
              <Puzzle className="w-5 h-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Manage Extensions</div>
                <div className="text-xs text-muted-foreground">View and configure installed extensions</div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border/30 -mx-1" role="tablist" aria-label="Settings sections">
            {sections.map((section) => (
              <button
                key={section.id}
                role="tab"
                aria-selected={activeSection === section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'px-3 py-2 text-sm rounded-t-md transition-colors -mb-px',
                  activeSection === section.id
                    ? 'border-b-2 border-foreground font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {section.label}
              </button>
            ))}
          </div>

          {/* Tab content — only the active section renders */}
          <div role="tabpanel" aria-label={`${activeSection} settings`}>
            {activeSection === 'appearance' && <AppearanceSettings {...sectionProps} />}
            {activeSection === 'workspace' && <WorkspaceSettings {...sectionProps} />}
            {activeSection === 'safety' && (
              <SafetySettings
                {...sectionProps}
                onNavigate={onNavigate}
                onFirewallTerminal={onFirewallTerminal}
                onSharePanel={onSharePanel}
              />
            )}
            {activeSection === 'advanced' && <AdvancedSettings {...sectionProps} />}
          </div>

        </div>
      </div>
    </div>
  )
}
