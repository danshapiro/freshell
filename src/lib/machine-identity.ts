import {
  DEVICE_ID_STORAGE_KEY,
  MACHINE_ID_STORAGE_KEY as STORED_MACHINE_ID_STORAGE_KEY,
  MACHINE_SELECTION_RESET_STORAGE_KEY as STORED_MACHINE_SELECTION_RESET_STORAGE_KEY,
  MACHINE_SELECTIONS_STORAGE_KEY as STORED_MACHINE_SELECTIONS_STORAGE_KEY,
} from '@/store/storage-keys'

export const MACHINE_ID_STORAGE_KEY = STORED_MACHINE_ID_STORAGE_KEY
export const MACHINE_SELECTIONS_STORAGE_KEY = STORED_MACHINE_SELECTIONS_STORAGE_KEY
export const MACHINE_SELECTION_RESET_STORAGE_KEY = STORED_MACHINE_SELECTION_RESET_STORAGE_KEY
export const LEGACY_DEVICE_ID_STORAGE_KEY = DEVICE_ID_STORAGE_KEY

export interface Machine {
  id: string
  label: string
  /** Unix epoch milliseconds, as serialized by the server's MachineStore. */
  createdAt: number
  /** Unix epoch milliseconds, as serialized by the server's MachineStore. */
  lastSeenAt: number
}

export type MachineIdentityResolution =
  | { kind: 'selected'; machine: Machine; source: 'saved' | 'legacy' | 'created' }
  | { kind: 'chooser'; machines: Machine[]; suggestedLabel: string }

type MachineSelectionMap = Record<string, string>

export type BrowserIdentityHints = {
  platform?: string
  userAgent?: string
}

export type DesktopMachineApi = {
  getHostname?: () => Promise<string>
}

function safeStorage(): Storage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    localStorage.getItem(MACHINE_ID_STORAGE_KEY)
    return localStorage
  } catch {
    return undefined
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readSelections(storage: Pick<Storage, 'getItem'> | undefined): MachineSelectionMap {
  if (!storage) return {}
  try {
    const raw = storage.getItem(MACHINE_SELECTIONS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([serverInstanceId, machineId]) => {
        const normalizedServerInstanceId = nonEmptyString(serverInstanceId)
        const normalizedMachineId = nonEmptyString(machineId)
        return normalizedServerInstanceId && normalizedMachineId
          ? [[normalizedServerInstanceId, normalizedMachineId]]
          : []
      }),
    )
  } catch {
    return {}
  }
}

function writeSelections(storage: Pick<Storage, 'setItem'> | undefined, selections: MachineSelectionMap): void {
  if (!storage) return
  try {
    storage.setItem(MACHINE_SELECTIONS_STORAGE_KEY, JSON.stringify(selections))
  } catch {
    // Storage can be disabled or full. The current browser session still has
    // its resolved machine in Redux, so do not turn a write failure into a
    // transport identity change.
  }
}

/**
 * The selected machine is origin-scoped by the browser. Once a websocket
 * supplies the durable server instance id, we additionally retain it in a
 * small map keyed by that id. The direct key is needed before the first hello;
 * the map protects a browser profile that later talks to more than one server.
 */
export function getSelectedMachineId(serverInstanceId?: string, storage = safeStorage()): string | undefined {
  const normalizedServerInstanceId = nonEmptyString(serverInstanceId)
  if (normalizedServerInstanceId) {
    const fromServer = readSelections(storage)[normalizedServerInstanceId]
    if (fromServer) return fromServer
  }
  try {
    return nonEmptyString(storage?.getItem(MACHINE_ID_STORAGE_KEY))
  } catch {
    return undefined
  }
}

export function persistSelectedMachineId(
  machineId: string,
  serverInstanceId?: string,
  storage = safeStorage(),
): void {
  const normalizedMachineId = nonEmptyString(machineId)
  if (!normalizedMachineId || !storage) return
  try {
    storage.setItem(MACHINE_ID_STORAGE_KEY, normalizedMachineId)
    // An explicit choice supersedes the one-shot instruction to ignore a
    // legacy id after the user pressed Switch machine.
    storage.removeItem(MACHINE_SELECTION_RESET_STORAGE_KEY)
  } catch {
    // Keep going: the server-instance map has the same best-effort semantics.
  }
  const normalizedServerInstanceId = nonEmptyString(serverInstanceId)
  if (!normalizedServerInstanceId) return
  const selections = readSelections(storage)
  selections[normalizedServerInstanceId] = normalizedMachineId
  writeSelections(storage, selections)
}

