import { nanoid } from 'nanoid'
import { resolveTarget } from './target-resolver.js'

type UiSnapshot = {
  tabs: Array<{ id: string; title?: string }>
  activeTabId?: string | null
  layouts: Record<string, any>
  activePane: Record<string, string>
  paneTitles?: Record<string, Record<string, string>>
  timestamp?: number
}

type Leaf = { id: string; content?: Record<string, unknown> & { kind?: string; terminalId?: string } }

type PaneSnapshot = {
  tabId: string
  paneId: string
  index: number
  kind?: string
  terminalId?: string
  paneContent?: Record<string, unknown> & { kind?: string; terminalId?: string }
}

export class LayoutStore {
  private snapshot: UiSnapshot | null = null
  private sourceConnectionId: string | null = null

  updateFromUi(snapshot: UiSnapshot, connectionId: string) {
    this.snapshot = snapshot
    this.sourceConnectionId = connectionId
  }

  getSourceConnectionId() {
    return this.sourceConnectionId
  }

  getActiveTabId() {
    return this.snapshot?.activeTabId || null
  }

  private ensureSnapshot(): UiSnapshot {
    if (!this.snapshot) {
      this.snapshot = { tabs: [], layouts: {}, activePane: {}, activeTabId: null }
    }
    return this.snapshot
  }

  private collectLeaves(node: any, leaves: Leaf[] = []): Leaf[] {
    if (!node) return leaves
    if (node.type === 'leaf') {
      leaves.push(node as Leaf)
      return leaves
    }
    if (node.type === 'split') {
      this.collectLeaves(node.children[0], leaves)
      this.collectLeaves(node.children[1], leaves)
    }
    return leaves
  }

  private findParentSplitId(node: any, paneId: string): string | null {
    if (!node || node.type !== 'split') return null
    const [left, right] = node.children || []
    if ((left?.type === 'leaf' && left.id === paneId) || (right?.type === 'leaf' && right.id === paneId)) {
      return node.id
    }
    return this.findParentSplitId(left, paneId) || this.findParentSplitId(right, paneId)
  }

  private buildHorizontalRow(leaves: Leaf[]): any {
    if (leaves.length === 1) return leaves[0]
    if (leaves.length === 2) {
      return {
        type: 'split',
        id: nanoid(),
        direction: 'horizontal',
        sizes: [50, 50],
        children: [leaves[0], leaves[1]],
      }
    }
    const mid = Math.ceil(leaves.length / 2)
    const left = leaves.slice(0, mid)
    const right = leaves.slice(mid)
    return {
      type: 'split',
      id: nanoid(),
      direction: 'horizontal',
      sizes: [50, 50],
      children: [this.buildHorizontalRow(left), this.buildHorizontalRow(right)],
    }
  }

  private buildGridLayout(leaves: Leaf[]): any {
    if (leaves.length === 1) return leaves[0]
    if (leaves.length === 2) {
      return {
        type: 'split',
        id: nanoid(),
        direction: 'horizontal',
        sizes: [50, 50],
        children: [leaves[0], leaves[1]],
      }
    }
    const topCount = Math.ceil(leaves.length / 2)
    const topLeaves = leaves.slice(0, topCount)
    const bottomLeaves = leaves.slice(topCount)
    return {
      type: 'split',
      id: nanoid(),
      direction: 'vertical',
      sizes: [50, 50],
      children: [this.buildHorizontalRow(topLeaves), this.buildHorizontalRow(bottomLeaves)],
    }
  }

  private findAndReplace(node: any, targetId: string, replacement: any): any | null {
    if (!node) return null
    if (node.id === targetId) return replacement
    if (node.type !== 'split') return null

    const leftResult = this.findAndReplace(node.children[0], targetId, replacement)
    if (leftResult) {
      return { ...node, children: [leftResult, node.children[1]] }
    }

    const rightResult = this.findAndReplace(node.children[1], targetId, replacement)
    if (rightResult) {
      return { ...node, children: [node.children[0], rightResult] }
    }

    return null
  }

  private buildContent(opts: { terminalId?: string; browser?: string; editor?: string }) {
    if (opts.browser) {
      return { kind: 'browser', url: opts.browser, devToolsOpen: false }
    }
    if (opts.editor) {
      return { kind: 'editor', filePath: opts.editor, language: null, readOnly: false, content: '', viewMode: 'source' }
    }
    return { kind: 'terminal', terminalId: opts.terminalId }
  }

  listTabs() {
    if (!this.snapshot) return []
    return this.snapshot.tabs.map((t) => ({
      id: t.id,
      title: t.title || t.id,
      activePaneId: this.snapshot?.activePane?.[t.id],
    }))
  }

