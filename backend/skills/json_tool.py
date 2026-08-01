"""Skill: validate, format, minify, or query JSON content."""

from __future__ import annotations

import json
from typing import Any


def _get_path(data: Any, path: str) -> Any:
    current = data
    for raw_part in path.replace("[", ".").replace("]", "").split("."):
      part = raw_part.strip()
      if not part:
          continue
      if isinstance(current, list):
          current = current[int(part)]
      elif isinstance(current, dict):
          current = current[part]
      else:
          raise KeyError(part)
    return current


def execute(text: str = "", mode: str = "format", path: str = "", indent: int = 2, **_kw: Any) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        return {"valid": False, "error": "text is required"}

    try:
        data = json.loads(raw)
    except Exception as exc:
        return {"valid": False, "error": str(exc)}

    action = str(mode or "format").strip().lower()
    try:
        spaces = max(0, min(int(indent), 8))
    except (TypeError, ValueError):
        spaces = 2

    if action == "minify":
        output = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    elif action == "path":
        try:
            value = _get_path(data, path)
            output = json.dumps(value, ensure_ascii=False, indent=spaces)
        except Exception as exc:
            return {"valid": True, "error": f"path not found: {exc}"}
    else:
        output = json.dumps(data, ensure_ascii=False, indent=spaces)

    return {
        "valid": True,
        "mode": action,
        "output": output,
        "type": type(data).__name__,
    }
