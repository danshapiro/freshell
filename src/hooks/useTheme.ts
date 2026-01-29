import { useEffect } from 'react'
import { useAppSelector } from '@/store/hooks'

function getSystemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false
}

export function useThemeEffect(): void {
  const theme = useAppSelector((s) => s.settings.settings.theme)
  const uiScale = useAppSelector((s) => s.settings.settings.uiScale) ?? 1.25

  useEffect(() => {
    const root = document.documentElement
    const isDark =
      theme === 'dark' ? true : theme === 'light' ? false : getSystemPrefersDark()

    root.classList.toggle('dark', isDark)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(uiScale))
  }, [uiScale])
}
