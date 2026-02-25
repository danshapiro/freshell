import { useAppSelector } from '@/store/hooks'
import { isFatalConnectionErrorCode } from '@/store/connectionSlice'
import { AlertTriangle } from 'lucide-react'

type FatalConnectionNotice = {
  title: string
  body: string
}

const FATAL_CONNECTION_NOTICES: Record<number, FatalConnectionNotice> = {
  4001: {
    title: 'Authentication required',
    body: 'Your session token is no longer valid. Sign in again to restore terminal access.',
  },
  4003: {
    title: 'Connection limit reached',
    body:
      "The server's maximum number of simultaneous connections has been exceeded. " +
      'Close unused tabs or increase the MAX_CONNECTIONS environment variable and restart the server.',
  },
  4010: {
    title: 'Client/server version mismatch',
    body: 'This browser is using an incompatible websocket protocol version. Refresh the page to upgrade the client.',
  },
}

export function ConnectionErrorOverlay() {
  const errorCode = useAppSelector((s) => s.connection.lastErrorCode)
  const notice = isFatalConnectionErrorCode(errorCode)
    ? FATAL_CONNECTION_NOTICES[errorCode as keyof typeof FATAL_CONNECTION_NOTICES]
    : undefined

  if (!notice) return null

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-background/90"
      role="alert"
    >
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <h3 className="text-sm font-semibold text-foreground">{notice.title}</h3>
        <p className="text-xs text-muted-foreground">
          {notice.body.includes('MAX_CONNECTIONS') ? (
            <>
              The server&apos;s maximum number of simultaneous connections has been exceeded.
              Close unused tabs or increase the{' '}
              <code className="rounded bg-muted px-1 font-mono">MAX_CONNECTIONS</code>{' '}
              environment variable and restart the server.
            </>
          ) : (
            notice.body
          )}
        </p>
      </div>
    </div>
  )
}
