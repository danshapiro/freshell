import { execFile, type ExecFileException } from 'node:child_process'

export const ELEVATED_POWERSHELL_TIMEOUT_MS = 120_000

export type ElevatedPowerShellCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void

export function buildElevatedPowerShellArgs(script: string): string[] {
  const escaped = script.replace(/'/g, "''")
  return [
    '-Command',
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escaped}'`,
  ]
}

export function spawnElevatedPowerShell(
  command: string,
  script: string,
  callback: ElevatedPowerShellCallback,
) {
  return execFile(
    command,
    buildElevatedPowerShellArgs(script),
    { timeout: ELEVATED_POWERSHELL_TIMEOUT_MS },
    callback,
  )
}
