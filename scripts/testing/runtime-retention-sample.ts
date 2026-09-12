import fs from 'node:fs'
import path from 'node:path'

/** One metadata observation per file. The shell can append/rotate concurrently;
 * comparing two separate byte totals confuses growth with foreign ownership. */
export function sampleRuntimeRetention(root: string, shellRuntimeDir: string) {
  let runtimeLogs = 0, currentBytes = 0, previousBytes = 0
  const current = path.join(shellRuntimeDir, 'terminal-spool-current.jsonl')
  const previous = path.join(shellRuntimeDir, 'terminal-spool-previous.jsonl')
  const stack = [root]
  while (stack.length) {
    const file = stack.pop()!
    const stat = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) stack.push(path.join(file, name))
      continue
    }
    const name = path.basename(file)
    if (/^terminal-spool-(?:current|previous)\.jsonl$/.test(name)) {
      if (!stat.isFile()) throw new Error('terminal spool is not a regular file')
      if (file === current) currentBytes = stat.size
      else if (file === previous) previousBytes = stat.size
      else throw new Error('terminal spool exists outside the single owned shell workload')
    } else if (name.endsWith('.log') || name.endsWith('.jsonl')) runtimeLogs += stat.size
  }
  return {
    terminalSpools: currentBytes + previousBytes, runtimeLogs,
    terminalOutput: { currentBytes, previousBytes },
  }
}
