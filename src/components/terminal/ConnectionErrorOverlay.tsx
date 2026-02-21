import { useAppSelector } from '@/store/hooks'
import { AlertTriangle } from 'lucide-react'

export function ConnectionErrorOverlay() {
  const errorCode = useAppSelector((s) => s.connection.lastErrorCode)

  if (errorCode !== 4003) return null

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background/90"
      role="alert"
    >
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <h3 className="text-sm font-semibold text-foreground">Connection limit reached</h3>
        <p className="text-xs text-muted-foreground">
          The server&apos;s maximum number of simultaneous connections has been exceeded.
          Close unused tabs or increase the{' '}
          <code className="rounded bg-muted px-1 font-mono">MAX_CONNECTIONS</code>{' '}
          environment variable and restart the server.
        </p>
      </div>
    </div>
  )
}
