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

export interface DirectSessionListOptions {
  changedFiles?: string[]
  deletedFiles?: string[]
}

export interface CodingCliProvider {
  readonly name: CodingCliProviderName
  readonly displayName: string
  readonly homeDir: string

  listSessionsDirect?(options?: DirectSessionListOptions): Promise<CodingCliSession[]>
  getSessionGlob(): string
  getSessionRoots(): string[]
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
}
