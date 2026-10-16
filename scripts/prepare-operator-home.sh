#!/usr/bin/env bash
# Operator-home prep for soul home mounts (see docs/development/managed-runtime.md).
# Under the rootless Docker daemon, provider children run with gid 0, which maps
# to the operator's group — group bits are how in-home config `{file:}` references
# resolve in-soul. Idempotent; safe to re-run at any time. Run once at deploy, and
# re-run after any Amplifier key rotation.
set -euo pipefail
home="${FRESHELL_OPERATOR_HOME:-$HOME}"

have_targets=0
for root in "$home/.freshell" "$home/.amplifier" "$home/.config" "$home/.local"; do
  if [ -e "$root" ]; then
    have_targets=1
    break
  fi
done
if [ "$have_targets" -eq 0 ]; then
  echo "nothing to prepare"
  exit 0
fi

# runc cannot mount a tmpfs mask over a missing directory in the read-only bind;
# a soul created while a destination is absent gets that mask filtered for its
# whole lifetime. Creating them here means every home-bound incarnation mounts
# the full mask set. Run this at deploy, before new incarnations. Destinations
# WE create are control-plane: keep them owner-only regardless of umask.
for dir in "$home/.freshell" "$home/.amplifier/onecli" "$home/.config/gcloud"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    chmod 0700 "$dir"
    echo "mkdir -p $dir (mode 0700)"
  fi
done

# Group traversal for the home root and the ancestors of the covered roots that
# exist — a 0700 home root blocks the child from reaching even a prepared key.
for dir in "$home" "$home/.local" "$home/.config" "$home/.local/share"; do
  if [ -d "$dir" ]; then
    chmod g+rx "$dir"
    echo "chmod g+rx $dir"
  fi
done

# Group read for the secret-bearing root: dirs traversable, files readable
# (covers keys under ~/.amplifier regardless of naming) — EXCEPT the masked
# control-plane subtree. .amplifier/onecli is tmpfs-masked in souls and must
# NEVER gain group bits: a soul created before onecli existed has that mask
# filtered for its lifetime, so group-readable onecli content would be exposed
# to it through the live bind. The prune keeps the re-run from ever granting
# bits there, and the revoke below strips any bits an earlier prep (or a
# permissive umask) left behind, so a re-run can never expose a running soul.
find "$home/.amplifier" -path "$home/.amplifier/onecli" -prune -o -type d -exec chmod g+rx {} +
find "$home/.amplifier" -path "$home/.amplifier/onecli" -prune -o -type f -exec chmod g+r {} +
echo "chmod g+rx dirs and g+r files under $home/.amplifier (excluding .amplifier/onecli)"
if [ -d "$home/.amplifier/onecli" ]; then
  find "$home/.amplifier/onecli" -type d -exec chmod g-rx {} +
  find "$home/.amplifier/onecli" -type f -exec chmod g-r {} +
  echo "chmod g-rx dirs and g-r files under $home/.amplifier/onecli (control-plane stays owner-only)"
fi

echo "note: Amplifier must write keys 0640 and ~/.amplifier 0750 going forward so rotation preserves this (tracked upstream item)."
