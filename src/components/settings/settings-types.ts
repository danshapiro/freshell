// Shared prop types for settings section components.

import type { AppSettings, LocalSettingsPatch, ServerSettingsPatch } from '@/store/types'

export interface SettingsSectionProps {
  settings: AppSettings
  applyLocalSetting: (updates: LocalSettingsPatch) => void
  applyServerSetting: (updates: ServerSettingsPatch) => void
  scheduleServerTextSettingSave: (key: string, updates: ServerSettingsPatch) => void
}
