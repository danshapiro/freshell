import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { hydrateTabs } from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import claudeReducer from './claudeSlice'
import panesReducer, { hydratePanes } from './panesSlice'
import { persistMiddleware, loadPersistedTabs, loadPersistedPanes } from './persistMiddleware'

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
    claude: claudeReducer,
    panes: panesReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(persistMiddleware),
})

// Hydrate persisted tabs once on startup.
const persistedTabs = loadPersistedTabs()
if (persistedTabs?.tabs) {
  store.dispatch(hydrateTabs(persistedTabs.tabs))
}

// Hydrate persisted panes once on startup.
const persistedPanes = loadPersistedPanes()
if (persistedPanes) {
  store.dispatch(hydratePanes(persistedPanes))
}

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
