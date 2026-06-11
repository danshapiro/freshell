import { normalizeServerUrl } from './launch-discovery.js'
import { validateLaunchPort, validateRemoteLaunchUrl } from './launch-chooser/chooser-logic.js'
import { LaunchChoiceSchema } from './types.js'
import type { DesktopConfig, ForcedLaunch, LaunchChoiceResult } from './types.js'

export interface ChooseLaunchOptionHandlerOptions {
  patchDesktopConfig: (patch: Partial<DesktopConfig>) => Promise<DesktopConfig | void>
  /**
   * Restart the launch flow, forcing the just-chosen action so it is honored
   * this launch regardless of saved config, `alwaysAskOnLaunch`, or
   * re-discovered servers.
   */
  restartMain: (forced: ForcedLaunch) => Promise<void> | void
  getCurrentPort: () => number
  validateServerAuth?: (url: string, token: string) => Promise<boolean>
  /**
   * Defense-in-depth: reject choices from any renderer other than the launch
   * chooser window. `choose-launch-option` is exposed via preload to every
   * window, so without this an untrusted renderer could force a launch.
   */
  isAllowedSender?: (event: unknown) => boolean
  /**
   * Authoritative (main-process) check that nothing is already listening on a
   * "Start local" port before we close the chooser and spawn. The renderer
   * guard is only advisory (stale candidate list, races, crafted requests).
   */
  isPortAvailable?: (port: number) => Promise<boolean>
}

export function createChooseLaunchOptionHandler(options: ChooseLaunchOptionHandlerOptions) {
  return async (event: unknown, rawChoice: unknown): Promise<LaunchChoiceResult> => {
    if (options.isAllowedSender && !options.isAllowedSender(event)) {
      return { ok: false, error: 'Unexpected launch request.' }
    }

    // The payload comes from a renderer over IPC, so validate its shape at
    // runtime — TypeScript's union does not survive the boundary.
    const parsed = LaunchChoiceSchema.safeParse(rawChoice)
    if (!parsed.success) {
      return { ok: false, error: 'Invalid launch request.' }
    }
    const choice = parsed.data

    if (choice.kind === 'remote' || choice.kind === 'connect') {
      if (!choice.url) {
        return { ok: false, error: 'Choose a server URL.' }
      }

      const url = normalizeServerUrl(choice.url)
      // Validate the scheme server-side (not just in the renderer) so a crafted
      // choice can never make the app load a file:// or other non-web URL.
      const urlError = validateRemoteLaunchUrl(url)
      if (urlError) {
        return { ok: false, error: urlError }
      }
      const token = choice.token?.trim()
      if (choice.requiresAuth !== false) {
        if (!token) {
          return { ok: false, error: `Enter a token for ${url}` }
        }

        if (options.validateServerAuth) {
          let authenticated = false
          try {
            authenticated = await options.validateServerAuth(url, token)
          } catch {
            authenticated = false
          }
          if (!authenticated) {
            return { ok: false, error: 'The server rejected that token.' }
          }
        }
      }

      // "Remember this choice" gates whether the server selection is saved as
      // the new default. The always-ask preference is standalone and always
      // persisted so the user can leave (or stay in) the chooser next launch.
      if (choice.remember) {
        await options.patchDesktopConfig({
          serverMode: 'remote',
          remoteUrl: url,
          remoteToken: token,
          alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
          setupCompleted: true,
        })
      } else {
        await options.patchDesktopConfig({ alwaysAskOnLaunch: choice.alwaysAskOnLaunch })
      }

      await options.restartMain({ kind: 'connect', url, token })
      return { ok: true }
    }

    // Defensive default: the schema only allows connect/remote/start-local, and
    // connect/remote are handled above, so anything else is rejected outright
    // rather than silently treated as start-local.
    if (choice.kind !== 'start-local') {
      return { ok: false, error: 'Invalid launch request.' }
    }

    const port = choice.port ?? options.getCurrentPort()
    const portError = validateLaunchPort(port)
    if (portError) {
      return { ok: false, error: portError }
    }

    // Authoritatively confirm the port is free before closing the chooser and
    // spawning. If we cannot determine availability, refuse rather than risk
    // spawning onto an occupied port (which could load the wrong process).
    if (options.isPortAvailable) {
      let available = false
      try {
        available = await options.isPortAvailable(port)
      } catch {
        available = false
      }
      if (!available) {
        return { ok: false, error: `Port ${port} is already in use. Choose a different port, or connect to that server.` }
      }
    }

    if (choice.remember) {
      await options.patchDesktopConfig({
        serverMode: 'app-bound',
        port,
        alwaysAskOnLaunch: choice.alwaysAskOnLaunch,
        setupCompleted: true,
      })
    } else {
      await options.patchDesktopConfig({ alwaysAskOnLaunch: choice.alwaysAskOnLaunch })
    }

    await options.restartMain({ kind: 'start-local', port })
    return { ok: true }
  }
}
