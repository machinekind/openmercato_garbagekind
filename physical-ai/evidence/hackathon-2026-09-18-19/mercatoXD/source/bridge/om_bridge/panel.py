"""Web-panel transport: the only thing in this repo that moves an arm.

Motion goes over the panel's WebSocket, never REST. That is the panel's rule,
and it is load-bearing: the panel auto-disengages when its last operator
connection drops, so a mover that holds a live socket is covered by that
failsafe and a stateless HTTP caller is not.

Role matters. The panel decides role by peer address: anything inside its
`--agent-net` (the direct DGX cable, 10.42.0.0/24 by default) is the *agent*
and may only send chat/preset/pantilt/move_joints, and only while the operator
has ticked "agent may move the arm". `engage`, `goal`, `grip` and `stop` are
operator-only. A bridge that needs to grasp therefore has to connect from the
operator side; `PanelArm.check_role()` fails fast when it does not.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import aiohttp

log = logging.getLogger(__name__)

STATE_STALE_S = 2.0


class PanelError(Exception):
    """The panel refused a command, or the link to it is down."""


class PanelArm:
    """Implements `types.ArmTransport` against one web panel."""

    def __init__(self, session: aiohttp.ClientSession, base_url: str, goal_timeout_s: float = 12.0):
        self._session = session
        self._base = base_url.rstrip("/")
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._state: dict[str, Any] = {}
        self._state_t = 0.0
        self._state_changed = asyncio.Event()
        self._pending: dict[str, asyncio.Future] = {}
        self._reader: asyncio.Task | None = None
        self.goal_timeout_s = goal_timeout_s

    # -- lifecycle ------------------------------------------------------------

    @property
    def ws_url(self) -> str:
        return self._base.replace("http://", "ws://").replace("https://", "wss://") + "/ws"

    async def connect(self) -> None:
        """Open the WS and start draining it. Idempotent."""
        if self._ws is not None and not self._ws.closed:
            return
        self._ws = await self._session.ws_connect(self.ws_url, heartbeat=10.0)
        self._reader = asyncio.create_task(self._read_loop())
        log.info("panel: connected to %s", self.ws_url)

    async def close(self) -> None:
        """Disengage and drop the socket. Safe to call twice."""
        try:
            if self._ws is not None and not self._ws.closed:
                await self.disengage()
        except PanelError:
            log.warning("panel: disengage on close failed; dropping the socket anyway")
        finally:
            if self._reader is not None:
                self._reader.cancel()
                self._reader = None
            if self._ws is not None:
                await self._ws.close()
                self._ws = None

    async def _read_loop(self) -> None:
        assert self._ws is not None
        async for msg in self._ws:
            if msg.type is not aiohttp.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            kind = data.get("type")
            if kind == "state":
                self._state = data
                self._state_t = time.monotonic()
                self._state_changed.set()
                self._state_changed.clear()
            elif kind == "result":
                fut = self._pending.pop(str(data.get("cmd")), None)
                if fut is not None and not fut.done():
                    fut.set_result(data)

    # -- commands -------------------------------------------------------------

    async def _send(self, cmd: str, **fields: Any) -> dict[str, Any]:
        """Send one command and wait for the panel's result for it."""
        if self._ws is None or self._ws.closed:
            raise PanelError(f"{cmd}: no live WS to the panel (motion is never sent blind)")
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[cmd] = fut
        await self._ws.send_str(json.dumps({"cmd": cmd, **fields}))
        try:
            result = await asyncio.wait_for(fut, timeout=10.0)
        except asyncio.TimeoutError as exc:
            self._pending.pop(cmd, None)
            raise PanelError(f"{cmd}: panel did not answer in 10 s") from exc
        if not result.get("ok", False):
            raise PanelError(f"{cmd}: {result.get('detail', 'refused')}")
        return result

    async def snapshot(self) -> dict[str, Any]:
        """Latest arm state. Raises when the feed went stale."""
        if not self._state or (time.monotonic() - self._state_t) > STATE_STALE_S:
            async with self._session.get(f"{self._base}/api/state") as res:
                if res.status != 200:
                    raise PanelError(f"GET /api/state -> HTTP {res.status}")
                self._state = await res.json()
                self._state_t = time.monotonic()
        return self._state

    async def check_role(self) -> str:
        """Refuse to start as the agent role: it may not engage or grip."""
        async with self._session.get(f"{self._base}/health") as res:
            health = await res.json()
        role = str(health.get("role", "unknown"))
        if role != "operator":
            raise PanelError(
                f"bridge connected as role {role!r}; engage/goal/grip are operator-only. "
                "Run the bridge outside the panel's --agent-net, or widen that net's exclusion."
            )
        return role

    async def engage(self) -> None:
        """Latch the target to the measured pose and start transmitting.

        Engaging moves the arm when its rest pose sits outside the safety
        window: the panel latches goal = clamp(measured). Check the pose is
        inside the window before calling this near a bound.
        """
        await self._send("engage")

    async def disengage(self) -> None:
        await self._send("disengage")

    async def stop(self) -> None:
        await self._send("stop")

    async def goto_preset(self, name: str) -> None:
        await self._send("preset", name=name)

    async def set_goal(self, joints_rad: list[float]) -> None:
        await self._send("goal", joints=list(joints_rad))

    async def set_grip(self, value: float) -> None:
        """Gripper travel. Negative opens, positive closes (panel units)."""
        await self._send("grip", value=float(value))

    async def grip_probe(self) -> None:
        """Wake a deaf gripper (nudge, then the FF 1->5->6 recovery)."""
        await self._send("grip_probe")

    async def say(self, text: str) -> None:
        """Put a line in the panel's chat, so the operator sees the order."""
        async with self._session.post(
            f"{self._base}/api/event",
            json={"from": "mercato-bridge", "kind": "status", "text": text},
        ) as res:
            if res.status != 200:
                raise PanelError(f"POST /api/event -> HTTP {res.status}")

    async def wait_goal_reached(self, timeout_s: float | None = None) -> bool:
        """Wait until the panel reports the goal reached, or time out."""
        deadline = time.monotonic() + (timeout_s if timeout_s is not None else self.goal_timeout_s)
        while time.monotonic() < deadline:
            state = await self.snapshot()
            if state.get("goal_reached") and not state.get("moving"):
                return True
            try:
                await asyncio.wait_for(self._state_changed.wait(), timeout=0.2)
            except asyncio.TimeoutError:
                pass
        return False

    async def frame(self, camera: str) -> bytes:
        """One JPEG off a panel camera stream (multipart MJPEG, first part)."""
        async with self._session.get(f"{self._base}/stream/{camera}") as res:
            if res.status != 200:
                raise PanelError(f"GET /stream/{camera} -> HTTP {res.status}")
            buf = bytearray()
            async for chunk in res.content.iter_chunked(8192):
                buf.extend(chunk)
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if start >= 0 and end > start:
                    return bytes(buf[start : end + 2])
                if len(buf) > 4_000_000:
                    raise PanelError(f"/stream/{camera}: no JPEG in the first 4 MB")
        raise PanelError(f"/stream/{camera}: stream ended before a full frame")
