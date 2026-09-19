#!/usr/bin/env python3
"""Motion primitives for procedural A1X episode generation.

This is the LEGS (arXiv:2606.01458) primitive generator reduced to a fixed-base
arm. The paper's Walk/Align/Approach/Stepback/Squat primitives exist to put a
humanoid's pelvis somewhere; an A1X bolted to a table has no such problem, so
what survives is the manipulation core -- Reach, Adapt, grip, and the
verification primitives that decide whether an episode is worth recording.

Two properties from the paper are load-bearing and are kept:

  * Arguments are scene-level, not joint-level. A primitive is told "the object"
    or "the target", and resolves joint angles from the current scene, so one
    task plan yields a different valid trajectory under every randomised reset.
  * Verified episodes only. Each motion ends in a check, and the manager in
    generate.py discards the episode if the check fails, so the dataset never
    contains a demonstration of failure.

Adapt uses privileged simulator state -- the true TCP pose -- which is exactly
what the paper does, and is legitimate because it is used only while generating
data and never appears in the policy's observation.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field

import mujoco
import numpy as np

from env import GRIP_CLOSED, GRIP_FORCE_LIMIT, GRIP_OPEN, N_JOINTS, TCP_POS, A1XSim
from kinematics import Chain, ik


class Status(enum.Enum):
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


# The jaw closes along the tool's y axis and accepts the object along +x, so a
# top-down grasp points tool +x at the floor. Verified reachable by IK across
# the workspace; see the orientation sweep in the Phase 2 notes.
APPROACH_DOWN = np.array([0.0, 0.0, -1.0])


def grasp_rotation(yaw: float) -> np.ndarray:
    """Tool frame for a top-down grasp with the jaw rolled to `yaw` radians."""
    x = APPROACH_DOWN
    grip = np.array([np.cos(yaw), np.sin(yaw), 0.0])
    grip -= x * (x @ grip)
    grip /= np.linalg.norm(grip)
    return np.column_stack([x, grip, np.cross(x, grip)])


def solve_grasp(ctx, p_tcp, seed=None):
    """IK for a top-down grasp at `p_tcp`, returning (q, residual).

    A parallel jaw is symmetric, so rolling the wrist by pi is the same physical
    grasp. Trying both costs one extra IK solve and recovers the sampled yaws
    that would otherwise sit outside arm_joint6's range.
    """
    seed = ctx.sim.state()[:N_JOINTS] if seed is None else seed
    # Only before the jaw has closed. The two rolls describe the same grasp of a
    # free object, but rolling the wrist 180 degrees while holding one spins it
    # straight out of the pads.
    rolls = (ctx.grasp_yaw,) if ctx.yaw_locked else (ctx.grasp_yaw, ctx.grasp_yaw + np.pi)
    best = None
    for yaw in rolls:
        T = link6_target(p_tcp, grasp_rotation(yaw))
        q = ik(ctx.chain, T, seed)
        q = np.asarray(q[0] if isinstance(q, tuple) else q, float)
        Tc = ctx.chain.fk(q)
        err = float(np.linalg.norm(
            Tc[:3, 3] + Tc[:3, :3] @ np.asarray(TCP_POS) - np.asarray(p_tcp, float)))
        if best is None or err < best[1]:
            best = (q, err, yaw)
    ctx.grasp_yaw = best[2]          # keep the working roll for the rest of the episode
    return best[0], best[1]


def link6_target(p_tcp: np.ndarray, R: np.ndarray) -> np.ndarray:
    """4x4 pose for the IK chain's tip that puts the TCP at `p_tcp`.

    kinematics.Chain ends at arm_link6; the jaw centre is a fixed offset ahead
    of it, so the request has to be walked back by that offset or every grasp
    lands one tool-length short.
    """
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = np.asarray(p_tcp, float) - R @ np.asarray(TCP_POS, float)
    return T


@dataclass
class Ctx:
    """Everything a primitive may read, plus the scratch space it writes."""
    sim: A1XSim
    chain: Chain
    rng: np.random.Generator
    object_body: str = "object"
    target_body: str = "target"
    grasp_yaw: float = 0.0
    yaw_locked: bool = False
    holding: bool = False
    notes: list[str] = field(default_factory=list)

    def tcp(self) -> np.ndarray:
        sid = mujoco.mj_name2id(self.sim.model, mujoco.mjtObj.mjOBJ_SITE, "tcp")
        return self.sim.data.site_xpos[sid].copy()

    def object_pos(self) -> np.ndarray:
        return self.sim.body_pose(self.object_body)[:3]

    def target_pos(self) -> np.ndarray:
        return self.sim.body_pose(self.target_body)[:3]

    def pads_touching(self, body: str) -> bool:
        """True when both jaw pads are in contact with `body`'s geom."""
        m, d = self.sim.model, self.sim.data
        gid = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, body)
        pads = {mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, n) for n in ("pad1", "pad2")}
        hit = set()
        for c in range(d.ncon):
            g1, g2 = d.contact[c].geom1, d.contact[c].geom2
            if g1 == gid and g2 in pads:
                hit.add(g2)
            elif g2 == gid and g1 in pads:
                hit.add(g1)
        return hit == pads


