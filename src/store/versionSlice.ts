import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export interface VersionState {
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  error: string | null
}

const initialState: VersionState = {
  currentVersion: null,
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  error: null,
}

export const versionSlice = createSlice({
  name: 'version',
  initialState,
  reducers: {
    setVersionInfo: (state, action: PayloadAction<{
      currentVersion: string
      updateCheck: {
        updateAvailable: boolean
        latestVersion: string | null
        releaseUrl: string | null
        error: string | null
      } | null
    }>) => {
      state.currentVersion = action.payload.currentVersion
      if (action.payload.updateCheck) {
        state.updateAvailable = action.payload.updateCheck.updateAvailable
        state.latestVersion = action.payload.updateCheck.latestVersion
        state.releaseUrl = action.payload.updateCheck.releaseUrl
        state.error = action.payload.updateCheck.error
      }
    },
  },
})

export const { setVersionInfo } = versionSlice.actions
export default versionSlice.reducer
