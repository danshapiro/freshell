export const STARTUP_TASKS = ['sessionRepairService', 'codingCliIndexer'] as const
export type StartupTask = typeof STARTUP_TASKS[number]

export class StartupState<T extends string> {
  private tasks: Record<T, boolean>

  constructor(taskNames: readonly T[]) {
    this.tasks = Object.fromEntries(taskNames.map((name) => [name, false])) as Record<T, boolean>
  }

  markReady(taskName: T): void {
    if (!Object.prototype.hasOwnProperty.call(this.tasks, taskName)) {
      throw new Error(`Unknown task: ${taskName}`)
    }
    this.tasks[taskName] = true
  }

  isReady(): boolean {
    return Object.values(this.tasks).every(Boolean)
  }

  snapshot(): { ready: boolean; tasks: Record<T, boolean> } {
    return {
      ready: this.isReady(),
      tasks: { ...this.tasks },
    }
  }
}

export function createStartupState(): StartupState<StartupTask> {
  return new StartupState(STARTUP_TASKS)
}
