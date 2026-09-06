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
// freshell-ws enforce it.)
//
// Focused-episode-7 round 5 (Finding F3) — NO bump for `pane.opened.result`:
// the re-assertion gained a correlated answer, but the client never GATES on
// it (its listen is bounded and non-blocking; the per-ready open sweep
// re-asserts every displayed pane regardless). A predated v10 server simply
// never sends the frame, and the mix degrades to exactly the behavior the
// sweep already heals — no wedge, no silent exactness loss beyond the
// already-shipped state. The bump rule applies to answers the client AWAITS
// (`pane.closed.result`, `panes.closed.result`): an awaited answer a
// predated server silently drops must never ship unversioned.
export const WS_PROTOCOL_VERSION = 10 as const
