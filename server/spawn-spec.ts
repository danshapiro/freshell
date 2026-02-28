import { logger } from './logger.js'
import { isValidClaudeSessionId } from './claude-session-id.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  isWindows, isWsl, isWindowsLike,
  getWindowsExe, getWindowsDefaultCwd,
  resolveShell, getSystemShell, isLinuxPath,
} from './platform-utils.js'
import type { ShellType } from './platform-utils.js'

// TerminalMode includes 'shell' for regular terminals, plus coding CLI providers.
// Provider command defaults are configurable via env vars; resume semantics
// are only configured for providers that define resume args.
export type TerminalMode = 'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'

type CodingCliCommandSpec = {
  label: string
  envVar: string
  defaultCommand: string
  resumeArgs?: (sessionId: string) => string[]
}

export const CODING_CLI_COMMANDS: Record<Exclude<TerminalMode, 'shell'>, CodingCliCommandSpec> = {
  claude: {
    label: 'Claude CLI',
    envVar: 'CLAUDE_CMD',
    defaultCommand: 'claude',
    resumeArgs: (sessionId) => ['--resume', sessionId],
  },
  codex: {
    label: 'Codex CLI',
    envVar: 'CODEX_CMD',
    defaultCommand: 'codex',
    resumeArgs: (sessionId) => ['resume', sessionId],
  },
  opencode: {
    label: 'OpenCode',
    envVar: 'OPENCODE_CMD',
    defaultCommand: 'opencode',
  },
  gemini: {
    label: 'Gemini',
    envVar: 'GEMINI_CMD',
    defaultCommand: 'gemini',
  },
  kimi: {
    label: 'Kimi',
    envVar: 'KIMI_CMD',
    defaultCommand: 'kimi',
  },
}

/**
 * Check if a terminal mode supports session resume.
 * Only modes with configured resumeArgs in CODING_CLI_COMMANDS support resume.
 */
export function modeSupportsResume(mode: TerminalMode): boolean {
  if (mode === 'shell') return false
  return !!CODING_CLI_COMMANDS[mode]?.resumeArgs
}

type ProviderTarget = 'unix' | 'windows'

const DEFAULT_FRESHELL_ORCHESTRATION_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'freshell-orchestration')
const LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'freshell-automation-tmux-style')
const DEFAULT_FRESHELL_DEMO_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'freshell-demo-creation')
const LEGACY_FRESHELL_DEMO_SKILL_DIR = path.join(process.cwd(), '.claude', 'skills', 'demo-creating')
const DEFAULT_FRESHELL_CLAUDE_PLUGIN_DIR = path.join(process.cwd(), '.claude', 'plugins', 'freshell-orchestration')
const LEGACY_FRESHELL_CLAUDE_PLUGIN_DIR = path.join(process.cwd(), '.claude', 'plugins', 'freshell-automation-tmux-style')
const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex')

function firstExistingPath(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Ignore filesystem errors and fall through to the next candidate.
    }
  }
  return undefined
}

function encodeTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function firstExistingPaths(candidates: Array<string | undefined>): string[] {
  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || unique.has(candidate)) continue
    try {
      if (fs.existsSync(candidate)) unique.add(candidate)
    } catch {
      // Ignore filesystem errors and continue collecting matches.
    }
  }
  return Array.from(unique)
}

function codexSkillsDir(): string {
  const codexHome = process.env.CODEX_HOME || DEFAULT_CODEX_HOME
  return path.join(codexHome, 'skills')
}

function codexOrchestrationSkillArgs(): string[] {
  const skillsDir = codexSkillsDir()
  const skillPath = firstExistingPath([
    process.env.FRESHELL_ORCHESTRATION_SKILL_DIR,
    DEFAULT_FRESHELL_ORCHESTRATION_SKILL_DIR,
    LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR,
    path.join(skillsDir, 'freshell-orchestration'),
    path.join(skillsDir, 'freshell-automation-tmux-style'),
  ])
  if (!skillPath) return []
  const disablePaths = firstExistingPaths([
    process.env.FRESHELL_DEMO_SKILL_DIR,
    DEFAULT_FRESHELL_DEMO_SKILL_DIR,
    LEGACY_FRESHELL_DEMO_SKILL_DIR,
    path.join(skillsDir, 'demo-creating'),
    path.join(skillsDir, 'freshell-demo-creation'),
    LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR,
    path.join(skillsDir, 'freshell-automation-tmux-style'),
  ]).filter((entryPath) => entryPath !== skillPath)

  const entries: Array<{ path: string; enabled: boolean }> = [
    { path: skillPath, enabled: true },
    ...disablePaths.map((entryPath) => ({ path: entryPath, enabled: false })),
  ]
  const tomlEntries = entries.map(
    (entry) => `{path = ${encodeTomlString(entry.path)}, enabled = ${entry.enabled}}`
  )
  return ['-c', `skills.config=[${tomlEntries.join(', ')}]`]
}

