/**
 * Session Scanner Types
 *
 * Designed for drop-in Rust replacement via NAPI-RS.
 * Node.js implementation first, same interface for Rust later.
 */

/**
 * Result of scanning a session file for chain integrity.
 */
export interface SessionScanResult {
  /** Session ID extracted from filename */
  sessionId: string
  /** Absolute path to the session file */
  filePath: string
  /** Health status of the session */
  status: 'healthy' | 'corrupted' | 'missing' | 'unreadable'
  /** Depth from last message to root (or to break point if corrupted) */
  chainDepth: number
  /** Number of messages with missing parentUuid references */
  orphanCount: number
  /** File size in bytes */
  fileSize: number
  /** Total number of messages in the file */
  messageCount: number
}

/**
 * Result of attempting to repair a session file.
 */
export interface SessionRepairResult {
  /** Session ID */
  sessionId: string
  /** Outcome of the repair attempt */
  status: 'repaired' | 'already_healthy' | 'failed'
  /** Path to backup file if created */
  backupPath?: string
  /** Number of orphan messages that were re-parented */
  orphansFixed: number
  /** Chain depth after repair */
  newChainDepth: number
  /** Error message if failed */
  error?: string
}

/**
 * Scanner interface - implemented in Node.js, later in Rust.
 */
export interface SessionScanner {
  /**
   * Scan a session file for chain integrity.
   * Returns scan result without modifying the file.
   */
  scan(filePath: string): Promise<SessionScanResult>

  /**
   * Repair a corrupted session file.
   * Creates backup before modifying. Idempotent - safe to call on healthy files.
   */
  repair(filePath: string): Promise<SessionRepairResult>

  /**
   * Scan multiple files in parallel.
   * Used for batch scanning at server start.
   */
  scanBatch(filePaths: string[]): Promise<SessionScanResult[]>
}

/**
 * Parsed message from a JSONL line.
 * Only includes fields relevant to chain integrity.
 */
export interface ParsedMessage {
  uuid: string
  parentUuid?: string
  type?: string
  lineNumber: number
}
