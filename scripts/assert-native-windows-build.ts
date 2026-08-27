export interface NativeWindowsBuildCheck {
  ok: boolean
  message?: string
}

export function checkNativeWindowsBuildPlatform(
  platform: NodeJS.Platform = process.platform,
): NativeWindowsBuildCheck {
  if (platform === 'win32') {
    return { ok: true }
  }

  return {
    ok: false,
    message: 'electron:build:win must run on native Windows so the Rust server is built for win32.',
  }
}

function logFailure(platform: NodeJS.Platform, message: string): void {
  console.error(JSON.stringify({
    severity: 'error',
    event: 'electron_native_windows_build_wrong_platform',
    platform,
    message,
  }))
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('assert-native-windows-build.ts') ||
    process.argv[1].endsWith('assert-native-windows-build.js'))

if (isMainModule) {
  const result = checkNativeWindowsBuildPlatform()
  if (!result.ok) {
    logFailure(process.platform, result.message ?? 'Native Windows build check failed.')
    process.exit(1)
  }
}
