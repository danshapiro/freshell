//! Field-level drift pin for the hoststats.* payloads (LB14).
//!
//! The inventory test pins discriminants only; this pins the exact key set and
//! camelCase spelling of every nested section, plus the nullable-vs-optional
//! serde split (`.nullable()` fields serialize as explicit `null`; `.optional()`
//! fields are omitted from the wire).

use std::collections::HashMap;

use freshell_protocol::server_messages::{
    HostStatsCpu, HostStatsDisk, HostStatsDiskIo, HostStatsDisks, HostStatsFreshell,
    HostStatsInotify, HostStatsLimits, HostStatsLive, HostStatsLoad, HostStatsMachine,
    HostStatsManual, HostStatsMemory, HostStatsNetwork, HostStatsPaging, HostStatsProcessHealth,
    HostStatsPsi, HostStatsRefreshResponse, HostStatsSnapshot, HostStatsThermalZone,
    HostStatsThermals, HostStatsTopProcess, HostStatsTopProcesses,
};

fn sample_live() -> HostStatsLive {
    HostStatsLive {
        machine: HostStatsMachine {
            cores: 12,
            mem_total_bytes: 34_000_000_000,
            platform: "linux".into(),
            wsl: true,
            kernel: Some("6.6".into()),
            hostname: Some("h".into()),
            psi: true,
            cgroup: "v2".into(),
            thermal_count: 1,
            battery_present: false,
            gpu: "none".into(),
        },
        cpu: HostStatsCpu {
            available: true,
            usage_pct: 12.5,
            steal_pct: Some(0.0),
            per_core_pct: vec![1.0, 2.0],
            freq_m_hz: Some(3400.0),
        },
        load: HostStatsLoad {
            available: true,
            load1: 0.5,
            load5: 1.0,
            load15: 1.2,
            cores: 12,
        },
        memory: HostStatsMemory {
            available: true,
            source: "host".into(),
            total_bytes: 1,
            used_bytes: 1,
            available_bytes: 1,
            cgroup_limit_bytes: None,
            swap_total_bytes: Some(0),
            swap_used_bytes: Some(0),
        },
        paging: HostStatsPaging {
            available: true,
            swap_in_kbps: 0.0,
            swap_out_kbps: 0.0,
            maj_faults_per_sec: 0.0,
            oom_kills_delta: 0,
            oom_kills_total: 0,
        },
        psi: HostStatsPsi {
            available: true,
            cpu_some10: Some(0.1),
            mem_some10: None,
            mem_full10: None,
            io_some10: Some(0.2),
            io_full10: Some(0.0),
        },
        disk_io: HostStatsDiskIo {
            available: true,
            read_bps: 0.0,
            write_bps: 0.0,
            util_pct: None,
            weighted_await_ms: None,
        },
        network: HostStatsNetwork {
            available: true,
            rx_bps: 0.0,
            tx_bps: 0.0,
            rx_errors_total: 0,
            tx_errors_total: 0,
            rx_dropped_total: 0,
            tx_dropped_total: 0,
            rx_errors_delta: 0,
            tx_errors_delta: 0,
            rx_dropped_delta: 0,
            tx_dropped_delta: 0,
        },
        limits: HostStatsLimits {
            available: true,
            fds_used: Some(128),
            fds_max: Some(1_048_576),
            pids_used: Some(900),
            pids_max: Some(4_194_304),
            time_wait: Some(42),
            ephemeral_ports: Some(28232),
        },
        freshell: HostStatsFreshell {
            available: true,
            source: "node".into(),
            ptys_running: 1,
            ptys_max: 50,
            ws_clients: 2,
            ws_clients_max: 50,
            event_loop_lag_p99_ms: Some(3.2),
            rss_bytes: Some(900_000_000),
            uptime_sec: 100.0,
        },
    }
}

fn sample_manual() -> HostStatsManual {
    HostStatsManual {
        top_processes: HostStatsTopProcesses {
            available: true,
            dwell_ms: 300,
            list: vec![HostStatsTopProcess {
                pid: 5,
                name: "node".into(),
                cpu_pct: 12.3,
                rss_bytes: 1_000_000,
                state: "S".into(),
            }],
        },
        process_health: HostStatsProcessHealth {
            available: true,
            zombies: 0,
            d_state: 0,
            total: 900,
        },
        inotify: HostStatsInotify {
            available: true,
            instances: Some(3),
            watches: Some(420),
            max_user_watches: Some(1_048_576),
            max_user_instances: Some(128),
        },
        disks: HostStatsDisks {
            available: true,
            list: vec![HostStatsDisk {
                mount: "/".into(),
                total_bytes: 1_000_000_000_000,
                free_bytes: 500_000_000_000,
                used_pct: 50.0,
                inodes_total: Some(100_000_000),
                inodes_free: Some(90_000_000),
            }],
        },
        thermals: HostStatsThermals {
            available: true,
            zones: vec![HostStatsThermalZone {
                label: "cpu".into(),
                celsius: 51.5,
            }],
            battery: None,
        },
        section_errors: HashMap::new(),
    }
}

