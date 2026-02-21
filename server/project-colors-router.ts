import { Router } from 'express'
import { z } from 'zod'

export const ProjectColorSchema = z.object({
  projectPath: z.string().min(1).max(1024),
  color: z.string().min(1).max(64),
})

export interface ProjectColorsRouterDeps {
  configStore: { setProjectColor: (path: string, color: string) => Promise<void> }
  codingCliIndexer: { refresh: () => Promise<void> }
}

export function createProjectColorsRouter(deps: ProjectColorsRouterDeps): Router {
  const { configStore, codingCliIndexer } = deps
  const router = Router()

  router.put('/project-colors', async (req, res) => {
    const parsed = ProjectColorSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { projectPath, color } = parsed.data
    await configStore.setProjectColor(projectPath, color)
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}
