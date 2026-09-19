#!/usr/bin/env python3
"""Przełożenie dziennika ruchu SO-101 na fakty, które przyjmuje ERP.

Dziennik z `mcp_server.py` jest lokalny i nikt poza tą maszyną go nie widzi.
Epizod w ERP jest policzalny: wchodzi do bramy rolloutu, do liczby z warunku Z7
i do porównania z licznikiem lokalnym agenta. Ten moduł robi tłumaczenie i nic
poza tym — nie chodzi do sieci i nie zmienia dziennika.

Mapowanie jest jawne, bo każde takie przypisanie to decyzja dziedzinowa:

| `status` przejazdu | `outcome` epizodu | interwencja |
| --- | --- | --- |
| `reached` | `success` | brak |
| `timeout` | `timeout` | brak |
| `halted_on_load` | `aborted` | `abort` / `unsafe_motion` |

Zatrzymanie na przeciążeniu jest interwencją, bo maszyna przerwała zadanie
sama — to jest dokładnie ta klasa zdarzeń, której brama rolloutu pilnuje jako
`maxSevereRate`.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

TASK_KEY = "so101-random-pose"
MOTION_ACTIONS = ("random_pose", "return_home")
OUTCOME_BY_STATUS = {
    "reached": "success",
    "timeout": "timeout",
    "halted_on_load": "aborted",
}
INTERVENTION_BY_STATUS = {
    "halted_on_load": ("abort", "unsafe_motion"),
}


def read_journal(path: Path) -> Iterator[dict[str, Any]]:
    """Czyta dziennik NDJSON, pomijając wiersze uszkodzone zamiast przerywać eksport."""
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def external_ref(entry: dict[str, Any]) -> str:
    """Klucz idempotencji: ten sam przejazd wysłany dwa razy daje jeden rekord."""
    material = json.dumps(
        {
            "action": entry.get("action"),
            "observedAt": entry.get("observedAt"),
            "target": entry.get("targetPositionRaw"),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return f"so101-{hashlib.sha256(material.encode('utf-8')).hexdigest()[:32]}"


def _parse(moment: str) -> datetime:
    return datetime.fromisoformat(moment.replace("Z", "+00:00")).astimezone(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def episode_from_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Buduje ładunek `kind: episode` albo zwraca None, gdy wpis nie jest przejazdem."""
    if entry.get("action") not in MOTION_ACTIONS:
        return None
    status = entry.get("status")
    outcome = OUTCOME_BY_STATUS.get(status)
    observed_at = entry.get("observedAt")
    if outcome is None or not isinstance(observed_at, str):
        return None

    ended = _parse(observed_at)
    duration = float(entry.get("durationS") or 0.0)
    payload: dict[str, Any] = {
        "externalRef": external_ref(entry),
        "taskKey": TASK_KEY,
        "startedAt": _iso(ended - timedelta(seconds=duration)),
        "endedAt": _iso(ended),
        "outcome": outcome,
        "metrics": {
            "cycleTimeS": duration,
            "maxErrorDeg": entry.get("maxErrorDeg"),
            "deltaBudgetDeg": entry.get("deltaBudgetDeg"),
            "jointsMoved": len(entry.get("targetPositionRaw") or {}),
        },
    }
    halted = entry.get("haltedJoints") or []
    if halted:
        payload["outcomeDetail"] = f"Zatrzymanie na przeciążeniu: {', '.join(halted)}"
    return payload


def intervention_from_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Buduje ładunek `kind: intervention` dla przejazdów przerwanych przez maszynę."""
    mapping = INTERVENTION_BY_STATUS.get(entry.get("status"))
    observed_at = entry.get("observedAt")
    if mapping is None or not isinstance(observed_at, str):
        return None
    kind, reason_category = mapping
    halted = entry.get("haltedJoints") or []
    return {
        "kind": kind,
        "stage": "motion",
        "reasonCategory": reason_category,
        "reason": (
            "Sterownik przerwał przejazd po przekroczeniu progu obciążenia na stawach: "
            f"{', '.join(halted) if halted else 'nieokreślone'}."
        ),
        "occurredAt": _iso(_parse(observed_at)),
        "notes": f"Dziennik lokalny agenta, akcja {entry.get('action')}.",
    }