class Primitive:
    """One motion step. `step` is called once per control tick."""

    name = "primitive"

    def start(self, ctx: Ctx) -> None:
        self.t = 0

    def step(self, ctx: Ctx) -> Status:
        raise NotImplementedError

    def _timeout(self, ctx: Ctx, secs: float) -> bool:
        self.t += 1
        return self.t * ctx.sim.control_dt > secs


class Reach(Primitive):
    """Drive the TCP to a scene-derived pose along a straight Cartesian line.

    A single IK solve for the whole move is not enough. The arm slews every
    joint toward its target at the same capped rate, so a move needing 35 deg of
    elbow and 40 deg of wrist arrives on a curve, not a line -- and a lift that
    starts by dipping the TCP 2 mm presses the object into the table and squirts
    it out of the jaw. Interpolating the TCP and re-solving per waypoint keeps
    the path straight for the cost of a handful of extra IK calls.
    """

    name = "reach"
    STEP = 0.02          # m between waypoints
    WAYPOINT_TOL = 0.01  # loose en route; self.tol is what the last one must meet
    # Beyond this the move is free-space repositioning, and forcing the TCP down
    # a straight line only drags the wrist through poses it cannot hold -- the
    # path from the home pose to the table passes through exactly those.
    STRAIGHT_MAX = 0.25

    def __init__(self, where, offset=(0.0, 0.0, 0.0), tol=0.006, timeout=8.0,
                 straight=None):
        self.where, self.offset, self.tol, self.timeout = where, np.array(offset, float), tol, timeout
        self.straight = straight

    def start(self, ctx: Ctx) -> None:
        super().start(ctx)
        self.goal = np.asarray(self.where(ctx), float) + self.offset
        start = ctx.tcp()
        span = float(np.linalg.norm(self.goal - start))
        straight = (span <= self.STRAIGHT_MAX) if self.straight is None else self.straight
        n = max(1, int(np.ceil(span / self.STEP))) if straight else 1
        self.waypoints = [start + (self.goal - start) * (i + 1) / n for i in range(n)]
        self.i = 0
        self.q, self.ik_err = solve_grasp(ctx, self.goal)
        if n > 1:
            self.q, _ = solve_grasp(ctx, self.waypoints[0])

    def step(self, ctx: Ctx) -> Status:
        if self.ik_err > 0.01:
            ctx.notes.append(f"{self.name}: unreachable, ik residual {self.ik_err*1000:.1f} mm")
            return Status.FAILED
        ctx.sim.command(self.q)
        last = self.i >= len(self.waypoints) - 1
        here = np.linalg.norm(ctx.tcp() - self.waypoints[self.i])
        if here < (self.tol if last else self.WAYPOINT_TOL):
            if last:
                return Status.DONE
            self.i += 1
            self.q, _ = solve_grasp(ctx, self.waypoints[self.i], seed=self.q)
        if self._timeout(ctx, self.timeout):
            ctx.notes.append(f"{self.name}: timeout, "
                             f"{np.linalg.norm(ctx.tcp() - self.goal)*1000:.1f} mm short")
            return Status.FAILED
        return Status.RUNNING


