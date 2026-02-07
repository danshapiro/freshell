// Storage migration MUST be imported first (before slices load from localStorage)
import './storage-migration'

import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import settingsReducer from './settingsSlice'
import codingCliReducer from './codingCliSlice'
import panesReducer from './panesSlice'
import sessionActivityReducer from './sessionActivitySlice'
import terminalActivityReducer from './terminalActivitySlice'
import { persistMiddleware } from './persistMiddleware'
import { sessionActivityPersistMiddleware } from './sessionActivityPersistence'
import { paneActivityCleanupMiddleware } from './paneActivityCleanupMiddleware'

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
    codingCli: codingCliReducer,
    panes: panesReducer,
    sessionActivity: sessionActivityReducer,
    terminalActivity: terminalActivityReducer,
  },
  middleware: (getDefault) =>
    getDefault({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(paneActivityCleanupMiddleware, persistMiddleware, sessionActivityPersistMiddleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
