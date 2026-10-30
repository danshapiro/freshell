import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { query } from './native-startup-query.mjs'

// Observe real resource reads by the production sidecar, without replacing
// its fingerprinting or its native checkpoint/permission implementation.
for (const operation of ['open', 'readFile']) {
  const original = filesystem[operation]
  filesystem[operation] = function (path, ...args) {
    if (String(path) === process.env.FRESHELL_TEST_PROFILE_PAYLOAD) {
      process.stdout.write(JSON.stringify({ type: 'probe.profile.resource.read' }) + '\n')
    }
    return original.call(this, path, ...args)
  }
}
syncBuiltinESMExports()

export { query }