class Adapt(Primitive):
    """Close the residual between where the TCP was commanded and where it is.

    The position servos sag under gravity and the slew cap truncates the last
    increment, so a Reach lands a few millimetres off. The paper corrects this
    with the commanded-vs-actual offset before closing the jaw; without it the
    grasp misses on the randomised resets that need the most accuracy.
    """

    name = "adapt"

    def __init__(self, where, offset=(0.0, 0.0, 0.0), tol=0.003, tries=3, timeout=3.0):
        self.where, self.offset, self.tol = where, np.array(offset, float), tol
        self.tries, self.timeout = tries, timeout

    GAIN = 0.8          # full feed-forward rings against the position servos
    MAX_CORRECTION = 0.02   # more than this is a moved object, not servo error

    def start(self, ctx: Ctx) -> None:
        super().start(ctx)
        self.left = self.tries
        # The correction is what the arm has learned about its own error so far.
        # It starts at zero: on entry the arm is still travelling, so the offset
        # between commanded and actual is the approach distance, not error, and
        # feeding that forward drives the jaw straight through the table.
        self.correction = np.zeros(3)
        self._resolve(ctx)

    def _resolve(self, ctx: Ctx) -> None:
        # Re-read the scene rather than trusting the pose captured at entry: if
        # the approach nudged the object, the stale goal is the wrong place.
        self.goal = np.asarray(self.where(ctx), float) + self.offset
        self.q, _ = solve_grasp(ctx, self.goal + self.correction)
        self.t = 0

    def _learn(self, ctx: Ctx) -> None:
        """Fold the settled commanded-vs-actual offset into the correction."""
        self.correction = np.clip(
            self.correction + self.GAIN * (self.goal - ctx.tcp()),
            -self.MAX_CORRECTION, self.MAX_CORRECTION)

    def step(self, ctx: Ctx) -> Status:
        ctx.sim.command(self.q)
        err = np.linalg.norm(ctx.tcp() - self.goal)
        if err < self.tol:
            return Status.DONE
        if self._timeout(ctx, self.timeout):
            self.left -= 1
            if self.left <= 0:
                ctx.notes.append(f"{self.name}: {err*1000:.1f} mm after {self.tries} tries")
                return Status.FAILED
            self._learn(ctx)
            self._resolve(ctx)
        return Status.RUNNING


class SetGrip(Primitive):
    """Drive the jaw open or closed and wait until it stops moving.

    Waiting on the jaw rather than on a fixed timer is what makes a grasp
    reliable: the finger either reaches its target or stalls against the object,
    and both show up as zero velocity. A timer that expires mid-travel hands the
    next primitive a half-closed gripper, which lifts nothing.
    """

    name = "grip"
    STILL = 1e-3        # m/s; below this the jaw has either arrived or stalled
    STALL_DWELL = 0.05  # s of sustained force before the jaw counts as stalled

    def __init__(self, value: float, timeout: float = 2.0, settle: float = 0.15):
        self.value, self.timeout, self.settle = value, timeout, settle

    def start(self, ctx: Ctx) -> None:
        super().start(ctx)
        self.still_for = 0.0
        self.loaded_for = 0.0
        if self.value <= GRIP_OPEN:
            ctx.yaw_locked = False         # released: the wrist is free again

    def step(self, ctx: Ctx) -> Status:
        ctx.sim.command(ctx.sim.target[:N_JOINTS], self.value)
        # A dwell, not an instant trip: the first pad touch spikes the actuator
        # force for a tick or two, and freezing on that spike leaves a bite too
        # shallow to survive the lift.
        loaded = self.value > GRIP_OPEN and ctx.sim.grip_force() > GRIP_FORCE_LIMIT
        self.loaded_for = self.loaded_for + ctx.sim.control_dt if loaded else 0.0
        if self.loaded_for >= self.STALL_DWELL:
            ctx.sim.freeze_grip()          # stalled on the object: hold, do not crush
            ctx.yaw_locked = True          # the wrist roll is now part of the grasp
            return Status.DONE
        speed = abs(float(ctx.sim.data.qvel[ctx.sim.finger_dofadr]))
        self.still_for = self.still_for + ctx.sim.control_dt if speed < self.STILL else 0.0
        if self.still_for >= self.settle:
            return Status.DONE
        if self._timeout(ctx, self.timeout):
            ctx.notes.append(f"{self.name}: jaw still moving at {speed*1000:.1f} mm/s")
            return Status.FAILED
        return Status.RUNNING


