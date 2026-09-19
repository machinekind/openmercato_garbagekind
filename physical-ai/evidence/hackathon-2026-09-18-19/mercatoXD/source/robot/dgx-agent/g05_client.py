#!/usr/bin/env python3
"""G0.5 -> Galaxea A1X bridge, driven by the web panel.

Runs on the DGX: the policy server is local and the panel is reachable
outbound (the laptop cannot connect into this box).

Each cycle:
  GET  panel /api/policy      -> {task, mode}   (operator sets these in the UI)
  GET  panel /api/state       -> measured joints
  infer on the local G0.5 server
  POST panel /api/policy/pred -> predicted joint target

The panel decides whether that target moves the arm (mode=execute) or is only
drawn next to the measured pose (mode=shadow). Envelope, slew limit and the
engage gate all live there, so this process cannot move the arm by itself.

Chunking matters: the server answers in 16-step chunks. It recomputes (~1.1 s)
only when it asks for a fresh observation via need_obs, and serves the other
15 steps from cache at ~56 ms. Sending a new observation every cycle restarts
the chunk forever, so you only ever see its first step - which always sits on
top of the current pose and looks like "the policy does nothing".
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import threading
import time
import urllib.error
import urllib.request

import cv2
import numpy as np
import websockets
from g05.utils.websocket import packb, unpackb

DEG = 180.0 / math.pi


class MjpegReader(threading.Thread):
    """Keeps only the latest frame from an MJPEG endpoint."""

    def __init__(self, url: str):
        super().__init__(daemon=True)
        self.url = url
        self.frame = None
        self.count = 0
        self.error = ""

    def run(self) -> None:
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
            except Exception as exc:  # noqa: BLE001 - reader must survive
                self.error = str(exc)
                time.sleep(2.0)


def chw_rgb(bgr, size=(640, 480)):
    """BGR HWC -> RGB CHW uint8, matching compressed_image_to_rgb_array."""
    if bgr is None:
        return np.zeros((3, size[1], size[0]), np.uint8)
    img = cv2.resize(bgr, size)
    return np.ascontiguousarray(
        cv2.cvtColor(img, cv2.COLOR_BGR2RGB).transpose(2, 0, 1))


def get_json(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post_json(url: str, payload: dict, timeout: float = 5.0):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def build_obs(head, wrist, zeros_img, q, task):
    return {
        "images": {"head_rgb": chw_rgb(head.frame),
                   "left_wrist_rgb": chw_rgb(wrist.frame),
                   "right_wrist_rgb": zeros_img},
        "state": {"left_arm": np.asarray(q[:6], np.float32),
                  "left_gripper": np.asarray([q[6]], np.float32),
                  "right_arm": np.zeros(6, np.float32),
                  "right_gripper": np.zeros(1, np.float32)},
        "task": task,
        "embodiment_type": "galaxea_r1lite",
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", default="http://192.168.220.102:8080")
    ap.add_argument("--policy", default="ws://127.0.0.1:8765")
    ap.add_argument("--hz", type=float, default=10.0,
                    help="step rate inside a chunk (the chunk is ~1 s long)")
    a = ap.parse_args()

    head = MjpegReader(a.panel + "/stream/robot")
    wrist = MjpegReader(a.panel + "/stream/wrist")
    head.start()
    wrist.start()
    time.sleep(3.0)
    print(f"kamery: head {head.count} klatek {head.error or 'ok'} | "
          f"wrist {wrist.count} klatek {wrist.error or 'ok'}", flush=True)

    zeros_img = np.zeros((3, 480, 640), np.uint8)
    period = 1.0 / a.hz
    idle_note = True
    need_obs = True
    obs = None
    step = 0
    last_task = None
    last_mode = None

    async with websockets.connect(a.policy, max_size=None,
                                  ping_interval=30) as ws:
        print("handshake:", unpackb(await ws.recv()), flush=True)
        while True:
            t0 = time.perf_counter()
            try:
                pol = get_json(a.panel + "/api/policy")
            except (urllib.error.URLError, OSError) as exc:
                print(f"panel nieosiagalny: {exc}", flush=True)
                await asyncio.sleep(2.0)
                continue

            if pol.get("mode") == "off":
                if idle_note:
                    print("policy off - czekam na polecenie z panelu",
                          flush=True)
                    idle_note = False
                need_obs = True
                await asyncio.sleep(0.5)
                continue
            idle_note = True

            # A new task, or re-arming the mode, must start a fresh chunk
            # instead of finishing the previous plan.
            if pol.get("task") != last_task or pol.get("mode") != last_mode:
                last_task, last_mode = pol.get("task"), pol.get("mode")
                need_obs = True

            try:
                st = get_json(a.panel + "/api/state")
            except (urllib.error.URLError, OSError) as exc:
                print(f"brak stanu ramienia: {exc}", flush=True)
                await asyncio.sleep(1.0)
                continue
            q = st.get("q")
            if not q:
                print("ramie bez feedbacku CAN", flush=True)
                await asyncio.sleep(1.0)
                continue

            if need_obs or obs is None:
                obs = build_obs(head, wrist, zeros_img, q,
                                pol.get("task", ""))
                step = 0
                # A chunk computed on black frames holds position for the next
                # 16 steps and looks exactly like "the policy does nothing",
                # so fingerprint the images that actually went into it.
                h_img = obs["images"]["head_rgb"]
                w_img = obs["images"]["left_wrist_rgb"]
                print(f"  [recompute] task={obs['task']!r} "
                      f"head mean {h_img.mean():6.1f} std {h_img.std():5.1f} "
                      f"({head.count} klatek) | "
                      f"wrist mean {w_img.mean():6.1f} std {w_img.std():5.1f} "
                      f"({wrist.count} klatek)", flush=True)

            await ws.send(packb(obs))
            res = unpackb(await ws.recv())
            dt = (time.perf_counter() - t0) * 1000
            if "error" in res:
                print("BLAD serwera:", res["error"], flush=True)
                need_obs = True
                await asyncio.sleep(1.0)
                continue
            need_obs = bool(res.get("need_obs", True))

            act = res["action"]
            tgt = np.asarray(act["left_arm"], dtype=float).reshape(-1)[:6]
            cur = np.asarray(q[:6], dtype=float)
            grip = act.get("left_gripper")
            payload = {"target": [float(x) for x in tgt],
                       "measured": [float(x) for x in cur],
                       "gripper": (float(np.asarray(grip).reshape(-1)[0])
                                   if grip is not None else None),
                       "dt_ms": dt,
                       "task": obs["task"]}
            try:
                ack = post_json(a.panel + "/api/policy/pred", payload)
            except (urllib.error.URLError, OSError) as exc:
                print(f"push predykcji padl: {exc}", flush=True)
                ack = {}

            print(f"krok {step:2d} {dt:6.0f} ms | delta(deg) "
                  f"{np.round((tgt - cur) * DEG, 1)} | "
                  f"tryb={ack.get('mode')} applied={ack.get('applied')} "
                  f"{ack.get('detail', '')}", flush=True)
            step += 1
            await asyncio.sleep(max(0.0, period - (time.perf_counter() - t0)))


if __name__ == "__main__":
    asyncio.run(main())