function claudePluginArgs(): string[] {
  const pluginDir = firstExistingPath([
    process.env.FRESHELL_CLAUDE_PLUGIN_DIR,
    DEFAULT_FRESHELL_CLAUDE_PLUGIN_DIR,
    LEGACY_FRESHELL_CLAUDE_PLUGIN_DIR,
  ])
  if (!pluginDir) return []
  return ['--plugin-dir', pluginDir]
}

function providerNotificationArgs(mode: TerminalMode, target: ProviderTarget): string[] {
  if (mode === 'codex') {
    return [
      '-c', 'tui.notification_method=bel',
      '-c', "tui.notifications=['agent-turn-complete']",
      ...codexOrchestrationSkillArgs(),
    ]
  }

  if (mode === 'claude') {
    const bellCommand = target === 'windows'
      ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$bell=[char]7; $ok=$false; try {[System.IO.File]::AppendAllText('\\\\.\\CONOUT$', [string]$bell); $ok=$true} catch {}; if (-not $ok) { try {[Console]::Out.Write($bell); $ok=$true} catch {} }; if (-not $ok) { try {[Console]::Error.Write($bell)} catch {} }"`
      : `sh -lc "printf '\\a' > /dev/tty 2>/dev/null || true"`
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: bellCommand,
              },
            ],
          },
        ],
      },
    }
    return [...claudePluginArgs(), '--settings', JSON.stringify(settings)]
  }

  return []
}

function resolveCodingCliCommand(mode: TerminalMode, resumeSessionId?: string, target: ProviderTarget = 'unix') {
  if (mode === 'shell') return null
  const spec = CODING_CLI_COMMANDS[mode]
  const command = process.env[spec.envVar] || spec.defaultCommand
  const providerArgs = providerNotificationArgs(mode, target)
  let resumeArgs: string[] = []
  if (resumeSessionId) {
    if (spec.resumeArgs) {
      resumeArgs = spec.resumeArgs(resumeSessionId)
    } else {
      logger.warn({ mode, resumeSessionId }, 'Resume requested but no resume args configured')
    }
  }
  return { command, args: [...providerArgs, ...resumeArgs], label: spec.label }
}

export function normalizeResumeSessionId(mode: TerminalMode, resumeSessionId?: string): string | undefined {
  if (!resumeSessionId) return undefined
  if (mode !== 'claude') return resumeSessionId
  if (isValidClaudeSessionId(resumeSessionId)) return resumeSessionId
  logger.warn({ resumeSessionId }, 'Ignoring invalid Claude resumeSessionId')
  return undefined
}

export function getModeLabel(mode: TerminalMode): string {
  if (mode === 'shell') return 'Shell'
  const label = CODING_CLI_COMMANDS[mode]?.label
  return label || mode.toUpperCase()
}

/**
 * Escape special characters for cmd.exe shell commands.
 * cmd.exe uses ^ as its escape character for most special characters.
 * The % character is special and must be doubled (%%).
 */
export function escapeCmdExe(s: string): string {
  // Escape ^ first (the escape char itself), then other special chars
  // Order matters: ^ must be escaped before we add more ^
  return s
    .replace(/\^/g, '^^')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '%%')
    .replace(/"/g, '\\"')
}

function quoteCmdArg(arg: string): string {
  // cmd.exe expands %VAR% even inside quotes; double % to preserve literals.
  const escaped = arg.replace(/%/g, '%%')
  let quoted = '"'
  let backslashCount = 0
  for (const ch of escaped) {
    if (ch === '\\') {
      backslashCount += 1
      continue
    }

    if (ch === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1)
      quoted += '"'
      backslashCount = 0
      continue
    }

    if (backslashCount > 0) {
      quoted += '\\'.repeat(backslashCount)
      backslashCount = 0
    }
    quoted += ch
  }

  if (backslashCount > 0) {
    quoted += '\\'.repeat(backslashCount * 2)
  }
  quoted += '"'
  return quoted
}

function buildCmdCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCmdArg).join(' ')
}

