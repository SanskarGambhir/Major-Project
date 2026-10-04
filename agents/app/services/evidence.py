"""
Turning the server's raw evidence into the compact text blocks the prompts
quote (agentsfile.md §4). The server already demuxed the logs and collapsed
repeats; this file only formats.
"""

from __future__ import annotations

from datetime import datetime, timezone


def fmt_bytes(n: float | int) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.0f} GB"


def fmt_pct(n: float | int) -> str:
    return f"{float(n or 0):.0f}%"


def fmt_time(at: int | float | str) -> str:
    """Epoch ms (poller) or ISO string (database) → HH:MM:SS."""
    try:
        if isinstance(at, (int, float)):
            return datetime.fromtimestamp(at / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        if isinstance(at, str) and at:
            return datetime.fromisoformat(at.replace("Z", "+00:00")).strftime("%H:%M:%S")
    except (ValueError, OverflowError, OSError):
        pass
    return str(at)


def latest_reading(history: list[dict]) -> dict:
    return dict(history[-1]) if history else {}


def metrics_table(history: list[dict], limit: int = 12) -> str:
    """
    MEMORY / CPU over the recent window, oldest first, thinned to `limit` rows.

        10:31:14   112 MB / 256 MB  (44%)   cpu  3%   running
    """
    if not history:
        return "  (no metrics history supplied)"
    rows = history[-limit:] if len(history) <= limit else _thin(history, limit)
    lines = []
    for r in rows:
        mem = f"{fmt_bytes(r.get('mem_used', 0)):>7} / {fmt_bytes(r.get('mem_limit', 0)):<7} ({fmt_pct(r.get('mem_pct', 0))})"
        lines.append(
            f"  {fmt_time(r.get('at', 0))}   {mem:<24}  cpu {fmt_pct(r.get('cpu_pct', 0)):>4}   {r.get('status', '')}"
        )
    return "\n".join(lines)


def _thin(history: list[dict], limit: int) -> list[dict]:
    """Keep the first, the last, and evenly spaced samples in between."""
    step = (len(history) - 1) / (limit - 1)
    return [history[round(i * step)] for i in range(limit)]


def logs_block(logs: list[str], max_lines: int = 60) -> str:
    if not logs:
        return "  (no log lines supplied)"
    tail = logs[-max_lines:]
    return "\n".join(f"  {line}" for line in tail)


def container_block(info: dict) -> str:
    """Returns "" when the server sent nothing identifying (only Pydantic defaults)."""
    exit_code = info.get("exit_code", -1)
    limit = info.get("memory_limit", 0) or 0
    if not info.get("status") and exit_code == -1 and not limit:
        return ""
    fields = [
        ("status", info.get("status", "")),
        ("exit_code", exit_code if exit_code != -1 else ""),
        ("oom_killed", info.get("oom_killed", False)),
        ("memory_limit", fmt_bytes(limit) if limit else "unlimited"),
        ("restart_policy", info.get("restart_policy", "no")),
        ("started_at", info.get("started_at", "")),
        ("finished_at", info.get("finished_at", "")),
    ]
    return "\n".join(f"  {k}: {v}" for k, v in fields if v not in ("", None))


def similar_block(similar: list[str]) -> str:
    if not similar:
        return ""
    body = "\n".join(f"  {s}" for s in similar)
    return f"\nSIMILAR PAST INCIDENTS\n{body}\n"


def memory_at_death(history: list[dict], container_info: dict) -> str:
    """
    '98.2% of 256 MB' for the triage prompt. Uses the last reading that still
    had a number: once a container has exited the poller reports 0 bytes, and
    "0% of 256 MB" would hide the one fact triage most needs.
    """
    last = next((r for r in reversed(history) if float(r.get("mem_used", 0) or 0) > 0), None)
    if last is None:
        last = latest_reading(history)
    limit = last.get("mem_limit") or container_info.get("memory_limit") or 0
    if not last or not limit:
        return "unknown"
    return f"{float(last.get('mem_pct', 0)):.1f}% of {fmt_bytes(limit)}"


# -----------------------------------------------------------------------------
# RCA helpers — the incident_events timeline is what makes the report specific
# -----------------------------------------------------------------------------

def parse_ts(at: str | int | float) -> datetime | None:
    try:
        if isinstance(at, (int, float)):
            return datetime.fromtimestamp(at / 1000, tz=timezone.utc)
        if isinstance(at, str) and at:
            return datetime.fromisoformat(at.replace("Z", "+00:00"))
    except (ValueError, OverflowError, OSError):
        pass
    return None


def timeline_block(timeline: list[dict]) -> str:
    """
        10:32:16  DETECTED            monitor    Incident detected on demo-api: CONTAINER_OOM_KILLED
    """
    if not timeline:
        return "  (no timeline supplied)"
    return "\n".join(
        f"  {fmt_time(e.get('at', '')):8}  {str(e.get('status') or '(event)'):19} {str(e.get('actor') or ''):10} {e.get('message', '')}"
        for e in timeline
    )


def actions_block(actions: list[dict]) -> str:
    if not actions:
        return "  (no actions recorded)"
    lines = []
    for a in actions:
        result = a.get("result", "")
        extra = ""
        if a.get("policy_reason"):
            extra = f" — {a['policy_reason']}"
        elif a.get("started_at_before") and a.get("started_at_after"):
            extra = f" (StartedAt {a['started_at_before']} → {a['started_at_after']})"
        lines.append(f"  {a.get('action_type', '?')} on {a.get('target', '?')}: {result}{extra}")
    return "\n".join(lines)


def duration_text(seconds: float | None) -> str:
    if seconds is None:
        return "unknown"
    seconds = max(0, int(round(seconds)))
    if seconds < 60:
        return f"{seconds} seconds"
    m, s = divmod(seconds, 60)
    return f"{m}m {s:02d}s"


def recovery_seconds(incident: dict, timeline: list[dict]) -> float | None:
    """detected_at → resolved_at, from the incident row or, failing that, the timeline."""
    start = parse_ts(incident.get("detected_at", ""))
    end = parse_ts(incident.get("resolved_at", ""))
    if start is None or end is None:
        for e in timeline:
            t = parse_ts(e.get("at", ""))
            if t is None:
                continue
            if start is None and e.get("status") == "DETECTED":
                start = t
            if e.get("status") in ("RESOLVED", "AUTO_RESOLVED"):
                end = t
    if start is None or end is None:
        return None
    return (end - start).total_seconds()
