import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { hydrateTabs } from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import { persistMiddleware, loadPersistedTabs } from './persistMiddleware'

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(persistMiddleware),
})

// Hydrate persisted tabs once on startup.
const persisted = loadPersistedTabs()
if (persisted?.tabs) {
  store.dispatch(hydrateTabs(persisted.tabs))
}

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