function quotePowerShellLiteral(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`
}

function buildPowerShellCommand(command: string, args: string[]): string {
  const invocation = ['&', quotePowerShellLiteral(command), ...args.map(quotePowerShellLiteral)].join(' ')
  return invocation
}

export function buildSpawnSpec(mode: TerminalMode, cwd: string | undefined, shell: ShellType, resumeSessionId?: string) {
  // CLAUDECODE is set by parent Claude Code sessions and causes child
  // claude processes to refuse to start ("nested session" error). Strip it.
  const { CLAUDECODE: _, ...parentEnv } = process.env
  const env = {
    ...parentEnv,
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
  }

  const normalizedResume = normalizeResumeSessionId(mode, resumeSessionId)

  // Resolve shell for the current platform
  const effectiveShell = resolveShell(shell)

  // Debug logging for shell/cwd resolution
  logger.debug({
    mode,
    requestedShell: shell,
    effectiveShell,
    cwd,
    isLinuxPath: cwd ? isLinuxPath(cwd) : false,
    isWsl: isWsl(),
    isWindows: isWindows(),
  }, 'buildSpawnSpec: resolving shell and cwd')

  // In WSL with 'system' shell (which 'wsl' resolves to), use Linux shell directly
  // For 'cmd' or 'powershell' in WSL, fall through to Windows shell handling
  const inWslWithLinuxShell = isWsl() && effectiveShell === 'system'

  if (isWindowsLike() && !inWslWithLinuxShell) {
    // If the cwd is a Linux path, force WSL mode since native Windows shells can't use it
    // (Only applies on native Windows, not when already in WSL)
    const forceWsl = isWindows() && isLinuxPath(cwd)

    // Use protocol-specified shell, falling back to env var for backwards compatibility
    const windowsMode = forceWsl
      ? 'wsl'
      : effectiveShell !== 'system'
        ? effectiveShell
        : (process.env.WINDOWS_SHELL || 'wsl').toLowerCase()

    // Option A: WSL (from native Windows) — recommended for coding CLIs on Windows.
    // This path is skipped when already running inside WSL.
    if (windowsMode === 'wsl') {
      const wsl = process.env.WSL_EXE || 'wsl.exe'
      const distro = process.env.WSL_DISTRO // optional
      const args: string[] = []
      if (distro) args.push('-d', distro)

      if (cwd) {
        // cwd must be a Linux path inside WSL.
        args.push('--cd', cwd)
      }

      if (mode === 'shell') {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      const cli = resolveCodingCliCommand(mode, normalizedResume, 'unix')
      if (!cli) {
        args.push('--exec', 'bash', '-l')
        return { file: wsl, args, cwd: undefined, env }
      }

      args.push('--exec', cli.command, ...cli.args)
      return { file: wsl, args, cwd: undefined, env }
    }

    // Option B: Native Windows shells (PowerShell/cmd)

    if (windowsMode === 'cmd') {
      const file = getWindowsExe('cmd')
      // In WSL, we can't pass Linux paths as cwd to Windows executables (they become UNC paths)
      // Instead, pass no cwd and use cd /d inside the command
      const inWsl = isWsl()
      const winCwd = inWsl ? getWindowsDefaultCwd() : (isLinuxPath(cwd) ? undefined : cwd)
      // For WSL: don't pass cwd to node-pty, use cd /d in command instead
      const procCwd = inWsl ? undefined : winCwd
      logger.debug({
        shell: 'cmd',
        inWsl,
        originalCwd: cwd,
        winCwd,
        procCwd,
        file,
      }, 'buildSpawnSpec: cmd.exe cwd resolution')
      if (mode === 'shell') {
        if (inWsl && winCwd) {
          // Use /K with cd command to change to Windows directory
          return { file, args: ['/K', `cd /d ${quoteCmdArg(winCwd)}`], cwd: procCwd, env }
        }
        return { file, args: ['/K'], cwd: procCwd, env }
      }
      const cli = resolveCodingCliCommand(mode, normalizedResume, 'windows')
      const cmd = cli?.command || mode
      const command = buildCmdCommand(cmd, cli?.args || [])
      const cd = winCwd ? `cd /d ${quoteCmdArg(winCwd)} && ` : ''
      return { file, args: ['/K', `${cd}${command}`], cwd: procCwd, env }
    }

    // default to PowerShell
    const file = getWindowsExe('powershell')
    // In WSL, we can't pass Linux paths as cwd to Windows executables (they become UNC paths)
    const inWsl = isWsl()
    const winCwd = inWsl ? getWindowsDefaultCwd() : (isLinuxPath(cwd) ? undefined : cwd)
    const procCwd = inWsl ? undefined : winCwd
    logger.debug({
      shell: 'powershell',
      inWsl,
      originalCwd: cwd,
      winCwd,
      procCwd,
      file,
    }, 'buildSpawnSpec: powershell.exe cwd resolution')
    if (mode === 'shell') {
      if (inWsl && winCwd) {
        // Use Set-Location to change to Windows directory
        return { file, args: ['-NoLogo', '-NoExit', '-Command', `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}`], cwd: procCwd, env }
      }
      return { file, args: ['-NoLogo'], cwd: procCwd, env }
    }

    const cli = resolveCodingCliCommand(mode, normalizedResume, 'windows')
    const cmd = cli?.command || mode
    const invocation = buildPowerShellCommand(cmd, cli?.args || [])
    const cd = winCwd ? `Set-Location -LiteralPath ${quotePowerShellLiteral(winCwd)}; ` : ''
    const command = `${cd}${invocation}`
    return { file, args: ['-NoLogo', '-NoExit', '-Command', command], cwd: procCwd, env }
  }
// Non-Windows: native spawn using system shell
  const systemShell = getSystemShell()

  if (mode === 'shell') {
    return { file: systemShell, args: ['-l'], cwd, env }
  }

  const cli = resolveCodingCliCommand(mode, normalizedResume, 'unix')
  const cmd = cli?.command || mode
  const args = cli?.args || []
  return { file: cmd, args, cwd, env }
}
