import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ProjectGroup } from './types'

export interface SessionsState {
  projects: ProjectGroup[]
  expandedProjects: Set<string>
  lastLoadedAt?: number
}

const initialState: SessionsState = {
  projects: [],
  expandedProjects: new Set<string>(),
}

export const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    setProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
      state.projects = action.payload
      state.lastLoadedAt = Date.now()
    },
    toggleProjectExpanded: (state, action: PayloadAction<string>) => {
      const key = action.payload
      if (state.expandedProjects.has(key)) state.expandedProjects.delete(key)
      else state.expandedProjects.add(key)
    },
    setProjectExpanded: (state, action: PayloadAction<{ projectPath: string; expanded: boolean }>) => {
      const { projectPath, expanded } = action.payload
      if (expanded) state.expandedProjects.add(projectPath)
      else state.expandedProjects.delete(projectPath)
    },
    collapseAll: (state) => {
      state.expandedProjects = new Set()
    },
    expandAll: (state) => {
      state.expandedProjects = new Set(state.projects.map((p) => p.projectPath))
    },
  },
})

export const { setProjects, toggleProjectExpanded, setProjectExpanded, collapseAll, expandAll } =
  sessionsSlice.actions

export default sessionsSlice.reducer
