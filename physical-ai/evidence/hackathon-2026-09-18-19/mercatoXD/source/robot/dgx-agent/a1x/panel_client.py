"""Outbound-only client for the laptop web panel (spec D/E).

Complete outbound protocol (the DGX never listens):
- WS ws://10.42.0.1:8080/ws — receives arm state @15 Hz and event
  broadcasts; sends preset/pantilt/chat command dicts.
- POST /api/event — pushes chat/status/alert/log lines.
- GET  /api/events?since=SEQ — poll fallback while the WS is down.
- GET  /api/presets, GET /api/state — REST reads.

Motion commands go over the WS so the panel's last-client-left
auto-disengage covers an agent crash. A motion send with no live WS
raises PanelError: it is never silently dropped.
"""

import asyncio
import collections
import json
import logging
import time
from typing import Any

import aiohttp

from . import config

log = logging.getLogger(__name__)


class PanelError(Exception):
    """A panel interaction failed (connection down or panel refused)."""


class PanelClient:
    def __init__(self, session: aiohttp.ClientSession):
        self._session = session
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self.latest_state: dict[str, Any] = {}
        self.state_t: float = 0.0
        self._state_changed = asyncio.Event()
        # Single event pipeline: WS broadcasts and poll-fallback results are
        # deduped by seq and delivered through this queue.
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        self._last_seq = 0
        # cmd name -> FIFO of futures awaiting that command's WS result
        # (the panel echoes "cmd" in every {"type":"result"} message).
        self._pending: dict[str, collections.deque] = {}

    # -- connection state -----------------------------------------------------

    @property
    def ws_connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    # -- WS receive loop ------------------------------------------------------

    async def run_ws(self) -> None:
        """Maintain the WS forever, with capped exponential backoff."""
        backoff = config.BACKOFF_INITIAL_S
        while True:
            try:
                async with self._session.ws_connect(
                        config.PANEL_WS_URL, heartbeat=10.0) as ws:
                    self._ws = ws
                    backoff = config.BACKOFF_INITIAL_S
                    log.info("panel WS: connected")
                    await self._resync_events()
                    await self._recv_loop(ws)
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, OSError) as exc:
                log.warning("panel WS: connect/recv error: %s", exc)
            finally:
                self._ws = None
                self._fail_pending("WS closed before result arrived")
            log.info("panel WS: down, reconnecting in %.1fs", backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, config.BACKOFF_MAX_S)

    async def _recv_loop(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type in (aiohttp.WSMsgType.CLOSED,
                                aiohttp.WSMsgType.ERROR):
                    break
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                log.warning("panel WS: non-JSON message dropped")
                continue
            if not isinstance(data, dict):
                continue
            # The panel sends exactly three message types: the 15 Hz
            # "state" snapshot, per-command "result" acks, and "event"
            # broadcasts. Never default an unknown type to state - a
            # result dict clobbering latest_state breaks wait_goal_reached
            # and pose reads at exactly the wrong moment.
            msg_type = data.get("type")
            if msg_type == "event":
                await self._deliver_event(data)
            elif msg_type == "state":
                self.latest_state = data
                self.state_t = time.time()
                self._state_changed.set()
                self._state_changed = asyncio.Event()
            elif msg_type == "result":
                self._resolve_result(data)
            else:
                log.warning("panel WS: unknown message type %r dropped",
                            msg_type)

    def _resolve_result(self, data: dict[str, Any]) -> None:
        """Route a {"type":"result"} ack to the oldest pending send_cmd."""
        queue = self._pending.get(str(data.get("cmd")))
        while queue:
            fut = queue.popleft()
            if not fut.done():
                fut.set_result((bool(data.get("ok")),
                                str(data.get("detail", ""))))
                return
        log.debug("panel WS: unmatched result dropped: %s", data)

    def _fail_pending(self, reason: str) -> None:
        for queue in self._pending.values():
            while queue:
                fut = queue.popleft()
                if not fut.done():
                    fut.set_result((False, reason))
        self._pending.clear()

    async def _resync_events(self) -> None:
        """On every WS (re)connect, read the whole event ring buffer once.

        A restarted panel resets its seq counter to 0 (Build 0 interface
        note): a buffer max below our _last_seq means restart, so accept
        the regressed numbering instead of going deaf to new events.
        """
        try:
            events = await self.get_events(0)
        except PanelError as exc:
            log.warning("event resync on connect failed: %s", exc)
            return
        seqs = [e["seq"] for e in events
                if isinstance(e, dict) and isinstance(e.get("seq"), int)]
        max_seq = max(seqs, default=0)
        if max_seq < self._last_seq:
            log.warning("panel restart detected (buffer max seq %d < last "
                        "seen %d); resetting seq tracking", max_seq,
                        self._last_seq)
            self._last_seq = 0
        for event in events:
            if isinstance(event, dict):
                await self._deliver_event(event)

    async def _deliver_event(self, event: dict[str, Any]) -> None:
        seq = event.get("seq")
        if isinstance(seq, int):
            if seq <= self._last_seq:
                return  # already seen (WS + poll overlap)
            self._last_seq = seq
        try:
            self.events.put_nowait(event)
        except asyncio.QueueFull:
            dropped = self.events.get_nowait()
            log.warning("event queue full, dropped seq=%s",
                        dropped.get("seq"))
            self.events.put_nowait(event)

    # -- state helpers --------------------------------------------------------

    async def wait_state(self, predicate, timeout: float) -> dict | None:
        """Wait until predicate(latest_state) is truthy. None on timeout."""
        deadline = time.monotonic() + timeout
        while True:
            state = self.latest_state
            if state and predicate(state):
                return state
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            waiter = self._state_changed
            try:
                await asyncio.wait_for(waiter.wait(),
                                       timeout=min(remaining, 0.5))
            except asyncio.TimeoutError:
                pass

    # -- WS command send ------------------------------------------------------

    RESULT_TIMEOUT_S = 5.0

    async def send_cmd(self, msg: dict[str, Any]) -> tuple[bool, str]:
        """Send a command dict over the WS and await the panel's
        per-command {"type":"result"} ack. Returns (ok, detail).

        Used for preset / pantilt / move_joints / chat. Motion failures
        must surface to the caller — never swallow them: a dead WS or a
        failed send raises PanelError; a command the panel REFUSED (e.g.
        "not engaged", "unknown preset") comes back as (False, detail).
        """
        ws = self._ws
        if ws is None or ws.closed:
            raise PanelError(f"WS down, cannot send cmd={msg.get('cmd')!r}")
        cmd = str(msg.get("cmd"))
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        queue = self._pending.setdefault(cmd, collections.deque())
        queue.append(fut)

        def _discard() -> None:
            try:
                queue.remove(fut)
            except ValueError:
                pass

        try:
            await ws.send_str(json.dumps(msg))
        except (aiohttp.ClientError, ConnectionError, OSError) as exc:
            _discard()
            raise PanelError(
                f"WS send failed for cmd={cmd!r}: {exc}") from exc
        try:
            return await asyncio.wait_for(fut, timeout=self.RESULT_TIMEOUT_S)
        except asyncio.TimeoutError:
            _discard()
            return False, f"no result from panel for cmd={cmd!r} (timeout)"

    # -- REST -----------------------------------------------------------------

    async def _get_json(self, path: str, params: dict | None = None) -> Any:
        url = config.PANEL_BASE_URL + path
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with self._session.get(url, params=params,
                                         timeout=timeout) as resp:
                if resp.status != 200:
                    raise PanelError(f"GET {path} -> HTTP {resp.status}")
                return await resp.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            raise PanelError(f"GET {path} failed: {exc}") from exc

    async def post_map(self, world_map: dict) -> None:
        """POST /api/map — best-effort push of the world map for the radar."""
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with self._session.post(
                    config.PANEL_BASE_URL + "/api/map",
                    json={"map": world_map}, timeout=timeout) as resp:
                if resp.status != 200:
                    log.warning("map push: panel said %d", resp.status)
        except (aiohttp.ClientError, OSError) as exc:
            log.warning("map push failed: %s", exc)

    async def post_event(self, kind: str, text: str,
                         sender: str = config.AGENT_NAME,
                         image_jpeg: bytes | None = None) -> int | None:
        """POST /api/event. Returns the assigned seq, or None on failure.

        Event pushes are best-effort (logged, never raised) — they carry
        no motion.
        """
        payload = {"from": sender, "kind": kind, "text": text[:2048]}
        if image_jpeg is not None:
            import base64
            b64 = base64.b64encode(image_jpeg).decode()
            payload["image"] = "data:image/jpeg;base64," + b64
        url = config.PANEL_BASE_URL + "/api/event"
        try:
            timeout = aiohttp.ClientTimeout(total=10)
            async with self._session.post(url, json=payload,
                                          timeout=timeout) as resp:
                body = await resp.json()
                if resp.status != 200 or not body.get("ok"):
                    log.error("post_event rejected: HTTP %d %s",
                              resp.status, body)
                    return None
                # Our own event echoes back over WS/poll with this seq;
                # the chat task filters it out by its "from" field.
                seq = body.get("seq")
                return seq if isinstance(seq, int) else None
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            log.error("post_event failed: %s", exc)
            return None

    async def get_events(self, since: int) -> list[dict[str, Any]]:
        body = await self._get_json("/api/events", params={"since": since})
        events = body.get("events", [])
        return events if isinstance(events, list) else []

    async def get_presets(self) -> dict[str, Any]:
        body = await self._get_json("/api/presets")
        presets = body.get("presets", {})
        return presets if isinstance(presets, dict) else {}

    async def get_state_rest(self) -> dict[str, Any]:
        body = await self._get_json("/api/state")
        return body if isinstance(body, dict) else {}

    # -- poll fallback --------------------------------------------------------

    async def run_event_poll_fallback(self) -> None:
        """Poll GET /api/events?since= while the WS is down (spec E)."""
        while True:
            await asyncio.sleep(config.EVENTS_POLL_INTERVAL_S)
            if self.ws_connected:
                continue
            try:
                events = await self.get_events(self._last_seq)
            except PanelError as exc:
                log.debug("event poll fallback failed: %s", exc)
                continue
            for event in events:
                if isinstance(event, dict):
                    await self._deliver_event(event)
