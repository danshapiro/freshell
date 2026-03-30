/**
 * Session Scanner Implementation
 *
 * Scans Claude session JSONL files for chain integrity and repairs corrupted sessions.
 * Designed for future Rust replacement - keep logic simple and well-tested.
 */

import { promises as fs } from 'fs'
import path from 'path'
import type {
  SessionScanner,
  SessionScanResult,
  SessionRepairResult,
  SessionRepairOptions,
  ParsedMessage,
} from './types.js'

/**
 * Extract session ID from file path.
 * e.g., /path/to/abc123.jsonl -> abc123
 */
function extractSessionId(filePath: string): string {
  const basename = path.basename(filePath, '.jsonl')
  return basename
}

/**
 * Parse a JSONL line, extracting only fields needed for chain analysis.
 * Returns null for invalid JSON or lines without uuid.
 */
function parseMessage(line: string, lineNumber: number): ParsedMessage | null {
  if (!line.trim()) return null

  try {
    const obj = JSON.parse(line)
    if (!obj.uuid) return null

    return {
      uuid: obj.uuid,
      parentUuid: obj.parentUuid,
      type: obj.type,
      lineNumber,
      subtype: obj.subtype,
      toolUseID: obj.toolUseID,
      dataType: obj.data?.type,
      dataHookEvent: obj.data?.hookEvent,
    }
  } catch {
    return null
  }
}

/**
 * Calculate chain depth from last message to root (or break point).
 * Returns the number of messages reachable by walking parentUuid links.
 */
function calculateChainDepth(
  messages: ParsedMessage[],
  uuidToMessage: Map<string, ParsedMessage>
): number {
  if (messages.length === 0) return 0

  const lastMessage = messages[messages.length - 1]
  let depth = 1
  let current = lastMessage

  while (current.parentUuid) {
    const parent = uuidToMessage.get(current.parentUuid)
    if (!parent) break // Chain broken
    depth++
    current = parent
  }

  return depth
}

/**
 * Find orphan messages - those with parentUuid pointing to non-existent uuid.
 */
function findOrphans(
  messages: ParsedMessage[],
  uuidToMessage: Map<string, ParsedMessage>
): ParsedMessage[] {
  return messages.filter(
    (msg) => msg.parentUuid && !uuidToMessage.has(msg.parentUuid)
  )
}

/**
 * Detect the inline stop-hook progress chain shape on the active leaf.
 *
 * The problematic shape is (from leaf toward root):
 *   turn_duration? -> stop_hook_summary -> progress(hook_progress/Stop) -> assistant
 *
 * Where stop_hook_summary.parentUuid === progress.uuid
 *   and stop_hook_summary.toolUseID === progress.toolUseID
 *   and progress.dataType === 'hook_progress'
 *   and progress.dataHookEvent === 'Stop'
 *   and the progress is parented to an assistant message.
 *
 * Returns the matched nodes if found, or undefined.
 */
interface InlineProgressMatch {
  stopSummary: ParsedMessage
  progress: ParsedMessage
  assistant: ParsedMessage
}

function detectInlineStopHookProgress(
  lastMessage: ParsedMessage | undefined,
  uuidToMessage: Map<string, ParsedMessage>,
): InlineProgressMatch | undefined {
  if (!lastMessage) return undefined

  // The leaf may be turn_duration (skip it) or stop_hook_summary directly
  let candidate = lastMessage
  if (candidate.type === 'system' && candidate.subtype === 'turn_duration' && candidate.parentUuid) {
    const parent = uuidToMessage.get(candidate.parentUuid)
    if (parent) candidate = parent
  }

  // Candidate should be stop_hook_summary
  if (candidate.type !== 'system' || candidate.subtype !== 'stop_hook_summary') return undefined
  const stopSummary = candidate

  // Parent of stop_hook_summary should be the progress record
  if (!stopSummary.parentUuid) return undefined
  const progress = uuidToMessage.get(stopSummary.parentUuid)
  if (!progress) return undefined

  // Validate progress record
  if (progress.type !== 'progress') return undefined
  if (progress.dataType !== 'hook_progress') return undefined
  if (progress.dataHookEvent !== 'Stop') return undefined

  // Validate toolUseID match
  if (!stopSummary.toolUseID || stopSummary.toolUseID !== progress.toolUseID) return undefined

  // Parent of progress should be an assistant message
  if (!progress.parentUuid) return undefined
  const assistant = uuidToMessage.get(progress.parentUuid)
  if (!assistant) return undefined
  if (assistant.type !== 'assistant') return undefined

  return { stopSummary, progress, assistant }
}

/**
 * Create the session scanner implementation.
 */
