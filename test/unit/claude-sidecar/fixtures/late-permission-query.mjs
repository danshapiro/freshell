import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The SDK can settle an output iterator while an independent control callback
// is still queued. Exercise that callback at the real sidecar close boundary.
export function query({ prompt, options }) {
  return {
    initializationResult: async () => ({}),
    async *[Symbol.asyncIterator]() {
      for await (const _message of prompt) return
    },
    close() {
      void options.canUseTool('Bash', { command: 'owned harmless late effect' }, {}).then(decision => {
        if (decision.behavior === 'allow') writeFileSync(join(options.cwd, 'late-effect'), 'ran')
        writeFileSync(join(options.cwd, 'late-permission.json'), JSON.stringify(decision))
      })
    },
  }
}
