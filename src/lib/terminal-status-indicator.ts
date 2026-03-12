import type { TerminalStatus } from '@/store/types'

export function getTerminalStatusIconClassName(status: TerminalStatus): string {
  switch (status) {
    case 'running':
      return 'text-success'
    case 'exited':
      return 'text-muted-foreground/40'
    case 'error':
      return 'text-destructive'
    case 'creating':
    default:
      return 'text-muted-foreground'
  }
}

export function getTerminalStatusDotClassName(status: TerminalStatus): string {
  switch (status) {
    case 'running':
      return 'fill-success text-success'
    case 'exited':
      return 'text-muted-foreground/40'
    case 'error':
      return 'fill-destructive text-destructive'
    case 'creating':
    default:
      return 'fill-muted-foreground text-muted-foreground'
  }
}
