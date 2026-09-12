/** Messages for client actions deliberately absent from the Rust server baseline. */
export const RUST_BASELINE_UNAVAILABLE = {
  remoteLoopback: 'Remote loopback forwarding is unavailable; use a localhost HTTP URL or open the URL on the server host.',
  shellCommand: 'Shell commands are unavailable here; open a shell pane instead',
  fullDiff: 'Full diff loading is unavailable.',
  extension: 'This extension pane is unavailable with the Rust server baseline.',
} as const
