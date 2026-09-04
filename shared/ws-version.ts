// Focused-episode-7 round 3 (Findings F1+F2): bumped 9 → 10 with the
// `panes.closed` batch envelope / `panes.closed.result` answer and the
// `pane.opened` durable open re-assertion. The client's whole-tab close gate
// awaits the batch answer, and a version-9 server that predates the frame's
// schema boundary DROPS unknown typed messages silently (the deserialization
// floor), so shipping the gated batch with no bump would let a mixed pair
// behave as though tab close evidence were recorded when it was not. The
// bump makes the mix fail LOUDLY instead: the strict hello check rejects
// mismatched sides with PROTOCOL_MISMATCH ("Please reload the page."), so a
// close is either confirmed by a server that knows the answer or the
// connection never pretends it can be — no silent exactness loss. (The
// hello check is symmetric: both the Node server's ws-handler and
// freshell-ws enforce it.) `pane.opened` itself is fire-and-forget and needs
// no answer; it rides the same bump because neither of its endpoints exists
// pre-v10 anyway.
export const WS_PROTOCOL_VERSION = 10 as const
