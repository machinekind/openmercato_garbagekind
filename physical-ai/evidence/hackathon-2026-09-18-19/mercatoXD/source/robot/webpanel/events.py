"""Event bus shared by the browser chat and the DGX agent.

One monotonic sequence number per event, a bounded ring buffer for late
joiners and reconnects (GET /api/events?since=SEQ), and fan-out to the live
WebSocket clients. The agent dedupes by seq, so a WS broadcast and a poll
returning the same event is harmless.

Text and images are capped here: an event travels to every browser tab, so
an oversized payload from a misbehaving producer is a panel-wide problem.
"""
from __future__ import annotations

import asyncio
import collections
import time

BUFFER_SIZE = 200
MAX_TEXT = 2048
MAX_IMAGE_CHARS = 2 * 1024 * 1024      # base64 data URL, ~1.5 MB of JPEG
KINDS = ("chat", "status", "alert", "log")


class EventBus:
    def __init__(self, buffer_size: int = BUFFER_SIZE):
        self._events: collections.deque[dict] = collections.deque(
            maxlen=buffer_size)
        self._seq = 0
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=BUFFER_SIZE)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def since(self, seq: int) -> list[dict]:
        return [e for e in self._events if e["seq"] > seq]

    def publish(self, kind: str, sender: str, text: str,
                image: str | None = None) -> dict:
        """Append an event and fan it out. Returns the stored event."""
        if kind not in KINDS:
            kind = "log"
        self._seq += 1
        event = {"type": "event", "seq": self._seq, "kind": kind,
                 "from": sender[:64], "text": str(text)[:MAX_TEXT],
                 "t": time.time()}
        if image:
            event["image"] = image[:MAX_IMAGE_CHARS]
        self._events.append(event)
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # A stalled client must not block the bus: drop its oldest.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
        return event
