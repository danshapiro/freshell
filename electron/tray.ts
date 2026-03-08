export interface TrayOptions {
  onShow: () => void
  onHide: () => void
  onSettings: () => void
  onCheckUpdates: () => void
  onQuit: () => void
  getServerStatus: () => Promise<{ running: boolean; mode: string; error?: string }>
}

export interface TrayApi {
  new (icon: string): TrayInstance
}

export interface TrayInstance {
  setToolTip(tooltip: string): void
  setContextMenu(menu: any): void
  on(event: string, callback: () => void): void
}

export interface MenuApi {
  buildFromTemplate(template: MenuItemTemplate[]): any
}

export interface MenuItemTemplate {
  label?: string
  type?: 'separator' | 'normal'
  enabled?: boolean
  click?: () => void
}

export function createTray(
  TrayConstructor: TrayApi,
  Menu: MenuApi,
  iconPath: string,
  options: TrayOptions,
): TrayInstance {
  const tray = new TrayConstructor(iconPath)
  tray.setToolTip('Freshell')

  const buildMenu = async () => {
    const status = await options.getServerStatus()

    const menuTemplate: MenuItemTemplate[] = [
      { label: 'Show/Hide', click: () => options.onShow() },
      { type: 'separator' },
      { label: `Server: ${status.running ? 'Running' : 'Stopped'}`, enabled: false },
      { label: `Mode: ${status.mode}`, enabled: false },
      { type: 'separator' },
      { label: 'Settings', click: () => options.onSettings() },
      { label: 'Check for Updates', click: () => options.onCheckUpdates() },
      { label: 'Quit', click: () => options.onQuit() },
    ]

    const menu = Menu.buildFromTemplate(menuTemplate)
    tray.setContextMenu(menu)
  }

  // Build initial menu
  void buildMenu()

  return tray
}
