import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
// MUST stay the FIRST side-effectful import — before
// '@/store/storage-migration', the store, and App (unified-agent-names
// Task 7; name reliability Task 2): its synchronous one-time capture copies
// each genuine pre-migration legacy key (never this window's own layout)
// into its own `freshell.session-names.migration.v1.<importId>` envelope
// BEFORE the storage migrations or the slice initial-state loads can
// rewrite it, at most once per device, and deletes envelopes no longer
// needed. It never imports the Redux store (react/react-dom/react-redux
// above are side-effect-free).
import '@/lib/session-name-migration'
// MUST stay ahead of the store/App imports: recover-my-panes boot-state (D1) depends on
// migrations having re-materialized this window's per-window layout key
// (freshell.layout.v3.<layoutWindowId>, adopting the legacy envelope when
// the window has none of its own) BEFORE any capture runs (the
// react/react-dom/react-redux imports above are side-effect-free) — see
// docs/plans/2026-07-26-recover-my-panes.md and main-import-order.test.ts.
import '@/store/storage-migration'
import { store } from '@/store/store'
import App from '@/App'
import '@/index.css'
import { initializeAuthToken } from '@/lib/auth'
import { createClientLogger } from '@/lib/client-logger'
import { initClientPerfLogging } from '@/lib/perf-logger'
import { registerServiceWorker } from '@/lib/pwa'
import { initChunkErrorRecovery } from '@/lib/import-retry'
import { reportBootCaptureFailures } from '@/lib/legacy-name-capture-policy'

initializeAuthToken()
createClientLogger().installConsoleCapture()
// The legacy-name capture pass ran during the imports above, before
// forwarding existed: replay its failures so they reach the server log.
reportBootCaptureFailures()
initClientPerfLogging()
registerServiceWorker()
initChunkErrorRecovery()

if (import.meta.env.DEV) {
  document.title = 'freshell:dev'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode disabled due to xterm.js incompatibility (double-mount causes renderer issues)
  <Provider store={store}>
    <App />
  </Provider>,
)
