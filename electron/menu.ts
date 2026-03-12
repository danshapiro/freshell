export interface MenuItemOptions {
  label?: string
  role?: string
  type?: 'separator' | 'normal' | 'submenu'
  accelerator?: string
  click?: () => void
  enabled?: boolean
  submenu?: MenuItemOptions[]
}

export interface MenuBuildApi {
  buildFromTemplate(template: MenuItemOptions[]): any
  setApplicationMenu(menu: any): void
}

export function buildAppMenu(
  Menu: MenuBuildApi,
  options: {
    onPreferences: () => void
    onCheckUpdates: () => void
    appVersion: string
    isMac: boolean
  },
): any {
  const { onPreferences, onCheckUpdates, isMac } = options

  const template: MenuItemOptions[] = []

  // macOS app menu
  if (isMac) {
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences', accelerator: 'CommandOrControl+,', click: onPreferences },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  // Edit menu
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  })

  // View menu
  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  })

  // Window menu
  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      ...(isMac ? [{ role: 'zoom' }] : [{ role: 'maximize' } as MenuItemOptions]),
      { role: 'close' },
    ],
  })

  // Help menu
  template.push({
    label: 'Help',
    submenu: [
      { label: 'Check for Updates', click: onCheckUpdates },
      { label: `About Freshell v${options.appVersion}`, enabled: false },
    ],
  })

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}
