import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ProjectGroup } from './types'

function normalizeProjects(payload: unknown): ProjectGroup[] {
  if (!Array.isArray(payload)) return []
  const out: ProjectGroup[] = []
  for (const raw of payload as any[]) {
    if (!raw || typeof raw !== 'object') continue
    const projectPath = (raw as any).projectPath
    if (typeof projectPath !== 'string' || projectPath.length === 0) continue
    const sessions = Array.isArray((raw as any).sessions) ? (raw as any).sessions : []
    const color = typeof (raw as any).color === 'string' ? (raw as any).color : undefined
    out.push({ projectPath, sessions, ...(color ? { color } : {}) } as ProjectGroup)
  }
  return out
}

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
      state.projects = normalizeProjects(action.payload)
      state.lastLoadedAt = Date.now()
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
    },
    clearProjects: (state) => {
      state.projects = []
      state.expandedProjects = new Set()
    },
    mergeProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
      const incoming = normalizeProjects(action.payload)
      // Merge incoming projects with existing ones by projectPath
      const projectMap = new Map(state.projects.map((p) => [p.projectPath, p]))
      for (const project of incoming) {
        projectMap.set(project.projectPath, project)
      }
      state.projects = Array.from(projectMap.values())
      state.lastLoadedAt = Date.now()
      const valid = new Set(state.projects.map((p) => p.projectPath))
      state.expandedProjects = new Set(Array.from(state.expandedProjects).filter((k) => valid.has(k)))
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

export const { setProjects, clearProjects, mergeProjects, toggleProjectExpanded, setProjectExpanded, collapseAll, expandAll } =
  sessionsSlice.actions

export default sessionsSlice.reducer
