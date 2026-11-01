import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_Z } from '@/components/ui/overlay'

const contextAttributes = ['data-context', 'data-tab-id', 'data-pane-id', 'data-session-id', 'data-provider', 'data-session-type']

export function FreshAgentDiffDrawer({ children, onClose, paneRoot }: {
  children: ReactNode
  onClose: () => void
  paneRoot?: HTMLElement | null
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current!
    const root = paneRoot ?? document.documentElement
    const sync = () => {
      wrapper.className = `fresh-agent-diff-drawer-overlay ${OVERLAY_Z.modal} ${Array.from(root.classList).filter((name) => name === 'fresh-agent-pane' || name.startsWith('fresh-agent-style-')).join(' ')}`
      for (const attribute of contextAttributes) {
        const value = root.getAttribute(attribute)
        if (value === null) wrapper.removeAttribute(attribute)
        else wrapper.setAttribute(attribute, value)
      }
      const styles = getComputedStyle(root)
      wrapper.style.cssText = ''
      for (let index = 0; index < styles.length; index++) {
        const name = styles[index]
        if (name.startsWith('--fresh-agent-')) wrapper.style.setProperty(name, styles.getPropertyValue(name))
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    for (let ancestor: HTMLElement | null = root; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true })
    }
    return () => observer.disconnect()
  }, [paneRoot])

  useLayoutEffect(() => {
    const previous = document.activeElement
    const wrapper = wrapperRef.current!
    closeRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      // Nested menus own their first Escape and their own keyboard navigation.
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
      } else if (event.key === 'Tab') {
        const controls = Array.from(wrapper.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
          .filter((node) => !node.matches(':disabled, [tabindex="-1"]') && !node.closest('[hidden], [inert]') && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none')
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault()
          const next = event.shiftKey ? last : first
          next?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const active = document.activeElement
      if (previous instanceof HTMLElement && previous.isConnected && (active === document.body || (active instanceof Node && wrapper.contains(active)))) previous.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div ref={wrapperRef} className={`fresh-agent-diff-drawer-overlay ${OVERLAY_Z.modal}`}>
      <button type="button" aria-label="Close Changes" tabIndex={-1}
        className="absolute inset-0 cursor-default border-0 bg-transparent" onClick={onClose} />
      <section role="dialog" aria-modal="true" aria-label="Changes" className="fresh-agent-diff-drawer">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-4">
          <h2>Changes</h2>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded px-3 py-2 hover:bg-accent focus-visible:outline focus-visible:outline-2">Close</button>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4">{children}</div>
      </section>
    </div>, document.body,
  )
}
