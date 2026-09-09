import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@playwright/test'
import { runtimeBrowserPost, pruneRuntimeBrowserLayout } from '../../../e2e-browser/helpers/runtime-browser-api.js'

const page = { evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)) } as unknown as Page

afterEach(() => { vi.unstubAllGlobals() })

describe('runtime browser gate uses the actual application API contract', () => {
  it('authenticates with x-auth-token and unwraps the status/data envelope', async () => {
    const fetch = vi.fn(async (_route, options) => {
      const headers = new Headers(options.headers)
      expect(headers.get('x-auth-token')).toBe('synthetic-browser-token')
      expect(headers.has('authorization')).toBe(false)
      expect(JSON.parse(options.body)).toEqual({ browser: 'about:blank' })
      return new Response(JSON.stringify({ status: 'success', data: { tabId: 'browser-1', paneId: 'pane-1' } }))
    })
    vi.stubGlobal('fetch', fetch)
    expect(await runtimeBrowserPost(page, 'synthetic-browser-token', '/api/tabs', { browser: 'about:blank' }))
      .toEqual({ tabId: 'browser-1', paneId: 'pane-1' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not leak error bodies or tokens into qualification logs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('synthetic-secret-error-body', { status: 401 })))
    await expect(runtimeBrowserPost(page, 'synthetic-token', '/api/tabs', {})).rejects.toThrow('HTTP 401')
    try { await runtimeBrowserPost(page, 'synthetic-token', '/api/tabs', {}) } catch (error) {
      expect(String(error)).not.toMatch(/synthetic-secret|synthetic-token/)
    }
  })

  it.each(['https://foreign.invalid/api/tabs', '//foreign.invalid/api/tabs', '/outside', '/api/../outside'])(
    'refuses credential-bearing requests to %s', async (route) => {
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
      await expect(runtimeBrowserPost(page, 'synthetic-token', route, {})).rejects.toThrow(/route/)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('does not treat a logical error in an HTTP 200 envelope as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', message: 'private fixture details' }))))
    await expect(runtimeBrowserPost(page, 'synthetic-token', '/api/tabs', {})).rejects.toThrow(/error envelope/)
  })
})

describe('runtime reconstruction removes only intentionally missing layout rows', () => {
  function layout() {
    return {
      version: 3, persistedAt: 100,
      tabs: { tabs: [{ id: 'browser-1', title: 'Saved browser' }, { id: 'managed-1', title: 'Managed shell' }], activeTabId: 'managed-1' },
      panes: { version: 2, layouts: { 'browser-1': { id: 'browser-pane' }, 'managed-1': { id: 'managed-pane' } },
        activePane: { 'browser-1': 'browser-pane', 'managed-1': 'managed-pane' },
        paneTitles: { 'browser-1': { 'browser-pane': 'Saved title' }, 'managed-1': {} },
      },
      tombstones: [{ id: 'unrelated-prior-tab', closedAt: 80 }],
    }
  }

  it('preserves the saved browser, pane title, tombstones and schema metadata', () => {
    const input = layout()
    const result = pruneRuntimeBrowserLayout(input, 'browser-1')
    expect(result.tabs.tabs).toEqual([{ id: 'browser-1', title: 'Saved browser' }])
    expect(result.tabs.activeTabId).toBe('browser-1')
    expect(result.panes.layouts).toEqual({ 'browser-1': { id: 'browser-pane' } })
    expect(result.panes.activePane).toEqual({ 'browser-1': 'browser-pane' })
    expect(result.panes.paneTitles).toEqual({ 'browser-1': { 'browser-pane': 'Saved title' } })
    expect(result.tombstones).toEqual(input.tombstones)
    expect(result.version).toBe(input.version)
    expect(result.persistedAt).toBe(input.persistedAt)
    expect(input.tabs.tabs).toHaveLength(2)
  })

  it('fails rather than pruning an unrelated or malformed layout record', () => {
    expect(() => pruneRuntimeBrowserLayout(layout(), 'missing-tab')).toThrow(/tab/)
    expect(() => pruneRuntimeBrowserLayout({}, 'browser-1')).toThrow(/layout/)
  })
})