def Close(timeout: float = 2.0) -> SetGrip:
    return SetGrip(GRIP_CLOSED, timeout)


def Open(timeout: float = 2.0) -> SetGrip:
    return SetGrip(GRIP_OPEN, timeout)


class Settle(Primitive):
    """Hold the current target, e.g. to let a released object come to rest."""

    name = "settle"

    def __init__(self, secs: float = 0.5):
        self.secs = secs

    def step(self, ctx: Ctx) -> Status:
        ctx.sim.command(ctx.sim.target[:N_JOINTS])
        return Status.DONE if self._timeout(ctx, self.secs) else Status.RUNNING


class Lift(Reach):
    """Raise the TCP straight up from wherever the grasp ended.

    A Reach whose goal is resolved at entry from the current pose, so the object
    travels vertically instead of along whatever arc joint-space would take.
    """

    name = "lift"

    def __init__(self, height: float = 0.15, timeout: float = 8.0):
        super().__init__(where=lambda ctx: ctx.tcp(),
                         offset=(0.0, 0.0, height), tol=0.01, timeout=timeout)


class VerifyHold(Primitive):
    """The object is off the table and pinched between both pads."""

    name = "verify_hold"

    def __init__(self, clearance: float = 0.05):
        self.clearance = clearance

    def step(self, ctx: Ctx) -> Status:
        ctx.sim.command(ctx.sim.target[:N_JOINTS])
        if not self._timeout(ctx, 0.3):
            return Status.RUNNING
        z = ctx.object_pos()[2]
        if z < self.clearance:
            ctx.notes.append(f"{self.name}: object at z={z:.3f}, never left the table")
            return Status.FAILED
        if not ctx.pads_touching(ctx.object_body):
            ctx.notes.append(f"{self.name}: object not between both pads")
            return Status.FAILED
        ctx.holding = True
        return Status.DONE


class VerifyPlace(Primitive):
    """The object came to rest on the target and the jaw let go of it."""

    name = "verify_place"

    def __init__(self, radius: float = 0.07, still: float = 0.02):
        self.radius, self.still = radius, still

    def step(self, ctx: Ctx) -> Status:
        ctx.sim.command(ctx.sim.target[:N_JOINTS])
        if not self._timeout(ctx, 0.6):
            return Status.RUNNING
        obj, tgt = ctx.object_pos(), ctx.target_pos()
        planar = float(np.linalg.norm(obj[:2] - tgt[:2]))
        if planar > self.radius:
            ctx.notes.append(f"{self.name}: {planar*1000:.0f} mm from target centre")
            return Status.FAILED
        speed = float(np.linalg.norm(ctx.sim.data.qvel[:3]))
        if speed > self.still:
            ctx.notes.append(f"{self.name}: still moving at {speed:.3f} m/s")
            return Status.FAILED
        if ctx.pads_touching(ctx.object_body):
            ctx.notes.append(f"{self.name}: jaw never released")
            return Status.FAILED
        ctx.holding = False
        return Status.DONE


def pick_and_place_plan(lift_height: float = 0.15,
                        approach: float = 0.12) -> list[Primitive]:
    """The paper's Pick and Place motions, minus everything locomotion.

    `approach` is the standoff the jaw descends from, which keeps the wrist from
    sweeping the object sideways off the table on its way in.
    """
    obj = lambda ctx: ctx.object_pos()
    tgt = lambda ctx: ctx.target_pos()
    return [
        # Pick
        Open(),
        Reach(obj, offset=(0, 0, approach)),
        Reach(obj, offset=(0, 0, 0.04)),
        Adapt(obj),
        Close(),
        Lift(lift_height),
        VerifyHold(),
        # Place
        Reach(tgt, offset=(0, 0, approach)),
        Reach(tgt, offset=(0, 0, 0.05)),
        Open(),
        Settle(0.6),
        Reach(tgt, offset=(0, 0, approach)),
        VerifyPlace(),
    ]
