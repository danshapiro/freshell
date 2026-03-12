import { execFile } from 'child_process'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { DaemonManager, DaemonPaths, DaemonStatus } from './daemon-manager.js'
import { resolveTemplatePath } from './template-path.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SERVICE_LABEL = 'com.freshell.server'
const PLIST_FILENAME = `${SERVICE_LABEL}.plist`

function getPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_FILENAME)
}

function execFilePromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string })
      }
    })
  })
}

export class LaunchdDaemonManager implements DaemonManager {
  readonly platform = 'darwin' as const
  private readonly resourcesPath?: string

  constructor(resourcesPath?: string) {
    this.resourcesPath = resourcesPath
  }

  async install(paths: DaemonPaths, port: number): Promise<void> {
    const templatePath = resolveTemplatePath(
      ['launchd', 'com.freshell.server.plist.template'],
      __dirname,
      this.resourcesPath,
    )
    const template = await fsp.readFile(templatePath, 'utf-8')

    const nodePath = [paths.nativeModules, paths.serverNodeModules].join(':')

    const content = template
      .replace(/\{\{NODE_BINARY\}\}/g, paths.nodeBinary)
      .replace(/\{\{SERVER_ENTRY\}\}/g, paths.serverEntry)
      .replace(/\{\{PORT\}\}/g, String(port))
      .replace(/\{\{NODE_PATH\}\}/g, nodePath)
      .replace(/\{\{CONFIG_DIR\}\}/g, paths.configDir)
      .replace(/\{\{LOG_DIR\}\}/g, paths.logDir)

    const plistDir = path.dirname(getPlistPath())
    await fsp.mkdir(plistDir, { recursive: true })
    await fsp.writeFile(getPlistPath(), content)

    await execFilePromise('launchctl', ['load', '-w', getPlistPath()])
  }

  async uninstall(): Promise<void> {
    try {
      await execFilePromise('launchctl', ['unload', getPlistPath()])
    } catch {
      // Ignore errors if not loaded
    }
    try {
      await fsp.unlink(getPlistPath())
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async start(): Promise<void> {
    await execFilePromise('launchctl', ['start', SERVICE_LABEL])
  }

  async stop(): Promise<void> {
    await execFilePromise('launchctl', ['stop', SERVICE_LABEL])
  }

  async status(): Promise<DaemonStatus> {
    try {
      const { stdout } = await execFilePromise('launchctl', ['list', SERVICE_LABEL])

      const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/)
      const running = pidMatch !== null
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined

      return {
        installed: true,
        running,
        pid,
      }
    } catch {
      return {
        installed: false,
        running: false,
      }
    }
  }

  async isInstalled(): Promise<boolean> {
    try {
      await fsp.access(getPlistPath())
      return true
    } catch {
      return false
    }
  }
}
