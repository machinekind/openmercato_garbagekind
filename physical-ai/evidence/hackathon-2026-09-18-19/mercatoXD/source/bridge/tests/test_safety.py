import math

import pytest

from om_bridge import safety

DEG = math.pi / 180.0


def test_max_joint_delta_reports_the_largest_joint_difference():
    a = [0.0, 10 * DEG, 0.0]
    b = [0.0, 0.0, 3 * DEG]
    assert safety.max_joint_delta_deg(a, b) == pytest.approx(10.0)


def test_check_step_rejects_a_jump_past_the_cap():
    measured = [0.0] * 6
    target = [0.0, 20 * DEG, 0.0, 0.0, 0.0, 0.0]
    with pytest.raises(safety.UnsafePlan, match="MAX_STEP_DEG"):
        safety.check_step(target, measured)


def test_check_step_rejects_non_finite_values():
    with pytest.raises(safety.UnsafePlan, match="non-finite"):
        safety.check_step([float("nan")] * 6, [0.0] * 6)


def test_check_total_rejects_drift_from_the_round_start():
    start = [0.0] * 6
    target = [0.0, 50 * DEG, 0.0, 0.0, 0.0, 0.0]
    with pytest.raises(safety.UnsafePlan, match="MAX_TOTAL_DEG"):
        safety.check_total(target, start)


def test_is_motion_is_false_for_a_flat_plan():
    measured = [0.0] * 6
    assert not safety.is_motion([1 * DEG] + [0.0] * 5, measured)
    assert safety.is_motion([10 * DEG] + [0.0] * 5, measured)


def test_clip_to_window_pulls_joints_into_the_operational_envelope():
    # J2 window is [0, 90]; -30 deg is below it, 120 deg above it.
    clipped = safety.clip_to_window([0.0, -30 * DEG, 0.0, 0.0, 0.0, 120 * DEG])
    assert clipped[1] == pytest.approx(0.0)
    assert clipped[5] == pytest.approx(90 * DEG)


def test_clip_to_window_passes_the_gripper_channel_through():
    clipped = safety.clip_to_window([0.0] * 6 + [-1.8])
    assert clipped[6] == pytest.approx(-1.8)


def test_at_window_edge_flags_a_joint_pinned_to_its_bound():
    # J3's window upper bound is 0 deg - the bound the live run stalled on.
    # J1 (+/-165) and J4..J6 sit mid-window at 0, so only J3 is flagged.
    assert safety.at_window_edge([0.0, 45 * DEG, 0.0, 0.0, 0.0, 0.0]) == [2]
    # J2's lower bound is 0 deg, so a rest pose flags the shoulder too.
    assert safety.at_window_edge([0.0] * 6) == [1, 2]
