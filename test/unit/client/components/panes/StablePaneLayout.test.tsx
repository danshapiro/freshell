import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@/store/paneTypes'
import StablePaneLayout from '@/components/panes/StablePaneLayout'

// This suite runs the real stable layer, geometry tree, PaneDivider, and resize
// hook. A lifecycle-counted pane stands in for xterm: browser acceptance must
// additionally exercise the actual TerminalView and provider terminal streams.
const observed = vi.hoisted(() => ({
  mounts: new Map<string, number>(),
  disposals: new Map<string, number>(),
  dispatch: vi.fn(),
}))
vi.mock('@/store/hooks', () => ({
  useAppDispatch: () => observed.dispatch,
  useAppSelector: (select: (state: unknown) => unknown) => select({ settings: { settings: { panes: { snapThreshold: 0 } } } }),
}))
vi.mock('@/store/panesSlice', () => ({ resizePanes: (payload: unknown) => ({ type: 'panes/resizePanes', payload }) }))
vi.mock('@/components/panes/PaneContainer', async () => {
  const { useEffect } = await import('react')
  return { default: ({ node, hidden }: { node: Extract<PaneNode, { type: 'leaf' }>; hidden?: boolean }) => {
    useEffect(() => {
      observed.mounts.set(node.id, (observed.mounts.get(node.id) ?? 0) + 1)
      return () => { observed.disposals.set(node.id, (observed.disposals.get(node.id) ?? 0) + 1) }
    }, [node.id])
    return <div data-testid={`pane-${node.id}`} data-hidden={hidden ? 'true' : 'false'}>
      <textarea aria-label={`Input ${node.id}`} defaultValue={`draft-${node.id}`} />
      <span>{node.content.kind === 'terminal' ? node.content.terminalId : node.content.kind}</span>
    </div>
  } }
})

const leaf = (id: string): Extract<PaneNode, { type: 'leaf' }> => ({
  type: 'leaf', id, content: { kind: 'terminal', mode: 'claude', status: 'running', createRequestId: `create-${id}`, terminalId: `terminal-${id}` },
})
const split = (id: string, a: PaneNode, b: PaneNode): PaneNode => ({ type: 'split', id, direction: 'horizontal', sizes: [50,50], children: [a,b] })
type Rect = { left: number; top: number; width: number; height: number }
const rect = (width=488, left=0, height=600, top=0): Rect => ({left,top,width,height})
let rootRect = rect(1000)
let rectangles: Map<string, Rect>
let observers: Array<{ callback: ResizeObserverCallback; disconnected: boolean }>
function box(element: HTMLElement): Rect {
  if (!element.isConnected) return rect(0,0,0)
  if (element.hasAttribute('data-stable-pane-layout') || element.hasAttribute('data-pane-root')) return rootRect
  for (const [attr,prefix] of [['data-pane-geometry-slot','pane:'],['data-pane-geometry-divider','divider:'],['data-pane-geometry-split','split:']]) {
    const id=element.getAttribute(attr)
    if (id !== null) return rectangles.get(`${prefix}${id}`) ?? rect(0,0,0)
  }
  return rect(0,0,0)
}
function notifyResize() {
  act(() => { for (const observer of [...observers]) if (!observer.disconnected) observer.callback([], {} as ResizeObserver) })
}
function surface(id: string) { return screen.getByTestId(`pane-${id}`).closest('[data-stable-pane-id]') as HTMLElement }

beforeEach(() => {
  observed.mounts.clear()
  observed.disposals.clear()
  observed.dispatch.mockClear()
  rootRect=rect(1000)
  observers=[]
  rectangles=new Map([
    ['pane:a',rect()],['pane:b',rect(500,500)],['pane:c',rect(200,100)],
    ['divider:s',rect(12,488)],['split:s',rect(1000)],
    ['divider:outer',rect(12,200)],['split:outer',rect(1000)],
  ])
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const r=box(this)
    return { ...r, x:r.left,y:r.top,right:r.left+r.width,bottom:r.top+r.height,toJSON:()=>r } as DOMRect
  })
  for (const [property,axis] of [['clientWidth','width'],['offsetWidth','width'],['clientHeight','height'],['offsetHeight','height']] as const) {
    vi.spyOn(HTMLElement.prototype,property,'get').mockImplementation(function(this: HTMLElement) { return box(this)[axis] })
  }
  vi.stubGlobal('ResizeObserver',class {
    entry: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.entry={callback,disconnected:false};observers.push(this.entry) }
    observe() {} unobserve() {} disconnect() { this.entry.disconnected=true }
  })
})
afterEach(() => { cleanup();vi.restoreAllMocks();vi.unstubAllGlobals() })

