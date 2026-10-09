//! The Claude sidecar and the Claude model-catalog probe always start Node
//! (`FRESHELL_CLAUDE_NODE`, default `node`). Node raises its own soft
//! open-file limit to the hard limit as it starts, but only when the two
//! differ. So these spawn sites leave the child's limit alone instead of
//! resetting it after the spawn (`freshell_platform::child_nofile`): a reset
//! that landed after Node's check would pin the child at the server's
//! original soft limit for its whole life.
//!
//! Two programs stand in for Node:
//! - `sh` running a recorder script. It never raises its own limit, so it
//!   shows whether the spawn site reset the limit.
//! - Real `node` running a recorder module. It shows the limit a Node child
//!   of these sites ends with.
//!
//! The control runs the same `sh` recorder through `opencode serve`'s
//! spawner, a site whose program may be native and so keeps the reset.
//!
//! This is its own test binary because it changes this process's soft
//! `RLIMIT_NOFILE` and records the process-wide original, which is set once.
//! The tests share one lock, because they set process-wide environment.
//! Every process here was spawned here and exits on its own.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};
use std::time::Duration;

use freshell_freshagent::model_capabilities::{ClaudeCatalogProbe, ModelCatalogProbe};
use freshell_freshagent::FreshClaudeState;
use freshell_opencode::transport::TokioProcessSpawner;
use freshell_opencode::{ProcessSpawner, SpawnRequest};
use freshell_platform::child_nofile;
use freshell_protocol::FreshAgentCreate;

/// The soft limit this process "started with". Set explicitly, because the
/// test runner may already run with soft == hard.
const ORIGINAL_SOFT: u64 = 512;

/// Stands in for a Node program but never raises its own limit. After a
/// pause long enough for any reset by its spawner to land, it records the
/// limit it runs with beside itself.
const SH_RECORDER: &str = "sleep 0.5\n\
dir=$(dirname \"$0\")\n\
printf '%s %s\\n' \"$(ulimit -Sn)\" \"$(ulimit -Hn)\" > \"$dir/limits.tmp\"\n\
mv \"$dir/limits.tmp\" \"$dir/limits\"\n";

/// A Node program that records, after the same pause, the limit it runs
/// with once Node's own start-up is done.
const NODE_RECORDER: &str = "import { readFileSync, renameSync, writeFileSync } from 'node:fs'\n\
setTimeout(() => {\n\
  const row = readFileSync('/proc/self/limits', 'utf8').split('\\n').find((line) => line.startsWith('Max open files'))\n\
  const [soft, hard] = row.trim().split(/\\s+/).slice(3, 5)\n\
  const tmp = new URL('./limits.tmp', import.meta.url)\n\
  writeFileSync(tmp, `${soft} ${hard}\\n`)\n\
  renameSync(tmp, new URL('./limits', import.meta.url))\n\
}, 500)\n";

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn own_limits() -> (u64, u64) {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    (lim.rlim_cur, lim.rlim_max)
}

fn set_own_soft(soft: u64) {
    let lim = libc::rlimit {
        rlim_cur: soft,
        rlim_max: own_limits().1,
    };
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);
}

/// Start at `ORIGINAL_SOFT`, record it, then raise the soft limit to the
/// hard limit: the server's start-up sequence. Returns the hard limit.
fn raised_like_the_server() -> u64 {
    static SETUP: Once = Once::new();
    SETUP.call_once(|| {
        let hard = own_limits().1;
        assert!(
            hard > ORIGINAL_SOFT,
            "the test needs a hard limit above {ORIGINAL_SOFT} (got {hard})"
        );
        set_own_soft(ORIGINAL_SOFT);
        child_nofile::record_original_soft_limit(ORIGINAL_SOFT);
        set_own_soft(hard);
    });
    let (soft, hard) = own_limits();
    assert_eq!(soft, hard, "this process must run with its raised limit");
    hard
}

/// The `(soft, hard)` a recorder wrote into `dir`, waiting for it.
async fn recorded_limits(dir: &Path) -> (u64, u64) {
    let file = dir.join("limits");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&file) {
            let mut values = raw.split_whitespace().map(|v| v.parse::<u64>().unwrap());
            return (values.next().unwrap(), values.next().unwrap());
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the child never recorded its limit in {}",
            dir.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Points the Claude spawn sites at `node` running `entry`'s directory (the
/// probe runs `model-catalog.mjs` beside the sidecar entry), until dropped.
struct ClaudeNode;

impl ClaudeNode {
    fn set(node: &str, entry: &Path) -> Self {
        std::env::set_var("FRESHELL_CLAUDE_NODE", node);
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", entry);
        ClaudeNode
    }
}

impl Drop for ClaudeNode {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
    }
}

