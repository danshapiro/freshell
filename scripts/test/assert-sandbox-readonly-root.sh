#!/usr/bin/env bash
# /home/sandbox belongs to sandbox and is outside the declared tmpfs and
# cache mounts. Permission denial under root-owned / would be a false positive.
set -euo pipefail

node <<'JS'
const fs = require('node:fs')
let probe
try {
  probe = fs.mkdtempSync('/home/sandbox/readonly-root-probe-')
} catch (error) {
  if (error.code !== 'EROFS') {
    console.error(`FAIL: root write failed with ${error.code}; expected EROFS`)
    process.exit(1)
  }
  console.log('PASS: sandbox root filesystem is read-only (EROFS)')
  process.exit(0)
}
fs.rmdirSync(probe)
console.error('FAIL: sandbox root filesystem is writable')
process.exitCode = 1
JS
