import { describe, it, expect } from 'vitest'
import {
  collectSurfaceLeaves, collectSurfaceOrder, resolveSurfaceZoom,
  localSurfaceRect, reconcileSurfaceMeasurements,
  type SurfaceRect,
} from '@/lib/pane-surface-layout'

type Tree = { type: 'leaf'; id: string; content: { value: string } }
  | { type: 'split'; id: string; direction: 'horizontal'; sizes: [number,number]; children: [Tree,Tree] }
const leaf=(id: string): Tree=>({type:'leaf',id,content:{value:id}})
const split=(id: string,a: Tree,b: Tree): Tree=>({type:'split',id,direction:'horizontal',sizes:[50,50],children:[a,b]})
const rect: SurfaceRect={left:0,top:0,width:100,height:50}

describe('pane surface layout',()=>{
  it('retains exact leaf objects and content through topology changes',()=>{
    const a=leaf('a'), b=leaf('b')
    expect(collectSurfaceLeaves(split('s',a,b))[0]).toBe(a)
    expect(collectSurfaceLeaves(split('o',leaf('c'),split('s',a,b)))[1]).toBe(a)
  })
  it('preserves the recursive pane-divider-pane presentation order',()=>{
    expect(collectSurfaceOrder(split('s',leaf('a'),split('t',leaf('b'),leaf('c')))).map(n=>n.id)).toEqual(['a','s','b','t','c'])
  })
  it('rejects malformed persistence without looping or assigning ambiguous keys',()=>{
    const a=leaf('a')
    expect(()=>collectSurfaceLeaves(split('s',a,a))).toThrow(/shared node/)
    expect(()=>collectSurfaceLeaves(split('s',a,leaf('a')))).toThrow(/Duplicate pane ID/)
    expect(()=>collectSurfaceOrder(split('s',split('t',a,leaf('b')),split('t',leaf('c'),leaf('d'))))).toThrow(/Duplicate split ID/)
  })
  it('treats stale zoom as an ordinary full layout',()=>{
    expect(resolveSurfaceZoom([{id:'a'},{id:'b'}],'gone')).toBeUndefined()
    expect(resolveSurfaceZoom([{id:'a'},{id:'b'}],'b')).toBe('b')
  })
  it('normalizes translated and scaled viewport geometry into CSS pixels',()=>{
    expect(localSurfaceRect({left:20,top:30,width:200,height:100},{left:120,top:30,width:100,height:100},100,50)).toEqual({left:50,top:0,width:50,height:50})
    expect(localSurfaceRect(rect,rect,0,50)).toBeUndefined()
  })
  it('keeps an existing surface when measurement temporarily disappears',()=>{
    const first=reconcileSurfaceMeasurements({},['a'],new Map([['a',rect]]))
    const hidden=reconcileSurfaceMeasurements(first,['a'],new Map())
    expect(hidden.a.rect).toBe(first.a.rect)
    expect(hidden.a.measurable).toBe(false)
    expect(reconcileSurfaceMeasurements(hidden,['a'],new Map([['a',rect]])).a.measurable).toBe(true)
  })
  it('does not render-loop on unchanged measurements or leak closed entries',()=>{
    const first=reconcileSurfaceMeasurements({},['a'],new Map([['a',rect]]))
    expect(reconcileSurfaceMeasurements(first,['a'],new Map([['a',{...rect}]]))).toBe(first)
    expect(Object.keys(reconcileSurfaceMeasurements(first,[],new Map()))).toEqual([])
  })
  it('never guesses an initial terminal size and handles arbitrary ID strings',()=>{
    expect(Object.keys(reconcileSurfaceMeasurements({},['a'],new Map()))).toEqual([])
    const next=reconcileSurfaceMeasurements({},['__proto__'],new Map([['__proto__',rect]]))
    expect(Object.getPrototypeOf(next)).toBeNull()
    expect(next.__proto__.measurable).toBe(true)
  })
})

