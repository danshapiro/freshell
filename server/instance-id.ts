import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const INSTANCE_ID_FILENAME = 'instance-id'

function resolveInstanceIdPath(baseDir?: string): string {
  const root = baseDir ? path.resolve(baseDir) : path.join(os.homedir(), '.freshell')
  return path.join(root, INSTANCE_ID_FILENAME)
}

export async function loadOrCreateServerInstanceId(baseDir?: string): Promise<string> {
  const filePath = resolveInstanceIdPath(baseDir)
  try {
    const existing = (await fs.readFile(filePath, 'utf8')).trim()
    if (existing) return existing
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'ENOENT') throw error
    // Create below.
  }

  const instanceId = `srv-${randomUUID()}`
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tempPath = path.join(dir, `${INSTANCE_ID_FILENAME}.tmp-${process.pid}-${Date.now()}`)
  await fs.writeFile(tempPath, `${instanceId}\n`, 'utf8')
  await fs.rename(tempPath, filePath)
  return instanceId
}
