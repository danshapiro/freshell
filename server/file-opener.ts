import path from 'path'
import { spawn } from 'child_process'

export type EditorPreset = 'auto' | 'cursor' | 'code' | 'custom'

export interface ResolveOpenCommandOptions {
  filePath: string
  reveal?: boolean
  line?: number
  column?: number
  editorSetting?: EditorPreset
  customEditorCommand?: string
  /** Pre-resolved platform string from detectPlatform(). */
  platform: string
}

export interface OpenCommand {
  command: string
  args: string[]
}

function buildLocationSuffix(line?: number, column?: number): string {
  if (line == null) return ''
  return column != null ? `:${line}:${column}` : `:${line}`
}

function resolveEditorPreset(
  preset: 'cursor' | 'code',
  filePath: string,
  line?: number,
  column?: number,
): OpenCommand {
  const location = buildLocationSuffix(line, column)
  switch (preset) {
    case 'cursor':
      return { command: 'cursor', args: ['-r', '-g', `${filePath}${location}`] }
    case 'code':
      return { command: 'code', args: ['-g', `${filePath}${location}`] }
  }
}

function parseCustomTemplate(
  template: string,
  filePath: string,
  line?: number,
  column?: number,
): OpenCommand | null {
  if (!template.trim()) return null

  const parts = template.trim().split(/\s+/)
  const command = parts[0]
  const substituted = parts
    .slice(1)
    .map((arg) => {
      let result = arg.replace(/\{file\}/g, filePath)
      if (line != null) {
        result = result.replace(/\{line\}/g, String(line))
      }
      if (column != null) {
        result = result.replace(/\{col\}/g, String(column))
      }
      return result
    })

  // Remove args that still contain unfilled placeholders, plus any
  // preceding flag arg (e.g. "--line {line}" → remove both "--line" and "{line}")
  const hasPlaceholder = (s: string) => /\{(line|col)\}/.test(s)
  const isFlag = (s: string) => s.startsWith('-') && !s.includes('=')
  const keep = substituted.map(() => true)

  for (let i = 0; i < substituted.length; i++) {
    if (hasPlaceholder(substituted[i])) {
      keep[i] = false
      if (i > 0 && isFlag(substituted[i - 1])) {
        keep[i - 1] = false
      }
    }
  }

  const args = substituted.filter((_, i) => keep[i])
  return { command, args }
}

function platformReveal(platform: string, filePath: string): OpenCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', filePath] }
    case 'win32':
      return { command: 'explorer.exe', args: ['/select,', filePath] }
    case 'wsl':
      return { command: 'explorer.exe', args: ['/select,', filePath] }
    default:
      // Linux: open the containing directory
      return { command: 'xdg-open', args: [path.dirname(filePath)] }
  }
}

function platformOpen(platform: string, filePath: string): OpenCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [filePath] }
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', filePath] }
    case 'wsl':
      return {
        command: '/mnt/c/Windows/System32/cmd.exe',
        args: ['/c', 'start', '', filePath],
      }
    default:
      return { command: 'xdg-open', args: [filePath] }
  }
}

export async function resolveOpenCommand(
  options: ResolveOpenCommandOptions,
): Promise<OpenCommand> {
  const {
    filePath,
    reveal,
    line,
    column,
    editorSetting = 'auto',
    customEditorCommand,
    platform,
  } = options

  // Reveal always uses platform file manager, regardless of editor setting
  if (reveal) {
    return platformReveal(platform, filePath)
  }

  // Check for explicit editor setting
  if (editorSetting === 'cursor' || editorSetting === 'code') {
    return resolveEditorPreset(editorSetting, filePath, line, column)
  }

  if (editorSetting === 'custom' && customEditorCommand) {
    const parsed = parseCustomTemplate(customEditorCommand, filePath, line, column)
    if (parsed) return parsed
  }

  // Auto / fallback: platform default
  return platformOpen(platform, filePath)
}

// --- Spawn health check ---

export interface SpawnResult {
  ok: boolean
  error?: string
}

const HEALTH_CHECK_TIMEOUT_MS = 2000

/**
 * Spawns a detached process and monitors it for early failure.
 * If the process exits with a non-zero code or emits an error within
 * HEALTH_CHECK_TIMEOUT_MS, returns a failure result. Otherwise returns ok.
 */
export function spawnAndMonitor(cmd: OpenCommand): Promise<SpawnResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.command, cmd.args, { detached: true, stdio: 'ignore' })
      child.unref()

      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const onError = (err: Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        child.removeListener('exit', onExit)
        resolve({ ok: false, error: `Failed to launch "${cmd.command}": ${err.message}` })
      }

      const onExit = (code: number | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        child.removeListener('error', onError)
        if (code !== null && code !== 0) {
          resolve({ ok: false, error: `"${cmd.command}" exited with code ${code}` })
        } else {
          // code === 0 or null (still running) — both fine
          resolve({ ok: true })
        }
      }

      child.on('error', onError)
      child.on('exit', onExit)

      // If no error/exit within timeout, assume success
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        resolve({ ok: true })
      }, HEALTH_CHECK_TIMEOUT_MS)
    } catch (err: unknown) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
