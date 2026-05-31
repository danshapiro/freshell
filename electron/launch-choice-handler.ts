import { normalizeServerUrl } from './launch-discovery.js'
import { validateLaunchPort } from './launch-chooser/chooser-logic.js'
import type { DesktopConfig, ForcedLaunch, LaunchChoice, LaunchChoiceResult } from './types.js'

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
}

export function createChooseLaunchOptionHandler(options: ChooseLaunchOptionHandlerOptions) {
  return async (_event: unknown, choice: LaunchChoice): Promise<LaunchChoiceResult> => {
    if (choice.kind === 'remote' || choice.kind === 'connect') {
      if (!choice.url) {
        return { ok: false, error: 'Choose a server URL.' }
      }

      const url = normalizeServerUrl(choice.url)
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

    const port = choice.port ?? options.getCurrentPort()
    const portError = validateLaunchPort(port)
    if (portError) {
      return { ok: false, error: portError }
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
