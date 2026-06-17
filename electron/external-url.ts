// Electron main-process helpers for opening URLs in the system browser.

export interface ExternalUrlDeps {
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle(channel: string, listener: (event: any, url: string) => Promise<void>): void
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
}

export function registerOpenExternalHandler(deps: ExternalUrlDeps): void {
  deps.ipcMain.handle('open-external-url', async (_event, url) => {
    await deps.shell.openExternal(url)
  })
}
