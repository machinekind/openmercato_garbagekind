#!/usr/bin/env python3
"""The A1X digital twin: MuJoCo physics behind the same 7-D interface as the arm.

Command and state are the vectors `record_a1x.py` writes to its LeRobot dataset
-- six joint angles in radians plus one gripper scalar in the arm's own `p_des`
units -- so a dataset recorded on hardware and one generated here are the same
shape, and a policy trained on either drives both.

Three details keep the twin honest, and all three come from measurements in
docs/PROTOCOL.md and docs/STEERING.md rather than from sim convention:

  * Position only. `t_ff`, `kp`, `kd`, `v_des` and `mode` are inert on the wire;
    only `p_des` moves the arm. So this exposes position targets and nothing else.
  * Slew-limited. `so101_bridge.py` caps follower motion at --follow-rate deg/s
    and the same cap applies here, or generated motion is faster than the real
    arm can track.
  * One grip scalar. The two finger joints are coupled in the scene, and
    GRIP_OPEN/GRIP_CLOSED are the measured p_des endpoints, not sim units.

    ./env.py                      # settle at home, print joint error
    ./env.py --render out.png     # offscreen render of the 'top' camera
"""
from __future__ import annotations

import argparse
import pathlib

import mujoco
import numpy as np

from urdf_to_mjcf import FINGER_CLOSED_SLIDE, TCP_POS

SIM_DIR = pathlib.Path(__file__).parent.resolve()
DEFAULT_SCENE = SIM_DIR / "a1x_scene.xml"

N_JOINTS = 6
ARM_JOINTS = [f"arm_joint{i}" for i in range(1, N_JOINTS + 1)]

# Measured on hardware (record_a1x.py --grip-open/--grip-closed): group-7
# position is linear at 57.1 deg per unit of p_des, travel tapering past -3.0.
GRIP_OPEN = -2.0
GRIP_CLOSED = 0.6
# The scene's finger slide range, open first to match the p_des endpoints above.
# Closed is not slide 0: the URDF's finger origin starts 13.45 mm off the
# centreline, so the pads meet before the joint runs out. urdf_to_mjcf.py owns
# that number because it is the same measurement that sizes the pad boxes.
FINGER_OPEN = 0.05
FINGER_CLOSED = FINGER_CLOSED_SLIDE

# The hardware analogue of record_a1x.py --grip-force: past this the grip target
# is frozen where it is instead of being driven further closed. Without it a
# position-controlled jaw keeps squeezing a stalled object until the solver
# ejects it, which the real arm never does -- it "grips, doesn't crush".
GRIP_FORCE_LIMIT = 15.0
# Freezing exactly where the pads first touch leaves a ~1 mm bite that the
# object slips out of the moment the arm accelerates. Squeeze this much past
# first contact so the grip carries a steady normal force.
GRIP_PRELOAD = 0.002

# so101_bridge.py --follow-rate default.
DEFAULT_FOLLOW_RATE = 90.0
# CAN command rate on hardware (so101_bridge.py --rate).
DEFAULT_CONTROL_HZ = 200.0


def grip_to_finger(grip: float) -> float:
    """p_des gripper units -> finger slide position, clipped to the travel."""
    span = GRIP_CLOSED - GRIP_OPEN
    frac = (float(grip) - GRIP_OPEN) / span
    pos = FINGER_OPEN + frac * (FINGER_CLOSED - FINGER_OPEN)
    return float(np.clip(pos, FINGER_CLOSED, FINGER_OPEN))


def finger_to_grip(finger: float) -> float:
    """Inverse of grip_to_finger, for reporting state in hardware units."""
    frac = (float(finger) - FINGER_OPEN) / (FINGER_CLOSED - FINGER_OPEN)
    return float(GRIP_OPEN + frac * (GRIP_CLOSED - GRIP_OPEN))


