/**
 * jsdom geometry harness for the stable pane surface layer.
 *
 * The production surface layer mounts a pane shell only after its geometry
 * slot has a usable measurement (never at a made-up size, per the PR
 * contract). jsdom reports 0×0 bounding rects and 0 client/offset sizes and
 * has no ResizeObserver, so without this harness nothing under PaneLayout
 * ever mounts. Tests get: every element returns a positive rect (identity
 * layout: no scaling, no translation), clientWidth/offsetWidth report the
 * same box, and ResizeObserver callbacks can be driven manually.
 *
 * Tests that need per-element geometry (e.g. distinct pane rectangles) should
 * install their own finer harness like StablePaneLayout.test.tsx does; this
 * one is deliberately uniform.
 */
import { vi } from 'vitest'
import { act } from '@testing-library/react'

export type InstalledPaneGeometry = {
  /** Drive every connected observer's measure callback (real RO fires this). */
  triggerResize: () => void
  restore: () => void
}

type ObserverEntry = { callback: ResizeObserverCallback; disconnected: boolean }

export function installPaneGeometry(box = { width: 1000, height: 600 }): InstalledPaneGeometry {
  const observers: ObserverEntry[] = []
  // Restore ONLY this harness's own spies: vi.restoreAllMocks() would also
  // wipe plain vi.fn() mockReturnValue registrations belonging to the host
  // suite's own fixtures (restored to undefined-returning), breaking later
  // tests in the same file.
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = { left: 0, top: 0, width: box.width, height: box.height }
      return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect
    }),
  ]
  for (const [property, value] of [['clientWidth', box.width], ['offsetWidth', box.width], ['clientHeight', box.height], ['offsetHeight', box.height]] as const) {
    spies.push(vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(value))
  }
  vi.stubGlobal('ResizeObserver', class {
    entry: ObserverEntry
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, disconnected: false }
      observers.push(this.entry)
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.disconnected = true
    }
  })
  return {
    triggerResize: () => {
      act(() => {
        for (const observer of [...observers]) {
          if (!observer.disconnected) observer.callback([], {} as ResizeObserver)
        }
      })
    },
    restore: () => {
      for (const spy of spies) spy.mockRestore()
      vi.unstubAllGlobals()
    },
  }
}