#[test]
fn fully_populated_snapshot_serializes_exact_camel_case_shape() {
    let snap = HostStatsSnapshot {
        at: 1_756_000_000_000,
        live: sample_live(),
        manual_at: Some(1_756_000_000_500),
        manual: Some(sample_manual()),
    };
    let v = serde_json::to_value(&snap).expect("serialize");
    let expected = serde_json::json!({
        "at": 1_756_000_000_000u64,
        "live": {
            "machine": {
                "cores": 12, "memTotalBytes": 34_000_000_000u64, "platform": "linux",
                "wsl": true, "kernel": "6.6", "hostname": "h", "psi": true,
                "cgroup": "v2", "thermalCount": 1, "batteryPresent": false, "gpu": "none"
            },
            "cpu": {
                "available": true, "usagePct": 12.5, "stealPct": 0.0,
                "perCorePct": [1.0, 2.0], "freqMHz": 3400.0
            },
            "load": { "available": true, "load1": 0.5, "load5": 1.0, "load15": 1.2, "cores": 12 },
            "memory": {
                "available": true, "source": "host", "totalBytes": 1, "usedBytes": 1,
                "availableBytes": 1, "cgroupLimitBytes": null,
                "swapTotalBytes": 0, "swapUsedBytes": 0
            },
            "paging": {
                "available": true, "swapInKbps": 0.0, "swapOutKbps": 0.0,
                "majFaultsPerSec": 0.0, "oomKillsDelta": 0, "oomKillsTotal": 0
            },
            "psi": {
                "available": true, "cpuSome10": 0.1, "memSome10": null, "memFull10": null,
                "ioSome10": 0.2, "ioFull10": 0.0
            },
            "diskIo": {
                "available": true, "readBps": 0.0, "writeBps": 0.0,
                "utilPct": null, "weightedAwaitMs": null
            },
            "network": {
                "available": true, "rxBps": 0.0, "txBps": 0.0,
                "rxErrorsTotal": 0, "txErrorsTotal": 0, "rxDroppedTotal": 0, "txDroppedTotal": 0,
                "rxErrorsDelta": 0, "txErrorsDelta": 0, "rxDroppedDelta": 0, "txDroppedDelta": 0
            },
            "limits": {
                "available": true, "fdsUsed": 128, "fdsMax": 1_048_576,
                "pidsUsed": 900, "pidsMax": 4_194_304, "timeWait": 42, "ephemeralPorts": 28232
            },
            "freshell": {
                "available": true, "source": "node", "ptysRunning": 1, "ptysMax": 50,
                "wsClients": 2, "wsClientsMax": 50, "eventLoopLagP99Ms": 3.2,
                "rssBytes": 900_000_000, "uptimeSec": 100.0
            }
        },
        "manualAt": 1_756_000_000_500u64,
        "manual": {
            "topProcesses": {
                "available": true, "dwellMs": 300,
                "list": [{ "pid": 5, "name": "node", "cpuPct": 12.3, "rssBytes": 1_000_000, "state": "S" }]
            },
            "processHealth": { "available": true, "zombies": 0, "dState": 0, "total": 900 },
            "inotify": {
                "available": true, "instances": 3, "watches": 420,
                "maxUserWatches": 1_048_576, "maxUserInstances": 128
            },
            "disks": {
                "available": true,
                "list": [{
                    "mount": "/", "totalBytes": 1_000_000_000_000u64, "freeBytes": 500_000_000_000u64,
                    "usedPct": 50.0, "inodesTotal": 100_000_000, "inodesFree": 90_000_000
                }]
            },
            "thermals": { "available": true, "zones": [{ "label": "cpu", "celsius": 51.5 }], "battery": null },
            "sectionErrors": {}
        }
    });
    // serde_json::Value equality is key-set + value + spelling exact (maps
    // compare as sets, so a renamed/missing/extra key diverges).
    assert_eq!(v, expected, "snapshot wire shape drifted");
}

#[test]
fn nullable_fields_serialize_null_and_optional_fields_are_absent() {
    // Bare refresh response: `.optional()` fields must be ABSENT, never null.
    let resp = HostStatsRefreshResponse {
        request_id: "r1".into(),
        ok: true,
        at: None,
        manual: None,
        error: None,
    };
    let v = serde_json::to_value(&resp).expect("serialize");
    let obj = v.as_object().expect("object");
    assert_eq!(obj.len(), 2, "bare response carries requestId+ok only");
    assert_eq!(v["requestId"], "r1");
    assert!(!obj.contains_key("at"), "at must be absent, not null");
    assert!(
        !obj.contains_key("manual"),
        "manual must be absent, not null"
    );
    assert!(!obj.contains_key("error"), "error must be absent, not null");

    // Snapshot with no manual refresh yet: `.nullable()` fields must be
    // PRESENT as explicit null.
    let snap = HostStatsSnapshot {
        at: 1,
        live: sample_live(),
        manual_at: None,
        manual: None,
    };
    let v = serde_json::to_value(&snap).expect("serialize");
    assert!(v.as_object().expect("object").contains_key("manualAt"));
    assert!(v.as_object().expect("object").contains_key("manual"));
    assert_eq!(v["manualAt"], serde_json::Value::Null);
    assert_eq!(v["manual"], serde_json::Value::Null);

    // Message-level envelope: serde tag must be the frozen discriminant.
    let msg = freshell_protocol::ServerMessage::HostStatsRefreshResponse(resp);
    let v = serde_json::to_value(&msg).expect("serialize envelope");
    assert_eq!(v["type"], "hoststats.refresh.response");
    assert!(!v.as_object().expect("object").contains_key("at"));
}
