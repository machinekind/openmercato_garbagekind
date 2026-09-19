#!/usr/bin/env python3
"""Why does unroll.py produce motion while the panel client does not?

Same server, same task, same arm pose - so the difference has to be in the
observation. This builds the observation BOTH ways in one process, prints an
image fingerprint for each, and unrolls a full chunk from each.
"""
from __future__ import annotations

import asyncio
import json
import math
import threading
import time
import urllib.request

import cv2
import numpy as np
import websockets
from g05.utils.websocket import packb, unpackb

PANEL = "http://192.168.220.102:8080"
POLICY = "ws://127.0.0.1:8765"
TASK = "pick up the can from the table"
DEG = 180.0 / math.pi


def chw_rgb(bgr, size=(640, 480)):
    if bgr is None:
        return np.zeros((3, size[1], size[0]), np.uint8)
    img = cv2.resize(bgr, size)
    return np.ascontiguousarray(
        cv2.cvtColor(img, cv2.COLOR_BGR2RGB).transpose(2, 0, 1))


def grab_once(path, size=(640, 480)):
    """unroll.py style: open the stream, take the first complete JPEG."""
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
                return chw_rgb(img, size)
    raise RuntimeError("no frame from " + path)


class Reader(threading.Thread):
    """client style: background thread keeping the latest frame."""

    def __init__(self, path):
        super().__init__(daemon=True)
        self.url = PANEL + path
        self.frame = None
        self.count = 0

    def run(self):
        while True:
            try:
                stream = urllib.request.urlopen(self.url, timeout=10)
                buf = b""
                while True:
                    chunk = stream.read(16384)
                    if not chunk:
                        break
                    buf += chunk
                    a = buf.find(b"\xff\xd8")
                    b = buf.find(b"\xff\xd9", a + 2)
                    if a >= 0 and b > 0:
                        img = cv2.imdecode(
                            np.frombuffer(buf[a:b + 2], np.uint8),
                            cv2.IMREAD_COLOR)
                        buf = buf[b + 2:]
                        if img is not None:
                            self.frame = img
                            self.count += 1
                    if len(buf) > 4 * 1024 * 1024:
                        buf = b""
            except Exception:  # noqa: BLE001
                time.sleep(2.0)


def fingerprint(name, img):
    print(f"    {name}: shape {img.shape} mean {img.mean():7.2f} "
          f"std {img.std():6.2f} min {img.min()} max {img.max()}")


async def unroll(label, obs, steps=16):
    print(f"\n=== {label} ===")
    for k, v in obs["images"].items():
        fingerprint(k, v)
    cur = np.asarray(obs["state"]["left_arm"], float)
    async with websockets.connect(POLICY, max_size=None,
                                  ping_interval=30) as ws:
        await ws.recv()
        worst = 0.0
        for i in range(steps):
            await ws.send(packb(obs))
            res = unpackb(await ws.recv())
            if "error" in res:
                print("    BLAD:", res["error"])
                return
            tgt = np.asarray(res["action"]["left_arm"], float).reshape(-1)[:6]
            d = float(np.max(np.abs((tgt - cur) * DEG)))
            worst = max(worst, d)
            if i in (0, 5, 10, 15):
                print(f"    krok {i:2d}  |d|max {d:5.1f} deg  "
                      f"cel {np.round(tgt * DEG, 1)}")
        print(f"    NAJWIEKSZE ODCHYLENIE W CHUNKU: {worst:.1f} deg")


async def main():
    with urllib.request.urlopen(PANEL + "/api/state", timeout=5) as r:
        q = json.load(r)["q"]
    print("poza (deg):", np.round(np.asarray(q[:6]) * DEG, 1))

    state = {"left_arm": np.asarray(q[:6], np.float32),
             "left_gripper": np.asarray([q[6]], np.float32),
             "right_arm": np.zeros(6, np.float32),
             "right_gripper": np.zeros(1, np.float32)}
    zeros = np.zeros((3, 480, 640), np.uint8)

    head_r, wrist_r = Reader("/stream/robot"), Reader("/stream/wrist")
    head_r.start()
    wrist_r.start()
    time.sleep(4.0)
    print(f"reader: head {head_r.count} klatek, wrist {wrist_r.count} klatek")

    await unroll("A. klatki jak w unroll.py (swieze polaczenie)", {
        "images": {"head_rgb": grab_once("/stream/robot"),
                   "left_wrist_rgb": grab_once("/stream/wrist"),
                   "right_wrist_rgb": zeros},
        "state": state, "task": TASK,
        "embodiment_type": "galaxea_r1lite"})

    await unroll("B. klatki jak w kliencie (watek w tle)", {
        "images": {"head_rgb": chw_rgb(head_r.frame),
                   "left_wrist_rgb": chw_rgb(wrist_r.frame),
                   "right_wrist_rgb": zeros},
        "state": state, "task": TASK,
        "embodiment_type": "galaxea_r1lite"})

    await unroll("C. czarne obrazy (kontrola)", {
        "images": {"head_rgb": zeros.copy(), "left_wrist_rgb": zeros.copy(),
                   "right_wrist_rgb": zeros},
        "state": state, "task": TASK,
        "embodiment_type": "galaxea_r1lite"})


if __name__ == "__main__":
    asyncio.run(main())
