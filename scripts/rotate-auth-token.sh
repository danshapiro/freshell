#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

new_token="$(openssl rand -hex 32)"

tmp_file="$(mktemp)"
awk -v token="${new_token}" '
  BEGIN { updated = 0 }
  /^AUTH_TOKEN=/ {
    print "AUTH_TOKEN=" token
    updated = 1
    next
  }
  { print }
  END {
    if (!updated) {
      print "AUTH_TOKEN=" token
    }
  }
' "${ENV_FILE}" > "${tmp_file}"

mv "${tmp_file}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}" || true

echo "AUTH_TOKEN rotated in ${ENV_FILE}"
echo "Restart freshell to apply the new token."