  hasTab(target: string): boolean {
    if (!this.snapshot) return false
    return this.snapshot.tabs.some((t) => t.id === target || t.title === target)
  }

  listPanes(tabId?: string) {
    if (!this.snapshot) return []
    const resolvedTabId = tabId || this.snapshot.activeTabId || this.snapshot.tabs[0]?.id
    if (!resolvedTabId) return []
    const root = this.snapshot.layouts?.[resolvedTabId]
    if (!root) return []
    const leaves = this.collectLeaves(root, [])
    return leaves.map((leaf, idx) => ({
      id: leaf.id,
      index: idx,
      kind: leaf.content?.kind,
      terminalId: leaf.content?.terminalId,
    }))
  }

  resolvePaneToTerminal(paneId: string): string | undefined {
    if (!this.snapshot) return undefined
    for (const tab of this.snapshot.tabs) {
      const root = this.snapshot.layouts?.[tab.id]
      const leaves = this.collectLeaves(root, [])
      const match = leaves.find((leaf) => leaf.id === paneId)
      if (match?.content?.terminalId) return match.content.terminalId
    }
    return undefined
  }

  getPaneSnapshot(paneId: string): PaneSnapshot | undefined {
    if (!this.snapshot) return undefined
    for (const tab of this.snapshot.tabs) {
      const root = this.snapshot.layouts?.[tab.id]
      const leaves = this.collectLeaves(root, [])
      const index = leaves.findIndex((leaf) => leaf.id === paneId)
      if (index < 0) continue
      const leaf = leaves[index]
      return {
        tabId: tab.id,
        paneId: leaf.id,
        index,
        kind: leaf.content?.kind,
        terminalId: leaf.content?.terminalId,
        paneContent: leaf.content,
      }
    }
    return undefined
  }

  findSplitForPane(paneId: string) {
    if (!this.snapshot) return undefined
    for (const tab of this.snapshot.tabs) {
      const root = this.snapshot.layouts?.[tab.id]
      const splitId = this.findParentSplitId(root, paneId)
      if (splitId) return { tabId: tab.id, splitId }
    }
    return undefined
  }

  resolveTarget(target: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' }
    return resolveTarget(target, this.snapshot)
  }

  createTab({ title, terminalId, browser, editor }: { title?: string; terminalId?: string; browser?: string; editor?: string }) {
    const snapshot = this.ensureSnapshot()
    const tabId = nanoid()
    const paneId = nanoid()
    snapshot.tabs.push({ id: tabId, title })
    snapshot.layouts[tabId] = {
      type: 'leaf',
      id: paneId,
      content: this.buildContent({ terminalId, browser, editor }),
    }
    snapshot.activeTabId = tabId
    snapshot.activePane[tabId] = paneId
    return { tabId, paneId }
  }

  splitPane(opts: { paneId: string; direction: 'horizontal' | 'vertical'; terminalId?: string; browser?: string; editor?: string }) {
    const snapshot = this.ensureSnapshot()
    for (const tab of snapshot.tabs) {
      const root = snapshot.layouts?.[tab.id]
      if (!root) continue
      const leaves = this.collectLeaves(root, [])
      if (!leaves.find((leaf) => leaf.id === opts.paneId)) continue

      const newPaneId = nanoid()
      const splitNode = {
        type: 'split',
        id: nanoid(),
        direction: opts.direction,
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: opts.paneId, content: (leaves.find((leaf) => leaf.id === opts.paneId) as any)?.content },
          { type: 'leaf', id: newPaneId, content: this.buildContent({ terminalId: opts.terminalId, browser: opts.browser, editor: opts.editor }) },
        ],
      }

