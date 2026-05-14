import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CodexDurabilityStoreRecordSchema,
  type CodexDurabilityStoreRecord,
} from '../../../shared/codex-durability.js'

type StoreFs = Pick<typeof fsp, 'mkdir' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>

export function defaultCodexDurabilityStoreDir(): string {
  return process.env.FRESHELL_CODEX_DURABILITY_DIR
    || path.join(os.homedir(), '.freshell', 'codex-durability')
}

export class CodexDurabilityStore {
  private readonly dir: string
  private readonly fsImpl: StoreFs

  constructor(options: { dir?: string; fsImpl?: StoreFs } = {}) {
    this.dir = options.dir ?? defaultCodexDurabilityStoreDir()
    this.fsImpl = options.fsImpl ?? fsp
  }

  async read(terminalId: string): Promise<CodexDurabilityStoreRecord | undefined> {
    const filePath = this.recordPath(terminalId)
    let raw: string
    try {
      raw = await this.fsImpl.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const parsed = CodexDurabilityStoreRecordSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(`Codex durability store record is invalid for terminal ${terminalId}.`)
    }
    return parsed.data
  }

  async write(record: CodexDurabilityStoreRecord): Promise<CodexDurabilityStoreRecord> {
    const parsed = CodexDurabilityStoreRecordSchema.parse(record)
    const existing = await this.read(parsed.terminalId)
    if (existing?.candidate && parsed.candidate) {
      if (
        existing.candidate.candidateThreadId !== parsed.candidate.candidateThreadId
        || existing.candidate.rolloutPath !== parsed.candidate.rolloutPath
      ) {
        throw new Error(`Codex durability candidate mismatch for terminal ${parsed.terminalId}.`)
      }
    }

    await this.fsImpl.mkdir(this.dir, { recursive: true })
    const filePath = this.recordPath(parsed.terminalId)
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await this.fsImpl.writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    await this.fsImpl.rename(tmpPath, filePath)
    return parsed
  }

  async delete(terminalId: string): Promise<void> {
    try {
      await this.fsImpl.unlink(this.recordPath(terminalId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  recordPath(terminalId: string): string {
    return path.join(this.dir, `${encodeURIComponent(terminalId)}.json`)
  }
}
