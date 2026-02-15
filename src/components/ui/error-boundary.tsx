import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
  label?: string
  onNavigate?: () => void
}

type ErrorBoundaryState = {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}] Caught error:`,
      error,
      errorInfo.componentStack
    )
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    const label = this.props.label ?? 'This section'
    return (
      <div className="flex h-full w-full items-center justify-center p-4" role="alert">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center text-card-foreground shadow-sm">
          <h3 className="mb-2 text-base font-semibold">Something went wrong</h3>
          <p className="mb-4 text-sm text-muted-foreground">{label} encountered an error and could not render.</p>
          {import.meta.env.DEV && this.state.error && (
            <pre className="mb-4 max-h-32 overflow-auto rounded bg-muted p-2 text-left text-xs">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex justify-center gap-2">
            <button
              onClick={this.handleReset}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Try Again
            </button>
            {this.props.onNavigate && (
              <button
                onClick={this.props.onNavigate}
                className="rounded-md border border-border px-4 py-2 text-sm transition-colors hover:bg-muted"
              >
                Go to Overview
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
