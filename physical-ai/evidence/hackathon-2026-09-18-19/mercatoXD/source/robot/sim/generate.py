#!/usr/bin/env python3
"""Generate A1X pick-and-place demonstrations in the twin, with no teleoperation.

This is the LEGS (arXiv:2606.01458) procedural generator for a fixed-base arm.
It runs the primitive plan from primitives.py against a randomised scene, keeps
only the episodes that pass their verification primitives, and writes a LeRobot
v3 dataset with exactly the schema record_a1x.py writes on hardware -- 7-D
action, 7-D state, one video stream per camera -- so a generated dataset and a
teleoperated one are interchangeable to a policy.

The paper's key property is preserved: the recorded command stream does not
depend on how the scene was rendered, so the same episodes can be re-rendered
later against a 3DGS background without regenerating any motion. That is why
motion and frames are kept separate below, and why --replay exists.

    ./generate.py --episodes 5 --no-record            # smoke test, writes nothing
    ./generate.py --repo-id local/a1x_legs --episodes 200

Rendering needs a GL backend; headless hosts want MUJOCO_GL=egl (or osmesa).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

import mujoco
import numpy as np

SIM_DIR = pathlib.Path(__file__).parent.resolve()
sys.path.insert(0, str(SIM_DIR))
sys.path.insert(0, str(SIM_DIR.parent))          # kinematics.py lives at the root

from env import A1XSim, N_JOINTS, ARM_JOINTS      # noqa: E402
from kinematics import Chain                      # noqa: E402
from primitives import Ctx, Status, pick_and_place_plan  # noqa: E402

A1X_URDF = SIM_DIR.parent / "ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf"

# Appendix D of the paper, manipulation-only row: the robot does not move, the
# objects do. Yaw is full-circle because a randomised approach angle is most of
# what makes one task plan produce distinct trajectories.
OBJECT_XY_CM = 5.0
OBJECT_YAW_DEG = 180.0

FEATURE_NAMES = [f"arm_joint{i}" for i in range(1, 7)] + ["gripper"]
DEFAULT_TASK = "place the orange on the plate"


class Recorder:
    """Collects one episode's frames at `fps` from a stream of control steps."""

    def __init__(self, sim: A1XSim, cameras: list[str], fps: int,
                 width: int, height: int, render: bool):
        self.sim, self.cameras, self.fps = sim, cameras, fps
        self.width, self.height, self.render = width, height, render
        self.reset()

    def reset(self) -> None:
        self.frames: list[dict] = []
        self._elapsed = 0.0
        self._next = 0.0

    def __call__(self, action: np.ndarray, state: np.ndarray) -> None:
        self._elapsed += self.sim.control_dt
        if self._elapsed + 1e-9 < self._next:
            return
        self._next += 1.0 / self.fps
        frame = {"action": action.astype(np.float32),
                 "observation.state": state.astype(np.float32)}
        if self.render:
            for cam in self.cameras:
                frame[f"observation.images.{cam}"] = self.sim.render(
                    cam, self.width, self.height)
        self.frames.append(frame)


def randomize(sim: A1XSim, rng: np.random.Generator) -> dict:
    """Per-reset object and target placement. Returns the sampled pose for the log."""
    m, d = sim.model, sim.data
    out = {}
    for body, joint in (("object", "object_free"), ("target", "target_free")):
        adr = m.jnt_qposadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, joint)]
        dx, dy = rng.uniform(-OBJECT_XY_CM / 100, OBJECT_XY_CM / 100, 2)
        yaw = rng.uniform(-np.deg2rad(OBJECT_YAW_DEG), np.deg2rad(OBJECT_YAW_DEG))
        d.qpos[adr + 0] += dx
        d.qpos[adr + 1] += dy
        d.qpos[adr + 3:adr + 7] = [np.cos(yaw / 2), 0.0, 0.0, np.sin(yaw / 2)]
        out[body] = [float(d.qpos[adr + 0]), float(d.qpos[adr + 1]), float(yaw)]
    d.qvel[:] = 0
    mujoco.mj_forward(m, d)
    return out


