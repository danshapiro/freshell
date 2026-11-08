path = "crates/freshell-freshagent/src/codex.rs"
s = open(path).read()
MARK_S = "<<<<<<< HEAD\n"
MARK_E = ">>>>>>> a17c27a3c (wip: z06a landing resolution checkpoint at 440bdbabe)\n"

out = []
i = 0
count = 0
while True:
    a = s.find(MARK_S, i)
    if a < 0:
        out.append(s[i:])
        break
    out.append(s[i:a])
    b = s.find("=======\n", a)
    c = s.find(MARK_E, b)
    head = s[a + len(MARK_S):b]
    kata = s[b + len("=======\n"):c]
    count += 1

    head_first = head.split("\n", 1)[0].strip()
    kata_first = kata.split("\n", 1)[0].strip()

    if "use std::collections::HashMap;" in head_first:
        chosen = ("use std::collections::{HashMap, HashSet};\n"
                  "use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};\n")
    elif "Per-session state of the wedged-sidecar quiet deadman" in head_first:
        chosen = head + kata
    elif "The configured wedged-sidecar quiet window" in head_first:
        chosen = head + kata
    elif head_first.startswith("let quiet_deadman = "):
        chosen = head + kata
    elif head_first.startswith("quiet_deadman.clone(),"):
        chosen = head + kata
    elif "fn codex_quiet_window_ms" in head:
        chosen = head + kata
    elif head_first.startswith("#[allow(clippy::too_many_arguments)]"):
        if "session-scoped wiring handed to a detached" in kata_first or "session-scoped wiring handed to a detached" in kata:
            chosen = kata  # kata's documented form
        else:
            chosen = head
    elif "A `freshAgent.kill` REQUESTS teardown via `kill_rx`" in head_first:
        chosen = kata  # kata's longer fenced/confirmed prose is the current truth
    elif head_first.startswith("quiet_deadman: Arc<StdMutex<QuietDeadman>>,"):
        # spawn_exit_watcher signature: union of the param lists; kata's bool return stays
        chosen = (head.rstrip("\n") + "\n"
                  + "    restart_lease_pins: Arc<TokioMutex<HashSet<String>>>,\n"
                  + "    runtime: freshell_protocol::RuntimeDescriptor,\n")
    elif head_first.startswith("_ = kill_rx => {"):
        chosen = (
            "            request = kill_rx => {\n"
            "                // Torn down on request -- the quiet deadman must never fire for a\n"
            "                // session that is going away (resolves a flagged stuck state).\n"
            "                disarm_codex_quiet(&quiet_deadman, &thread_id, \"kill\");\n"
            "                // Capture the ownership-tagged tree while the direct child and\n"
            "                // transport are still intact. The caller waits for this ack\n"
            "                // before closing the app-server client, preventing a YAMA\n"
            "                // reparent window.\n"
            "                let mut barrier = freshell_codex::transport::OwnedProcessTreeBarrier::capture(\n"
            "                    child.id().unwrap_or(0),\n"
            "                    CODEX_SIDECAR_OWNERSHIP_ENV,\n"
            "                    &ownership_id,\n"
            "                );\n"
            "                if let Ok(request) = request {\n"
            "                    let _ = request.captured.send(());\n"
            "                }\n"
            "                let tree_dead = barrier.terminate_and_confirm().await;\n"
            "                let child_reaped = matches!(\n"
            "                    tokio::time::timeout(Duration::from_secs(1), child.wait()).await,\n"
            "                    Ok(Ok(_))\n"
            "                );\n"
            "                if tree_dead && child_reaped {\n"
            "                    reap_owned_codex_sidecars(&ownership_id);\n"
            "                    crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);\n"
            "                    // Task 12: the bound session is gone -- reopen its durable id\n"
            "                    // (`handle_kill` also clears on quiescence; idempotent).\n"
            "                    // LB-04: UNLESS the session is parked in restart quarantine —\n"
            "                    // there the durable binding stays fail-closed until the\n"
            "                    // retirement's `Stopped` path releases it (`restart_lease_pins`\n"
            "                    // was set before the kill request reached this arm).\n"
            "                    if !restart_lease_pins.lock().await.contains(&thread_id) {\n"
            "                        leases.clear_binding(PROVIDER, &thread_id);\n"
            "                    }\n"
            "                    tracing::info!(provider = PROVIDER, session_id = %thread_id, \"freshagent.sidecar.reaped\");\n"
            "                    true\n"
            "                } else {\n"
            "                    tracing::error!(\n"
            "                        provider = PROVIDER,\n"
            "                        session_id = %thread_id,\n"
            "                        ownership_id,\n"
            "                        tree_dead,\n"
            "                        child_reaped,\n"
            "                        \"freshagent.codex.restart_shutdown_not_quiescent\"\n"
            "                    );\n"
            "                    false\n"
            "                }\n"
            "            }\n"
        )
    else:
        raise SystemExit(f"UNRESOLVED #{count}: HEAD={head_first!r} KATA={kata_first!r}")
    out.append(chosen)
    i = c + len(MARK_E)

open(path, "w").write("".join(out))
print("resolved", count)
