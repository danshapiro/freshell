import { execFile } from 'child_process'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { DaemonManager, DaemonPaths, DaemonStatus } from './daemon-manager.js'
import { resolveTemplatePath } from './template-path.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SERVICE_NAME = 'freshell'
const UNIT_FILENAME = `${SERVICE_NAME}.service`

function getUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_FILENAME)
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

export class SystemdDaemonManager implements DaemonManager {
  readonly platform = 'linux' as const
  private readonly resourcesPath?: string

  constructor(resourcesPath?: string) {
    this.resourcesPath = resourcesPath
  }

  async install(paths: DaemonPaths, port: number): Promise<void> {
    const templatePath = resolveTemplatePath(
      ['systemd', 'freshell.service.template'],
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

    const unitDir = path.dirname(getUnitPath())
    await fsp.mkdir(unitDir, { recursive: true })
    await fsp.writeFile(getUnitPath(), content)

    await execFilePromise('systemctl', ['--user', 'daemon-reload'])
    await execFilePromise('systemctl', ['--user', 'enable', SERVICE_NAME])
  }

  async uninstall(): Promise<void> {
    try {
      await execFilePromise('systemctl', ['--user', 'disable', SERVICE_NAME])
    } catch {
      // Ignore if not enabled
    }
    try {
      await execFilePromise('systemctl', ['--user', 'stop', SERVICE_NAME])
    } catch {
      // Ignore if not running
    }
    try {
      await fsp.unlink(getUnitPath())
    } catch {
      // Ignore if file doesn't exist
    }
    try {
      await execFilePromise('systemctl', ['--user', 'daemon-reload'])
    } catch {
      // Ignore
    }
  }

  async start(): Promise<void> {
    await execFilePromise('systemctl', ['--user', 'start', SERVICE_NAME])
  }

  async stop(): Promise<void> {
    await execFilePromise('systemctl', ['--user', 'stop', SERVICE_NAME])
  }

  async status(): Promise<DaemonStatus> {
    try {
      const { stdout } = await execFilePromise('systemctl', [
        '--user', 'show', SERVICE_NAME,
        '--property=ActiveState,MainPID,ExecMainStartTimestamp',
      ])

      const activeStateMatch = stdout.match(/ActiveState=(\w+)/)
      const pidMatch = stdout.match(/MainPID=(\d+)/)

      const activeState = activeStateMatch?.[1]
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined
      const running = activeState === 'active'

      return {
        installed: true,
        running,
        pid: running && pid && pid > 0 ? pid : undefined,
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
      await fsp.access(getUnitPath())
      return true
    } catch {
      return false
    }
  }
}
