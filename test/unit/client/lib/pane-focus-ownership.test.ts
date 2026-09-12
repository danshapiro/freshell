import { describe, it, expect, afterEach } from 'vitest'
import { render, waitFor, cleanup as rtlCleanup } from '@testing-library/react'
import { useEffect, createElement } from 'react'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout, removeLayout, setActivePane, splitPane, addPane, closePane } from '@/store/panesSlice'
import tabsReducer, { addTab, switchToNextTab, switchToPrevTab, removeTab, setActiveTab } from '@/store/tabsSlice'
import { usePaneFocusAdoption } from '@/hooks/usePaneFocusAdoption'
import {
  recordPaneFocusBeforeUnmount,
  paneSelectionMiddleware,
  resolveRecordedFocusTarget,
  schedulePaneFocusRestore,
  shouldFocusPaneOnEligibleMount,
  shouldRecordSuppressAutofocus,
  wirePaneFocusOwnershipInvalidation,
  isPaneFocusRestorePendingForTests,
  resetPaneFocusOwnershipForTests,
  getPaneSelectionSerial,
} from '@/lib/pane-focus-ownership'

function makePanesStore() {
  return configureStore({
    reducer: { panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(paneSelectionMiddleware as never),
  })
}

describe('pane-focus-ownership', () => {
  let unsubscribe: (() => void) | null = null
  afterEach(() => {
    unsubscribe?.()
    unsubscribe = null
    resetPaneFocusOwnershipForTests()
    document.body.innerHTML = ''
  })

  it('unknown pane ids default to may-focus (fresh creation UX unchanged)', () => {
    expect(shouldFocusPaneOnEligibleMount('never-seen')).toBe(true)
  })

  it('records "owned" when focus is inside the pane subtree at unmount time', () => {
    document.body.innerHTML = `<div data-pane-id="p1"><input id="i1"></div>`
    const input = document.getElementById('i1') as HTMLInputElement
    input.focus()
    recordPaneFocusBeforeUnmount('p1')
    expect(shouldFocusPaneOnEligibleMount('p1')).toBe(true)
  })

  it('records "not owned" when focus is outside the pane subtree (e.g. in app chrome)', () => {
    document.body.innerHTML = `
      <div data-pane-id="p2"><input id="i2"></div>
      <nav><input id="sidebar-filter"></nav>`
    const chrome = document.getElementById('sidebar-filter') as HTMLInputElement
    chrome.focus()
    recordPaneFocusBeforeUnmount('p2')
    expect(shouldFocusPaneOnEligibleMount('p2')).toBe(false)
  })

  it('records nothing when the pane root is absent (bare unit renders / already detaching)', () => {
    // no [data-pane-id="p3"] in the document
    recordPaneFocusBeforeUnmount('p3')
    expect(shouldFocusPaneOnEligibleMount('p3')).toBe(true) // still unknown/default
  })

  it('records "not owned" when an element OUTSIDE the pane holds focus (chrome button)', () => {
    document.body.innerHTML = `<div data-pane-id="p4"><input id="i4"></div><button id="chrome">New tab</button>`
    ;(document.getElementById('chrome') as HTMLElement).focus()
    recordPaneFocusBeforeUnmount('p4')
    expect(shouldFocusPaneOnEligibleMount('p4')).toBe(false)
  })

  it('remembers WHICH element owned focus and re-resolves it inside a new subtree (descriptor restore)', () => {
    document.body.innerHTML = `<div data-pane-id="p5"><input aria-label="Terminal search"></div>`
    const search = document.querySelector('[aria-label="Terminal search"]') as HTMLInputElement
    search.focus()
    recordPaneFocusBeforeUnmount('p5')
    // Simulate leaf→split remount: fresh subtree, same pane id.
    document.body.innerHTML = `<div data-pane-id="p5"><div class="split-inner"><input aria-label="Terminal search"></div></div>`
    const restored = resolveRecordedFocusTarget('p5')
    expect(restored).toBe(document.querySelector('[aria-label="Terminal search"]'))
  })

  it('returns no restore target when the pane did not own focus', () => {
    document.body.innerHTML = `<div data-pane-id="p6"><input aria-label="Terminal search"></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p6')
    expect(resolveRecordedFocusTarget('p6')).toBeNull()
  })

  it('returns no restore target when the element did not come back (transient in-pane UI)', () => {
    document.body.innerHTML = `<div data-pane-id="p7"><input aria-label="Transient thing"></div>`
    ;(document.querySelector('[aria-label="Transient thing"]') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p7')
    document.body.innerHTML = `<div data-pane-id="p7"><p>remounted without it</p></div>`
    expect(resolveRecordedFocusTarget('p7')).toBeNull()
  })

  it('describes a sole embedded iframe (no aria/test/placeholder attributes) so embedded-page focus restores', () => {
    document.body.innerHTML = `<div data-pane-id="p8"><iframe title="Browser content"></iframe></div>`
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    iframe.focus()
    recordPaneFocusBeforeUnmount('p8')
    document.body.innerHTML = `<div data-pane-id="p8"><div><iframe title="Browser content"></iframe></div></div>`
    expect(resolveRecordedFocusTarget('p8')).toBe(document.querySelector('iframe'))
  })

  it('refreshing an existing record moves it to newest before cap eviction (true LRU)', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    for (let i = 0; i < 512; i++) {
      const root = document.createElement('div')
      root.setAttribute('data-pane-id', `q-${i}`)
      document.body.appendChild(root)
    }
    for (let i = 0; i < 512; i++) recordPaneFocusBeforeUnmount(`q-${i}`)
    // Re-record the oldest pane — it just unmounted again, so its record is
    // FRESH and must not be the first eviction victim.
    recordPaneFocusBeforeUnmount('q-0')
    // Cross the cap once.
    const extra = document.createElement('div')
    extra.setAttribute('data-pane-id', 'q-512')
    document.body.appendChild(extra)
    recordPaneFocusBeforeUnmount('q-512')
    expect(shouldFocusPaneOnEligibleMount('q-0')).toBe(false) // refreshed record survives
    expect(shouldFocusPaneOnEligibleMount('q-1')).toBe(true) // actual oldest evicted → unknown
    expect(shouldFocusPaneOnEligibleMount('q-512')).toBe(false) // newest survives
  })

  it('describes the pane ROOT itself when the shell held focus (:scope sentinel)', () => {
    document.body.innerHTML = `<div data-pane-id="p9" tabindex="-1"><input></div>`
    const root = document.querySelector('[data-pane-id="p9"]') as HTMLElement
    root.focus()
    expect(document.activeElement).toBe(root)
    recordPaneFocusBeforeUnmount('p9')
    document.body.innerHTML = `<div data-pane-id="p9" tabindex="-1"><input></div>`
    expect(resolveRecordedFocusTarget('p9')).toBe(document.querySelector('[data-pane-id="p9"]'))
  })

  it('falls back to the title attribute for title-only controls (pin: title candidate is reached)', () => {
    document.body.innerHTML = `<div data-pane-id="p10"><span title="Sole title" tabindex="-1"></span><iframe></iframe></div>`
    const titled = document.querySelector('[title="Sole title"]') as HTMLElement
    titled.focus()
    recordPaneFocusBeforeUnmount('p10')
    document.body.innerHTML = `<div data-pane-id="p10"><span title="Sole title" tabindex="-1"></span><iframe></iframe></div>`
    expect(resolveRecordedFocusTarget('p10')?.getAttribute('title')).toBe('Sole title')
  })

  it('does NOT overwrite the pre-split descriptor while a restore is in flight (burst splits)', async () => {
    document.body.innerHTML = `<div data-pane-id="p11"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p11')
    // Mount schedules a restore; descriptor is now protected…
    document.body.innerHTML = `<div data-pane-id="p11"><div><input placeholder="Enter URL..."></div></div>`
    const cancel = schedulePaneFocusRestore('p11')
    // …and a second teardown inside the burst must not overwrite with the
    // intermediate frame's focus (here: root-focused remount artifact).
    const root2 = document.querySelector('[data-pane-id="p11"]') as HTMLElement
    root2.focus()
    recordPaneFocusBeforeUnmount('p11')
    cancel()
    document.body.innerHTML = `<div data-pane-id="p11"><div><input placeholder="Enter URL..."></div></div>`
    expect(resolveRecordedFocusTarget('p11')).toBe(document.querySelector('input'))
    // After the restore fires, pending clears and the next teardown records fresh.
    const cancel2 = schedulePaneFocusRestore('p11')
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p11')).toBe(false))
    cancel2()
    document.body.innerHTML = `<div data-pane-id="p11"><div><input placeholder="Enter URL..."></div></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p11')
    expect(shouldFocusPaneOnEligibleMount('p11')).toBe(false)
  })

  it('refuses to restore into a hidden tab', () => {
    document.body.innerHTML = `<div data-pane-id="p12" tabindex="-1"></div>`
    const root = document.querySelector('[data-pane-id="p12"]') as HTMLElement
    root.focus()
    recordPaneFocusBeforeUnmount('p12')
    document.body.innerHTML = `<div class="tab-hidden"><div data-pane-id="p12" tabindex="-1"></div></div>`
    expect(resolveRecordedFocusTarget('p12')).toBeNull()
  })

  it('never throws on user-derived multiline attribute text; the element falls through to null', () => {
    document.body.innerHTML = `<div data-pane-id="p13"></div>`
    const root = document.querySelector('[data-pane-id="p13"]')!
    const btn = document.createElement('button')
    btn.setAttribute('aria-label', 'glom\nthis multiline message')
    root.appendChild(btn)
    btn.focus()
    expect(() => recordPaneFocusBeforeUnmount('p13')).not.toThrow()
    // aria-label candidate unparseable, title/data-context absent → no descriptor
    expect(resolveRecordedFocusTarget('p13')).toBeNull()
  })

  it('restore yields to a NEWER explicit selection (user click or scripted select)', async () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    // Establish an existing activePane entry so the later select is a real change.
    store.dispatch(initLayout({ tabId: 'tab-x', paneId: 'p20', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p20"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p20')
    schedulePaneFocusRestore('p20')
    // The newer selection lands elsewhere (focus follows it) before the window fires.
    const selected = document.createElement('input')
    document.body.appendChild(selected)
    selected.focus()
    // Explicit selection arrives inside the restore window (serial bumps).
    store.dispatch(setActivePane({ tabId: 'tab-x', paneId: 'pane-else' }))
    // The fire ran (window spent)…
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p20')).toBe(false))
    // …but the newer selection kept focus; the restore yielded.
    expect(document.activeElement).toBe(selected)
    // The window is spent: pending cleared, later teardown records fresh.
    const chrome = document.createElement('input')
    document.body.appendChild(chrome)
    chrome.focus()
    recordPaneFocusBeforeUnmount('p20')
    expect(shouldFocusPaneOnEligibleMount('p20')).toBe(false)
  })

  it('a background tab create (activePane addition) does NOT void an unrelated pending restore', async () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-a', paneId: 'p20', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p20"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p20')
    document.body.innerHTML = `<div data-pane-id="p20"><input placeholder="Enter URL..."></div>`
    schedulePaneFocusRestore('p20')
    // Focus-neutral background creation: a NEW tab's activePane addition must
    // not read as selection activity for an existing pane.
    store.dispatch(initLayout({ tabId: 'tab-bg', paneId: 'p-bg', content: { kind: 'terminal', mode: 'shell' } }))
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p20')).toBe(false))
    expect(document.querySelector('input')).toHaveFocus() // restore fired, not voided
  })

  it('close-time records linger but a reopen (pane id re-appearing) forgets them', () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'p21', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p21"></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('p21')
    expect(shouldFocusPaneOnEligibleMount('p21')).toBe(false)
    // Removal alone does NOT forget: React's teardown re-record lands AFTER
    // the store update, and its record intentionally lingers (LRU-bounded).
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    recordPaneFocusBeforeUnmount('p21') // layout-cleanup order: after removeLayout
    expect(shouldFocusPaneOnEligibleMount('p21')).toBe(false)
    // Re-appearing in any layout (e.g. reopened tab keeping leaf ids) forgets.
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'p21', content: { kind: 'terminal', mode: 'shell' } }))
    expect(shouldFocusPaneOnEligibleMount('p21')).toBe(true) // forgotten → fresh mount focus
  })

  it('restore abandons a descriptor that is no longer UNIQUE in the rebuilt subtree', () => {
    document.body.innerHTML = `<div data-pane-id="p30"><button aria-label="Go"></button></div>`
    ;(document.querySelector('button') as HTMLElement).focus()
    recordPaneFocusBeforeUnmount('p30')
    // Remount introduced a second identical control (e.g. split/resize) —
    // resolving to a first-match guess could steal focus for a sibling.
    document.body.innerHTML = `<div data-pane-id="p30"><button aria-label="Go">a</button><button aria-label="Go">b</button></div>`
    expect(resolveRecordedFocusTarget('p30')).toBeNull()
    expect(shouldRecordSuppressAutofocus('p30')).toBe(false)
  })

  it('removals of OTHER tab entries are not selection activity (cross-tab sync must not void a restore)', async () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-a', paneId: 'p31', content: { kind: 'terminal', mode: 'shell' } }))
    store.dispatch(initLayout({ tabId: 'tab-b', paneId: 'p-b', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="p31"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('p31')
    document.body.innerHTML = `<div data-pane-id="p31"><input placeholder="Enter URL..."></div>`
    schedulePaneFocusRestore('p31')
    // Another tab's layout removal (close elsewhere / hydrate delta) must not cancel the restore.
    store.dispatch(removeLayout({ tabId: 'tab-b' }))
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('p31')).toBe(false))
    expect(document.querySelector('input')).toHaveFocus()
  })

  it('an ACTIVATING user split does not let the restore yank focus from the new pane', async () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'old', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="old"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    // User's "Split" gesture reassigns activePane BEFORE React teardown records
    // the old pane — the record must NOT override the new pane's mount focus.
    store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'new-pane' }))
    recordPaneFocusBeforeUnmount('old')
    document.body.innerHTML = `<div data-pane-id="old"><input placeholder="Enter URL..."></div><div data-pane-id="new-pane"><input id="np"></div>`
    schedulePaneFocusRestore('old')
    const np = document.getElementById('np') as HTMLInputElement
    np.focus() // the activating split's mount autofocus
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('old')).toBe(false))
    expect(np).toHaveFocus()
  })

  it('a focus record captured BEFORE a later selection is voided for mount adoption (close-promoted sibling)', () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-2', paneId: 'pa', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="pa"></div><input id="chrome">`
    ;(document.getElementById('chrome') as HTMLInputElement).focus()
    recordPaneFocusBeforeUnmount('pa')
    expect(shouldFocusPaneOnEligibleMount('pa')).toBe(false)
    // A newer explicit selection voids the stale record for future mounts.
    store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pb', focusNudge: true }))
    expect(shouldFocusPaneOnEligibleMount('pa')).toBe(true)
  })

  it('epoch-entry REMOVAL (closePane/removeLayout cleanup) is not selection activity', async () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-c', paneId: 'pc', content: { kind: 'terminal', mode: 'shell' } }))
    store.dispatch(setActivePane({ tabId: 'tab-c', paneId: 'pc', focusNudge: true })) // pc now HAS an epoch entry
    store.dispatch(initLayout({ tabId: 'tab-d', paneId: 'pd', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="pd"><input placeholder="Enter URL..."></div>`
    const url = document.querySelector('input') as HTMLInputElement
    url.focus()
    recordPaneFocusBeforeUnmount('pd')
    document.body.innerHTML = `<div data-pane-id="pd"><input placeholder="Enter URL..."></div>`
    schedulePaneFocusRestore('pd')
    // Cleanup deletes pc's epoch entry — must NOT void pd's restore.
    store.dispatch(removeLayout({ tabId: 'tab-c' }))
    await waitFor(() => expect(isPaneFocusRestorePendingForTests('pd')).toBe(false))
    expect(document.querySelector('input')).toHaveFocus()
  })

  it('close-promotion REAL ordering: record AFTER the activePane reassignment still adopts stranded body focus', () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-3', paneId: 'pa', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="pa"><input id="ua"></div><div data-pane-id="pb"></div>`
    ;(document.getElementById('ua') as HTMLElement).focus()
    // User closes the ACTIVE pane: Redux reassigns activePane FIRST…
    store.dispatch(setActivePane({ tabId: 'tab-3', paneId: 'pb' }))
    // …then React's teardown records (post-reassignment serial — the record
    // CANNOT rely on serial supersession here).
    recordPaneFocusBeforeUnmount('pa')
    recordPaneFocusBeforeUnmount('pb')
    expect(shouldFocusPaneOnEligibleMount('pb')).toBe(false)
    // The old subtree disappears; focus strands on body.
    document.body.innerHTML = `<div data-pane-id="pb"></div>`
    expect(document.activeElement).toBe(document.body)
    // An eligible mount claims stranded focus — otherwise keyboard input has no home.
    expect(shouldFocusPaneOnEligibleMount('pb')).toBe(true)
  })

  it('an eligible mount with focus stranded on body adopts focus even when the record is owned:false (stranding always loses)', () => {
    // Covers BOTH the deliberate "user clicked nowhere" and the split/close
    // race where the sibling's teardown observes body after the closing pane's
    // focused DOM vanished. The cases are indistinguishable at record time and
    // stranding is strictly worse — adoption wins.
    document.body.innerHTML = `<div data-pane-id="pe"><input id="in-pe"></div>`
    const inside = document.getElementById('in-pe') as HTMLElement
    inside.focus()
    inside.blur() // jsdom: activeElement falls back to body
    expect(document.activeElement).toBe(document.body)
    recordPaneFocusBeforeUnmount('pe')
    expect(shouldFocusPaneOnEligibleMount('pe')).toBe(true)
  })

  it('split/close RACE: sibling record written after the focused pane vanished still adopts (round-14)', () => {
    const store = makePanesStore()
    unsubscribe = wirePaneFocusOwnershipInvalidation(store)
    store.dispatch(initLayout({ tabId: 'tab-r', paneId: 'pa', content: { kind: 'terminal', mode: 'shell' } }))
    document.body.innerHTML = `<div data-pane-id="pa"><input id="ua"></div><div data-pane-id="pb"></div>`
    ;(document.getElementById('ua') as HTMLElement).focus()
    // Split A's pane (agent split of focused pane A), then immediately close A
    recordPaneFocusBeforeUnmount('pa') // split commit teardown: still owned
    store.dispatch(setActivePane({ tabId: 'tab-r', paneId: 'pa' })) // A stays active (agent split)
    // ...close commit: reassignment runs before teardown (closePane folds)…
    store.dispatch(setActivePane({ tabId: 'tab-r', paneId: 'pb' }))
    // …and by the time B's teardown runs, A's focused DOM is ALREADY gone —
    // the record observes body.
    document.body.innerHTML = `<div data-pane-id="pb"></div>`
    recordPaneFocusBeforeUnmount('pb')
    expect(document.activeElement).toBe(document.body)
    expect(shouldFocusPaneOnEligibleMount('pb')).toBe(true)
  })

  it('restore is NOT superseded by focus moving within the SAME pane id (shell/inner roots share the id)', async () => {
    document.body.innerHTML = `<div data-pane-id="p40"><button aria-label="Split">s</button><div data-pane-id="p40"><input id="inner"></div></div>`
    ;(document.querySelector('button') as HTMLElement).focus()
    recordPaneFocusBeforeUnmount('p40')
    document.body.innerHTML = `<div data-pane-id="p40"><button aria-label="Split">s</button><div data-pane-id="p40"><input id="inner"></div></div>`
    ;(document.getElementById('inner') as HTMLElement).focus()
    schedulePaneFocusRestore('p40')
    await waitFor(() => expect(document.querySelector('button')).toHaveFocus())
  })

  it('HOOK lifecycle: owned:false record + restore scheduled synchronously at mount still adopts stranded body focus', () => {
    // The real lifecycle: the hook's mount layout effect marks the record
    // restore-pending BEFORE a component's passive focus effect consults the
    // gate — the strand exception must apply anyway (round-16 review).
    let adoption: boolean | null = null
    function Probe() {
      const mayFocusNow = usePaneFocusAdoption('pw', true)
      useEffect(() => { adoption = mayFocusNow() }, [mayFocusNow])
      return createElement('div', { 'data-pane-id': 'pw' }, createElement('input', { 'aria-label': 'probe' }))
    }
    document.body.innerHTML = `<div data-pane-id="pw"></div>`
    const chrome = document.createElement('input')
    document.body.appendChild(chrome)
    chrome.focus()
    recordPaneFocusBeforeUnmount('pw') // not owned; chrome holds focus
    // Teardown destroys both: focus strands on body, then the pane remounts.
    document.body.innerHTML = ''
    ;(chrome as HTMLInputElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    try {
      render(createElement(Probe))
      expect(adoption).toBe(true)
    } finally {
      rtlCleanup()
    }
  })

  it('trims the OLDEST entries beyond the cap instead of wiping the map', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    for (let i = 0; i < 513; i++) {
      const root = document.createElement('div')
      root.setAttribute('data-pane-id', `p-${i}`)
      document.body.appendChild(root)
    }
    for (let i = 0; i < 513; i++) recordPaneFocusBeforeUnmount(`p-${i}`)
    // 513 inserts cross the 512 cap. A whole-map clear would ALSO erase the
    // newest record (p-512), letting its immediate remount focus as "unknown" —
    // exactly the chrome-steal the record exists to prevent. Only p-0 (oldest)
    // may be evicted.
    expect(shouldFocusPaneOnEligibleMount('p-0')).toBe(true) // evicted → unknown
    expect(shouldFocusPaneOnEligibleMount('p-1')).toBe(false) // retained
    expect(shouldFocusPaneOnEligibleMount('p-512')).toBe(false) // newest must survive
  })
})

describe('paneSelectionMiddleware selection-serial coverage', () => {
  afterEach(() => {
    resetPaneFocusOwnershipForTests()
    document.body.innerHTML = ''
  })

  function makeTabsPanesStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault({ serializableCheck: false }).concat(paneSelectionMiddleware as never),
      preloadedState: {
        tabs: {
          tabs: [
            { id: 'tab-1', createRequestId: 'req-1', title: 'One', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: 1 },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-1': { type: 'leaf' as const, id: 'pane-1', content: { kind: 'terminal' as const, mode: 'shell' as const, status: 'running' as const, terminalId: 'term-1' } },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: { 'tab-1': { 'pane-1': 'One' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      } as any,
    })
  }

  it('user new-tab (default-activating addTab) counts as selection activity', () => {
    const store = makeTabsPanesStore()
    const s0 = getPaneSelectionSerial()
    store.dispatch(addTab({ id: 'tab-2', title: 'Two' }))
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
  })

  it('agent new-tab (activate:false) does NOT count as selection activity', () => {
    const store = makeTabsPanesStore()
    const s0 = getPaneSelectionSerial()
    store.dispatch(addTab({ id: 'tab-2', title: 'Two', activate: false }))
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(getPaneSelectionSerial()).toBe(s0)
  })

  it('keyboard tab navigation (switchToNextTab/switchToPrevTab) counts as selection activity', () => {
    const store = makeTabsPanesStore()
    store.dispatch(addTab({ id: 'tab-2', title: 'Two', activate: false }))
    const s0 = getPaneSelectionSerial()
    store.dispatch(switchToNextTab())
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
    store.dispatch(switchToPrevTab())
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(getPaneSelectionSerial()).toBe(s0 + 2)
  })

  it('a user split (default-activating splitPane) counts as selection activity', () => {
    const store = makeTabsPanesStore()
    const s0 = getPaneSelectionSerial()
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2',
    }))
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
  })

  it('an agent split (splitPane activate:false) is NOT selection activity', () => {
    const store = makeTabsPanesStore()
    const s0 = getPaneSelectionSerial()
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2',
      activate: false,
    }))
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')
    expect(getPaneSelectionSerial()).toBe(s0)
  })

  it('addPane (local pane splitting) counts as selection activity', () => {
    const store = makeTabsPanesStore()
    const s0 = getPaneSelectionSerial()
    store.dispatch(addPane({ tabId: 'tab-1', newContent: { kind: 'terminal', mode: 'shell' } }))
    expect(store.getState().panes.activePane['tab-1']).not.toBe('pane-1')
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
  })

  it('closing the ACTIVE tab (removeTab fallback selection) counts as selection activity', () => {
    const store = makeTabsPanesStore()
    store.dispatch(addTab({ id: 'tab-2', title: 'Two' })) // activates tab-2
    const s0 = getPaneSelectionSerial()
    store.dispatch(removeTab('tab-2')) // falls back to tab-1
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
  })

  it('closing a BACKGROUND tab does NOT count as selection activity', () => {
    const store = makeTabsPanesStore()
    store.dispatch(addTab({ id: 'tab-2', title: 'Two' })) // active: tab-2
    const s0 = getPaneSelectionSerial()
    store.dispatch(removeTab('tab-1')) // background close — selection unmoved
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
    expect(getPaneSelectionSerial()).toBe(s0)
  })

  it('closing the ACTIVE pane (sibling promotion) counts as selection activity', () => {
    const store = makeTabsPanesStore()
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2',
    })) // activates pane-2
    const s0 = getPaneSelectionSerial()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' })) // promotes sibling pane-1
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
  })

  it('closing a NON-active pane does NOT count as selection activity', () => {
    const store = makeTabsPanesStore()
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
      newPaneId: 'pane-2',
    })) // active: pane-2
    const s0 = getPaneSelectionSerial()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-1' })) // background close
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
    expect(getPaneSelectionSerial()).toBe(s0)
  })

  it('explicit select folds (setActivePane / setActiveTab) count as selection activity', () => {
    const store = makeTabsPanesStore()
    store.dispatch(addTab({ id: 'tab-2', title: 'Two', activate: false })) // background
    const s0 = getPaneSelectionSerial()
    store.dispatch(setActivePane({ tabId: 'tab-2', paneId: 'pane-2' }))
    expect(getPaneSelectionSerial()).toBe(s0 + 1)
    store.dispatch(setActiveTab('tab-2'))
    expect(getPaneSelectionSerial()).toBe(s0 + 2)
  })
})
