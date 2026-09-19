#!/usr/bin/env python3
"""Convert a Galaxea A1X teleop MCAP bag into a LeRobot v2.1 parquet dataset.

Convention (standard for leader/follower teleop):
    action            = LEADER joint positions   (what you demonstrated)
    observation.state = FOLLOWER joint positions (what the arm did)

The official OpenGalaxea/GalaxeaLeRobotToolkit only supports R1Pro/R1Lite, so
this writes the dataset directly.

    to_lerobot.py <bag_dir> <out_dir> [dataset_name] [fps]
"""
import json
import math
import pathlib
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

from rclpy.serialization import deserialize_message
from rosidl_runtime_py.utilities import get_message
import rosbag2_py

LEADER_T = "/leader/hdas/feedback_arm"
FOLLOWER_T = "/hdas/feedback_arm"
N = 6
JOINTS = [f"arm_joint{i}" for i in range(1, N + 1)]


def read_bag(bag_dir):
    reader = rosbag2_py.SequentialReader()
    reader.open(
        rosbag2_py.StorageOptions(uri=str(bag_dir), storage_id="mcap"),
        rosbag2_py.ConverterOptions("", ""),
    )
    types = {t.name: t.type for t in reader.get_all_topics_and_types()}
    out = defaultdict(list)
    while reader.has_next():
        topic, data, stamp = reader.read_next()
        if topic not in (LEADER_T, FOLLOWER_T):
            continue
        msg = deserialize_message(data, get_message(types[topic]))
        out[topic].append((stamp * 1e-9, list(msg.position[:N])))
    return out


def resample(series, grid):
    """Zero-order-hold resample onto a uniform time grid."""
    ts = np.array([s[0] for s in series])
    vals = np.array([s[1] for s in series], dtype=np.float32)
    idx = np.searchsorted(ts, grid, side="right") - 1
    idx = np.clip(idx, 0, len(ts) - 1)
    return vals[idx]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    bag = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2])
    name = sys.argv[3] if len(sys.argv) > 3 else bag.name
    fps = float(sys.argv[4]) if len(sys.argv) > 4 else 30.0

    data = read_bag(bag)
    lead, foll = data.get(LEADER_T), data.get(FOLLOWER_T)
    if not lead or not foll:
        print(f"missing topics. leader={len(lead or [])} follower={len(foll or [])}")
        return 1

    t0 = max(lead[0][0], foll[0][0])
    t1 = min(lead[-1][0], foll[-1][0])
    if t1 <= t0:
        print("no overlapping time range")
        return 1
    grid = np.arange(t0, t1, 1.0 / fps)
    action = resample(lead, grid)
    state = resample(foll, grid)
    n = len(grid)
    print(f"leader {len(lead)} msgs, follower {len(foll)} msgs "
          f"-> {n} frames @ {fps:g} Hz ({t1-t0:.1f}s)")

    root = out / name
    (root / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
    (root / "meta").mkdir(parents=True, exist_ok=True)

    df = pd.DataFrame({
        "action": [a.astype(np.float32).tolist() for a in action],
        "observation.state": [s.astype(np.float32).tolist() for s in state],
        "timestamp": (grid - grid[0]).astype(np.float32),
        "frame_index": np.arange(n, dtype=np.int64),
        "episode_index": np.zeros(n, dtype=np.int64),
        "index": np.arange(n, dtype=np.int64),
        "task_index": np.zeros(n, dtype=np.int64),
    })
    df.to_parquet(root / "data" / "chunk-000" / "episode_000000.parquet", index=False)

    features = {
        "action": {"dtype": "float32", "shape": [N], "names": JOINTS},
        "observation.state": {"dtype": "float32", "shape": [N], "names": JOINTS},
        "timestamp": {"dtype": "float32", "shape": [1], "names": None},
        "frame_index": {"dtype": "int64", "shape": [1], "names": None},
        "episode_index": {"dtype": "int64", "shape": [1], "names": None},
        "index": {"dtype": "int64", "shape": [1], "names": None},
        "task_index": {"dtype": "int64", "shape": [1], "names": None},
    }
    info = {
        "codebase_version": "v2.1", "robot_type": "galaxea_a1x",
        "total_episodes": 1, "total_frames": n, "total_tasks": 1,
        "total_videos": 0, "total_chunks": 1, "chunks_size": 1000,
        "fps": fps, "splits": {"train": "0:1"},
        "data_path": "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
        "video_path": None, "features": features,
    }
    (root / "meta" / "info.json").write_text(json.dumps(info, indent=2))
    (root / "meta" / "tasks.jsonl").write_text(
        json.dumps({"task_index": 0, "task": name}) + "\n")
    (root / "meta" / "episodes.jsonl").write_text(
        json.dumps({"episode_index": 0, "tasks": [name], "length": n}) + "\n")
    stats = {}
    for key, arr in (("action", action), ("observation.state", state)):
        stats[key] = {"mean": arr.mean(0).tolist(), "std": arr.std(0).tolist(),
                      "min": arr.min(0).tolist(), "max": arr.max(0).tolist()}
    (root / "meta" / "stats.json").write_text(json.dumps(stats, indent=2))

    print(f"wrote {root}")
    print(f"  data/chunk-000/episode_000000.parquet  ({n} rows)")
    rng = [round(math.degrees(action[:, j].max() - action[:, j].min()), 1) for j in range(N)]
    print(f"  leader motion range per joint (deg): {rng}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