export function createSessionScanner(): SessionScanner {
  async function scan(filePath: string): Promise<SessionScanResult> {
    const sessionId = extractSessionId(filePath)

    // Check if file exists
    let stat
    try {
      stat = await fs.stat(filePath)
    } catch {
      return {
        sessionId,
        filePath,
        status: 'missing',
        chainDepth: 0,
        orphanCount: 0,
        fileSize: 0,
        messageCount: 0,
      }
    }

    // Read and parse file
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch {
      return {
        sessionId,
        filePath,
        status: 'unreadable',
        chainDepth: 0,
        orphanCount: 0,
        fileSize: stat.size,
        messageCount: 0,
      }
    }

    // Parse all lines
    const lines = content.split('\n')
    const messages: ParsedMessage[] = []
    const uuidToMessage = new Map<string, ParsedMessage>()

    for (let i = 0; i < lines.length; i++) {
      const msg = parseMessage(lines[i], i)
      if (msg) {
        messages.push(msg)
        uuidToMessage.set(msg.uuid, msg)
      }
    }

    // Find orphans
    const orphans = findOrphans(messages, uuidToMessage)
    const chainDepth = calculateChainDepth(messages, uuidToMessage)

    // Detect resume issue on active chain (bounded: at most 3 parent hops from leaf)
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
    const resumeMatch = detectInlineStopHookProgress(lastMessage, uuidToMessage)

    return {
      sessionId,
      filePath,
      status: orphans.length > 0 ? 'corrupted' : 'healthy',
      chainDepth,
      orphanCount: orphans.length,
      fileSize: stat.size,
      messageCount: messages.length,
      resumeIssue: resumeMatch ? 'inline_stop_hook_progress' : undefined,
    }
  }

  async function repair(filePath: string, options?: SessionRepairOptions): Promise<SessionRepairResult> {
    const sessionId = extractSessionId(filePath)

    // Read file
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      return {
        sessionId,
        status: 'failed',
        orphansFixed: 0,
        resumeIssuesFixed: 0,
        newChainDepth: 0,
        error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // Parse all lines
    const lines = content.split('\n')
    const messages: ParsedMessage[] = []
    const uuidToMessage = new Map<string, ParsedMessage>()
    const lineToObj = new Map<number, Record<string, unknown>>()

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue

      try {
        const obj = JSON.parse(lines[i])
        lineToObj.set(i, obj)

        if (obj.uuid) {
          const msg: ParsedMessage = {
            uuid: obj.uuid,
            parentUuid: obj.parentUuid,
            type: obj.type,
            lineNumber: i,
            subtype: obj.subtype,
            toolUseID: obj.toolUseID,
            dataType: obj.data?.type,
            dataHookEvent: obj.data?.hookEvent,
          }
          messages.push(msg)
          uuidToMessage.set(obj.uuid, msg)
        }
      } catch {
        // Skip malformed lines during repair
      }
    }

    // Find orphans
    const orphans = findOrphans(messages, uuidToMessage)

    // Detect inline-progress match when resume issue repair is enabled
    const inlineMatch = options?.includeResumeIssues
      ? detectInlineStopHookProgress(
          messages.length > 0 ? messages[messages.length - 1] : undefined,
          uuidToMessage,
        )
      : undefined

    if (orphans.length === 0 && !inlineMatch) {
      const chainDepth = calculateChainDepth(messages, uuidToMessage)
      return {
        sessionId,
        status: 'already_healthy',
        orphansFixed: 0,
        resumeIssuesFixed: 0,
        newChainDepth: chainDepth,
      }
    }

    // Create backup
    const backupPath = `${filePath}.backup-${Date.now()}`
    await fs.copyFile(filePath, backupPath)

    // Fix orphans: re-parent to previous valid message
    const fixedLines = [...lines]

    for (const orphan of orphans) {
      const obj = lineToObj.get(orphan.lineNumber)
      if (!obj) continue

      // Find previous valid message (one whose parent exists or has no parent)
      let newParent: string | null = null
      for (let j = orphan.lineNumber - 1; j >= 0; j--) {
        const candidate = messages.find((m) => m.lineNumber === j)
        if (candidate) {
          // Check if candidate is valid (not itself an unfixed orphan)
          const candidateParent = candidate.parentUuid
          if (!candidateParent || uuidToMessage.has(candidateParent)) {
            newParent = candidate.uuid
            break
          }
        }
      }

      // Update the object with new parent
      obj.parentUuid = newParent
      fixedLines[orphan.lineNumber] = JSON.stringify(obj)

      // Update in-memory structures for subsequent orphans
      orphan.parentUuid = newParent ?? undefined
      if (newParent) {
        // The orphan is now valid, can be used as parent for later orphans
      }
    }

    // Fix inline stop-hook progress if detected
    let resumeIssuesFixed = 0
    if (inlineMatch) {
      const obj = lineToObj.get(inlineMatch.stopSummary.lineNumber)
      if (obj) {
        obj.parentUuid = inlineMatch.assistant.uuid
        fixedLines[inlineMatch.stopSummary.lineNumber] = JSON.stringify(obj)
        resumeIssuesFixed = 1
      }
    }

    // Write repaired content
    await fs.writeFile(filePath, fixedLines.join('\n'))

    // Recalculate chain depth after repair
    const repairedContent = await fs.readFile(filePath, 'utf8')
    const repairedLines = repairedContent.split('\n')
    const repairedMessages: ParsedMessage[] = []
    const repairedUuidToMessage = new Map<string, ParsedMessage>()

    for (let i = 0; i < repairedLines.length; i++) {
      const msg = parseMessage(repairedLines[i], i)
      if (msg) {
        repairedMessages.push(msg)
        repairedUuidToMessage.set(msg.uuid, msg)
      }
    }

    const newChainDepth = calculateChainDepth(repairedMessages, repairedUuidToMessage)

    return {
      sessionId,
      status: 'repaired',
      backupPath,
      orphansFixed: orphans.length,
      resumeIssuesFixed,
      newChainDepth,
    }
  }

  async function scanBatch(filePaths: string[]): Promise<SessionScanResult[]> {
    return Promise.all(filePaths.map(scan))
  }

  return { scan, repair, scanBatch }
}
