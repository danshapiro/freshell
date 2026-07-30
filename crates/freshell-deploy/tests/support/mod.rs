#![allow(dead_code)]

use std::path::{Path, PathBuf};

use freshell_deploy::{
    CandidateEvidence, DeployPort, DeploymentReadyReceipt, FileIdentity, ListenerIdentity,
    ProcessIdentity, RuntimeProvenance,
};

pub const PRIOR_ID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub const TARGET_ID: &str = "2222222222222222222222222222222222222222222222222222222222222222";
pub const FOREIGN_ID: &str = "3333333333333333333333333333333333333333333333333333333333333333";
pub const TRANSACTION_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
pub const NONCE: &str = "controller-nonce-0123456789";

pub fn generation_root(port: u16, id: &str) -> PathBuf {
    Path::new("/private/checkout/.freshell-deploy/ports")
        .join(port.to_string())
        .join("generations")
        .join(id)
}

pub fn stable_client(port: u16) -> PathBuf {
    Path::new("/private/checkout/.freshell-deploy/ports")
        .join(port.to_string())
        .join("current/client")
}

pub fn process_identity(id: &str, pid: u32, port: u16) -> ProcessIdentity {
    let root = generation_root(port, id);
    let runtime = |relative: &str| root.join(relative).display().to_string();
    ProcessIdentity {
        pid,
        kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
        start_time_ticks: format!("{}", 10_000_u64 + u64::from(pid)),
        executable: FileIdentity {
            device: "2049".to_string(),
            inode: format!("{}", 20_000_u64 + u64::from(pid)),
            sha256: if id == PRIOR_ID {
                "a".repeat(64)
            } else {
                "b".repeat(64)
            },
            mode: 0o555,
        },
        listener: ListenerIdentity {
            port: DeployPort::new(port).unwrap(),
            socket_inode: format!("{}", 30_000_u64 + u64::from(pid)),
            owner_pid: pid,
            network_namespace: "net:[4026533111]".to_string(),
        },
        cwd: root.display().to_string(),
        argv0: "freshell-server".to_string(),
        argument_count: 1,
        effective_uid: unsafe { libc::geteuid() },
        runtime: RuntimeProvenance {
            client_dir: stable_client(port).display().to_string(),
            extensions_dir: runtime("extensions"),
            dist_server_dir: runtime("dist/server"),
            mcp_entry: runtime("dist/server/mcp/server.js"),
            claude_sidecar_entry: runtime("claude-sidecar/index.mjs"),
            node_executable: "/usr/bin/node".to_string(),
            package_json: runtime("package.json"),
            package_lock: runtime("package-lock.json"),
            production_node_modules: runtime("node_modules"),
        },
    }
}

pub fn ready_receipt(id: &str, pid: u32, port: u16) -> DeploymentReadyReceipt {
    DeploymentReadyReceipt {
        schema_version: "1".to_string(),
        nonce: NONCE.to_string(),
        actual_address: format!("127.0.0.1:{port}"),
        pid,
        boot_id: "boot-11111111-2222-4333-8444-555555555555".to_string(),
        instance_id: "srv-11111111-2222-4333-8444-555555555555".to_string(),
        server_process_generation_id: id.to_string(),
        server_component_version: "0.7.0".to_string(),
        build_commit: "0123456789abcdef".to_string(),
    }
}

pub fn candidate(id: &str, pid: u32, port: u16) -> CandidateEvidence {
    CandidateEvidence {
        ready: ready_receipt(id, pid, port),
        process: process_identity(id, pid, port),
    }
}
