"""Skill: test a regular expression against sample text."""

from __future__ import annotations

import re
from typing import Any


def execute(pattern: str = "", text: str = "", flags: str = "", limit: int = 20, **_kw: Any) -> dict[str, Any]:
    if not pattern:
        return {"error": "pattern is required"}

    flag_value = 0
    flag_text = str(flags or "").lower()
    if "i" in flag_text:
        flag_value |= re.IGNORECASE
    if "m" in flag_text:
        flag_value |= re.MULTILINE
    if "s" in flag_text:
        flag_value |= re.DOTALL

    try:
        max_matches = max(1, min(int(limit), 200))
    except (TypeError, ValueError):
        max_matches = 20

    try:
        regex = re.compile(pattern, flag_value)
    except re.error as exc:
        return {"valid": False, "error": str(exc)}

    matches = []
    for match in regex.finditer(str(text or "")):
        matches.append({
            "match": match.group(0),
            "span": list(match.span()),
            "groups": list(match.groups()),
            "groupdict": match.groupdict(),
        })
        if len(matches) >= max_matches:
            break

    return {
        "valid": True,
        "count": len(matches),
        "matches": matches,
        "truncated": len(matches) >= max_matches,
    }
