const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  new BrowserWindow({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
})
app.on('window-all-closed', () => app.quit())