describe('stable pane ownership', () => {
  it('keeps a pane and its draft when a leaf is wrapped in a split and collapsed again', () => {
    const a=leaf('a')
    const {rerender}=render(<StablePaneLayout tabId="tab" layout={a} />)
    const input=screen.getByLabelText('Input a')
    fireEvent.change(input,{target:{value:'unsent work'}})
    const original=surface('a')
    rerender(<StablePaneLayout tabId="tab" layout={split('s',a,leaf('b'))} />)
    expect(surface('a')).toBe(original)
    expect(screen.getByLabelText('Input a')).toBe(input)
    rerender(<StablePaneLayout tabId="tab" layout={a} />)
    expect(observed.mounts.get('a')).toBe(1)
    expect(observed.disposals.get('a')??0).toBe(0)
    expect((input as HTMLTextAreaElement).value).toBe('unsent work')
    expect(observed.disposals.get('b')).toBe(1)
  })
  it('retains all surfaces through nested ancestry changes', () => {
    const a=leaf('a'),b=leaf('b')
    const {rerender}=render(<StablePaneLayout tabId="tab" layout={split('s',a,b)} />)
    const original=surface('a')
    rerender(<StablePaneLayout tabId="tab" layout={split('outer',leaf('c'),split('s',a,b))} />)
    expect(surface('a')).toBe(original)
    expect(observed.mounts.get('a')).toBe(1)
  })
  it('zoom hides and inerts siblings/dividers without unmounting them', () => {
    const layout=split('s',leaf('a'),leaf('b'))
    const {rerender}=render(<StablePaneLayout tabId="tab" layout={layout} />)
    const a=surface('a'), b=surface('b')
    for(let i=0;i<20;i++) {
      rerender(<StablePaneLayout tabId="tab" layout={layout} zoomedPaneId="a" />)
      expect(surface('b')).toBe(b)
      expect(b.inert).toBe(true)
      expect(b.getAttribute('aria-hidden')).toBe('true')
      expect(a.style.width).toBe('100%')
      expect(screen.getByRole('separator',{hidden:true}).closest('[aria-hidden="true"]')).not.toBeNull()
      rerender(<StablePaneLayout tabId="tab" layout={layout} />)
    }
    expect(surface('a')).toBe(a)
    expect(b.inert).toBe(false)
    expect(observed.mounts.get('b')).toBe(1)
    expect(observed.disposals.size).toBe(0)
  })
  it('stale zoom IDs leave both panes and the separator usable', () => {
    render(<StablePaneLayout tabId="tab" layout={split('s',leaf('a'),leaf('b'))} zoomedPaneId="missing" />)
    expect(surface('a').inert).toBe(false)
    expect(surface('b').inert).toBe(false)
    expect(screen.getByRole('separator')).toBeTruthy()
  })
  it('keeps the normal pane-divider-pane keyboard and reading order', () => {
    const {container}=render(<StablePaneLayout tabId="tab" layout={split('s',leaf('a'),leaf('b'))} />)
    const order=[...container.querySelectorAll('[data-pane-surface-layer] textarea, [data-pane-surface-layer] [role="separator"]')]
    expect(order.map(e=>e.getAttribute('aria-label'))).toEqual(['Input a','Pane divider (horizontal resize)','Input b'])
    expect(container.querySelectorAll('[data-pane-geometry-tree] [tabindex]').length).toBe(0)
  })
  it('updates content in place without caching an obsolete terminal ID', () => {
    const a=leaf('a')
    const {rerender}=render(<StablePaneLayout tabId="tab" layout={a} />)
    const old=surface('a')
    const content={...a.content,terminalId:'replacement-terminal'}
    rerender(<StablePaneLayout tabId="tab" layout={{...a,content}} />)
    expect(surface('a')).toBe(old)
    expect(screen.getByText('replacement-terminal')).toBeTruthy()
    expect(observed.mounts.get('a')).toBe(1)
  })
  it('keeps measured surfaces while geometry is unavailable, then restores their visibility', () => {
    const {unmount}=render(<StablePaneLayout tabId="tab" layout={leaf('a')} />)
    const a=surface('a')
    rootRect=rect(0,0,0)
    notifyResize()
    expect(surface('a')).toBe(a)
    expect(a.inert).toBe(true)
    rootRect=rect(1000)
    notifyResize()
    expect(a.inert).toBe(false)
    unmount()
    expect(observed.disposals.get('a')).toBe(1)
    expect(observers.every(o=>o.disconnected)).toBe(true)
  })
  it('does not construct a new surface at guessed zero-sized initial geometry', () => {
    rootRect=rect(0,0,0)
    render(<StablePaneLayout tabId="tab" layout={leaf('a')} />)
    expect(observed.mounts.size).toBe(0)
    rootRect=rect(1000)
    notifyResize()
    expect(observed.mounts.get('a')).toBe(1)
  })
  it('hidden tab surfaces remain mounted and become usable again', () => {
    const layout=leaf('a')
    const {rerender}=render(<StablePaneLayout tabId="tab" layout={layout} />)
    const a=surface('a')
    rerender(<StablePaneLayout tabId="tab" layout={layout} hidden />)
    expect(a.inert).toBe(true)
    rerender(<StablePaneLayout tabId="tab" layout={layout} />)
    expect(surface('a')).toBe(a)
    expect(observed.mounts.get('a')).toBe(1)
  })
  it('does not introduce additional mounts after StrictMode initialization', () => {
    const layout=split('s',leaf('a'),leaf('b'))
    const {rerender}=render(<StrictMode><StablePaneLayout tabId="tab" layout={layout} /></StrictMode>)
    const before=new Map(observed.mounts)
    rerender(<StrictMode><StablePaneLayout tabId="tab" layout={layout} zoomedPaneId="a" /></StrictMode>)
    rerender(<StrictMode><StablePaneLayout tabId="tab" layout={layout} /></StrictMode>)
    expect(observed.mounts).toEqual(before)
  })
  it('keyboard resize still dispatches through the shared split resize hook', () => {
    render(<StablePaneLayout tabId="tab" layout={split('s',leaf('a'),leaf('b'))} />)
    fireEvent.keyDown(screen.getByRole('separator'),{key:'ArrowRight'})
    expect(observed.dispatch).toHaveBeenCalledWith({type:'panes/resizePanes',payload:{tabId:'tab',splitId:'s',sizes:[51,49]}})
  })
  it('resolves the replacement geometry element after wrapping an existing split', () => {
    const a=leaf('a'), b=leaf('b')
    const layout=split('s',a,b)
    const {container,rerender}=render(<StablePaneLayout tabId="tab" layout={layout} />)
    const oldGeometry=container.querySelector('[data-pane-geometry-split="s"]')
    // The mocked rectangle remains exactly the same. The new layout commit
    // replaces the geometry DOM but need not update measurement state.
    rerender(<StablePaneLayout tabId="tab" layout={split('outer',leaf('c'),layout)} />)
    const currentGeometry=container.querySelector('[data-pane-geometry-split="s"]')
    expect(currentGeometry).not.toBe(oldGeometry)
    // React may repurpose the old root element for the outer split instead
    // of detaching it. Either way, it is no longer the correct split slot.
    expect(oldGeometry?.getAttribute('data-pane-geometry-split')).not.toBe('s')
    Object.defineProperty(oldGeometry!, 'offsetWidth', { configurable: true, value: 0 })
    const divider=container.querySelector('[role="separator"][data-split-id="s"]')!
    fireEvent.keyDown(divider,{key:'ArrowRight'})
    expect(observed.dispatch).toHaveBeenCalledWith({type:'panes/resizePanes',payload:{tabId:'tab',splitId:'s',sizes:[51,49]}})
  })
  it('repeated no-op measurements do not recreate surfaces', () => {
    render(<StablePaneLayout tabId="tab" layout={leaf('a')} />)
    for(let i=0;i<50;i++) notifyResize()
    expect(observed.mounts.get('a')).toBe(1)
    expect(observed.disposals.size).toBe(0)
  })


})

