import { useCallback } from 'react'
import type { PaneNode } from '@/store/paneTypes'
import { cn } from '@/lib/utils'

export type RegisterPaneSlot = (key: string, element: HTMLDivElement | null) => void

type GeometryProps = { node: PaneNode; registerSlot: RegisterPaneSlot }

function PaneSlot({ paneId, registerSlot }: { paneId: string; registerSlot: RegisterPaneSlot }) {
  const ref = useCallback((element: HTMLDivElement | null) => registerSlot(`pane:${paneId}`, element), [paneId, registerSlot])
  return <div ref={ref} data-pane-geometry-slot={paneId} className="h-full w-full" />
}

function SplitGeometry({ node, registerSlot }: GeometryProps & { node: Extract<PaneNode, { type: 'split' }> }) {
  const splitRef = useCallback((element: HTMLDivElement | null) => registerSlot(`split:${node.id}`, element), [node.id, registerSlot])
  const dividerRef = useCallback((element: HTMLDivElement | null) => registerSlot(`divider:${node.id}`, element), [node.id, registerSlot])
  const [size1, size2] = node.sizes
  const axis = node.direction === 'horizontal' ? 'width' : 'height'
  return (
    <div ref={splitRef} data-pane-geometry-split={node.id} className={cn('flex h-full w-full', node.direction === 'horizontal' ? 'flex-row' : 'flex-col')}>
      <div style={{ [axis]: `${size1}%` }} className="min-w-0 min-h-0">
        <PaneGeometryTree node={node.children[0]} registerSlot={registerSlot} />
      </div>
      <div ref={dividerRef} data-pane-geometry-divider={node.id} className={cn('flex-shrink-0', node.direction === 'horizontal' ? 'w-3' : 'h-3')} />
      <div style={{ [axis]: `${size2}%` }} className="min-w-0 min-h-0">
        <PaneGeometryTree node={node.children[1]} registerSlot={registerSlot} />
      </div>
    </div>
  )
}

/** A noninteractive, accessibility-hidden copy of the existing flex geometry.
 * Its divider placeholders use the same w-3/h-3 sizing as PaneDivider; there
 * is no competing pixel layout algorithm. Real controls live in visual order
 * alongside the stable pane shells.
 */
export default function PaneGeometryTree(props: GeometryProps) {
  return props.node.type === 'leaf'
    ? <PaneSlot paneId={props.node.id} registerSlot={props.registerSlot} />
    : <SplitGeometry {...props} node={props.node} />
}
