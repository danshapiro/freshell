import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  RangeSlider,
} from './settings-controls'

export default function RuntimeSettings({
  settings,
  applyServerSetting,
}: SettingsSectionProps) {
  const [defaultCwdInput, setDefaultCwdInput] = useState(settings.defaultCwd ?? '')
  const [defaultCwdError, setDefaultCwdError] = useState<string | null>(null)
  const defaultCwdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const defaultCwdValidationRef = useRef(0)
  const lastSettingsDefaultCwdRef = useRef(settings.defaultCwd ?? '')

  useEffect(() => {
    return () => {
      if (defaultCwdTimerRef.current) clearTimeout(defaultCwdTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const next = settings.defaultCwd ?? ''
    if (defaultCwdInput === lastSettingsDefaultCwdRef.current) {
      setDefaultCwdInput(next)
    }
    lastSettingsDefaultCwdRef.current = next
  }, [defaultCwdInput, settings.defaultCwd])

  const commitDefaultCwd = useCallback((nextValue: string | undefined) => {
    if (nextValue === settings.defaultCwd) return
    applyServerSetting({ defaultCwd: nextValue })
  }, [applyServerSetting, settings.defaultCwd])

  const scheduleDefaultCwdValidation = useCallback((value: string) => {
    defaultCwdValidationRef.current += 1
    const validationId = defaultCwdValidationRef.current
    if (defaultCwdTimerRef.current) clearTimeout(defaultCwdTimerRef.current)

    defaultCwdTimerRef.current = setTimeout(() => {
      if (defaultCwdValidationRef.current !== validationId) return
      const trimmed = value.trim()
      if (!trimmed) {
        setDefaultCwdError(null)
        commitDefaultCwd(undefined)
        return
      }

      api.post<{ valid: boolean }>('/api/files/validate-dir', { path: trimmed })
        .then((result) => {
          if (defaultCwdValidationRef.current !== validationId) return
          if (result.valid) {
            setDefaultCwdError(null)
            commitDefaultCwd(trimmed)
            return
          }
          setDefaultCwdError('directory not found')
          commitDefaultCwd(undefined)
        })
        .catch(() => {
          if (defaultCwdValidationRef.current !== validationId) return
          setDefaultCwdError('directory not found')
          commitDefaultCwd(undefined)
        })
    }, 500)
  }, [commitDefaultCwd])

  return (
    <SettingsSection title="Runtime" description="Process lifetime and launch defaults">
      <SettingsRow label="Auto-kill idle (minutes)">
        <RangeSlider
          value={settings.safety.autoKillIdleMinutes}
          min={5}
          max={720}
          step={5}
          format={(v) => String(v)}
          onChange={(v) => {
            applyServerSetting({ safety: { autoKillIdleMinutes: v } })
          }}
        />
      </SettingsRow>

      <SettingsRow label="Default working directory">
        <div className="relative w-full md:max-w-xs">
          <input
            type="text"
            value={defaultCwdInput}
            placeholder="e.g. C:\Users\you\projects"
            aria-invalid={defaultCwdError ? true : undefined}
            onChange={(e) => {
              const nextValue = e.target.value
              setDefaultCwdInput(nextValue)
              setDefaultCwdError(null)
              scheduleDefaultCwdValidation(nextValue)
            }}
            className="h-10 w-full px-3 text-sm bg-muted border-0 rounded-md placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-border md:h-8"
          />
          {defaultCwdError && (
            <span
              className="pointer-events-none absolute right-2 -bottom-4 text-[10px] text-destructive"
            >
              {defaultCwdError}
            </span>
          )}
        </div>
      </SettingsRow>
    </SettingsSection>
  )
}
