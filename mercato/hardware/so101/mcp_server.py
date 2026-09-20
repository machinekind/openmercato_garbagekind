#!/usr/bin/env python3
"""Serwer MCP do demonstracji ruchu SO-101.

Udostępnia cztery narzędzia: odczyt stanu, załączenie momentu, przejazd do
pozy losowej i zwolnienie momentu. Każde wywołanie ruchowe wymaga jawnego
`confirm=true`, bo skutek jest fizyczny.

Uruchomienie (stdio):

    SO101_PORT=/dev/ttyACM0 python3 mercato/hardware/so101/mcp_server.py

Serwer **nie zmienia stanu momentu przy zamknięciu procesu**. Zamknięcie okna
nie jest zatrzymaniem maszyny; deterministyczną warstwą pozostaje przerywacz
zasilania napędów.
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp.server.fastmcp import FastMCP  # noqa: E402

from arm_control import DEMO_DELTA_DEG, DEMO_JOINTS, ArmSession  # noqa: E402

DEFAULT_PORT = os.environ.get("SO101_PORT", "/dev/ttyACM0")
JOURNAL_PATH = Path(
    os.environ.get("SO101_MOTION_JOURNAL", ".runtime/so101-motion/journal.ndjson")
)

NOT_AN_ESTOP = (
    "Zwolnienie momentu przez MCP nie jest E-stopem: idzie tą samą magistralą "
    "i tym samym procesem. Fizyczny przerywacz zasilania musi być w zasięgu ręki."
)

server = FastMCP("so101-arm")
_session: ArmSession | None = None


def session() -> ArmSession:
    global _session
    if _session is None:
        created = ArmSession(DEFAULT_PORT)
        created.connect()
        _session = created
    return _session


def journal(action: str, result: dict[str, Any]) -> dict[str, Any]:
    """Dopisuje wynik do dziennika poza Git; brak dziennika nie blokuje operacji."""
    entry = {"action": action, **result}
    try:
        JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        with JOURNAL_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        entry["journalError"] = f"{type(exc).__name__}: {exc}"
    return entry


def refuse_unconfirmed(action: str) -> dict[str, Any]:
    return {
        "status": "refused",
        "reason": f"{action} wymaga confirm=true - skutek jest fizyczny",
        "checklist": [
            "przestrzeń robocza pusta",
            "ramię podparte",
            "wyłącznik zasilacza w zasięgu ręki",
        ],
    }


@server.tool()
def so101_status() -> dict[str, Any]:
    """Odczytuje stan sześciu serw: pozycja, moment, napięcie, temperatura, obciążenie.

    Nic nie zapisuje do serw i nie rusza ramieniem.
    """
    return session().read_state()


@server.tool()
def so101_enable(confirm: bool = False) -> dict[str, Any]:
    """Załącza moment na sześciu stawach z utrzymaniem pozycji zadanej równej bieżącej.

    Ramię pozostanie w obecnej pozie, ale **będzie pod napięciem napędów**.
    Wymaga confirm=true.
    """
    if not confirm:
        return refuse_unconfirmed("so101_enable")
    return journal("enable", session().enable())


@server.tool()
def so101_random_pose(
    confirm: bool = False,
    joints: list[str] | None = None,
    delta_deg: float = DEMO_DELTA_DEG,
    seed: int | None = None,
) -> dict[str, Any]:
    """Jedzie do pozy losowej w okienku limitów EEPROM, z ograniczonym przyrostem na ruch.

    Domyślnie rusza tylko dwoma pierwszymi stawami (shoulder_pan, shoulder_lift)
    o nie więcej niż `delta_deg`. Wymaga wcześniejszego so101_enable i confirm=true.
    """
    if not confirm:
        return refuse_unconfirmed("so101_random_pose")
    generator = random.Random(seed) if seed is not None else random.Random()
    selected = joints if joints else list(DEMO_JOINTS)
    return journal(
        "random_pose",
        session().move_random(rng=generator, joints=selected, delta_deg=delta_deg),
    )


@server.tool()
def so101_return_home(confirm: bool = False) -> dict[str, Any]:
    """Wraca do pozy zastanej z chwili so101_enable, bez zwalniania momentu.

    Wymaga confirm=true. Ramię się poruszy.
    """
    if not confirm:
        return refuse_unconfirmed("so101_return_home")
    return journal("return_home", session().return_home())


@server.tool()
def so101_release(confirm: bool = False, return_home: bool = True) -> dict[str, Any]:
    """Wraca do pozy zastanej z chwili so101_enable, potem zwalnia moment.

    Z `return_home=false` zwalnia moment od razu w bieżącej pozie - wtedy ramię
    opadnie pod własnym ciężarem. To nie jest E-stop. Wymaga confirm=true.
    """
    if not confirm:
        return refuse_unconfirmed("so101_release")
    result = session().release(return_home=return_home)
    result["warning"] = NOT_AN_ESTOP
    return journal("release", result)


if __name__ == "__main__":
    try:
        server.run()
    finally:
        if _session is not None:
            _session.close()
