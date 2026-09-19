"""Shared vocabulary between the Open Mercato module and the bridge.

The status names are the same strings the `robot_pick_task.status` column
stores, so a transition is one value moved across the wire, never a mapping.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Protocol


class TaskStatus(str, enum.Enum):
    QUEUED = "queued"
    CLAIMED = "claimed"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    ABORTED = "aborted"


TERMINAL_STATUSES = (TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.ABORTED)


class PickStage(str, enum.Enum):
    """Where inside one pick attempt we are; reported as telemetry."""

    ENGAGING = "engaging"
    SEARCHING = "searching"
    APPROACHING = "approaching"
    GRASPING = "grasping"
    LIFTING = "lifting"
    RETREATING = "retreating"
    DONE = "done"


@dataclass(frozen=True)
class PickTask:
    """One unit of work handed over by Open Mercato."""

    id: str
    cell_id: str
    instruction: str
    target_label: str = "can"
    drop_preset: str | None = None
    max_attempts: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def from_api(payload: dict[str, Any]) -> "PickTask":
        """Build from the module's JSON envelope; unknown fields are ignored."""
        missing = [k for k in ("id", "cellId", "instruction") if not payload.get(k)]
        if missing:
            raise ValueError(f"pick task payload missing {', '.join(missing)}")
        return PickTask(
            id=str(payload["id"]),
            cell_id=str(payload["cellId"]),
            instruction=str(payload["instruction"]),
            target_label=str(payload.get("targetLabel") or "can"),
            drop_preset=(str(payload["dropPreset"]) if payload.get("dropPreset") else None),
            max_attempts=int(payload.get("maxAttempts") or 1),
            metadata=dict(payload.get("metadata") or {}),
        )


@dataclass(frozen=True)
class PickResult:
    """Outcome of one pick attempt. Immutable: runners return a new one."""

    task_id: str
    status: TaskStatus
    stage: PickStage
    detail: str
    attempts: int = 1
    grasped: bool = False


class ArmTransport(Protocol):
    """What a pick needs from the web panel. Implemented by `panel.PanelArm`."""

    async def snapshot(self) -> dict[str, Any]: ...
    async def engage(self) -> None: ...
    async def disengage(self) -> None: ...
    async def goto_preset(self, name: str) -> None: ...
    async def set_goal(self, joints_rad: list[float]) -> None: ...
    async def set_grip(self, value: float) -> None: ...
    async def wait_goal_reached(self, timeout_s: float) -> bool: ...
    async def say(self, text: str) -> None: ...


class Policy(Protocol):
    """Produces the next joint target for a task. G0.5, or a scripted stub."""

    async def plan(self, task: PickTask, state: dict[str, Any]) -> list[list[float]]:
        """Return a chunk of absolute joint targets (radians), outermost first."""
        ...


class TaskSink(Protocol):
    """Where progress goes back to. Implemented by `om_client.OpenMercatoClient`."""

    async def claim(self, cell_id: str) -> PickTask | None: ...
    async def report(self, task_id: str, stage: PickStage, detail: str) -> None: ...
    async def finish(self, result: PickResult) -> None: ...
