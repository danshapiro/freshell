/** Geometry and identity helpers for the stable pane surface layer.
 * Pure functions: no terminal state, network calls, or global pane cache.
 */
export type SurfaceRect = { left: number; top: number; width: number; height: number }
export type MeasuredSurface = { rect: SurfaceRect; measurable: boolean }
export type SurfaceMeasurements = Readonly<Record<string, MeasuredSurface>>

type LayoutNode<T> =
  | { type: 'leaf'; id: string; content: T }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; sizes: [number, number]; children: [LayoutNode<T>, LayoutNode<T>] }

/** Retain the actual leaf objects, not new content snapshots. Keys are pane IDs. */
export function collectSurfaceLeaves<T>(root: LayoutNode<T>): Array<Extract<LayoutNode<T>, { type: 'leaf' }>> {
  const leaves: Array<Extract<LayoutNode<T>, { type: 'leaf' }>> = []
  const pending = [root]
  const seenNodes = new Set<LayoutNode<T>>()
  const seenIds = new Set<string>()
  while (pending.length) {
    const node = pending.pop()!
    if (seenNodes.has(node)) throw new Error('Pane layout contains a cycle or shared node')
    seenNodes.add(node)
    if (node.type === 'leaf') {
      if (seenIds.has(node.id)) throw new Error(`Duplicate pane ID: ${node.id}`)
      seenIds.add(node.id)
      leaves.push(node)
    } else {
      if (node.children.length !== 2) throw new Error('A pane split must have two children')
      pending.push(node.children[1], node.children[0])
    }
  }
  return leaves
}

/** In-order pane/divider presentation matches the recursive layout's DOM
 * reading and keyboard order while all stateful components share one parent.
 */
export function collectSurfaceOrder<T>(root: LayoutNode<T>): LayoutNode<T>[] {
  collectSurfaceLeaves(root) // Validate before traversing malformed persistence.
  const ordered: LayoutNode<T>[] = []
  const pending: Array<{ node: LayoutNode<T>; emit: boolean }> = [{ node: root, emit: false }]
  const splitIds = new Set<string>()
  while (pending.length) {
    const { node, emit } = pending.pop()!
    if (node.type === 'leaf' || emit) {
      ordered.push(node)
    } else {
      if (splitIds.has(node.id)) throw new Error(`Duplicate split ID: ${node.id}`)
      splitIds.add(node.id)
      pending.push({ node: node.children[1], emit: false }, { node, emit: true }, { node: node.children[0], emit: false })
    }
  }
  return ordered
}

export function resolveSurfaceZoom(leaves: readonly { id: string }[], zoomedPaneId?: string): string | undefined {
  return zoomedPaneId && leaves.some((leaf) => leaf.id === zoomedPaneId) ? zoomedPaneId : undefined
}

export function isUsableSurfaceRect(rect: SurfaceRect | undefined): rect is SurfaceRect {
  return !!rect && Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0
}

/** Convert viewport coordinates into the borderless layout root's CSS pixels.
 * The root deliberately has no border/padding. Axis-aligned CSS scaling is
 * supported; rotation/skew is not a supported pane-root layout transform.
 */
export function localSurfaceRect(
  root: SurfaceRect,
  slot: SurfaceRect,
  rootWidth: number,
  rootHeight: number,
): SurfaceRect | undefined {
  if (!isUsableSurfaceRect(root) || !isUsableSurfaceRect(slot)
    || !Number.isFinite(rootWidth) || !Number.isFinite(rootHeight)
    || rootWidth <= 0 || rootHeight <= 0) return undefined
  const sx = rootWidth / root.width
  const sy = rootHeight / root.height
  return {
    left: (slot.left - root.left) * sx,
    top: (slot.top - root.top) * sy,
    width: slot.width * sx,
    height: slot.height * sy,
  }
}

function sameRect(a: SurfaceRect, b: SurfaceRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

/** Zero-sized/temporarily unavailable roots must not destroy mounted surfaces.
 * Keep the last usable geometry but make it noninteractive. Closed panes are
 * removed immediately. A never-measured pane mounts only when measurable.
 */
export function reconcileSurfaceMeasurements(
  previous: SurfaceMeasurements,
  surfaceKeys: readonly string[],
  measured: ReadonlyMap<string, SurfaceRect>,
): SurfaceMeasurements {
  const next: Record<string, MeasuredSurface> = Object.create(null)
  let changed = false
  for (const id of surfaceKeys) {
    const rect = measured.get(id)
    const old = Object.hasOwn(previous, id) ? previous[id] : undefined
    if (isUsableSurfaceRect(rect)) {
      next[id] = old?.measurable && sameRect(old.rect, rect) ? old : { rect, measurable: true }
    } else if (old) {
      next[id] = old.measurable ? { rect: old.rect, measurable: false } : old
    }
    if (next[id] !== old) changed = true
  }
  if (Object.keys(previous).length !== Object.keys(next).length) changed = true
  return changed ? next : previous
}
