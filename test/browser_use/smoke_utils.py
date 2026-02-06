from __future__ import annotations

import datetime as _dt
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def now_iso_z() -> str:
  # Matches server logs: "2026-02-06T03:51:12.180Z"
  return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


_PIN0_LEVELS: Dict[str, int] = {
  "debug": 20,
  "info": 30,
  "warn": 40,
  "error": 50,
}


@dataclass(frozen=True)
class JsonLogger:
  min_level: str = "info"
  app: str = "freshell"
  component: str = "browser_use_smoke"
  env: str = "smoke"
  version: Optional[str] = None

  def _enabled(self, severity: str) -> bool:
    return _PIN0_LEVELS.get(severity, 30) >= _PIN0_LEVELS.get(self.min_level, 30)

  def log(self, severity: str, msg: str, **fields: object) -> None:
    if not self._enabled(severity):
      return

    level = _PIN0_LEVELS.get(severity, 30)
    payload: Dict[str, object] = {
      "level": level,
      "severity": severity,
      "time": now_iso_z(),
      "app": self.app,
      "env": self.env,
      "version": self.version,
      "component": self.component,
      "msg": msg,
      **fields,
    }
    # Drop None values to keep logs concise.
    payload = {k: v for k, v in payload.items() if v is not None}
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()

  def debug(self, msg: str, **fields: object) -> None:
    self.log("debug", msg, **fields)

  def info(self, msg: str, **fields: object) -> None:
    self.log("info", msg, **fields)

  def warn(self, msg: str, **fields: object) -> None:
    self.log("warn", msg, **fields)

  def error(self, msg: str, **fields: object) -> None:
    self.log("error", msg, **fields)


def redact_url(url: str) -> str:
  """
  Redact auth token query param from URLs to avoid leaking it in logs.
  """
  try:
    parts = urlsplit(url)
  except Exception:
    return url

  if not parts.query:
    return url

  q = []
  for k, v in parse_qsl(parts.query, keep_blank_values=True):
    if k == "token":
      q.append((k, "REDACTED"))
    else:
      q.append((k, v))
  return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))


def token_fingerprint(token: str) -> str:
  # Repo convention: first 8 ... last 8
  if len(token) <= 16:
    return f"{token[:4]}...{token[-4:]}"
  return f"{token[:8]}...{token[-8:]}"


def load_dotenv(path: Path) -> Dict[str, str]:
  """
  Minimal .env parser (KEY=VALUE, ignores comments/blank lines).
  Intentionally does not implement shell expansion/quotes.
  """
  if not path.exists():
    return {}

  out: Dict[str, str] = {}
  for raw in path.read_text(encoding="utf-8").splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
      continue
    if "=" not in line:
      continue
    k, v = line.split("=", 1)
    k = k.strip()
    v = v.strip()
    if not k:
      continue
    out[k] = v
  return out


def find_upwards(start_dir: Path, filename: str, max_depth: int = 12) -> Optional[Path]:
  cur = start_dir.resolve()
  for _ in range(max_depth + 1):
    candidate = cur / filename
    if candidate.exists():
      return candidate
    if cur.parent == cur:
      break
    cur = cur.parent
  return None


def env_or(default: Optional[str], *keys: str) -> Optional[str]:
  if default:
    return default
  for k in keys:
    v = os.environ.get(k)
    if v:
      return v
  return None


def default_base_url(dotenv: Dict[str, str]) -> str:
  # In dev, users typically run Vite on VITE_PORT and proxy /api + /ws to the backend.
  vite_port = (dotenv.get("VITE_PORT") or os.environ.get("VITE_PORT") or "5173").strip()
  return f"http://localhost:{vite_port}"


def build_target_url(base_url: str, token: str) -> str:
  base = base_url.rstrip("/")
  # freshell's client bootstraps `?token=...` into sessionStorage and then removes it from the URL.
  return f"{base}/?token={token}"


def monotonic_timer() -> tuple[float, callable[[], float]]:
  start = time.monotonic()

  def elapsed_s() -> float:
    return time.monotonic() - start

  return start, elapsed_s


def require(name: str, value: Optional[str]) -> str:
  if value:
    return value
  raise ValueError(f"Missing required setting: {name}")