      const replaced = this.findAndReplace(root, opts.paneId, splitNode)
      if (replaced) {
        snapshot.layouts[tab.id] = replaced
        snapshot.activePane[tab.id] = newPaneId
        return { tabId: tab.id, newPaneId }
      }
    }
    return { message: 'pane not found' as const }
  }

  closePane(paneId: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    for (const tab of this.snapshot.tabs) {
      const root = this.snapshot.layouts?.[tab.id]
      if (!root) continue
      const leaves = this.collectLeaves(root, [])
      const remaining = leaves.filter((leaf) => leaf.id !== paneId)
      if (remaining.length === leaves.length) continue
      if (remaining.length === 0) return { message: 'cannot close only pane' as const }
      this.snapshot.layouts[tab.id] = this.buildGridLayout(remaining)
      this.snapshot.activePane[tab.id] = remaining[remaining.length - 1].id
      return { tabId: tab.id }
    }
    return { message: 'pane not found' as const }
  }

  selectTab(tabId: string) {
    const snapshot = this.ensureSnapshot()
    const exists = snapshot.tabs.some((tab) => tab.id === tabId)
    if (!exists) return { message: 'tab not found' as const }
    snapshot.activeTabId = tabId
    return { tabId }
  }

  selectPane(tabId: string | undefined, paneId: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const tabExists = tabId ? this.snapshot.tabs.some((tab) => tab.id === tabId) : false
    const targetTab = tabExists
      ? tabId
      : this.snapshot.tabs.find((tab) => {
          const root = this.snapshot?.layouts?.[tab.id]
          const leaves = this.collectLeaves(root, [])
          return leaves.some((leaf) => leaf.id === paneId)
        })?.id
    if (!targetTab) return { message: 'pane not found' as const }
    this.snapshot.activePane[targetTab] = paneId
    this.snapshot.activeTabId = targetTab
    return { tabId: targetTab, paneId }
  }

  renameTab(tabId: string, title?: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const tab = this.snapshot.tabs.find((t) => t.id === tabId)
    if (!tab) return { message: 'tab not found' as const }
    tab.title = title
    return { tabId }
  }

  closeTab(tabId: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const nextTabs = this.snapshot.tabs.filter((t) => t.id !== tabId)
    if (nextTabs.length === this.snapshot.tabs.length) return { message: 'tab not found' as const }
    delete this.snapshot.layouts[tabId]
    delete this.snapshot.activePane[tabId]
    this.snapshot.tabs = nextTabs
    this.snapshot.activeTabId = nextTabs[0]?.id || null
    return { tabId }
  }

  selectNextTab() {
    if (!this.snapshot || this.snapshot.tabs.length === 0) return { message: 'no tabs' as const }
    const currentIndex = this.snapshot.tabs.findIndex((t) => t.id === this.snapshot?.activeTabId)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % this.snapshot.tabs.length : 0
    const tabId = this.snapshot.tabs[nextIndex].id
    this.snapshot.activeTabId = tabId
    return { tabId }
  }

  selectPrevTab() {
    if (!this.snapshot || this.snapshot.tabs.length === 0) return { message: 'no tabs' as const }
    const currentIndex = this.snapshot.tabs.findIndex((t) => t.id === this.snapshot?.activeTabId)
    const prevIndex = currentIndex >= 0
      ? (currentIndex - 1 + this.snapshot.tabs.length) % this.snapshot.tabs.length
      : 0
    const tabId = this.snapshot.tabs[prevIndex].id
    this.snapshot.activeTabId = tabId
    return { tabId }
  }

  swapPane(tabId: string | undefined, aId: string, bId: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const targetTab = tabId || this.snapshot.tabs.find((tab) => {
      const root = this.snapshot?.layouts?.[tab.id]
      const leaves = this.collectLeaves(root, [])
      return leaves.some((leaf) => leaf.id === aId) && leaves.some((leaf) => leaf.id === bId)
    })?.id
    if (!targetTab) return { message: 'panes not found' as const }
    const root = this.snapshot.layouts?.[targetTab]
    const leaves = this.collectLeaves(root, [])
    const a = leaves.find((leaf) => leaf.id === aId)
    const b = leaves.find((leaf) => leaf.id === bId)
    if (!a || !b) return { message: 'panes not found' as const }
    const temp = a.content
    a.content = b.content
    b.content = temp
    return { tabId: targetTab }
  }

  resizePane(tabId: string | undefined, splitId: string, sizes: [number, number]) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const targetTab = tabId || this.snapshot.tabs.find((tab) => {
      const root = this.snapshot?.layouts?.[tab.id]
      const stack: any[] = root ? [root] : []
      while (stack.length) {
        const node = stack.pop()
        if (node?.id === splitId) return true
        if (node?.type === 'split') stack.push(node.children[0], node.children[1])
      }
      return false
    })?.id
    if (!targetTab) return { message: 'split not found' as const }
    const root = this.snapshot.layouts?.[targetTab]
    const update = (node: any): any => {
      if (!node) return node
      if (node.type === 'leaf') return node
      if (node.id === splitId) return { ...node, sizes }
      return { ...node, children: [update(node.children[0]), update(node.children[1])] }
    }
    this.snapshot.layouts[targetTab] = update(root)
    return { tabId: targetTab }
  }

  attachPaneContent(tabId: string, paneId: string, content: any) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const root = this.snapshot.layouts?.[tabId]
    if (!root) return { message: 'tab not found' as const }
    const update = (node: any): any => {
      if (node.type === 'leaf') {
        if (node.id === paneId) return { ...node, content }
        return node
      }
      return { ...node, children: [update(node.children[0]), update(node.children[1])] }
    }
    this.snapshot.layouts[tabId] = update(root)
    return { tabId, paneId }
  }
}
