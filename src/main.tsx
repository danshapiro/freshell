import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from '@/store/store'
import App from '@/App'
import '@/index.css'
import { initializeAuthToken } from '@/lib/auth'
import { createClientLogger } from '@/lib/client-logger'
import { initClientPerfLogging } from '@/lib/perf-logger'
import { registerServiceWorker } from '@/lib/pwa'

initializeAuthToken()
createClientLogger().installConsoleCapture()
initClientPerfLogging()
registerServiceWorker()

if (import.meta.env.DEV) {
  document.title = 'freshell:dev'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode disabled due to xterm.js incompatibility (double-mount causes renderer issues)
  <Provider store={store}>
    <App />
  </Provider>,
)
