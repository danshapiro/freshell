//! Shared ordinary source views and selection metadata. Private indexed
//! payloads retain the separate provider_input_exchange profile.
pub const MAX_SOURCE_VIEW_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SOURCE_EVENTS: usize = 8192;
pub const MAX_SOURCE_EVENT_BYTES: usize = 8 * 1024 * 1024;
