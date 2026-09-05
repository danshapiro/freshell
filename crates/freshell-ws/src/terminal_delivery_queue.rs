//! Byte-fair, connection-local terminal delivery. Payloads are opaque: scheduling
//! never edits terminal bytes or reorders a terminal's frames. The global oldest
//! evictable index preserves the existing drop-oldest retention policy. Gaps are
//! generation-scoped, and sequenced controls (exit) cannot be evicted.
//!
//! Three service classes receive approximately 8:3:1 BYTES while all are busy.
//! Empty classes accrue no credit. Within a class, lanes receive equal byte
//! service. Selection scans active terminals, not queued frames; removal and
//! global-oldest eviction use ordered indices. One large frame is indivisible.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Focused,
    Visible,
    Background,
}
impl Priority {
    fn index(self) -> usize {
        match self {
            Self::Focused => 0,
            Self::Visible => 1,
            Self::Background => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Range {
    pub stream_id: String,
    pub attach_request_id: Option<String>,
    pub from_seq: i64,
    pub to_seq: i64,
}

#[derive(Debug)]
pub enum Delivery<T> {
    Frame { payload: T, bytes: usize },
    Gap { terminal_id: String, range: Range },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapacityError {
    MetadataLimit,
    UnrecoverableOverflow,
    SequenceExhausted,
}

struct Entry<T> {
    terminal_id: String,
    payload: T,
    bytes: usize,
    range: Option<Range>,
    /// Admission order, assigned by the caller under its queue lock: used by
    /// the connection writer's control-vs-output arbitration. Scheduling
    /// itself never looks at stamps.
    stamp: u64,
}

/// Byte-service multipliers per class. Service is counted in bytes × weight;
/// picking the MINIMUM service class each pop therefore converges to ~8:3:1
/// BYTES of focused/visible/background while all three stay backlogged.
const WEIGHT: [u128; 3] = [3, 8, 24];

struct Lane {
    priority: Priority,
    ids: BTreeSet<u64>,
    gaps: VecDeque<Range>,
    served: u128,
}
impl Lane {
    fn active(&self) -> bool {
        !self.ids.is_empty() || !self.gaps.is_empty()
    }
}

pub struct DeliveryQueue<T> {
    entries: BTreeMap<u64, Entry<T>>,
    evictable: BTreeSet<u64>,
    lanes: BTreeMap<String, Lane>,
    next_id: u64,
    bytes: usize,
    reserved: usize,
    byte_limit: usize,
    metadata_limit: usize,
    gap_count: usize,
    class_served: [u128; 3],
    class_clock: u128,
    lane_clock: [u128; 3],
}

impl<T> DeliveryQueue<T> {
    pub fn new(byte_limit: usize, metadata_limit: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            evictable: BTreeSet::new(),
            lanes: BTreeMap::new(),
            next_id: 0,
            bytes: 0,
            reserved: 0,
            byte_limit: byte_limit.max(1),
            metadata_limit: metadata_limit.max(1),
            gap_count: 0,
            class_served: [0; 3],
            class_clock: 0,
            lane_clock: [0; 3],
        }
    }

    pub fn pending_bytes(&self) -> usize {
        self.bytes
    }
    pub fn outstanding_bytes(&self) -> usize {
        self.bytes.saturating_add(self.reserved)
    }
    #[cfg(test)]
    pub fn lane_count(&self) -> usize {
        self.lanes.len()
    }

    // The writer leases one frame at a time. Its bytes remain charged until
    // the socket flush finishes; this method is called under its admission lock.
    pub fn set_reserved_bytes(&mut self, bytes: usize) {
        self.reserved = bytes;
    }

    pub fn push(
        &mut self,
        terminal_id: &str,
        priority: Priority,
        payload: T,
        bytes: usize,
        range: Option<Range>,
        stamp: u64,
    ) -> Result<(), CapacityError> {
        if self.entries.len().saturating_add(self.gap_count) >= self.metadata_limit {
            return Err(CapacityError::MetadataLimit);
        }
        let id = self.next_id;
        let next_id = id.checked_add(1).ok_or(CapacityError::SequenceExhausted)?;
        let next_bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(CapacityError::UnrecoverableOverflow)?;
        self.next_id = next_id;
        let class = priority.index();
        self.class_served[class] = self.class_served[class].max(self.class_clock);
        let lane = self
            .lanes
            .entry(terminal_id.to_string())
            .or_insert_with(|| Lane {
                priority,
                ids: BTreeSet::new(),
                gaps: VecDeque::new(),
                served: self.lane_clock[class],
            });
        // Existing lane priorities change only via update_priorities, making
        // admission incapable of undoing a newer authoritative interest update.
        lane.ids.insert(id);
        if range.is_some() {
            self.evictable.insert(id);
        }
        self.bytes = next_bytes;
        self.entries.insert(
            id,
            Entry {
                terminal_id: terminal_id.to_string(),
                payload,
                bytes,
                range,
                stamp,
            },
        );
        self.evict_overflow()
    }

    fn evict_overflow(&mut self) -> Result<(), CapacityError> {
        while self.outstanding_bytes() > self.byte_limit {
            let Some(id) = self.evictable.pop_first() else {
                // Only sequenced controls and/or the indivisible in-flight
                // frame remain. Terminate the connection, never silently drop exit.
                return Err(CapacityError::UnrecoverableOverflow);
            };
            let entry = self
                .entries
                .remove(&id)
                .expect("evictable index matches entries");
            self.bytes -= entry.bytes;
            let lane = self
                .lanes
                .get_mut(&entry.terminal_id)
                .expect("entry has lane");
            lane.ids.remove(&id);
            let range = entry.range.expect("only output is evictable");
            if let Some(last) = lane.gaps.back_mut() {
                if last.stream_id == range.stream_id
                    && last.attach_request_id == range.attach_request_id
                    && range.from_seq <= last.to_seq.saturating_add(1)
                {
                    last.from_seq = last.from_seq.min(range.from_seq);
                    last.to_seq = last.to_seq.max(range.to_seq);
                    continue;
                }
            }
            lane.gaps.push_back(range);
            self.gap_count += 1;
            // Invariant (no post-check needed): admission keeps
            // entries + gaps <= metadata_limit, and each eviction removes one
            // entry while adding at most one gap.
        }
        Ok(())
    }

    /// Atomic caller snapshot: update scheduling only, never attachment,
    /// generation, geometry, sequence state, or the PTY process.
    pub fn update_priorities(&mut self, mut priority: impl FnMut(&str) -> Priority) {
        for (id, lane) in &mut self.lanes {
            let next = priority(id);
            if lane.priority != next {
                let origin = lane.priority.index();
                let dest = next.index();
                lane.priority = next;
                lane.served = self.lane_clock[dest];
                // Lift the destination class to at least the origin class's
                // watermark. class_served across classes is ONE normalized
                // virtual clock (compared directly in select_lane), so no
                // weight conversion may be applied. Without the lift, demoting
                // a long-served lane leaves its new class at its old (lower)
                // watermark: the demoted lane would then be the most
                // "underserved" one and win reprioritization against the very
                // lane that was just promoted. (A weight-scaled credit instead
                // would starve the demoted lane for a period proportional to
                // the connection's entire prior service — caught by
                // demotion_after_history_neither_steals_nor_starves.)
                self.class_served[next.index()] =
                    self.class_served[next.index()].max(self.class_served[origin]);
            }
            self.class_served[next.index()] = self.class_served[next.index()].max(self.class_clock);
        }
        self.refresh_clocks();
    }

    pub fn discard_terminal(&mut self, terminal_id: &str) {
        if let Some(lane) = self.lanes.remove(terminal_id) {
            self.gap_count -= lane.gaps.len();
            for id in lane.ids {
                let entry = self
                    .entries
                    .remove(&id)
                    .expect("lane index matches entries");
                self.bytes -= entry.bytes;
                self.evictable.remove(&id);
            }
        }
        self.refresh_clocks();
    }

    fn refresh_clocks(&mut self) {
        let mut active = [false; 3];
        let mut lane_min = [u128::MAX; 3];
        for lane in self.lanes.values().filter(|lane| lane.active()) {
            let i = lane.priority.index();
            active[i] = true;
            lane_min[i] = lane_min[i].min(lane.served);
        }
        if let Some(minimum) = (0..3)
            .filter(|i| active[*i])
            .map(|i| self.class_served[i])
            .min()
        {
            self.class_clock = self.class_clock.max(minimum);
        }
        for i in 0..3 {
            if active[i] {
                self.lane_clock[i] = self.lane_clock[i].max(lane_min[i]);
            }
        }
    }

    /// The single shared selection used by `pop` and `front_stamp`.
    /// Fixed 3-class weighted virtual-service comparison, followed by equal
    /// byte service within the winning class. Saturating u128 arithmetic
    /// makes service counters safe for arbitrarily long-lived connections.
    fn select_lane(&self) -> Option<&str> {
        self.lanes
            .iter()
            .filter(|(_, lane)| lane.active())
            .min_by_key(|(id, lane)| {
                let i = lane.priority.index();
                (
                    self.class_served[i].max(self.class_clock),
                    i,
                    lane.served.max(self.lane_clock[i]),
                    *id,
                )
            })
            .map(|(id, _)| id.as_str())
    }

    pub fn has_pending(&self) -> bool {
        self.lanes.values().any(|lane| lane.active())
    }

    /// Admission stamp of the frame `pop` would deliver next. Gap heads carry
    /// no stamp (None): a gap never leapfrogs an older control.
    pub fn front_stamp(&self) -> Option<u64> {
        let terminal_id = self.select_lane()?;
        let lane = self.lanes.get(terminal_id).expect("selected lane exists");
        if !lane.gaps.is_empty() {
            return None;
        }
        let id = lane
            .ids
            .iter()
            .next()
            .expect("active lane has frame or gap");
        Some(
            self.entries
                .get(id)
                .expect("lane index matches entries")
                .stamp,
        )
    }

    pub fn pop(&mut self) -> Option<Delivery<T>> {
        let terminal_id = self.select_lane()?.to_string();
        let lane = self
            .lanes
            .get_mut(&terminal_id)
            .expect("chosen lane exists");
        let class = lane.priority.index();
        let (delivery, cost) = if let Some(range) = lane.gaps.pop_front() {
            self.gap_count -= 1;
            (
                Delivery::Gap {
                    terminal_id: terminal_id.clone(),
                    range,
                },
                256usize,
            )
        } else {
            let id = lane.ids.pop_first().expect("active lane has frame or gap");
            let entry = self
                .entries
                .remove(&id)
                .expect("lane index matches entries");
            self.evictable.remove(&id);
            self.bytes -= entry.bytes;
            let cost = entry.bytes.max(1);
            (
                Delivery::Frame {
                    payload: entry.payload,
                    bytes: entry.bytes,
                },
                cost,
            )
        };
        lane.served = lane
            .served
            .max(self.lane_clock[class])
            .saturating_add(cost as u128);
        self.class_served[class] = self.class_served[class]
            .max(self.class_clock)
            .saturating_add((cost as u128).saturating_mul(WEIGHT[class]));
        if !lane.active() {
            self.lanes.remove(&terminal_id);
        }
        self.refresh_clocks();
        Some(delivery)
    }
}

#[cfg(test)]
#[path = "terminal_delivery_queue_tests.rs"]
mod tests;
