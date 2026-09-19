import pytest

from om_bridge.om_client import OpenMercatoClient, OpenMercatoError
from om_bridge.types import PickResult, PickStage, TaskStatus


class FakeResponse:
    def __init__(self, status: int, body):
        self.status = status
        self._body = body

    async def json(self, content_type=None):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSession:
    """Captures posts and replays queued responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.posts = []

    def post(self, url, json=None, headers=None):
        self.posts.append((url, json, headers))
        return self.responses.pop(0)


def client(responses):
    session = FakeSession(responses)
    return OpenMercatoClient(session, "https://erp.example/", "secret-key", "dgx/g05"), session


async def test_claim_sends_the_cell_and_bridge_identity():
    api, session = client([FakeResponse(200, {"task": None})])

    assert await api.claim("cell-1") is None
    url, payload, headers = session.posts[0]
    assert url == "https://erp.example/api/robotics/tasks/claim"
    assert payload == {"cellId": "cell-1", "bridge": "dgx/g05"}
    assert headers["x-api-key"] == "secret-key"


async def test_claim_parses_a_task_envelope():
    body = {"task": {"id": "t-9", "cellId": "cell-1", "instruction": "pick up the can", "dropPreset": "shelf_cans"}}
    api, _ = client([FakeResponse(200, body)])

    task = await api.claim("cell-1")

    assert task is not None
    assert (task.id, task.drop_preset) == ("t-9", "shelf_cans")


async def test_finish_posts_the_terminal_status_and_grasp_flag():
    api, session = client([FakeResponse(200, {})])
    result = PickResult("t-9", TaskStatus.SUCCEEDED, PickStage.DONE, "object held after lift", grasped=True)

    await api.finish(result)

    url, payload, _ = session.posts[0]
    assert url.endswith("/api/robotics/tasks/finish")
    assert payload["status"] == "succeeded"
    assert payload["grasped"] is True
    assert payload["payload"]["stage"] == "done"


async def test_http_error_is_raised_with_the_body():
    api, _ = client([FakeResponse(403, {"error": "Unauthorized"})])

    with pytest.raises(OpenMercatoError, match="403"):
        await api.claim("cell-1")
