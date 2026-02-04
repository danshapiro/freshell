import { it, expect, vi } from 'vitest'
import { runCommand } from '../../../server/cli/commands/sendKeys'

it('calls api send-keys endpoint', async () => {
  const client = { post: vi.fn().mockResolvedValue({ status: 'ok' }) }
  await runCommand({ target: 'pane_1', keys: ['Enter'] }, client as any)
  expect(client.post).toHaveBeenCalled()
})
