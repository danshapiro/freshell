interface ExtensionErrorProps {
  name: string
  message?: string
  onRetry?: () => void
}

export default function ExtensionError({ name, message, onRetry }: ExtensionErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
      <p className="text-lg font-medium">Extension not available</p>
      <p className="text-sm">{message || `Extension "${name}" is not installed or failed to load.`}</p>
      {onRetry && (
        <button onClick={onRetry} className="text-sm underline hover:text-foreground">
          Retry
        </button>
      )}
    </div>
  )
}
