export interface DaemonStatus {
  installed: boolean
  running: boolean
  pid?: number
  uptime?: number  // seconds
  error?: string
}

export interface DaemonPaths {
  nodeBinary: string      // bundled Node.js binary: {resourcesPath}/bundled-node/bin/node
  serverEntry: string     // server entry point: {resourcesPath}/server/index.js
  serverNodeModules: string // server deps: {resourcesPath}/server-node-modules
  nativeModules: string   // recompiled native modules: {resourcesPath}/bundled-node/native-modules
  configDir: string       // ~/.freshell
  logDir: string          // ~/.freshell/logs
}

// All paths above are real filesystem paths from extraResources.
// They are NOT inside the ASAR archive. The bundled Node.js binary
// is a vanilla Node.js process and cannot read from ASAR.

export interface DaemonManager {
  readonly platform: 'darwin' | 'linux' | 'win32'

  /** Register the OS service/agent (idempotent) */
  install(paths: DaemonPaths, port: number): Promise<void>

  /** Remove the OS service/agent (idempotent) */
  uninstall(): Promise<void>

  /** Start the service */
  start(): Promise<void>

  /** Stop the service */
  stop(): Promise<void>

  /** Query current status */
  status(): Promise<DaemonStatus>

  /** Check if service definition exists */
  isInstalled(): Promise<boolean>
}
