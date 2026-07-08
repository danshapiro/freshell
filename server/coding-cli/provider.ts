import type { CodingCliProviderName, CodingCliSession, NormalizedEvent, ParsedSessionMeta } from './types.js'

export interface SpawnOptions {
  prompt: string
  cwd?: string
  resumeSessionId?: string
  model?: string
  maxTurns?: number
  permissionMode?: string
  sandbox?: string
  allowedTools?: string[]
  disallowedTools?: string[]
}

export interface CodingCliProvider {
  readonly name: CodingCliProviderName
  readonly displayName: string
  readonly homeDir: string

  listSessionsDirect?(): Promise<CodingCliSession[]>
  getSessionGlob(): string | string[]
  getSessionRoots(): string[]
  /**
   * Newest mtime (ms) among the session's activity sidecar files (e.g. Amplifier's
   * `transcript.jsonl` / `events.jsonl`), or undefined if none exist. Providers whose
   * recency is fully captured by their primary session file omit this. The indexer uses
   * it both to fold real file activity into recency and to force a re-parse when a sidecar
   * grows even though the primary session file is unchanged.
   */
  getActivityMtimeMs?(filePath: string): Promise<number | undefined>
  /** Absolute path of the live lifecycle event log sibling to the given canonical
   *  session file, if this provider maintains one. Enables event-driven activity
   *  tracking without hardcoding sidecar layouts outside the provider. */
  getLiveEventsPath?(filePath: string): string | undefined
  getSessionWatchBases?(): string[]
  listSessionFiles(): Promise<string[]>
  parseSessionFile(content: string, filePath: string): Promise<ParsedSessionMeta>
  resolveProjectPath(filePath: string, meta: ParsedSessionMeta): Promise<string>
  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string

  getCommand(): string
  getStreamArgs(options: SpawnOptions): string[]
  getResumeArgs(sessionId: string): string[]
  parseEvent(line: string): NormalizedEvent[]

  supportsLiveStreaming(): boolean
  supportsSessionResume(): boolean

  /**
   * Whether this provider always generates its own authoritative session title
   * (e.g. Amplifier AI-names every session). Used by the one-time title-shadow
   * cleanup to identify overrides that should yield to the provider title.
   */
  providesAuthoritativeTitle?(): boolean
}
