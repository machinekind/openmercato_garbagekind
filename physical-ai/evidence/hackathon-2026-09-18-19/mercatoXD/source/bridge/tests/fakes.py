"""In-memory stand-ins for the arm, the policy and Open Mercato."""
from __future__ import annotations

from typing import Any

from om_bridge.types import PickResult, PickStage, PickTask


class FakeArm:
    """Records every call and answers from a scripted state."""

    def __init__(self, q: list[float] | None = None, grip: dict[str, float] | None = None):
        self.q = list(q if q is not None else [0.0] * 7)
        self.grip = dict(grip or {"measured": 0.6, "effort": 0.0})
        self.calls: list[tuple[str, Any]] = []
        self.engaged = False
        self.goal_reached = True

    async def snapshot(self) -> dict[str, Any]:
        return {"q": list(self.q), "engaged": self.engaged, "grip": dict(self.grip), "goal_reached": self.goal_reached}

    async def engage(self) -> None:
        self.engaged = True
        self.calls.append(("engage", None))

    async def disengage(self) -> None:
        self.engaged = False
        self.calls.append(("disengage", None))

    async def goto_preset(self, name: str) -> None:
        self.calls.append(("preset", name))

    async def set_goal(self, joints_rad: list[float]) -> None:
        self.calls.append(("goal", list(joints_rad)))
        self.q = list(joints_rad) + self.q[len(joints_rad) :]

    async def set_grip(self, value: float) -> None:
        # Records the command only: what the jaws actually did is scripted by
        # the test through the `grip` state, the way the real arm reports it.
        self.calls.append(("grip", value))

    async def wait_goal_reached(self, timeout_s: float = 0.0) -> bool:
        return self.goal_reached

    async def say(self, text: str) -> None:
        self.calls.append(("say", text))

    async def frame(self, camera: str) -> bytes:
        return b"\xff\xd8\xff\xd9"


class FakePolicy:
    """Replays fixed chunks; `is_scripted=False` so the runner plans."""

    is_scripted = False

    def __init__(self, chunks: list[list[list[float]]]):
        self.chunks = list(chunks)
        self.observations: list[dict[str, Any]] = []

    async def plan(self, task: PickTask, state: dict[str, Any]) -> list[list[float]]:
        self.observations.append(state)
        return self.chunks.pop(0) if self.chunks else []


class FakeSink:
    """Collects the progress a runner reports."""

    def __init__(self, tasks: list[PickTask] | None = None):
        self.queue = list(tasks or [])
        self.reports: list[tuple[str, PickStage, str]] = []
        self.finished: list[PickResult] = []

    async def claim(self, cell_id: str) -> PickTask | None:
        return self.queue.pop(0) if self.queue else None

    async def report(self, task_id: str, stage: PickStage, detail: str) -> None:
        self.reports.append((task_id, stage, detail))

    async def finish(self, result: PickResult) -> None:
        self.finished.append(result)

    @property
    def stages(self) -> list[PickStage]:
        return [stage for _, stage, _ in self.reports]