def run_episode(sim: A1XSim, chain: Chain, rng: np.random.Generator,
                max_secs: float) -> tuple[bool, Ctx, dict]:
    """Execute the plan once against a fresh randomised scene."""
    sim.reset()
    layout = randomize(sim, rng)
    ctx = Ctx(sim=sim, chain=chain, rng=rng, grasp_yaw=rng.uniform(-np.pi / 2, np.pi / 2))

    budget = int(max_secs / sim.control_dt)
    ticks = 0
    for prim in pick_and_place_plan():
        prim.start(ctx)
        while True:
            status = prim.step(ctx)
            ticks += 1
            if status is Status.DONE:
                break
            if status is Status.FAILED:
                return False, ctx, layout
            if ticks > budget:
                ctx.notes.append(f"episode budget of {max_secs:.0f} s exhausted in {prim.name}")
                return False, ctx, layout
    return True, ctx, layout


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--episodes", type=int, default=200, help="verified episodes to keep")
    ap.add_argument("--repo-id", default="", help="e.g. local/a1x_legs")
    ap.add_argument("--root", default=None, help="dataset directory (default: HF cache)")
    ap.add_argument("--task", default=DEFAULT_TASK, help="language prompt for every episode")
    ap.add_argument("--cameras", default="top,front,wrist")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--cam-width", type=int, default=640)
    ap.add_argument("--cam-height", type=int, default=480)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-secs", type=float, default=40.0,
                    help="wall-clock sim budget per episode attempt")
    ap.add_argument("--max-attempts", type=int, default=0,
                    help="give up after this many attempts (0 = 10x episodes)")
    ap.add_argument("--no-record", action="store_true",
                    help="run the generator and report yield, write no dataset")
    ap.add_argument("--no-render", action="store_true",
                    help="skip rendering; motion only, for measuring yield fast")
    a = ap.parse_args()

    if not a.no_record and not a.repo_id:
        print("  --repo-id is required unless --no-record")
        return 1

    cameras = [c.strip() for c in a.cameras.split(",") if c.strip()]
    render = not (a.no_render or a.no_record)

    sim = A1XSim()
    chain = Chain(str(A1X_URDF), ARM_JOINTS)
    rng = np.random.default_rng(a.seed)
    rec = Recorder(sim, cameras, a.fps, a.cam_width, a.cam_height, render)
    sim.on_step = rec

    ds = None
    if not a.no_record:
        from lerobot.datasets.lerobot_dataset import LeRobotDataset
        features = {
            "action": {"dtype": "float32", "shape": (7,), "names": FEATURE_NAMES},
            "observation.state": {"dtype": "float32", "shape": (7,), "names": FEATURE_NAMES},
        }
        for cam in cameras:
            features[f"observation.images.{cam}"] = {
                "dtype": "video", "shape": (a.cam_height, a.cam_width, 3),
                "names": ["height", "width", "channels"]}
        ds = LeRobotDataset.create(a.repo_id, fps=a.fps, features=features,
                                   root=a.root, robot_type="galaxea_a1x",
                                   use_videos=True, image_writer_threads=4)
        print(f"  created dataset {a.repo_id}")

    max_attempts = a.max_attempts or a.episodes * 10
    kept, attempts, failures = 0, 0, {}
    t0 = time.time()

    while kept < a.episodes and attempts < max_attempts:
        attempts += 1
        rec.reset()
        ok, ctx, layout = run_episode(sim, chain, rng, a.max_secs)
        if not ok:
            reason = ctx.notes[-1].split(":")[0] if ctx.notes else "unknown"
            failures[reason] = failures.get(reason, 0) + 1
            continue

        kept += 1
        if ds is not None:
            for frame in rec.frames:
                ds.add_frame(frame, task=a.task)
            ds.save_episode()
        rate = kept / max(1e-9, time.time() - t0)
        print(f"  episode {kept}/{a.episodes}  {len(rec.frames):4d} frames  "
              f"attempt {attempts}  {rate*3600:.0f}/hr  object={np.round(layout['object'],3)}")

    secs = time.time() - t0
    print(f"\n  kept {kept}/{attempts} attempts ({100*kept/max(1,attempts):.0f}% yield) "
          f"in {secs/60:.1f} min")
    if failures:
        print("  failures by primitive:")
        for reason, n in sorted(failures.items(), key=lambda kv: -kv[1]):
            print(f"    {n:4d}  {reason}")

    if ds is not None:
        meta = pathlib.Path(ds.root) / "legs_generation.json"
        meta.write_text(json.dumps({
            "generator": "sim/generate.py", "seed": a.seed, "task": a.task,
            "episodes": kept, "attempts": attempts, "cameras": cameras,
            "object_xy_cm": OBJECT_XY_CM, "object_yaw_deg": OBJECT_YAW_DEG,
        }, indent=2))
        print(f"  wrote {meta}")
    return 0 if kept == a.episodes else 1


if __name__ == "__main__":
    raise SystemExit(main())
