import { readAmplifierNativeHistory } from './amplifier.js'
import { readClaudeNativeHistory } from './claude.js'
import { readCodexNativeHistory } from './codex.js'
import { readOpenCodeNativeHistory } from './opencode.js'

const [provider, source, nativeSessionId] = process.argv.slice(2)

try {
  if (!provider || !source || !nativeSessionId) throw new Error('missing probe arguments')
  const history = provider === 'claude'
    ? readClaudeNativeHistory(source, nativeSessionId)
    : provider === 'codex'
      ? readCodexNativeHistory(source, nativeSessionId)
      : provider === 'opencode'
        ? readOpenCodeNativeHistory(source, nativeSessionId)
        : provider === 'amplifier'
          ? readAmplifierNativeHistory(source, nativeSessionId)
          : null
  if (!history) throw new Error('unsupported provider')
  process.stdout.write(JSON.stringify(history))
} catch {
  // Never echo parsed content, paths, ids, or exception values from a native store.
  process.stderr.write('[provider-native-history] BLOCKED: native history validation failed\n')
  process.exitCode = 2
}
