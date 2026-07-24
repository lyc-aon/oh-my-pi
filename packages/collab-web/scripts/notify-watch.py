#!/usr/bin/env python3
"""Notify on health transitions in the local Sentry collab control plane."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

HOME = Path("/Users/michaelkelly")
REGISTRY = HOME / ".local/state/sentry/collab-sessions.json"
SESSION_LINKS = HOME / ".local/state/sentry/sessions"
DEFAULT_LINK = HOME / "collab-room.link"
STATE = HOME / ".local/state/sentry/notify-watch.json"
NOTIFY = "/Users/michaelkelly/bin/notify-sentry"
VALID_ID = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
SERVICES = {"relay": 7466, "web": 7467}


def read_registry(path: Path | None = None) -> list[dict[str, Any]]:
    path = path or REGISTRY
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [
        item
        for item in data
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and VALID_ID.fullmatch(item["id"])
    ]


def lane_target(identifier: str) -> tuple[Path, str]:
    if identifier == "collab":
        return DEFAULT_LINK, "collab"
    return SESSION_LINKS / identifier / "room.link", f"collab-{identifier}"


def lane_health(
    lane: dict[str, Any],
    *,
    exists: Callable[[Path], bool] = Path.exists,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> bool | None:
    link, tmux_name = lane_target(lane["id"])
    if not exists(link):
        return None
    try:
        result = runner(
            ["tmux", "has-session", "-t", tmux_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def port_up(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def load_state(path: Path | None = None) -> dict[str, Any]:
    path = path or STATE
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def save_state(value: dict[str, Any], path: Path | None = None) -> None:
    path = path or STATE
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    handed_to_file = False
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as output:
            handed_to_file = True
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        if not handed_to_file:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def send(label: str, *, recovery: bool = False, runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> bool:
    arguments = [
        NOTIFY,
        "sentry-collab",
        "Sentry service recovered" if recovery else "Sentry service needs attention",
        "info" if recovery else "warning",
    ]
    try:
        result = runner(
            arguments,
            input=f"component: {label}\n".encode("utf-8"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def collect_health() -> dict[str, Any]:
    lanes: dict[str, bool] = {}
    for lane in read_registry():
        health = lane_health(lane)
        if health is not None:
            lanes[lane["id"]] = health
    return {
        "lanes": lanes,
        **{name: port_up(port) for name, port in SERVICES.items()},
    }


def transitions(previous: dict[str, Any], current: dict[str, Any]) -> list[tuple[str, bool]]:
    changes: list[tuple[str, bool]] = []
    previous_lanes = previous.get("lanes") if isinstance(previous.get("lanes"), dict) else {}
    current_lanes = current.get("lanes") if isinstance(current.get("lanes"), dict) else {}
    for identifier, healthy in current_lanes.items():
        if identifier in previous_lanes and previous_lanes[identifier] != healthy:
            changes.append((f"lane {identifier}", bool(healthy)))
    for service in SERVICES:
        before = previous.get(service)
        after = current.get(service)
        if isinstance(before, bool) and isinstance(after, bool) and before != after:
            changes.append((service, after))
    return changes


def main() -> int:
    previous = load_state()
    current = collect_health()
    if previous:
        for label, recovery in transitions(previous, current):
            if not send(label, recovery=recovery):
                return 1
    save_state(current)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
