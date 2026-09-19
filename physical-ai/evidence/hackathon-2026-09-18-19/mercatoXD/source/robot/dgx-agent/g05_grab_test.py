#!/usr/bin/env python3
"""Ask G0.5 to grab the can and report what it actually plans.

One fresh observation per task, then the whole 16-step chunk unrolled, so we
see the trajectory rather than its first step (which always sits on the
current pose). Repeats each task to show whether the plan is reproducible.
Nothing is sent to the arm.
"""
from __future__ import annotations

import asyncio
import json
import math
import sys
import urllib.request

import cv2
import numpy as np
import websockets
from g05.utils.websocket import packb, unpackb

PANEL = "http://192.168.220.102:8080"
POLICY = "ws://127.0.0.1:8765"
DEG = 180.0 / math.pi
JOINTS = ["J1 base", "J2 shldr", "J3 elbow", "J4 wr-p", "J5 wr-y", "J6 wr-r"]

TASKS = [
    "pick up the can",
    "pick up the red bull can from the table",
    "grasp the can and lift it",
]
REPEATS = 2


WRIST_DEV = 0          # /dev/video0 on the DGX = the gripper camera


def grab_local(dev, size=(640, 480)):
    """One frame straight off a local V4L2 device -> RGB CHW uint8."""
    cap = cv2.VideoCapture(dev)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    img = None
    for _ in range(10):
        ok, frame = cap.read()
        if ok:
            img = frame
            break
    cap.release()
    if img is None:
        raise RuntimeError(f"no frame from /dev/video{dev}")
    img = cv2.resize(img, size)
    return np.ascontiguousarray(
        cv2.cvtColor(img, cv2.COLOR_BGR2RGB).transpose(2, 0, 1))


def grab(path, size=(640, 480)):
    s = urllib.request.urlopen(PANEL + path, timeout=10)
    buf = b""
    for _ in range(400):
        buf += s.read(16384)
        a = buf.find(b"\xff\xd8")
        b = buf.find(b"\xff\xd9", a + 2)
        if a >= 0 and b > 0:
            img = cv2.imdecode(np.frombuffer(buf[a:b + 2], np.uint8),
                               cv2.IMREAD_COLOR)
            if img is not None:
                img = cv2.resize(img, size)
                return np.ascontiguousarray(
                    cv2.cvtColor(img, cv2.COLOR_BGR2RGB).transpose(2, 0, 1))
    raise RuntimeError("no frame from " + path)


async def run_chunk(ws, obs, cur):
    """Unroll one chunk; return (trajectory [16,6], gripper list)."""
    traj, grips = [], []
    for _ in range(16):
        await ws.send(packb(obs))
        res = unpackb(await ws.recv())
        if "error" in res:
            print("   BLAD:", res["error"])
            return None, None
        act = res["action"]
        traj.append(np.asarray(act["left_arm"], float).reshape(-1)[:6])
        g = act.get("left_gripper")
        grips.append(None if g is None
                     else float(np.asarray(g).reshape(-1)[0]))
    return np.asarray(traj), grips


async def main():
    with urllib.request.urlopen(PANEL + "/api/state", timeout=5) as r:
        st = json.load(r)
    q = st.get("q")
    if not q:
        print("brak feedbacku z ramienia")
        return 1
    cur = np.asarray(q[:6], float)
    print("poza teraz (deg):", np.round(cur * DEG, 1))
    print("chwytak:", round(q[6], 3))

    # head_rgb: the laptop camera over the bench, served by the panel.
    # left_wrist_rgb: the camera bolted to the gripper, wired to this box.
    head = grab("/stream/robot")
    wrist = grab_local(WRIST_DEV)
    print(f"klatki: head mean {head.mean():.1f}, wrist mean {wrist.mean():.1f}")

    zeros = np.zeros((3, 480, 640), np.uint8)
    state = {"left_arm": cur.astype(np.float32),
             "left_gripper": np.asarray([q[6]], np.float32),
             "right_arm": np.zeros(6, np.float32),
             "right_gripper": np.zeros(1, np.float32)}

    async with websockets.connect(POLICY, max_size=None,
                                  ping_interval=30) as ws:
        await ws.recv()
        for task in TASKS:
            print(f"\n=== {task!r} ===")
            for rep in range(REPEATS):
                obs = {"images": {"head_rgb": head, "left_wrist_rgb": wrist,
                                  "right_wrist_rgb": zeros},
                       "state": state, "task": task,
                       "embodiment_type": "galaxea_r1lite"}
                traj, grips = await run_chunk(ws, obs, cur)
                if traj is None:
                    continue
                end = traj[-1]
                d = (end - cur) * DEG
                print(f"  proba {rep + 1}: |d|max {np.max(np.abs(d)):5.1f} deg"
                      f"   gripper={'brak' if grips[-1] is None else round(grips[-1], 3)}")
                print("    koncowa delta:", "  ".join(
                    f"{n}={v:+6.1f}" for n, v in zip(JOINTS, d)))
                mid = (traj[7] - cur) * DEG
                print("    w polowie   :", "  ".join(
                    f"{n}={v:+6.1f}" for n, v in zip(JOINTS, mid)))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
