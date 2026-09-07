# Managed runtime image contract

Phase 1 deliberately does not route production coding agents through this
runtime yet. The live gate uses an **exact `sha256:` Docker image identity** and
bind-mounts only the compiled `freshell-session-host` binary plus one
incarnation-scoped runtime directory. The supervisor's restricted Docker broker
rejects floating images, extra mounts, networking, host PID namespace access,
privilege escalation, and management sockets.

A production runtime image will be pinned and built here in the later provider
integration phase. Do not replace the exact-image requirement with a tag at the
supervisor boundary.
