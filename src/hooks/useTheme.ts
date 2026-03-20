import { useEffect } from 'react'
import { useAppSelector } from '@/store/hooks'
import { getSystemPrefersDark } from '@/lib/theme-utils'

export function useThemeEffect(): void {
  const theme = useAppSelector((s) => s.settings.settings.theme)
  const uiScale = useAppSelector((s) => s.settings.settings.uiScale) ?? 1.0
  const terminalFontSize = useAppSelector((s) => s.settings.settings.terminal.fontSize) ?? 16

  // UI base font size matches terminal font size, then UI scale multiplies it
  // At 100% scale, UI text = terminal text size
  const effectiveScale = (terminalFontSize / 16) * uiScale

  useEffect(() => {
    const root = document.documentElement
    const isDark =
      theme === 'dark' ? true : theme === 'light' ? false : getSystemPrefersDark()

    root.classList.toggle('dark', isDark)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(effectiveScale))
  }, [effectiveScale])
}
