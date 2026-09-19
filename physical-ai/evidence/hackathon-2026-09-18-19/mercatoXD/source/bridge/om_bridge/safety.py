"""Bridge-side motion envelope.

This is the *second* gate, not the only one: the web panel already clamps
every target to the per-joint window in `presets.json`, slew-limits it and
refuses anything while disengaged. What lives here is the check the panel
cannot make, because only the bridge knows where an attempt started - how far
a policy is allowed to wander from the pose the attempt began at.

Mirrors the caps proven in robot/dgx-agent/g05_approach.py.
"""
from __future__ import annotations

import math

DEG = 180.0 / math.pi

# A single step may not jump further than this from the measured pose.
# 12 deg is the cap that the live G0.5 runs on this arm were driven with
# (robot/dgx-agent/g05_approach.py).
MAX_STEP_DEG = 12.0
# A whole round may not wander further than this from the pose it started at.
MAX_TOTAL_DEG = 40.0
# Below this, a "plan" is the policy holding still. G0.5 is stochastic and
# returns such flat chunks for the same observation, so they are resampled
# rather than executed.
MIN_MOTION_DEG = 6.0


class UnsafePlan(Exception):
    """A planned target left the envelope; the caller must abort the attempt."""


def max_joint_delta_deg(a: list[float], b: list[float]) -> float:
    """Largest per-joint difference between two poses, in degrees.

    Compared over the common prefix: a policy plan covers the 6 arm joints,
    while the panel's state vector also carries the gripper channel, which is
    commanded separately and must not count as arm motion.
    """
    if not a or not b:
        raise ValueError("cannot compare an empty pose")
    return max((abs(x - y) * DEG for x, y in zip(a, b)), default=0.0)


def check_step(target: list[float], measured: list[float]) -> float:
    """Validate one step against the measured pose; returns its size in deg."""
    if not all(math.isfinite(v) for v in target):
        raise UnsafePlan("plan contains a non-finite joint value")
    step = max_joint_delta_deg(target, measured)
    if step > MAX_STEP_DEG:
        raise UnsafePlan(f"step of {step:.1f} deg exceeds MAX_STEP_DEG={MAX_STEP_DEG}")
    return step


def check_total(target: list[float], start: list[float]) -> float:
    """Validate a step against the pose the attempt started at."""
    total = max_joint_delta_deg(target, start)
    if total > MAX_TOTAL_DEG:
        raise UnsafePlan(f"drift of {total:.1f} deg exceeds MAX_TOTAL_DEG={MAX_TOTAL_DEG}")
    return total


def is_motion(target: list[float], measured: list[float]) -> bool:
    """True when the target actually asks the arm to move."""
    return max_joint_delta_deg(target, measured) >= MIN_MOTION_DEG


# Operational joint window of the A1X, in degrees, as configured in the panel's
# presets.json (J2 lower bound and J3 upper bound were widened to legalize the
# arm's physical rest pose). The panel clamps to this too - it is repeated here
# so the bridge can reject a plan before transmitting instead of watching the
# panel silently clip it.
JOINT_WINDOW_DEG: tuple[tuple[float, float], ...] = (
    (-165.0, 165.0),   # J1 base
    (0.0, 90.0),       # J2 shoulder
    (-70.0, 0.0),      # J3 elbow
    (-45.0, 45.0),     # J4 wrist pitch
    (-60.0, 60.0),     # J5 wrist yaw
    (-90.0, 90.0),     # J6 wrist roll
)


def clip_to_window(target_rad: list[float]) -> list[float]:
    """Clip the arm joints of a plan into the operational window.

    Returns a new list; the input is never mutated. Values past the 6 arm
    joints (e.g. a gripper channel) are passed through untouched, because the
    gripper has its own travel and is commanded separately.
    """
    out: list[float] = []
    for i, value in enumerate(target_rad):
        if i < len(JOINT_WINDOW_DEG):
            lo, hi = JOINT_WINDOW_DEG[i]
            out.append(max(lo / DEG, min(hi / DEG, value)))
        else:
            out.append(value)
    return out


def at_window_edge(target_rad: list[float], tol_deg: float = 0.5) -> list[int]:
    """Indices of joints sitting on a window bound.

    A plan that keeps pushing a joint into its bound is the shape the live runs
    failed in: J3 walked to 0.0 deg, stalled there, and every later chunk had
    nowhere to go.
    """
    stuck: list[int] = []
    for i, value in enumerate(target_rad[: len(JOINT_WINDOW_DEG)]):
        lo, hi = JOINT_WINDOW_DEG[i]
        deg = value * DEG
        if abs(deg - lo) <= tol_deg or abs(deg - hi) <= tol_deg:
            stuck.append(i)
    return stuck
