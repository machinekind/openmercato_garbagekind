"""One pick attempt, stage by stage.

The split of responsibility this file assumes:

* the panel owns the physical envelope (joint window, 30 deg/s slew, engage
  gate, auto-disengage) and is the single CAN writer;
* this runner owns the *task* envelope - how far one round may wander, when a
  flat plan is resampled, when to give up - and the grasp itself;
* the policy only proposes arm joint targets.

The grasp is scripted on purpose. `g05-base` zero-shot never emitted a
`left_gripper` action in any observed trial, so waiting for the model to close
the jaws would wait forever.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from . import safety
from .types import ArmTransport, PickResult, PickStage, PickTask, Policy, TaskSink, TaskStatus

log = logging.getLogger(__name__)

# Gripper travel in panel units. Negative opens; +0.6 is a full close on an
# empty gripper - closing on an object stops early under force limit, which is
# how a successful grasp is recognised.
GRIP_OPEN = -1.8
GRIP_CLOSED = 0.6
GRIP_EFFORT_HOLDING = 1.0
GRIP_SETTLE_S = 1.5


@dataclass(frozen=True)
class PickSettings:
    home_preset: str = "home"
    search_preset: str = "table"
    goal_timeout_s: float = 12.0
    max_rounds: int = 12
    max_flat_resamples: int = 3
    lift_deg: float = 10.0


class PickRunner:
    """Drives one task from engage to disengage and reports every transition."""

    def __init__(
        self,
        arm: ArmTransport,
        policy: Policy,
        sink: TaskSink,
        settings: PickSettings | None = None,
    ):
        self.arm = arm
        self.policy = policy
        self.sink = sink
        self.settings = settings or PickSettings()

    async def _say(self, task: PickTask, stage: PickStage, message: str) -> None:
        log.info("[%s] %s: %s", task.id, stage.value, message)
        await self.sink.report(task.id, stage, message)

    async def run(self, task: PickTask) -> PickResult:
        """Execute one attempt. Always disengages, including on failure."""
        grasped = False
        try:
            await self._engage(task)
            await self._search(task)
            await self._approach(task)
            grasped = await self._grasp(task)
            if not grasped:
                return PickResult(
                    task_id=task.id,
                    status=TaskStatus.FAILED,
                    stage=PickStage.GRASPING,
                    detail="gripper closed fully: nothing between the jaws",
                )
            await self._lift(task)
            await self._retreat(task)
            return PickResult(
                task_id=task.id,
                status=TaskStatus.SUCCEEDED,
                stage=PickStage.DONE,
                detail="object held after lift",
                grasped=True,
            )
        except safety.UnsafePlan as exc:
            return PickResult(task.id, TaskStatus.FAILED, PickStage.APPROACHING, f"unsafe plan: {exc}", grasped=grasped)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - the reason must reach the task record
            return PickResult(task.id, TaskStatus.FAILED, PickStage.APPROACHING, str(exc), grasped=grasped)
        finally:
            # Ceasing to transmit is the safe failure mode: an uncommanded arm
            # holds position. This runs on every path, including cancellation.
            try:
                await self.arm.disengage()
            except Exception:  # noqa: BLE001 - never mask the original failure
                log.exception("[%s] disengage failed", task.id)

    # -- stages ---------------------------------------------------------------

    async def _engage(self, task: PickTask) -> None:
        state = await self.arm.snapshot()
        q = [float(v) for v in state.get("q", [])]
        edges = safety.at_window_edge(q) if q else []
        if edges:
            # Engaging latches goal = clamp(measured); at a bound that is a
            # real move the operator did not ask for.
            await self._say(task, PickStage.ENGAGING, f"joints {edges} sit on a window bound; engaging will move the arm")
        await self.arm.engage()
        await self.arm.say(f"Mercato: {task.instruction}")
        await self._say(task, PickStage.ENGAGING, "engaged")

    async def _search(self, task: PickTask) -> None:
        await self.arm.goto_preset(self.settings.search_preset)
        reached = await self.arm.wait_goal_reached(self.settings.goal_timeout_s)
        await self.arm.set_grip(GRIP_OPEN)
        await self._say(
            task,
            PickStage.SEARCHING,
            f"at preset {self.settings.search_preset}" + ("" if reached else " (goal not confirmed)"),
        )

    async def _approach(self, task: PickTask) -> None:
        """Walk the policy's plan toward the target, one bounded round at a time."""
        if getattr(self.policy, "is_scripted", False):
            await self._say(task, PickStage.APPROACHING, "scripted policy: no joint plan, holding at the search pose")
            return

        for round_index in range(self.settings.max_rounds):
            start = [float(v) for v in (await self.arm.snapshot()).get("q", [])]
            chunk = await self._plan_with_resample(task, start)
            if chunk is None:
                await self._say(task, PickStage.APPROACHING, f"round {round_index}: policy kept planning to hold still")
                return

            moved_deg = 0.0
            for step in chunk:
                measured = [float(v) for v in (await self.arm.snapshot()).get("q", [])]
                target = safety.clip_to_window(step)
                if not safety.is_motion(target, measured):
                    continue
                safety.check_step(target, measured)
                safety.check_total(target, start)
                # The panel's goal vector is full width; the policy plans arm
                # joints only, so the gripper channel keeps its measured value.
                await self.arm.set_goal(target + measured[len(target) :])
                await self.arm.wait_goal_reached(self.settings.goal_timeout_s)
                moved_deg = max(moved_deg, safety.max_joint_delta_deg(target, start))

            stuck = safety.at_window_edge([float(v) for v in (await self.arm.snapshot()).get("q", [])])
            await self._say(
                task,
                PickStage.APPROACHING,
                f"round {round_index}: moved {moved_deg:.1f} deg" + (f", joints {stuck} at a window bound" if stuck else ""),
            )
            if moved_deg < safety.MIN_MOTION_DEG:
                return

    async def _plan_with_resample(self, task: PickTask, measured: list[float]) -> list[list[float]] | None:
        """Ask for a plan, rejecting flat chunks - the policy is stochastic."""
        images = await self._observe()
        for _ in range(self.settings.max_flat_resamples):
            chunk = await self.policy.plan(task, {"joints": measured, "images": images})
            if any(safety.is_motion(safety.clip_to_window(step), measured) for step in chunk):
                return chunk
        return None

    async def _observe(self) -> dict[str, object]:
        """Fetch the camera frames the policy needs, already RGB CHW uint8."""
        from .vision import fetch_observation_images  # noqa: PLC0415 - numpy/cv2 only here

        return await fetch_observation_images(self.arm)

    async def _grasp(self, task: PickTask) -> bool:
        """Close the jaws and decide from the force whether anything is held."""
        await self._say(task, PickStage.GRASPING, "closing gripper")
        await self.arm.set_grip(GRIP_CLOSED)
        await asyncio.sleep(GRIP_SETTLE_S)

        state = await self.arm.snapshot()
        grip = state.get("grip") or {}
        measured = float(grip.get("measured", GRIP_CLOSED))
        effort = abs(float(grip.get("effort", 0.0)))
        # An empty gripper travels all the way to GRIP_CLOSED; one holding a can
        # stalls short of it under force limit.
        held = effort >= GRIP_EFFORT_HOLDING and measured < GRIP_CLOSED - 0.05
        await self._say(
            task,
            PickStage.GRASPING,
            f"grip pos {measured:.3f}, effort {effort:.2f} -> {'holding' if held else 'empty'}",
        )
        return held

    async def _lift(self, task: PickTask) -> None:
        state = await self.arm.snapshot()
        q = [float(v) for v in state.get("q", [])]
        target = list(q)
        # J2 is the shoulder; lifting is a bounded nudge, not a preset jump, so
        # the object stays over the spot it was picked from.
        target[1] = q[1] + self.settings.lift_deg / safety.DEG
        target = safety.clip_to_window(target)
        safety.check_step(target, q)
        await self.arm.set_goal(target)
        await self.arm.wait_goal_reached(self.settings.goal_timeout_s)
        await self._say(task, PickStage.LIFTING, f"lifted {self.settings.lift_deg:.0f} deg at the shoulder")

    async def _retreat(self, task: PickTask) -> None:
        if task.drop_preset:
            await self.arm.goto_preset(task.drop_preset)
            await self.arm.wait_goal_reached(self.settings.goal_timeout_s)
            await self.arm.set_grip(GRIP_OPEN)
            await self._say(task, PickStage.RETREATING, f"released at preset {task.drop_preset}")
            return
        await self.arm.goto_preset(self.settings.home_preset)
        await self.arm.wait_goal_reached(self.settings.goal_timeout_s)
        await self._say(task, PickStage.RETREATING, f"holding the object at preset {self.settings.home_preset}")