/** Clear every cached selection for this browser origin. The reset marker
 * prevents a retained legacy v2 id from silently selecting the old machine
 * again after Switch machine. */
export function clearSelectedMachineId(storage = safeStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(MACHINE_ID_STORAGE_KEY)
    storage.removeItem(MACHINE_SELECTIONS_STORAGE_KEY)
    storage.setItem(MACHINE_SELECTION_RESET_STORAGE_KEY, '1')
  } catch {
    // no-op when storage is unavailable
  }
}

export function getBrowserMachineLabel(hints: BrowserIdentityHints = {}): string {
  const platform = hints.platform
    ?? (typeof navigator !== 'undefined' ? navigator.platform : '')
  const userAgent = hints.userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  const fingerprint = `${platform} ${userAgent}`.toLowerCase()

  if (fingerprint.includes('android')) return 'Android device 1'
  if (fingerprint.includes('iphone')) return 'iPhone 1'
  if (fingerprint.includes('ipad')) return 'iPad 1'
  if (fingerprint.includes('win')) return 'Windows device 1'
  if (fingerprint.includes('mac')) return 'macOS device 1'
  if (fingerprint.includes('linux')) return 'Linux device 1'
  return 'Browser device 1'
}

function getDesktopApi(): DesktopMachineApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { freshellDesktop?: DesktopMachineApi }).freshellDesktop
}

/**
 * Electron can name a machine from the renderer's own operating system.
 * A browser intentionally gets only a broad platform label; the server owns
 * label; the server may further canonicalize it when another machine already
 * has the same name.
 */
export async function getSuggestedMachineLabel(): Promise<string> {
  const desktop = getDesktopApi()
  if (typeof desktop?.getHostname === 'function') {
    try {
      const hostname = nonEmptyString(await desktop.getHostname())
      if (hostname) return hostname
    } catch {
      // Fall back to the browser-safe label when Electron IPC is unavailable.
    }
  }
  return getBrowserMachineLabel()
}

export async function resolveMachineIdentity({
  machines,
  createMachine,
  suggestedLabel,
  serverInstanceId,
  storage = safeStorage(),
}: {
  machines: Machine[]
  createMachine: (label: string) => Promise<Machine>
  suggestedLabel: string
  serverInstanceId?: string
  storage?: Storage
}): Promise<MachineIdentityResolution> {
  const savedMachineId = getSelectedMachineId(serverInstanceId, storage)
  const skipLegacyMigration = storage?.getItem(MACHINE_SELECTION_RESET_STORAGE_KEY) === '1'
  const savedMachine = savedMachineId
    ? machines.find((machine) => machine.id === savedMachineId)
    : undefined
  // A direct selection can be stale when this browser was last pointed at a
  // different server. In that case a recognized legacy v2 id still wins over
  // the chooser: it is the one durable identity this server explicitly knows.
  const legacyMachineId = savedMachine || skipLegacyMigration
    ? undefined
    : nonEmptyString(storage?.getItem(LEGACY_DEVICE_ID_STORAGE_KEY))
  const legacyMachine = legacyMachineId
    ? machines.find((machine) => machine.id === legacyMachineId)
    : undefined
  const selectedMachine = savedMachine ?? legacyMachine

  if (selectedMachine) {
    persistSelectedMachineId(selectedMachine.id, serverInstanceId, storage)
    return {
      kind: 'selected',
      machine: selectedMachine,
      source: savedMachine ? 'saved' : 'legacy',
    }
  }

  if (machines.length === 0) {
    const machine = await createMachine(suggestedLabel)
    persistSelectedMachineId(machine.id, serverInstanceId, storage)
    return { kind: 'selected', machine, source: 'created' }
  }

  return { kind: 'chooser', machines, suggestedLabel }
}
