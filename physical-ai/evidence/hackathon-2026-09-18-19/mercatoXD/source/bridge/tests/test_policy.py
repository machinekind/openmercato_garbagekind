import pytest

from om_bridge.policy import EMBODIMENT, G05Policy, PolicyError, PresetPolicy
from om_bridge.types import PickTask

TASK = PickTask(id="t", cell_id="c", instruction="pick up the can")
IMAGES = {"head_rgb": object(), "left_wrist_rgb": object()}


def test_observation_carries_the_runtime_keys_the_server_validates():
    obs = G05Policy("ws://x").build_observation(TASK, [0.1] * 6 + [-1.8], IMAGES)

    assert set(obs["images"]) == {"head_rgb", "left_wrist_rgb"}
    assert obs["state"]["left_arm"] == [0.1] * 6
    assert obs["state"]["left_gripper"] == [-1.8]
    assert obs["task"] == "pick up the can"
    assert obs["embodiment_type"] == EMBODIMENT


def test_absent_right_arm_is_sent_as_zeros_not_omitted():
    # The robot has no right arm, but the server requires the state keys.
    obs = G05Policy("ws://x").build_observation(TASK, [0.0] * 7, IMAGES)

    assert obs["state"]["right_arm"] == [0.0] * 6
    assert obs["state"]["right_gripper"] == [0.0]


def test_observation_without_the_wrist_camera_is_refused():
    with pytest.raises(PolicyError, match="left_wrist_rgb"):
        G05Policy("ws://x").build_observation(TASK, [0.0] * 7, {"head_rgb": object()})


def test_observation_needs_all_six_arm_joints():
    with pytest.raises(PolicyError, match="need 6 arm joints"):
        G05Policy("ws://x").build_observation(TASK, [0.0] * 3, IMAGES)


def test_pop_step_walks_the_cached_chunk_then_asks_for_a_new_observation():
    policy = G05Policy("ws://x")
    policy._chunk = [[0.0] * 6, [0.1] * 6]  # noqa: SLF001 - protocol state under test
    policy._need_obs = False  # noqa: SLF001

    assert policy.needs_observation is False
    assert policy.pop_step() == [0.0] * 6
    assert policy.pop_step() == [0.1] * 6
    assert policy.pop_step() is None
    assert policy.needs_observation is True


async def test_preset_policy_plans_no_joint_chunk():
    policy = PresetPolicy(["table", "home"])

    assert policy.is_scripted is True
    assert await policy.plan(TASK, {}) == []
