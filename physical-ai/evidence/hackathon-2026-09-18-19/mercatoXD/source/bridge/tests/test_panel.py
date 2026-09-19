import asyncio
import json

import pytest

from om_bridge.panel import PanelArm, PanelError


class FakeWS:
    def __init__(self, closed=False):
        self.closed = closed
        self.sent = []

    async def send_str(self, payload):
        self.sent.append(json.loads(payload))


class FakeResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = body

    async def json(self, content_type=None):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    def __init__(self, gets=None):
        self.gets = list(gets or [])
        self.urls = []

    def get(self, url):
        self.urls.append(url)
        return self.gets.pop(0)

    def post(self, url, json=None):
        self.urls.append(url)
        return FakeResponse(200, {"ok": True})


def arm(session=None):
    return PanelArm(session or FakeSession(), "http://10.42.0.1:8080/")


def test_ws_url_is_the_panel_url_with_the_ws_scheme():
    assert arm().ws_url == "ws://10.42.0.1:8080/ws"


async def test_motion_without_a_live_socket_is_refused_not_dropped():
    # A motion command must never be silently swallowed.
    with pytest.raises(PanelError, match="no live WS"):
        await arm().set_goal([0.0] * 7)


async def test_command_result_resolves_the_pending_future():
    panel = arm()
    ws = FakeWS()
    panel._ws = ws  # noqa: SLF001 - transport injected for the test

    async def answer():
        await asyncio.sleep(0)
        fut = panel._pending["engage"]  # noqa: SLF001
        fut.set_result({"type": "result", "cmd": "engage", "ok": True, "detail": "engaged"})

    await asyncio.gather(panel.engage(), answer())
    assert ws.sent == [{"cmd": "engage"}]


async def test_a_refusal_from_the_panel_raises_with_its_detail():
    panel = arm()
    panel._ws = FakeWS()  # noqa: SLF001

    async def refuse():
        await asyncio.sleep(0)
        panel._pending["grip"].set_result(  # noqa: SLF001
            {"type": "result", "cmd": "grip", "ok": False, "detail": "grip: arm is not engaged"}
        )

    with pytest.raises(PanelError, match="arm is not engaged"):
        await asyncio.gather(panel.set_grip(0.6), refuse())


async def test_agent_role_is_refused_at_startup():
    # The agent role may not engage, set a goal or grip - fail fast instead of
    # discovering it mid-task.
    session = FakeSession([FakeResponse(200, {"role": "agent"})])
    with pytest.raises(PanelError, match="operator-only"):
        await arm(session).check_role()


async def test_operator_role_is_accepted():
    session = FakeSession([FakeResponse(200, {"role": "operator"})])
    assert await arm(session).check_role() == "operator"


async def test_snapshot_falls_back_to_rest_when_no_state_arrived():
    session = FakeSession([FakeResponse(200, {"q": [0.0] * 7, "engaged": False})])
    state = await arm(session).snapshot()

    assert state["q"] == [0.0] * 7
    assert session.urls == ["http://10.42.0.1:8080/api/state"]
