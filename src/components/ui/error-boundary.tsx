import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Label shown in fallback UI, e.g. "Terminal", "Settings" */
  label?: string
  /** Called when user clicks "Go to Overview" in fallback */
  onNavigate?: () => void
}

interface ErrorBoundaryState {
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
      errorInfo.componentStack,
    )
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const label = this.props.label ?? 'This section'
      return (
        <div
          className="flex items-center justify-center h-full w-full p-4"
          role="alert"
        >
          <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm max-w-md w-full p-6 text-center">
            <h3 className="text-base font-semibold mb-2">Something went wrong</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {label} encountered an error and couldn&apos;t render.
            </p>
            {import.meta.env.DEV && this.state.error && (
              <pre className="text-xs text-left bg-muted rounded p-2 mb-4 overflow-auto max-h-32">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-2 justify-center">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Try Again
              </button>
              {this.props.onNavigate && (
                <button
                  onClick={this.props.onNavigate}
                  className="px-4 py-2 text-sm rounded-md border border-border hover:bg-muted transition-colors"
                >
                  Go to Overview
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
