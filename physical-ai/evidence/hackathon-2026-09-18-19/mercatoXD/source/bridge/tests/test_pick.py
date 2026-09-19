import math

import pytest

from fakes import FakeArm, FakePolicy, FakeSink
from om_bridge.pick import GRIP_CLOSED, GRIP_OPEN, PickRunner, PickSettings
from om_bridge.types import PickStage, PickTask, TaskStatus

DEG = math.pi / 180.0
TASK = PickTask(id="t-1", cell_id="c-1", instruction="pick up the can")


def runner(arm, policy, sink, **kwargs):
    run = PickRunner(arm, policy, sink, PickSettings(goal_timeout_s=0.0, **kwargs))
    # The camera path needs cv2 and a real panel; the plan logic under test
    # does not, so the observation is stubbed out.
    async def _observe():
        return {"head_rgb": object(), "left_wrist_rgb": object()}

    run._observe = _observe  # noqa: SLF001 - deliberate seam for the test
    return run


async def test_successful_pick_reports_every_stage_and_disengages():
    # Arrange: the gripper stalls short of a full close under load -> holding.
    arm = FakeArm(grip={"measured": 0.01, "effort": 6.45})
    policy = FakePolicy([[[0.0, 10 * DEG, 0.0, 0.0, 0.0, 0.0]], []])
    sink = FakeSink()

    # Act
    result = await runner(arm, policy, sink).run(TASK)

    # Assert
    assert result.status is TaskStatus.SUCCEEDED
    assert result.grasped is True
    assert PickStage.ENGAGING in sink.stages and PickStage.DONE not in sink.stages
    assert ("disengage", None) in arm.calls


async def test_empty_gripper_fails_the_task():
    # A gripper that travels all the way to GRIP_CLOSED held nothing.
    arm = FakeArm(grip={"measured": GRIP_CLOSED, "effort": 0.1})
    result = await runner(arm, FakePolicy([[]]), FakeSink()).run(TASK)

    assert result.status is TaskStatus.FAILED
    assert result.stage is PickStage.GRASPING
    assert "nothing between the jaws" in result.detail


async def test_unsafe_plan_aborts_the_attempt_without_commanding_it():
    # 60 deg in one step is past MAX_STEP_DEG; nothing may be transmitted.
    arm = FakeArm()
    policy = FakePolicy([[[0.0, 60 * DEG, 0.0, 0.0, 0.0, 0.0]]])
    result = await runner(arm, policy, FakeSink()).run(TASK)

    assert result.status is TaskStatus.FAILED
    assert "unsafe plan" in result.detail
    assert not [call for call in arm.calls if call[0] == "goal"]


async def test_flat_plans_are_resampled_then_give_up():
    # The policy is stochastic and returns "hold still" chunks for the same
    # observation; those must not count as progress.
    arm = FakeArm(grip={"measured": 0.01, "effort": 6.45})
    flat = [[0.0] * 6]
    policy = FakePolicy([flat, flat, flat])
    sink = FakeSink()

    result = await runner(arm, policy, sink).run(TASK)

    assert result.status is TaskStatus.SUCCEEDED  # it still tries the grasp
    assert any("hold still" in detail for _, _, detail in sink.reports)
    # The only goal commanded is the post-grasp lift: no flat chunk was played.
    goals = [index for index, call in enumerate(arm.calls) if call[0] == "goal"]
    grip_close = max(i for i, call in enumerate(arm.calls) if call[0] == "grip")
    assert len(goals) == 1 and goals[0] > grip_close


async def test_gripper_is_opened_before_the_approach():
    arm = FakeArm(grip={"measured": 0.01, "effort": 6.45})
    await runner(arm, FakePolicy([[]]), FakeSink()).run(TASK)

    grips = [value for name, value in arm.calls if name == "grip"]
    assert grips[0] == pytest.approx(GRIP_OPEN)
    assert grips[-1] == pytest.approx(GRIP_CLOSED)


async def test_drop_preset_releases_the_object_there():
    arm = FakeArm(grip={"measured": 0.01, "effort": 6.45})
    task = PickTask(id="t-2", cell_id="c-1", instruction="pick up the can", drop_preset="shelf_cans")

    result = await runner(arm, FakePolicy([[]]), FakeSink()).run(task)

    assert result.status is TaskStatus.SUCCEEDED
    presets = [value for name, value in arm.calls if name == "preset"]
    assert presets[-1] == "shelf_cans"


async def test_arm_is_disengaged_even_when_a_stage_raises():
    class Exploding(FakePolicy):
        async def plan(self, task, state):
            raise RuntimeError("policy server died")

    arm = FakeArm()
    result = await runner(arm, Exploding([]), FakeSink()).run(TASK)

    assert result.status is TaskStatus.FAILED
    assert "policy server died" in result.detail
    assert ("disengage", None) in arm.calls
