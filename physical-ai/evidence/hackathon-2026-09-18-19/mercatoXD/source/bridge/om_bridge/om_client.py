"""REST client for the Open Mercato robotics module.

One API key, one cell. The key needs the `robotics.bridge.report` feature and
nothing else: the bridge claims work and reports outcomes, it never edits cells
or queues tasks of its own.
"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp

from .types import PickResult, PickStage, PickTask

log = logging.getLogger(__name__)


class OpenMercatoError(Exception):
    """The app refused a call, or is unreachable."""


class OpenMercatoClient:
    """Implements `types.TaskSink`."""

    def __init__(self, session: aiohttp.ClientSession, base_url: str, api_key: str, bridge_name: str = "bridge"):
        self._session = session
        self._base = base_url.rstrip("/")
        self._headers = {"x-api-key": api_key, "content-type": "application/json"}
        self.bridge_name = bridge_name

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base}{path}"
        try:
            async with self._session.post(url, json=payload, headers=self._headers) as res:
                body = await res.json(content_type=None)
                if res.status >= 400:
                    raise OpenMercatoError(f"{path} -> HTTP {res.status}: {body}")
                return body or {}
        except aiohttp.ClientError as exc:
            raise OpenMercatoError(f"{path} unreachable: {exc}") from exc

    async def claim(self, cell_id: str) -> PickTask | None:
        """Ask for the next queued task. `None` is the normal idle answer."""
        body = await self._post("/api/robotics/tasks/claim", {"cellId": cell_id, "bridge": self.bridge_name})
        payload = body.get("task")
        return PickTask.from_api(payload) if payload else None

    async def report(self, task_id: str, stage: PickStage, detail: str) -> None:
        await self._post(
            "/api/robotics/tasks/report",
            {"taskId": task_id, "stage": stage.value, "message": detail, "kind": "stage"},
        )

    async def finish(self, result: PickResult) -> None:
        await self._post(
            "/api/robotics/tasks/finish",
            {
                "taskId": result.task_id,
                "status": result.status.value,
                "detail": result.detail,
                "grasped": result.grasped,
                "payload": {"stage": result.stage.value, "attempts": result.attempts},
            },
        )
