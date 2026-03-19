// Settings page shell — sidebar navigation with section components.

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
  const contentRef = useRef<HTMLDivElement>(null)
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

  // IntersectionObserver to track which section is visible
  useEffect(() => {
    const container = contentRef.current
    if (!container || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id as SectionId
            if (sections.some((s) => s.id === id)) {
              setActiveSection(id)
            }
          }
        }
      },
      {
        root: container,
        rootMargin: '-10% 0px -80% 0px',
        threshold: 0,
      },
    )

    for (const section of sections) {
      const el = container.querySelector(`#${section.id}`)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [])

  const scrollToSection = useCallback((id: SectionId) => {
    const el = contentRef.current?.querySelector(`#${id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

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

      {/* Body: sidebar + content */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav
          className="hidden md:flex flex-col w-48 shrink-0 border-r border-border/30 py-4 px-3"
          aria-label="Settings sections"
        >
          <div className="space-y-0.5">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => scrollToSection(section.id)}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-sm rounded-md transition-colors',
                  activeSection === section.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                {section.label}
              </button>
            ))}
          </div>

          <div className="mt-auto pt-4 border-t border-border/30">
            <button
              onClick={() => onNavigate?.('extensions')}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-muted/50 transition-colors"
            >
              <Puzzle className="w-3.5 h-3.5" />
              Extensions
              <ChevronRight className="w-3 h-3 ml-auto" />
            </button>
          </div>
        </nav>

        {/* Content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl space-y-8 px-3 py-4 md:px-6 md:py-6">

            {/* Mobile: Manage Extensions button (hidden on desktop where sidebar has the link) */}
            <button
              onClick={() => onNavigate?.('extensions')}
              className="w-full flex items-center justify-between rounded-lg border border-border/40 bg-card px-4 py-3 text-left hover:bg-muted/50 transition-colors md:hidden"
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

            <AppearanceSettings {...sectionProps} />

            <WorkspaceSettings {...sectionProps} />

            <SafetySettings
              {...sectionProps}
              onNavigate={onNavigate}
              onFirewallTerminal={onFirewallTerminal}
              onSharePanel={onSharePanel}
            />

            <AdvancedSettings {...sectionProps} />

          </div>
        </div>
      </div>
    </div>
  )
}
