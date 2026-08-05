import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import type { ReactNode } from 'react'
import settingsReducer, { setLocalSettings, updateSettingsLocal } from '@/store/settingsSlice'
import { useThemeEffect } from '@/hooks/useTheme'
import { resolveLocalSettings } from '@shared/settings'

// The slice initial state already carries a complete LocalSettings resolved
// from (cleared) browser preferences, so updateSettingsLocal is safe to
// dispatch against a bare store — no partial preloaded state needed.
function createStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
    },
  })
}

function createWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

function getUiScaleProperty(): string {
  return document.documentElement.style.getPropertyValue('--ui-scale')
}

describe('useThemeEffect', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    document.documentElement.style.removeProperty('--ui-scale')
  })

  describe('--ui-scale custom property', () => {
    it('exposes a --ui-scale of 1 for the default settings', () => {
      const store = createStore()
      renderHook(() => useThemeEffect(), { wrapper: createWrapper(store) })

      expect(getUiScaleProperty()).toBe('1')
    })

    it('exposes the uiScale verbatim at the 400% ceiling', () => {
      const store = createStore()
      renderHook(() => useThemeEffect(), { wrapper: createWrapper(store) })

      act(() => {
        store.dispatch(setLocalSettings(resolveLocalSettings({ uiScale: 4 })))
      })

      expect(getUiScaleProperty()).toBe('4')
    })

    it('multiplies uiScale by the terminal font size ratio', () => {
      const store = createStore()
      renderHook(() => useThemeEffect(), { wrapper: createWrapper(store) })

      act(() => {
        store.dispatch(setLocalSettings(resolveLocalSettings({ uiScale: 4, terminal: { fontSize: 32 } })))
      })

      // (32px / 16px) * 4 = 8 — root font size and UI scale compose.
      expect(getUiScaleProperty()).toBe('8')
    })

    it('recomputes --ui-scale when uiScale changes at runtime', () => {
      const store = createStore()
      renderHook(() => useThemeEffect(), { wrapper: createWrapper(store) })

      expect(getUiScaleProperty()).toBe('1')

      act(() => {
        store.dispatch(updateSettingsLocal({ uiScale: 4 }))
      })
      expect(getUiScaleProperty()).toBe('4')

      act(() => {
        store.dispatch(updateSettingsLocal({ uiScale: 0.75 }))
      })
      expect(getUiScaleProperty()).toBe('0.75')
    })

    it('clamps an out-of-range uiScale to [75%, 400%] before computing --ui-scale', () => {
      const store = createStore()
      renderHook(() => useThemeEffect(), { wrapper: createWrapper(store) })

      act(() => {
        store.dispatch(updateSettingsLocal({ uiScale: 999 }))
      })
      expect(getUiScaleProperty()).toBe('4')

      act(() => {
        store.dispatch(updateSettingsLocal({ uiScale: 0.1 }))
      })
      expect(getUiScaleProperty()).toBe('0.75')
    })
  })
})
