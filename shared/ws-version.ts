/** Current protocol. v8 adds exact-recovery negotiation and launch fencing. */
export const WS_PROTOCOL_VERSION = 8 as const

/** The one explicit compatibility handshake accepted by v8 servers. */
export const WS_LEGACY_PROTOCOL_VERSION = 7 as const
