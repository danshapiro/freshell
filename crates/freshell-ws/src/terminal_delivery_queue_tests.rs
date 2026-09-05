use super::*;
static STAMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn put_at(q: &mut DeliveryQueue<(String, i64)>, id: &str, p: Priority, seq: i64, bytes: usize) {
    q.push(
        id,
        p,
        (id.to_string(), seq),
        bytes,
        range(seq, "g"),
        stamp(),
    )
    .unwrap();
}
fn stamp() -> u64 {
    STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
fn range(seq: i64, generation: &str) -> Option<Range> {
    Some(Range {
        stream_id: "s".into(),
        attach_request_id: Some(generation.into()),
        from_seq: seq,
        to_seq: seq,
    })
}
fn put(q: &mut DeliveryQueue<(String, i64)>, id: &str, p: Priority, seq: i64, bytes: usize) {
    q.push(
        id,
        p,
        (id.to_string(), seq),
        bytes,
        range(seq, "g"),
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
}
fn next(q: &mut DeliveryQueue<(String, i64)>) -> (String, i64, usize) {
    match q.pop().expect("queued") {
        Delivery::Frame {
            payload: (id, seq),
            bytes,
        } => (id, seq, bytes),
        other => panic!("{other:?}"),
    }
}
#[test]
fn terminal_fifo_and_exit_are_preserved_across_cross_terminal_priority() {
    let mut q = DeliveryQueue::new(100_000, 1000);
    put(&mut q, "b", Priority::Background, 1, 100);
    put(&mut q, "b", Priority::Background, 2, 100);
    q.push(
        "b",
        Priority::Background,
        ("b".into(), 3),
        100,
        None,
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    put(&mut q, "f", Priority::Focused, 1, 100);
    assert_eq!(next(&mut q).0, "f");
    assert_eq!(next(&mut q).1, 1);
    assert_eq!(next(&mut q).1, 2);
    assert_eq!(next(&mut q).1, 3);
}
#[test]
fn continuously_backlogged_classes_get_eight_three_one_bytes() {
    let mut q = DeliveryQueue::new(10_000_000, 10000);
    for i in 0..1000 {
        for (id, p) in [
            ("f", Priority::Focused),
            ("v", Priority::Visible),
            ("b", Priority::Background),
        ] {
            put(&mut q, id, p, i, 100);
        }
    }
    let mut counts = BTreeMap::new();
    for _ in 0..120 {
        *counts.entry(next(&mut q).0).or_insert(0usize) += 1;
    }
    assert_eq!(counts["f"], 80);
    assert_eq!(counts["v"], 30);
    assert_eq!(counts["b"], 10);
}
#[test]
fn tiny_background_frames_do_not_purchase_equal_bandwidth() {
    let mut q = DeliveryQueue::new(100_000_000, 100_000);
    for i in 0..1000 {
        put(&mut q, "f", Priority::Focused, i, 8192);
    }
    for i in 0..50000 {
        put(&mut q, "b", Priority::Background, i, 128);
    }
    let (mut f, mut b) = (0usize, 0usize);
    for _ in 0..5000 {
        let (id, _, n) = next(&mut q);
        if id == "f" {
            f += n
        } else {
            b += n
        }
    }
    assert!((f as i64 - 8 * b as i64).abs() <= 8192 * 9, "f={f} b={b}");
}
#[test]
fn background_count_does_not_multiply_class_share() {
    let mut q = DeliveryQueue::new(100_000_000, 100_000);
    for i in 0..500 {
        put(&mut q, "f", Priority::Focused, i, 100);
    }
    for lane in 0..20 {
        for i in 0..100 {
            put(&mut q, &format!("b{lane}"), Priority::Background, i, 100);
        }
    }
    let mut focused = 0;
    for _ in 0..450 {
        if next(&mut q).0 == "f" {
            focused += 1;
        }
    }
    assert_eq!(focused, 400);
}
#[test]
fn lanes_in_one_class_share_bytes_not_frame_counts() {
    let mut q = DeliveryQueue::new(10_000_000, 10000);
    for i in 0..1000 {
        put(&mut q, "a", Priority::Visible, i, 100);
        put(&mut q, "b", Priority::Visible, i, 1000);
    }
    let (mut a, mut b) = (0i64, 0i64);
    for _ in 0..200 {
        let (id, _, n) = next(&mut q);
        if id == "a" {
            a += n as i64
        } else {
            b += n as i64
        }
    }
    assert!((a - b).abs() <= 1000, "a={a} b={b}");
}
#[test]
fn priority_change_preserves_every_queued_byte_and_sequence() {
    let mut q = DeliveryQueue::new(100_000, 1000);
    for i in 0..100 {
        put(&mut q, "a", Priority::Background, i, 100);
        put(&mut q, "b", Priority::Background, i, 100);
    }
    let before = q.pending_bytes();
    q.update_priorities(|id| {
        if id == "b" {
            Priority::Focused
        } else {
            Priority::Background
        }
    });
    assert_eq!(q.pending_bytes(), before);
    assert_eq!(next(&mut q).0, "b");
    let mut last = BTreeMap::from([("b".to_string(), 0i64)]);
    while let Some(Delivery::Frame {
        payload: (id, seq), ..
    }) = q.pop()
    {
        assert_eq!(seq, last.get(&id).map(|s| s + 1).unwrap_or(0));
        last.insert(id, seq);
    }
    assert_eq!(last["a"], 99);
    assert_eq!(last["b"], 99);
    assert_eq!(q.pending_bytes(), 0);
}
#[test]
fn empty_classes_do_not_reserve_bandwidth() {
    let mut q = DeliveryQueue::new(10000, 1000);
    for i in 0..50 {
        put(&mut q, "b", Priority::Background, i, 100);
    }
    for i in 0..50 {
        assert_eq!(next(&mut q).1, i);
    }
    assert!(q.pop().is_none());
    assert_eq!(q.lane_count(), 0);
}
#[test]
fn late_arriving_focused_lane_has_no_historical_background_debt() {
    let mut q = DeliveryQueue::new(1_000_000, 10000);
    for i in 0..200 {
        put(&mut q, "b", Priority::Background, i, 100);
    }
    for _ in 0..100 {
        next(&mut q);
    }
    put(&mut q, "f", Priority::Focused, 0, 100);
    assert_eq!(next(&mut q).0, "f");
}
#[test]
fn global_oldest_eviction_remains_explicit_and_generation_scoped() {
    let mut q = DeliveryQueue::new(250, 100);
    put(&mut q, "a", Priority::Focused, 1, 100);
    put(&mut q, "b", Priority::Background, 1, 100);
    put(&mut q, "a", Priority::Focused, 2, 100);
    assert_eq!(q.pending_bytes(), 200);
    match q.pop().unwrap() {
        Delivery::Gap { terminal_id, range } => {
            assert_eq!(terminal_id, "a");
            assert_eq!(range.from_seq, 1);
            assert_eq!(range.attach_request_id.as_deref(), Some("g"));
        }
        other => panic!("{other:?}"),
    }
}
#[test]
fn adjacent_evictions_coalesce_but_generation_changes_do_not() {
    let mut q = DeliveryQueue::new(1, 100);
    q.push(
        "a",
        Priority::Visible,
        1,
        10,
        range(1, "old"),
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    q.push(
        "a",
        Priority::Visible,
        2,
        10,
        range(2, "old"),
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    q.push(
        "a",
        Priority::Visible,
        3,
        10,
        range(3, "new"),
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    match q.pop().unwrap() {
        Delivery::Gap { range, .. } => assert_eq!((range.from_seq, range.to_seq), (1, 2)),
        _ => panic!(),
    }
    match q.pop().unwrap() {
        Delivery::Gap { range, .. } => assert_eq!(range.attach_request_id.as_deref(), Some("new")),
        _ => panic!(),
    }
}
#[test]
fn in_flight_output_stays_in_the_admission_budget() {
    let mut q = DeliveryQueue::new(250, 100);
    put(&mut q, "a", Priority::Visible, 1, 200);
    let (_, _, bytes) = next(&mut q);
    q.set_reserved_bytes(bytes);
    put(&mut q, "b", Priority::Visible, 1, 100);
    assert!(q.outstanding_bytes() <= 250);
    assert!(matches!(q.pop(), Some(Delivery::Gap { .. })));
    q.set_reserved_bytes(0);
    assert_eq!(q.outstanding_bytes(), 0);
}
#[test]
fn sequenced_controls_cannot_be_evicted() {
    let mut q = DeliveryQueue::new(100, 100);
    assert_eq!(
        q.push(
            "a",
            Priority::Visible,
            "exit",
            101,
            None,
            STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
        Err(CapacityError::UnrecoverableOverflow)
    );
}
#[test]
fn superseding_one_terminal_does_not_touch_another() {
    let mut q = DeliveryQueue::new(10000, 100);
    put(&mut q, "a", Priority::Focused, 1, 100);
    put(&mut q, "b", Priority::Background, 1, 100);
    q.push(
        "a",
        Priority::Focused,
        ("a".into(), 2),
        100,
        None,
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    q.discard_terminal("a");
    assert_eq!(q.pending_bytes(), 100);
    assert_eq!(next(&mut q).0, "b");
}
#[test]
fn exact_unicode_payload_is_opaque_to_scheduler() {
    let mut q = DeliveryQueue::new(10000, 100);
    let text = "\x1b[?1049h\x1b[31m東京🦀\r\n\x1b[?2026l".to_string();
    q.push(
        "a",
        Priority::Visible,
        text.clone(),
        text.len(),
        range(1, "g"),
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    match q.pop().unwrap() {
        Delivery::Frame { payload, .. } => assert_eq!(payload.as_bytes(), text.as_bytes()),
        _ => panic!(),
    }
}
#[test]
fn metadata_limit_prevents_unbounded_zero_byte_items() {
    let mut q = DeliveryQueue::new(10000, 2);
    q.push(
        "a",
        Priority::Visible,
        1,
        0,
        None,
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    q.push(
        "a",
        Priority::Visible,
        2,
        0,
        None,
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    assert_eq!(
        q.push(
            "a",
            Priority::Visible,
            3,
            0,
            None,
            STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
        Err(CapacityError::MetadataLimit)
    );
}
#[test]
fn randomized_priority_changes_preserve_fifo_and_accounting() {
    for seed in 1..=100u64 {
        let mut random = seed;
        let mut q = DeliveryQueue::new(100_000_000, 10000);
        let mut produced = [0i64; 4];
        let mut received = [0i64; 4];
        let mut bytes = 0usize;
        for _ in 0..1000 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let i = ((random >> 32) % 4) as usize;
            match random % 3 {
                0 => {
                    let id = i.to_string();
                    put(&mut q, &id, Priority::Visible, produced[i], 17);
                    produced[i] += 1;
                    bytes += 17;
                }
                1 => {
                    if let Some(Delivery::Frame {
                        payload: (id, seq),
                        bytes: n,
                    }) = q.pop()
                    {
                        let j = id.parse::<usize>().unwrap();
                        assert_eq!(seq, received[j]);
                        received[j] += 1;
                        bytes -= n;
                    }
                }
                _ => q.update_priorities(|id| {
                    if id == i.to_string() {
                        Priority::Focused
                    } else {
                        Priority::Background
                    }
                }),
            }
            assert_eq!(q.pending_bytes(), bytes);
        }
        while let Some(Delivery::Frame {
            payload: (id, seq), ..
        }) = q.pop()
        {
            let j = id.parse::<usize>().unwrap();
            assert_eq!(seq, received[j]);
            received[j] += 1;
        }
        assert_eq!(received, produced);
        assert_eq!(q.pending_bytes(), 0);
        assert_eq!(q.lane_count(), 0);
    }
}

#[test]
fn arithmetic_overflow_does_not_create_a_phantom_index_entry() {
    let mut q = DeliveryQueue::new(usize::MAX, 100);
    q.push(
        "a",
        Priority::Visible,
        "first",
        usize::MAX,
        None,
        STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    )
    .unwrap();
    assert_eq!(
        q.push(
            "b",
            Priority::Focused,
            "rejected",
            1,
            None,
            STAMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
        Err(CapacityError::UnrecoverableOverflow)
    );
    assert_eq!(q.lane_count(), 1);
    assert_eq!(q.pending_bytes(), usize::MAX);
    match q.pop().unwrap() {
        Delivery::Frame { payload, .. } => assert_eq!(payload, "first"),
        _ => panic!(),
    }
    assert!(q.pop().is_none());
}

#[test]
fn demotion_after_history_neither_steals_nor_starves() {
    // 8:1 window check with real service history: after 1000 focused frames,
    // demoting that lane to background (and promoting another to focused) must
    // leave both progressing — the demoted lane inside its first window, and
    // at roughly 8:1 bytes thereafter. A zero-carry watermark would let the
    // long-served lane jump the promotion; a weight-SCALED carry would starve
    // it for thousands of pops (both pinned wrong before).
    let mut q = DeliveryQueue::new(10_000_000_000, 1_000_000);
    for i in 0..1000 {
        q.push("f", Priority::Focused, ("f".into(), i), 100, None, stamp())
            .unwrap();
        q.pop();
    }
    assert_eq!(q.lane_count(), 0);
    // Enough backlog on both sides that neither lane drains inside the
    // measured window (service would otherwise degenerate to a drained-lane
    // free-run, which is correct behavior, not the ratio under test).
    for i in 1000..1060 {
        put_at(&mut q, "f", Priority::Focused, i, 100);
    }
    for i in 0..60 {
        put_at(&mut q, "g", Priority::Focused, i, 100);
    }
    q.update_priorities(|id| {
        if id == "g" {
            Priority::Focused
        } else {
            Priority::Background
        }
    });
    let (mut fs, mut gs, mut first_f) = (0usize, 0usize, None);
    for n in 0..27 {
        let (id, ..) = next(&mut q);
        if id == "f" {
            fs += 1;
            if first_f.is_none() {
                first_f = Some(n);
            }
        } else {
            gs += 1;
        }
    }
    assert!(
        first_f.is_some_and(|n| (1..=9).contains(&n)),
        "demoted lane must arrive within one 8:1 window of the promotion, got {first_f:?}"
    );
    assert!(
        fs == 3 && gs == 24,
        "27 saturated pops at 8:1 ⇒ exactly 3 demoted, got fs={fs} gs={gs}"
    );
}
