// Delta-r7-round-3 (focused-episode-7 round 2, Finding F4): bumped 8 → 9
// with the `pane.closed.result` server frame. The client's pane-close
// evidence is now ACKNOWLEDGED and the close gate awaits that answer — a
// version-8 server that predates the frame's schema boundary DROPS unknown
// typed messages silently (the deserialization floor), so without the bump
// a staged/rolled-back mix could let a new client behave as though close
// evidence were recorded when it was not. The bump makes the mix fail LOUDLY
// instead: the strict hello check rejects mismatched sides with
// PROTOCOL_MISMATCH ("Please reload the page."), so a close is either
// confirmed by a server that knows the answer or the connection never
// pretends it can be — no silent exactness loss. (The hello check is
// symmetric: both the Node server's ws-handler and freshell-ws enforce it.)
export const WS_PROTOCOL_VERSION = 9 as const
