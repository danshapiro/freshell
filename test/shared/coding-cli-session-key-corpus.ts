export type SessionKeyNormalizationCase = {
  name: string
  rawCwd: string
  normalizedCwd: string
}

export const SESSION_KEY_NORMALIZATION_CASES: SessionKeyNormalizationCase[] = [
  {
    name: 'posix',
    rawCwd: '/repo/root/packages/app/',
    normalizedCwd: '/repo/root/packages/app',
  },
  {
    name: 'windows-drive',
    rawCwd: 'C:\\Users\\Dan\\Worktree\\App\\',
    normalizedCwd: 'c:/users/dan/worktree/app',
  },
  {
    name: 'unc',
    rawCwd: '\\\\wsl$\\Ubuntu\\home\\Dan\\Worktree\\App\\',
    normalizedCwd: '//wsl$/ubuntu/home/dan/worktree/app',
  },
  {
    name: 'wsl',
    rawCwd: '/mnt/c/Users/Dan/Worktree/App/',
    normalizedCwd: '/mnt/c/Users/Dan/Worktree/App',
  },
]

function encodePart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function makeExpectedScopedSessionKey(provider: string, sessionId: string, normalizedCwd: string): string {
  return `${provider}:cwd=${encodePart(normalizedCwd)}:sid=${encodePart(sessionId)}`
}
