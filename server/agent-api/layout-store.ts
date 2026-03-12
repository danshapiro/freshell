import type { SessionLocator } from '../../shared/ws-protocol.js'
import { nanoid } from 'nanoid'
import { resolveTarget } from './target-resolver.js'

type UiSnapshot = {
  tabs: Array<{ id: string; title?: string; fallbackSessionRef?: SessionLocator }>
  activeTabId?: string | null
  layouts: Record<string, any>
  activePane: Record<string, string>
  paneTitles?: Record<string, Record<string, string>>
  paneTitleSetByUser?: Record<string, Record<string, boolean>>
  timestamp?: number
}

type PaneContentSnapshot = Record<string, unknown> & { kind?: string; terminalId?: string }

type Leaf = { id: string; content?: PaneContentSnapshot }

type PaneSnapshot = {
  tabId: string
  paneId: string
  index: number
  kind?: string
  terminalId?: string
  paneContent?: PaneContentSnapshot
}

export class LayoutStore {
  private snapshot: UiSnapshot | null = null
  private sourceConnectionId: string | null = null

  private ensurePaneTitleMaps(tabId: string) {
    if (!this.snapshot) return
    if (!this.snapshot.paneTitles) this.snapshot.paneTitles = {}
    if (!this.snapshot.paneTitles[tabId]) this.snapshot.paneTitles[tabId] = {}
    if (!this.snapshot.paneTitleSetByUser) this.snapshot.paneTitleSetByUser = {}
    if (!this.snapshot.paneTitleSetByUser[tabId]) this.snapshot.paneTitleSetByUser[tabId] = {}
  }

  private getPaneTitleMaps(tabId: string) {
    if (!this.snapshot) return undefined
    this.ensurePaneTitleMaps(tabId)

    const paneTitles = this.snapshot.paneTitles?.[tabId]
    const paneTitleSetByUser = this.snapshot.paneTitleSetByUser?.[tabId]
    if (!paneTitles || !paneTitleSetByUser) return undefined

    return { paneTitles, paneTitleSetByUser }
  }

  private removePaneMetadata(tabId: string, paneId: string) {
    if (!this.snapshot) return
    if (this.snapshot.paneTitles?.[tabId]) {
      delete this.snapshot.paneTitles[tabId][paneId]
      if (Object.keys(this.snapshot.paneTitles[tabId]).length === 0) {
        delete this.snapshot.paneTitles[tabId]
      }
    }
    if (this.snapshot.paneTitleSetByUser?.[tabId]) {
      delete this.snapshot.paneTitleSetByUser[tabId][paneId]
      if (Object.keys(this.snapshot.paneTitleSetByUser[tabId]).length === 0) {
        delete this.snapshot.paneTitleSetByUser[tabId]
      }
    }
  }

  private removeTabMetadata(tabId: string) {
    if (!this.snapshot) return
    delete this.snapshot.paneTitles?.[tabId]
    delete this.snapshot.paneTitleSetByUser?.[tabId]
  }

  private derivePaneTitle(content: any): string | undefined {
    if (!content || typeof content !== 'object') return undefined

    if (content.kind === 'editor') {
      if (typeof content.filePath !== 'string' || !content.filePath) return 'Editor'
      const parts = content.filePath.replace(/\\/g, '/').split('/')
      return parts[parts.length - 1] || 'Editor'
    }

    if (content.kind === 'browser') {
      if (typeof content.url !== 'string' || !content.url) return 'Browser'
      try {
        const url = new URL(content.url)
        return url.hostname || 'Browser'
      } catch {
        return 'Browser'
      }
    }

    if (content.kind === 'agent-chat') {
      switch (content.provider) {
        case 'claude':
          return 'Claude'
        case 'codex':
          return 'Codex'
        default:
          return 'Agent'
      }
    }

    if (content.kind === 'extension') {
      return typeof content.extensionName === 'string' && content.extensionName
        ? content.extensionName
        : 'Extension'
    }

    if (content.kind !== 'terminal') return undefined

    switch (content.mode) {
      case 'claude':
        return 'Claude CLI'
      case 'codex':
        return 'Codex CLI'
      case 'gemini':
        return 'Gemini'
      case 'opencode':
        return 'OpenCode'
      case 'kimi':
        return 'Kimi'
      default:
        switch (content.shell) {
          case 'powershell':
            return 'PowerShell'
          case 'cmd':
            return 'Command Prompt'
          case 'wsl':
            return 'WSL'
          case 'system':
          default:
            return 'Shell'
        }
    }
  }

  private seedPaneTitle(tabId: string, paneId: string, content: any) {
    const title = this.derivePaneTitle(content)
    if (!title || !this.snapshot) return
    const paneTitleMaps = this.getPaneTitleMaps(tabId)
    if (!paneTitleMaps || paneTitleMaps.paneTitleSetByUser[paneId]) return
    paneTitleMaps.paneTitles[paneId] = title
  }

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

