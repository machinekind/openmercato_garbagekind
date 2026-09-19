"""Panel transport: MJPEG frame extraction and the WS read loop."""

import asyncio
import json

import aiohttp
import pytest

from om_bridge.panel import PanelArm, PanelError
from test_panel import FakeResponse, FakeSession, FakeWS


def arm(session=None):
    return PanelArm(session or FakeSession(), "http://10.42.0.1:8080/")


class FakeContent:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def iter_chunked(self, size):
        for chunk in self._chunks:
            yield chunk


class FakeStreamResponse(FakeResponse):
    def __init__(self, status, chunks):
        super().__init__(status, None)
        self.content = FakeContent(chunks)


class FakeWSMessage:
    def __init__(self, data):
        self.type = aiohttp.WSMsgType.TEXT
        self.data = data


class ReplayWS(FakeWS):
    """Yields a fixed list of WS payloads, then ends the loop."""

    def __init__(self, messages):
        super().__init__()
        self._messages = list(messages)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._messages:
            raise StopAsyncIteration
        return FakeWSMessage(self._messages.pop(0))


async def test_frame_extracts_the_first_jpeg_out_of_the_mjpeg_stream():
    boundary = b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
    session = FakeSession([FakeStreamResponse(200, [boundary, b"\xff\xd8body", b"\xff\xd9--frame"])])

    jpeg = await arm(session).frame("robot")

    assert jpeg.startswith(b"\xff\xd8") and jpeg.endswith(b"\xff\xd9")
    assert session.urls == ["http://10.42.0.1:8080/stream/robot"]


async def test_frame_surfaces_a_stream_error():
    session = FakeSession([FakeStreamResponse(404, [])])

    with pytest.raises(PanelError, match="HTTP 404"):
        await arm(session).frame("wrist")


async def test_frame_gives_up_when_the_stream_ends_without_a_full_jpeg():
    session = FakeSession([FakeStreamResponse(200, [b"\xff\xd8 half a frame"])])

    with pytest.raises(PanelError, match="ended before a full frame"):
        await arm(session).frame("robot")


async def test_read_loop_keeps_the_latest_state_and_answers_commands():
    panel = arm()
    panel._ws = ReplayWS(  # noqa: SLF001 - transport injected for the test
        [
            json.dumps({"type": "state", "q": [0.1] * 7, "engaged": True}),
            "not json at all",
            json.dumps({"type": "result", "cmd": "engage", "ok": True, "detail": "engaged"}),
        ]
    )
    pending = asyncio.get_running_loop().create_future()
    panel._pending["engage"] = pending  # noqa: SLF001

    await panel._read_loop()  # noqa: SLF001

    assert panel._state["q"] == [0.1] * 7  # noqa: SLF001
    assert pending.done() and pending.result()["ok"] is True


async def test_say_posts_a_status_line_to_the_panel_feed():
    session = FakeSession()

    await arm(session).say("Mercato: pick up the can")

    assert session.urls == ["http://10.42.0.1:8080/api/event"]
