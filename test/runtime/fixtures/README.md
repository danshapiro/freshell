# Managed-runtime gate fixtures

Phase 1 fixtures are compiled into `freshell-session-host` so the live gate can
prove that execution occurs only after a durable execution grant. The fixture
modes are:

- `heartbeat`: repeatedly fsyncs a timestamped heartbeat into the incarnation directory.
- `descendant_spawner`: creates a worker, a new-session descendant, and a grandchild so container-wide cleanup is observable.
- `cpu_burner`: creates exactly four busy descendants; cgroup CPU quota is the bounding mechanism.
- `memory_allocator`: allocates and touches exactly 32 MiB, then holds it for measured-limit tests.
- `native_session`: serves create/resume/history over a private Unix socket and persists deterministic session history to disk; wrong-session resume fails closed.
- `security_probe`: records whether Docker/admin/registry authority or the host PID namespace leaked into the workload.

They do not contact coding-agent providers, do not use production provider
homes, and do not bind network ports. The native-session socket stays inside the
incarnation directory and exists only to make later recovery gates deterministic.
Phase 2 replaces these with hosted PTY and
provider integration while retaining these safety fixtures as regression tests.
