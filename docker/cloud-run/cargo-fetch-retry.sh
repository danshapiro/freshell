#!/bin/sh
set -u

attempt_limit=3
attempt=1

while [ "$attempt" -le "$attempt_limit" ]; do
  if cargo fetch --locked; then
    printf '{"severity":"info","event":"cloud_rust.cargo_fetch.succeeded","attempt":%s,"attemptLimit":%s}\n' \
      "$attempt" "$attempt_limit" >&2
    exit 0
  else
    cargo_status=$?
  fi

  if [ "$attempt" -eq "$attempt_limit" ]; then
    printf '{"severity":"error","event":"cloud_rust.cargo_fetch.exhausted","attempt":%s,"attemptLimit":%s,"exitCode":%s}\n' \
      "$attempt" "$attempt_limit" "$cargo_status" >&2
    exit "$cargo_status"
  fi

  backoff_seconds=$attempt
  printf '{"severity":"warn","event":"cloud_rust.cargo_fetch.retry","attempt":%s,"attemptLimit":%s,"exitCode":%s,"backoffSeconds":%s}\n' \
    "$attempt" "$attempt_limit" "$cargo_status" "$backoff_seconds" >&2
  sleep "$backoff_seconds"
  attempt=$((attempt + 1))
done

exit 1
