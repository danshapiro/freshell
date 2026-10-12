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
# the full mask set. Run this at deploy, before new incarnations.
for dir in "$home/.freshell" "$home/.amplifier/onecli" "$home/.config/gcloud"; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    echo "mkdir -p $dir"
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

# Whole-tree group read for the secret-bearing root: dirs traversable, files
# readable (covers keys under ~/.amplifier regardless of naming).
find "$home/.amplifier" -type d -exec chmod g+rx {} +
find "$home/.amplifier" -type f -exec chmod g+r {} +
echo "chmod g+rx dirs and g+r files under $home/.amplifier"

echo "note: Amplifier must write keys 0640 and ~/.amplifier 0750 going forward so rotation preserves this (tracked upstream item)."
