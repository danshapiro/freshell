use super::*;
use std::path::Path;

fn write_fixture(root: &Path, relative: &str, text: &str) {
    let file = root.join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

fn fixture_collector(root: &Path) -> HostStatsCollectorService {
    HostStatsCollectorService::new(
        HostStatsCollectorConfig {
            proc_root: root.join("proc"),
            sys_root: root.join("sys"),
            ..Default::default()
        },
        freshell_terminal::TerminalRegistry::new(),
        HostStatsInterestRegistry::default(),
        Instant::now(),
    )
}

#[test]
fn cpu_rates_use_deltas_for_aggregate_steal_and_each_core() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "stat",
        "cpu 100 0 0 900 0 0 0 0\n\
         cpu0 25 0 0 225 0 0 0 0\n\
         cpu1 25 0 0 225 0 0 0 0\n\
         cpu2 25 0 0 225 0 0 0 0\n\
         cpu3 25 0 0 225 0 0 0 0\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_cpu_section(1_000);
    assert!(first.available);
    assert_eq!(first.usage_pct, 0.0);
    assert_eq!(first.steal_pct, Some(0.0));
    assert_eq!(first.per_core_pct, vec![0.0; 4]);

    write_fixture(
        &proc_root,
        "stat",
        "cpu 280 0 0 1700 0 0 0 20\n\
         cpu0 100 0 0 400 0 0 0 0\n\
         cpu1 100 0 0 400 0 0 0 0\n\
         cpu2 100 0 0 400 0 0 0 0\n\
         cpu3 100 0 0 400 0 0 0 0\n",
    );
    let next = collector.ctx.read_cpu_section(3_000);
    assert!(next.available);
    assert_eq!(next.usage_pct, 20.0);
    assert_eq!(next.steal_pct, Some(2.0));
    assert_eq!(next.per_core_pct, vec![30.0; 4]);
}

#[test]
fn paging_rates_convert_page_deltas_over_elapsed_seconds() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "vmstat",
        "pswpin 100\npswpout 40\npgmajfault 50\noom_kill 2\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_paging_section(1_000);
    assert!(first.available);
    assert_eq!(first.swap_in_kbps, 0.0);
    assert_eq!(first.swap_out_kbps, 0.0);
    assert_eq!(first.maj_faults_per_sec, 0.0);
    assert_eq!(first.oom_kills_delta, 0);
    assert_eq!(first.oom_kills_total, 2);

    write_fixture(
        &proc_root,
        "vmstat",
        "pswpin 108\npswpout 44\npgmajfault 70\noom_kill 5\n",
    );
    let next = collector.ctx.read_paging_section(3_000);
    assert!(next.available);
    assert_eq!(next.swap_in_kbps, 16.0);
    assert_eq!(next.swap_out_kbps, 8.0);
    assert_eq!(next.maj_faults_per_sec, 10.0);
    assert_eq!(next.oom_kills_delta, 3);
    assert_eq!(next.oom_kills_total, 5);
}

#[test]
fn disk_rates_convert_sectors_and_compute_utilization_and_await() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "diskstats",
        "8 0 sda 1000 0 100000 4000 2000 0 400000 8000 0 500 0\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_disk_io_section(5_000);
    assert!(first.available);
    assert_eq!(first.read_bps, 0.0);
    assert_eq!(first.write_bps, 0.0);
    assert_eq!(first.util_pct, None);
    assert_eq!(first.weighted_await_ms, None);

    write_fixture(
        &proc_root,
        "diskstats",
        "8 0 sda 1100 0 151200 6000 2400 0 502400 10000 0 1500 0\n",
    );
    let next = collector.ctx.read_disk_io_section(10_000);
    assert!(next.available);
    assert_eq!(next.read_bps, 5_242_880.0);
    assert_eq!(next.write_bps, 10_485_760.0);
    assert_eq!(next.util_pct, Some(20.0));
    assert_eq!(next.weighted_await_ms, Some(8.0));
}

#[test]
fn network_rates_keep_error_and_drop_totals_and_deltas_distinct() {
    let root = tempfile::tempdir().unwrap();
    let proc_root = root.path().join("proc");
    write_fixture(
        &proc_root,
        "net/dev",
        "eth0: 1000000 0 3 2 0 0 0 0 500000 0 1 4 0 0 0 0\n",
    );
    let collector = fixture_collector(root.path());
    let first = collector.ctx.read_network_section(5_000);
    assert!(first.available);
    assert_eq!(first.rx_bps, 0.0);
    assert_eq!(first.tx_bps, 0.0);
    assert_eq!(first.rx_errors_delta, 0);
    assert_eq!(first.tx_errors_delta, 0);
    assert_eq!(first.rx_dropped_delta, 0);
    assert_eq!(first.tx_dropped_delta, 0);

    write_fixture(
        &proc_root,
        "net/dev",
        "eth0: 1500000 0 5 3 0 0 0 0 600000 0 3 5 0 0 0 0\n",
    );
    let next = collector.ctx.read_network_section(10_000);
    assert!(next.available);
    assert_eq!(next.rx_bps, 100_000.0);
    assert_eq!(next.tx_bps, 20_000.0);
    assert_eq!(next.rx_errors_total, 5);
    assert_eq!(next.tx_errors_total, 3);
    assert_eq!(next.rx_dropped_total, 3);
    assert_eq!(next.tx_dropped_total, 5);
    assert_eq!(next.rx_errors_delta, 2);
    assert_eq!(next.tx_errors_delta, 2);
    assert_eq!(next.rx_dropped_delta, 1);
    assert_eq!(next.tx_dropped_delta, 1);
}