class A1XSim:
    """MuJoCo A1X with the hardware's command interface and nothing more."""

    def __init__(self, scene: pathlib.Path = DEFAULT_SCENE,
                 control_hz: float = DEFAULT_CONTROL_HZ,
                 follow_rate: float = DEFAULT_FOLLOW_RATE):
        self.model = mujoco.MjModel.from_xml_path(str(scene))
        self.data = mujoco.MjData(self.model)
        self.control_dt = 1.0 / float(control_hz)
        self.follow_rate = float(follow_rate)
        self._substeps = max(1, round(self.control_dt / self.model.opt.timestep))

        self.qadr = np.array([
            self.model.jnt_qposadr[mujoco.mj_name2id(
                self.model, mujoco.mjtObj.mjOBJ_JOINT, name)]
            for name in ARM_JOINTS
        ])
        finger_jid = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_JOINT, "gripper_finger_joint1")
        self.finger_qadr = self.model.jnt_qposadr[finger_jid]
        self.finger_dofadr = self.model.jnt_dofadr[finger_jid]
        self.ctrlrange = self.model.actuator_ctrlrange.copy()
        self._renderer: mujoco.Renderer | None = None
        # Called with (action, state) after every control step. The episode
        # recorder hooks in here so primitives stay unaware of being recorded.
        self.on_step = None
        self.reset()

    # -- state ---------------------------------------------------------------

    def reset(self, keyframe: int = 0) -> np.ndarray:
        mujoco.mj_resetDataKeyframe(self.model, self.data, keyframe)
        mujoco.mj_forward(self.model, self.data)
        self.target = self.data.ctrl.copy()
        return self.state()

    def state(self) -> np.ndarray:
        """(7,) measured: six joint angles in rad, gripper in p_des units."""
        return np.concatenate([
            self.data.qpos[self.qadr],
            [finger_to_grip(self.data.qpos[self.finger_qadr])],
        ])

    def body_pose(self, name: str) -> np.ndarray:
        """(7,) world position + quaternion. Privileged; data generation only."""
        bid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, name)
        return np.concatenate([self.data.xpos[bid], self.data.xquat[bid]])

    # -- control -------------------------------------------------------------

    def command(self, joints: np.ndarray, grip: float | None = None) -> np.ndarray:
        """Move one control step toward a 6-joint target, slew- and limit-capped.

        Returns the (7,) target actually commanded, which is what belongs in a
        dataset's `action` -- the real arm records the commanded p_des, not the
        unreachable request.
        """
        want = np.asarray(joints, dtype=float)
        if want.shape != (N_JOINTS,):
            raise ValueError(f"expected {N_JOINTS} joint targets, got {want.shape}")

        step = np.deg2rad(self.follow_rate) * self.control_dt
        delta = np.clip(want - self.target[:N_JOINTS], -step, step)
        self.target[:N_JOINTS] += delta
        if grip is not None:
            self._set_grip_target(grip_to_finger(grip))

        np.clip(self.target, self.ctrlrange[:, 0], self.ctrlrange[:, 1],
                out=self.target)
        self.data.ctrl[:] = self.target
        for _ in range(self._substeps):
            mujoco.mj_step(self.model, self.data)

        action = np.concatenate([
            self.target[:N_JOINTS], [finger_to_grip(self.target[N_JOINTS])],
        ])
        if self.on_step is not None:
            self.on_step(action, self.state())
        return action

    def _set_grip_target(self, slide: float) -> None:
        """Drive both fingers from one jaw opening, mirrored about the centreline."""
        self.target[N_JOINTS] = slide
        self.target[N_JOINTS + 1] = -slide

    def grip_force(self) -> float:
        """Magnitude of the jaw actuator's force, in newtons."""
        return abs(float(self.data.actuator_force[N_JOINTS]))

    def freeze_grip(self, preload: float | None = None) -> None:
        """Pin the grip target just past where the jaw actually is.

        Called when the jaw stalls on an object. Every later command leaves the
        grip alone (grip=None), so the frozen target is what holds the object
        for the rest of the episode.
        """
        # Read the module global at call time, not as a default argument bound
        # at import, so the value stays tunable from a sweep.
        preload = GRIP_PRELOAD if preload is None else preload
        slide = float(self.data.qpos[self.finger_qadr]) - preload
        self._set_grip_target(max(FINGER_CLOSED, slide))

    def hold(self, seconds: float) -> None:
        """Keep the current target for a while, e.g. to let a grasp settle."""
        for _ in range(int(seconds / self.control_dt)):
            self.command(self.target[:N_JOINTS])

    # -- rendering -----------------------------------------------------------

    def render(self, camera: str = "top", width: int = 640, height: int = 480):
        """Offscreen RGB. Headless needs MUJOCO_GL=egl (or osmesa) in the env."""
        if self._renderer is None or (self._renderer.width, self._renderer.height) != (width, height):
            self._renderer = mujoco.Renderer(self.model, height=height, width=width)
        self._renderer.update_scene(self.data, camera=camera)
        return self._renderer.render()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", type=pathlib.Path, default=DEFAULT_SCENE)
    ap.add_argument("--secs", type=float, default=2.0)
    ap.add_argument("--render", type=pathlib.Path, default=None,
                    help="write an offscreen frame here and exit")
    ap.add_argument("--camera", default="top")
    args = ap.parse_args()

    sim = A1XSim(args.scene)
    home = sim.state()[:N_JOINTS].copy()
    print(f"scene   {args.scene}")
    print(f"physics {1 / sim.model.opt.timestep:.0f} Hz, "
          f"control {1 / sim.control_dt:.0f} Hz ({sim._substeps} substeps/step)")

    for _ in range(int(args.secs / sim.control_dt)):
        sim.command(home)
    err = np.rad2deg(sim.state()[:N_JOINTS] - home)
    print("hold error (deg) " + "  ".join(f"{e:+.2f}" for e in err))
    print(f"object  {np.round(sim.body_pose('object')[:3], 4)}")

    if args.render:
        try:
            import imageio.v3 as iio
        except ImportError:
            raise SystemExit("--render needs imageio: pip install imageio")
        iio.imwrite(args.render, sim.render(args.camera))
        print(f"wrote {args.render}")


if __name__ == "__main__":
    main()
