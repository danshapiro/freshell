import { execFile } from 'child_process'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { DaemonManager, DaemonPaths, DaemonStatus } from './daemon-manager.js'
import { resolveTemplatePath } from './template-path.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const TASK_NAME = 'Freshell Server'

function getTaskXmlPath(): string {
  return path.join(os.homedir(), '.freshell', 'freshell-task.xml')
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

export class WindowsServiceDaemonManager implements DaemonManager {
  readonly platform = 'win32' as const
  private nodeBinaryPath?: string
  private readonly resourcesPath?: string

  constructor(resourcesPath?: string) {
    this.resourcesPath = resourcesPath
  }

  async install(paths: DaemonPaths, port: number): Promise<void> {
    this.nodeBinaryPath = paths.nodeBinary

    const templatePath = resolveTemplatePath(
      ['windows', 'freshell-task.xml.template'],
      __dirname,
      this.resourcesPath,
    )
    const template = await fsp.readFile(templatePath, 'utf-8')
    const nodePath = [paths.nativeModules, paths.serverNodeModules].join(';')

    const content = template
      .replace(/\{\{NODE_BINARY\}\}/g, paths.nodeBinary)
      .replace(/\{\{SERVER_ENTRY\}\}/g, paths.serverEntry)
      .replace(/\{\{PORT\}\}/g, String(port))
      .replace(/\{\{NODE_PATH\}\}/g, nodePath)
      .replace(/\{\{CONFIG_DIR\}\}/g, paths.configDir)
      .replace(/\{\{LOG_DIR\}\}/g, paths.logDir)

    // Write the task XML to a known location
    const xmlDir = path.dirname(getTaskXmlPath())
    await fsp.mkdir(xmlDir, { recursive: true })
    await fsp.writeFile(getTaskXmlPath(), content)

    // Create the scheduled task from the XML file
    await execFilePromise('schtasks', [
      '/Create',
      '/TN', TASK_NAME,
      '/XML', getTaskXmlPath(),
      '/F', // Force overwrite if exists (idempotent)
    ])
  }

  async uninstall(): Promise<void> {
    try {
      await execFilePromise('schtasks', [
        '/Delete',
        '/TN', TASK_NAME,
        '/F',
      ])
    } catch {
      // Ignore if not found
    }
    try {
      await fsp.unlink(getTaskXmlPath())
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async start(): Promise<void> {
    await execFilePromise('schtasks', ['/Run', '/TN', TASK_NAME])
  }

  async stop(): Promise<void> {
    // Find the specific Freshell server process by matching the bundled node binary path.
    // We must NOT kill all node.exe processes -- only the one running via our bundled binary.
    try {
      const { stdout } = await execFilePromise('wmic', [
        'process', 'where',
        `name='node.exe' and CommandLine like '%${(this.nodeBinaryPath ?? 'freshell').replace(/\\/g, '\\\\')}%'`,
        'get', 'ProcessId',
        '/format:list',
      ])

      const pidMatch = stdout.match(/ProcessId=(\d+)/)
      if (pidMatch) {
        await execFilePromise('taskkill', ['/PID', pidMatch[1], '/F'])
      }
    } catch {
      // Fallback: try to end the scheduled task run
      try {
        await execFilePromise('schtasks', ['/End', '/TN', TASK_NAME])
      } catch {
        // Ignore if task is not running
      }
    }
  }

  async status(): Promise<DaemonStatus> {
    try {
      const { stdout } = await execFilePromise('schtasks', [
        '/Query',
        '/TN', TASK_NAME,
        '/FO', 'CSV',
      ])

      const lines = stdout.split('\r\n').filter(Boolean)
      if (lines.length < 2) {
        return { installed: false, running: false }
      }

      const dataLine = lines[1]
      const running = dataLine.includes('"Running"')

      return {
        installed: true,
        running,
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
      await execFilePromise('schtasks', ['/Query', '/TN', TASK_NAME])
      return true
    } catch {
      return false
    }
  }
}
