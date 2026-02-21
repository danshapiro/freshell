// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createFilesRouter } from '../../../server/files-router'

describe('Candidate directories API integration', () => {
  let app: Express

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/api/files', createFilesRouter({
      configStore: {
        getSettings: vi.fn().mockResolvedValue({}),
        snapshot: vi.fn().mockResolvedValue({
          settings: {
            defaultCwd: '/default/cwd',
            codingCli: {
              providers: {
                claude: { cwd: '/provider/claude' },
                codex: { cwd: '/code/project-alpha' }, // duplicate — should be deduped
              },
            },
          },
          recentDirectories: ['/recent/one', '/terminals/current'],
        }),
      },
      codingCliIndexer: {
        getProjects: () => [
          {
            projectPath: '/code/project-alpha',
            sessions: [
              { cwd: '/code/project-alpha' },
              { cwd: '/code/project-beta' },
            ],
          },
          {
            projectPath: '/code/project-gamma',
            sessions: [{ cwd: '/code/project-gamma/worktree' }],
          },
        ],
      },
      registry: {
        list: () => [
          { cwd: '/terminals/current' },
          { cwd: '/code/project-beta' },
        ],
      },
    }))
  })

  it('aggregates candidate directories from all configured sources and deduplicates', async () => {
    const res = await request(app).get('/api/files/candidate-dirs')

    expect(res.status).toBe(200)
    expect(res.body.directories).toContain('/code/project-alpha')
    expect(res.body.directories).toContain('/code/project-beta')
    expect(res.body.directories).toContain('/code/project-gamma')
    expect(res.body.directories).toContain('/code/project-gamma/worktree')
    expect(res.body.directories).toContain('/terminals/current')
    expect(res.body.directories).toContain('/recent/one')
    expect(res.body.directories).toContain('/provider/claude')
    expect(res.body.directories).toContain('/default/cwd')
    // Verify deduplication: /code/project-alpha appears in sessions + provider cwd
    const alphaCount = res.body.directories.filter((d: string) => d === '/code/project-alpha').length
    expect(alphaCount).toBe(1)
  })
})
