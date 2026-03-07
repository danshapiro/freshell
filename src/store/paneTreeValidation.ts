import type { PaneNode } from './paneTypes'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isPaneContentShape(content: unknown): boolean {
  if (!isRecord(content) || typeof content.kind !== 'string') {
    return false
  }

  switch (content.kind) {
    case 'terminal':
      return typeof content.createRequestId === 'string'
        && typeof content.status === 'string'
        && typeof content.mode === 'string'
        && isOptionalString(content.terminalId)
        && isOptionalString(content.shell)
        && isOptionalString(content.resumeSessionId)
        && isOptionalString(content.initialCwd)
    case 'browser':
      return typeof content.browserInstanceId === 'string'
        && typeof content.url === 'string'
        && typeof content.devToolsOpen === 'boolean'
    case 'editor':
      return (content.filePath === null || typeof content.filePath === 'string')
        && (content.language === null || typeof content.language === 'string')
        && typeof content.readOnly === 'boolean'
        && typeof content.content === 'string'
        && (content.viewMode === 'source' || content.viewMode === 'preview')
    case 'picker':
      return true
    case 'agent-chat':
      return typeof content.provider === 'string'
        && typeof content.createRequestId === 'string'
        && typeof content.status === 'string'
        && isOptionalString(content.sessionId)
        && isOptionalString(content.resumeSessionId)
        && isOptionalString(content.initialCwd)
        && isOptionalString(content.model)
        && isOptionalString(content.permissionMode)
        && (content.effort === undefined
          || content.effort === 'low'
          || content.effort === 'medium'
          || content.effort === 'high'
          || content.effort === 'max')
        && (content.plugins === undefined
          || (Array.isArray(content.plugins) && content.plugins.every((plugin) => typeof plugin === 'string')))
        && (content.showThinking === undefined || typeof content.showThinking === 'boolean')
        && (content.showTools === undefined || typeof content.showTools === 'boolean')
        && (content.showTimecodes === undefined || typeof content.showTimecodes === 'boolean')
        && (content.settingsDismissed === undefined || typeof content.settingsDismissed === 'boolean')
    case 'extension':
      return typeof content.extensionName === 'string'
        && isRecord(content.props)
    default:
      return false
  }
}

function isPaneLeafNodeShape(node: unknown): node is Extract<PaneNode, { type: 'leaf' }> {
  return !!node
    && typeof node === 'object'
    && (node as any).type === 'leaf'
    && typeof (node as any).id === 'string'
    && !!(node as any).content
    && typeof (node as any).content === 'object'
    && typeof (node as any).content.kind === 'string'
}

function isPaneSplitNodeShape(node: unknown): node is Extract<PaneNode, { type: 'split' }> {
  return !!node
    && typeof node === 'object'
    && (node as any).type === 'split'
    && typeof (node as any).id === 'string'
    && ((node as any).direction === 'horizontal' || (node as any).direction === 'vertical')
    && Array.isArray((node as any).children)
    && (node as any).children.length === 2
    && Array.isArray((node as any).sizes)
    && (node as any).sizes.length === 2
    && typeof (node as any).sizes[0] === 'number'
    && typeof (node as any).sizes[1] === 'number'
}

export function hasPaneTreeShape(node: unknown): boolean {
  if (isPaneLeafNodeShape(node)) return true
  if (!isPaneSplitNodeShape(node)) return false
  return hasPaneTreeShape(node.children[0]) && hasPaneTreeShape(node.children[1])
}

export function isWellFormedPaneTree(node: unknown): node is PaneNode {
  if (isPaneLeafNodeShape(node)) {
    return isPaneContentShape(node.content)
  }
  if (!isPaneSplitNodeShape(node)) return false
  return isWellFormedPaneTree(node.children[0]) && isWellFormedPaneTree(node.children[1])
}