/// A temp directory holding `file` with `source`. Returns the dir and path.
fn staged(file: &str, source: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join(file);
    std::fs::write(&path, source).expect("write the recorder");
    (dir, path)
}

/// One freshclaude create. The recorder never answers, so the create fails
/// once it exits; only the limit it recorded matters here.
async fn create_a_claude_session() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = FreshClaudeState::new(Arc::new(tx));
    let msg: FreshAgentCreate = serde_json::from_value(serde_json::json!({
        "requestId": "child-nofile-create",
        "sessionType": "freshclaude",
    }))
    .expect("a freshclaude create");
    tokio::time::timeout(Duration::from_secs(30), state.handle_create(msg, None))
        .await
        .expect("the create settles");
    state.shutdown().await;
}

async fn probe_the_claude_catalog() {
    let probe = ClaudeCatalogProbe;
    let _ = tokio::time::timeout(Duration::from_secs(30), probe.probe(None))
        .await
        .expect("the probe settles");
}

#[tokio::test]
async fn the_claude_sidecar_spawn_leaves_its_childs_limit_alone() {
    let _lock = LOCK.lock().await;
    let hard = raised_like_the_server();
    let (dir, entry) = staged("index.mjs", SH_RECORDER);
    let _node = ClaudeNode::set("sh", &entry);

    create_a_claude_session().await;

    assert_eq!(recorded_limits(dir.path()).await, (hard, hard));
}

#[tokio::test]
async fn the_claude_model_probe_spawn_leaves_its_childs_limit_alone() {
    let _lock = LOCK.lock().await;
    let hard = raised_like_the_server();
    let (dir, _) = staged("model-catalog.mjs", SH_RECORDER);
    let _node = ClaudeNode::set("sh", &dir.path().join("index.mjs"));

    probe_the_claude_catalog().await;

    assert_eq!(recorded_limits(dir.path()).await, (hard, hard));
}

#[tokio::test]
async fn a_node_claude_sidecar_ends_at_the_hard_limit() {
    let _lock = LOCK.lock().await;
    let hard = raised_like_the_server();
    let (dir, entry) = staged("index.mjs", NODE_RECORDER);
    let _node = ClaudeNode::set("node", &entry);

    create_a_claude_session().await;

    assert_eq!(recorded_limits(dir.path()).await, (hard, hard));
}

#[tokio::test]
async fn a_node_claude_model_probe_ends_at_the_hard_limit() {
    let _lock = LOCK.lock().await;
    let hard = raised_like_the_server();
    let (dir, _) = staged("model-catalog.mjs", NODE_RECORDER);
    let _node = ClaudeNode::set("node", &dir.path().join("index.mjs"));

    probe_the_claude_catalog().await;

    assert_eq!(recorded_limits(dir.path()).await, (hard, hard));
}

/// Control: the same recorder, spawned where the program may be native,
/// gets the recorded soft limit back. So the recorder does see a reset, and
/// the sites above are exceptions, not a reset that stopped working.
#[tokio::test]
async fn a_site_whose_program_may_be_native_still_resets_the_limit() {
    let _lock = LOCK.lock().await;
    let hard = raised_like_the_server();
    // `sh serve --hostname .. --port ..` runs `serve` from the cwd.
    let (dir, _) = staged("serve", SH_RECORDER);

    let serve = TokioProcessSpawner
        .spawn(SpawnRequest {
            command: "sh".to_string(),
            hostname: "127.0.0.1".to_string(),
            port: 9,
            ownership_id: format!("child-nofile-control-{}", std::process::id()),
            env: Vec::new(),
            pure: false,
            cwd: Some(dir.path().display().to_string()),
        })
        .expect("spawn the recorder as `opencode serve`");
    let recorded = recorded_limits(dir.path()).await;
    // Drop the handle only once the recorder has exited on its own.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while serve.exited().is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the recorder never exited"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drop(serve);

    assert_eq!(recorded, (ORIGINAL_SOFT, hard));
}