  private findSplitById(node: any, splitId: string): any | undefined {
    if (!node || node.type !== 'split') return undefined
    if (node.id === splitId) return node
    return this.findSplitById(node.children?.[0], splitId) || this.findSplitById(node.children?.[1], splitId)
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
      title: this.snapshot?.paneTitles?.[resolvedTabId]?.[leaf.id],
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

  getSplitSizes(tabId: string | undefined, splitId: string): [number, number] | undefined {
    if (!this.snapshot) return undefined
    const candidateTabs = tabId ? [tabId] : this.snapshot.tabs.map((tab) => tab.id)
    for (const candidateTabId of candidateTabs) {
      const root = this.snapshot.layouts?.[candidateTabId]
      const splitNode = this.findSplitById(root, splitId)
      if (!splitNode) continue
      const sizes = splitNode.sizes
      if (!Array.isArray(sizes) || sizes.length !== 2) return undefined
      const first = Number(sizes[0])
      const second = Number(sizes[1])
      if (!Number.isFinite(first) || !Number.isFinite(second)) return undefined
      return [first, second]
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
    const content = this.buildContent({ terminalId, browser, editor })
    snapshot.tabs.push({ id: tabId, title })
    snapshot.layouts[tabId] = {
      type: 'leaf',
      id: paneId,
      content,
    }
    snapshot.activeTabId = tabId
    snapshot.activePane[tabId] = paneId
    this.seedPaneTitle(tabId, paneId, content)
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
      const newContent = this.buildContent({ terminalId: opts.terminalId, browser: opts.browser, editor: opts.editor })
      const splitNode = {
        type: 'split',
        id: nanoid(),
        direction: opts.direction,
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: opts.paneId, content: (leaves.find((leaf) => leaf.id === opts.paneId) as any)?.content },
          { type: 'leaf', id: newPaneId, content: newContent },
        ],
      }

      const replaced = this.findAndReplace(root, opts.paneId, splitNode)
      if (replaced) {
        snapshot.layouts[tab.id] = replaced
        snapshot.activePane[tab.id] = newPaneId
        this.seedPaneTitle(tab.id, newPaneId, newContent)
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
      this.removePaneMetadata(tab.id, paneId)
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

  renamePane(paneId: string, title: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }

    const pane = this.getPaneSnapshot(paneId)
    if (!pane) return { message: 'pane not found' as const }

    const paneTitleMaps = this.getPaneTitleMaps(pane.tabId)
    if (!paneTitleMaps) return { message: 'no layout snapshot' as const }

    paneTitleMaps.paneTitles[paneId] = title
    paneTitleMaps.paneTitleSetByUser[paneId] = true
    return { tabId: pane.tabId, paneId }
  }

  closeTab(tabId: string) {
    if (!this.snapshot) return { message: 'no layout snapshot' as const }
    const nextTabs = this.snapshot.tabs.filter((t) => t.id !== tabId)
    if (nextTabs.length === this.snapshot.tabs.length) return { message: 'tab not found' as const }
    delete this.snapshot.layouts[tabId]
    delete this.snapshot.activePane[tabId]
    this.removeTabMetadata(tabId)
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
    if (this.snapshot.paneTitles?.[targetTab]) {
      const titleA = this.snapshot.paneTitles[targetTab][aId]
      const titleB = this.snapshot.paneTitles[targetTab][bId]
      if (titleB === undefined) {
        delete this.snapshot.paneTitles[targetTab][aId]
      } else {
        this.snapshot.paneTitles[targetTab][aId] = titleB
      }
      if (titleA === undefined) {
        delete this.snapshot.paneTitles[targetTab][bId]
      } else {
        this.snapshot.paneTitles[targetTab][bId] = titleA
      }
    }
    if (this.snapshot.paneTitleSetByUser?.[targetTab]) {
      const titleSetByUserA = this.snapshot.paneTitleSetByUser[targetTab][aId]
      const titleSetByUserB = this.snapshot.paneTitleSetByUser[targetTab][bId]
      if (titleSetByUserB === undefined) {
        delete this.snapshot.paneTitleSetByUser[targetTab][aId]
      } else {
        this.snapshot.paneTitleSetByUser[targetTab][aId] = titleSetByUserB
      }
      if (titleSetByUserA === undefined) {
        delete this.snapshot.paneTitleSetByUser[targetTab][bId]
      } else {
        this.snapshot.paneTitleSetByUser[targetTab][bId] = titleSetByUserA
      }
    }
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
    this.seedPaneTitle(tabId, paneId, content)
    return { tabId, paneId }
  }
}
