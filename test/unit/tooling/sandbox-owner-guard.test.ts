// @vitest-environment node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const exerciseJoin = String.raw`
import builtins, errno, json, runpy, sys, tempfile
from pathlib import Path
from unittest.mock import patch

guard = runpy.run_path(sys.argv[1])
scenario = json.loads(sys.argv[2])
with tempfile.TemporaryDirectory(prefix="sandbox-guard-join-") as directory:
    control = Path(directory)
    pid = 2147483647
    guard["record"](control, "owner-guard.json", {"pid": pid, "identity": "owned-birth"})
    if scenario["done"] is not None:
        guard["record"](control, "owner-guard.done", {"code": scenario["done"]})
    read_text = Path.read_text
    def disappearing_process(file, *args, **kwargs):
        if file == Path(f"/proc/{pid}/stat"):
            error = getattr(builtins, scenario["error"])
            number = errno.ESRCH if error is ProcessLookupError else errno.ENOENT if error is FileNotFoundError else errno.EACCES
            raise error(number, "fixture process stat read", str(file))
        return read_text(file, *args, **kwargs)
    with patch.object(Path, "read_text", disappearing_process):
        try:
            result = {"code": guard["join"](control)}
        except PermissionError:
            result = {"error": "PermissionError"}
    print(json.dumps(result))
`

describe('sandbox owner guard completion', () => {
  it.each([
    { error: 'ProcessLookupError', done: 0, expected: { code: 0 } },
    { error: 'ProcessLookupError', done: 1, expected: { code: 1 } },
    { error: 'ProcessLookupError', done: null, expected: { code: 1 } },
    { error: 'FileNotFoundError', done: 0, expected: { code: 0 } },
    { error: 'PermissionError', done: 0, expected: { error: 'PermissionError' } },
  ])('settles $error with completion $done', ({ error, done, expected }) => {
    const child = spawnSync('python3', ['-c', exerciseJoin,
      path.resolve('scripts/testing/sandbox-owner-guard.py'), JSON.stringify({ error, done })],
    { encoding: 'utf8', timeout: 10_000 })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual(expected)
  })
})
