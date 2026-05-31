import type { DesktopConfig } from './types.js'

/**
 * One-time provisioning from a silent installer.
 *
 * The installer cannot safely emit JSON (it has no string-escaping), so it
 * writes raw values to a line-based `desktop.provision` file instead. We parse
 * that file here and persist a real config via `patchDesktopConfig`, whose
 * `JSON.stringify` serialization escapes quotes/backslashes correctly.
 */

export interface ParsedProvisioning {
  remoteUrl?: string
  remoteToken?: string
}

/**
 * Parse `KEY=value` lines. The value keeps every character after the first
 * `=` (so tokens may contain `=`, `"`, or `\`) and is trimmed of surrounding
 * whitespace. Unknown or malformed lines are ignored.
 */
export function parseProvisioning(content: string): ParsedProvisioning {
  const result: ParsedProvisioning = {}
  for (const line of content.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key === 'FRESHELL_REMOTE_URL') result.remoteUrl = value
    else if (key === 'FRESHELL_TOKEN') result.remoteToken = value
  }
  return result
}

export interface ProvisioningDeps {
  /** Returns the file contents, or undefined if the provision file is absent. */
  readFile: (path: string) => string | undefined
  deleteFile: (path: string) => void
  patchDesktopConfig: (patch: Partial<DesktopConfig>) => Promise<DesktopConfig | void>
}

/**
 * Apply a provision file if present, then always remove it (so it only takes
 * effect once). A malformed file must never block startup, so persistence
 * errors are swallowed. Returns true when a file was found and consumed.
 */
export async function applyProvisioningFile(
  provisionPath: string,
  deps: ProvisioningDeps,
): Promise<boolean> {
  const content = deps.readFile(provisionPath)
  if (content === undefined) return false

  try {
    const { remoteUrl, remoteToken } = parseProvisioning(content)
    if (remoteUrl && remoteToken) {
      await deps.patchDesktopConfig({
        serverMode: 'remote',
        remoteUrl,
        remoteToken,
        setupCompleted: true,
      })
    }
  } catch {
    // A malformed provision file must not brick startup; fall through to delete.
  } finally {
    deps.deleteFile(provisionPath)
  }
  return true
}