describe('stable divider resizing', () => {
  it('a real mouse drag on the stable divider resizes through the shared hook', () => {
    const layout = split('s', leaf('a'), leaf('b'))
    render(<StablePaneLayout tabId="tab" layout={layout} />)
    const divider = screen.getByRole('separator')

    fireEvent.mouseDown(divider, { clientX: 500, clientY: 300 })
    fireEvent.mouseMove(document, { clientX: 600, clientY: 300 })
    fireEvent.mouseUp(document)

    expect(observed.dispatch).toHaveBeenCalled()
    const last = observed.dispatch.mock.calls.at(-1)![0]
    expect(last.type).toBe('panes/resizePanes')
    expect(last.payload.tabId).toBe('tab')
    expect(last.payload.splitId).toBe('s')
    // Split slot is 1000px wide in the geometry harness: +100px = +10% from 50.
    expect(last.payload.sizes).toEqual([60, 40])
  })

  it('a keyboard nudge resizes without snapping machinery', () => {
    const layout = split('s', leaf('a'), leaf('b'))
    render(<StablePaneLayout tabId="tab" layout={layout} />)
    const divider = screen.getByRole('separator')

    fireEvent.keyDown(divider, { key: 'ArrowRight' })

    expect(observed.dispatch).toHaveBeenCalled()
    const last = observed.dispatch.mock.calls.at(-1)![0]
    expect(last.type).toBe('panes/resizePanes')
    expect(last.payload.sizes[0]).toBeGreaterThan(50)
  })

  it('refuses to resize from an unreadable or zero-area container', () => {
    const layout = split('s', leaf('a'), leaf('b'))
    render(<StablePaneLayout tabId="tab" layout={layout} />)
    const divider = screen.getByRole('separator')

    // A zero-sized container can never produce a valid pixel-to-percent
    // mapping: the event is a no-op (previously this dispatched NaN sizes).
    const zeroWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(0)
    try {
      fireEvent.mouseDown(divider, { clientX: 500, clientY: 300 })
      fireEvent.mouseMove(document, { clientX: 600, clientY: 300 })
      fireEvent.mouseUp(document)
      expect(observed.dispatch).not.toHaveBeenCalled()
    } finally {
      zeroWidth.mockRestore()
    }
  })
})

