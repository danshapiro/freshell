import { describe, it, expect, afterEach } from 'vitest'
import { installFocusStealGuard } from '@/lib/focus-steal-guard'

// The guard defangs scripted focus hoists from nested documents whose iframe
// is marked data-focus-locked (rendered whenever a pane is NOT focus-eligible).
// Chromium's observed behavior (verified live Aug 2026): the hoist is silent on
// the winning side but the DISPLACED element fires a bubbling focusout, and a
// body-displaced hoist fires window blur. Tests replay those exact events
// deterministically (jsdom's own focus chain event order is not reliable
// across shuffled runs).
//
// Hermeticity: the repo shuffles test order; each test input has a unique id,
// the guard instance is disposed in afterEach, and flushes are two macrotasks
// (the rebuff itself is a chained setTimeout(0)).

async function flushGuard() {
  await new Promise((resolve) => setTimeout(resolve, 10))
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function displacedFocusout(el: Element) {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

describe('focus-steal-guard', () => {
  let dispose: () => void
  afterEach(() => {
    dispose?.()
    // jsdom focus machinery: blur any active element BEFORE wiping the DOM,
    // so no queued guard timer from this test encounters a detached target.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    document.body.innerHTML = ''
    document.body.removeAttribute('tabindex')
  })

  it('a hoist mid-burst restores the element IT displaced, not an earlier-queued transition target', async () => {
    dispose = installFocusStealGuard()
    document.body.innerHTML = `
      <input id="a-g10">
      <input id="b-g10">
      <iframe data-focus-locked="true"></iframe>`
    const a = document.getElementById('a-g10') as HTMLInputElement
    const b = document.getElementById('b-g10') as HTMLInputElement
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    a.focus()
    // Ordinary A→B transition queues displaced=A…
    displacedFocusout(a)
    b.focus()
    // …then a hoist displaces B before the timers fire.
    displacedFocusout(b)
    iframe.focus()
    await flushGuard()
    expect(document.activeElement).toBe(b) // never the stale A
  })

  it('a disposed guard never acts on a queued hoist (pending rebuff cancelled)', async () => {
    dispose = installFocusStealGuard()
    document.body.innerHTML = `
      <input id="real-g9">
      <iframe data-focus-locked="true"></iframe>`
    const real = document.getElementById('real-g9') as HTMLInputElement
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    real.focus()
    // Hoist begins: displaced element fires focusout, queuing the rebuff…
    displacedFocusout(real)
    // …the guard is disposed BEFORE the timer fires (e.g. App unmount)…
    dispose()
    // …and the hoist completes. Without cancellation the stale rebuff would
    // blur the win and re-focus the displaced element.
    iframe.focus()
    await flushGuard()
    expect(document.activeElement).toBe(iframe)
  })

  it('blurs a locked iframe that displaced a focused element, and restores that element', async () => {
    dispose = installFocusStealGuard()
    document.body.innerHTML = `
      <input id="real-g1">
      <iframe data-focus-locked="true"></iframe>`
    const real = document.getElementById('real-g1') as HTMLInputElement
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    iframe.tabIndex = -1

    real.focus()
    expect(document.activeElement).toBe(real)

    // Post-hoist Chromium state: iframe is active, displaced element fired focusout.
    iframe.focus()
    expect(document.activeElement).toBe(iframe)
    displacedFocusout(real)

    await flushGuard()
    expect(document.activeElement).toBe(real)
  })

  it('rebuffs hoists observed via window blur (displaced element was body)', async () => {
    dispose = installFocusStealGuard()
    document.body.setAttribute('tabindex', '-1')
    document.body.innerHTML = `<iframe data-focus-locked="true"></iframe>`
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    iframe.tabIndex = -1
    iframe.focus()
    expect(document.activeElement).toBe(iframe)
    window.dispatchEvent(new Event('blur'))

    await flushGuard()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone when the active element is NOT a locked iframe', async () => {
    dispose = installFocusStealGuard()
    document.body.innerHTML = `
      <input id="real-g3a">
      <input id="real-g3b">
      <iframe></iframe>`
    const a = document.getElementById('real-g3a') as HTMLInputElement
    const b = document.getElementById('real-g3b') as HTMLInputElement
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    iframe.tabIndex = -1

    // Ordinary element→element transition must not be disturbed.
    a.focus()
    b.focus()
    displacedFocusout(a)
    await flushGuard()
    expect(document.activeElement).toBe(b)

    // Unlocked iframe (an eligible pane the user clicked into) must not be disturbed.
    b.focus()
    iframe.focus()
    displacedFocusout(b)
    await flushGuard()
    expect(document.activeElement).toBe(iframe)
  })

  it('restores to body when the displaced element was removed before the rebuff runs', async () => {
    dispose = installFocusStealGuard()
    document.body.setAttribute('tabindex', '-1')
    document.body.innerHTML = `
      <input id="real-g4">
      <iframe data-focus-locked="true"></iframe>`
    const doomed = document.getElementById('real-g4') as HTMLInputElement
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    iframe.tabIndex = -1
    doomed.focus()
    iframe.focus()
    displacedFocusout(doomed)
    doomed.remove()

    await flushGuard()
    expect(document.activeElement).toBe(document.body)
  })
})
