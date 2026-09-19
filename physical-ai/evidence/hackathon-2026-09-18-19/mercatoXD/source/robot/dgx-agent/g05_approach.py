#!/usr/bin/env python3
"""Run one G0.5 command on the A1X and watch what it does. One process.

    python ~/g05/approach.py --task "pick up the can"

It engages the arm itself and holds that same panel connection for the whole
run - the panel auto-disengages when the last operator disconnects, so
engaging from a separate process races against this one and loses.

Per round: read the pose, grab both cameras, sample plans until one actually
moves (sampling is stochastic - the same observation yields a real reach one
time and a hold the next), then play that plan out step by step.

Safety, on top of the panel's own envelope clamp, slew limit and engage gate:
  * MAX_TOTAL_DEG - refuse a plan that wanders further than this from the
    pose the round started at;
  * MAX_STEP_DEG  - refuse a single step that jumps further than this;
  * any refusal from the panel aborts the run and disengages.

Disengaging always runs, including on Ctrl-C.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import urllib.request

import cv2
import numpy as np
import websockets
from g05.utils.websocket import packb, unpackb

PANEL = "http://192.168.220.102:8080"
POLICY = "ws://127.0.0.1:8765"
# Both cameras hang off the laptop and reach us through the panel:
#   /stream/robot - bench overhead view  -> head_rgb
#   /stream/wrist - camera on the gripper -> left_wrist_rgb
DEG = 180.0 / math.pi

MAX_TOTAL_DEG = 40.0
MAX_STEP_DEG = 12.0


def grab_stream(path, size=(640, 480)):
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


def panel_state():
    with urllib.request.urlopen(PANEL + "/api/state", timeout=5) as r:
        return json.load(r)


async def panel_cmd(ws, msg) -> tuple[bool, str]:
    """Send one panel command and wait for its result, skipping state pushes."""
    await ws.send(json.dumps(msg))
    while True:
        ack = json.loads(await ws.recv())
        if ack.get("type") == "result":
            return bool(ack.get("ok")), str(ack.get("detail", ""))


async def plan(policy_ws, obs, start, min_move, tries):
    """Sample chunks until one moves at least min_move degrees."""
    for attempt in range(tries):
        steps = []
        for _ in range(16):
            await policy_ws.send(packb(obs))
            res = unpackb(await policy_ws.recv())
            if "error" in res:
                print("BLAD serwera:", res["error"])
                return None, 0.0
            steps.append(
                np.asarray(res["action"]["left_arm"], float).reshape(-1)[:6])
        cand = np.asarray(steps)
        move = float(np.max(np.abs((cand - start) * DEG)))
        print(f"    plan {attempt + 1}: {move:5.1f} deg")
        if move >= min_move:
            return cand, move
    return None, 0.0


async def play(panel_ws, traj, hz) -> bool:
    """Feed a plan to the panel one step at a time. False = aborted."""
    for i, tgt in enumerate(traj):
        cur = np.asarray(panel_state()["q"][:6], float)
        jump = float(np.max(np.abs((tgt - cur) * DEG)))
        if jump > MAX_STEP_DEG:
            print(f"    PRZERWANE na kroku {i}: skok {jump:.1f} deg")
            return False
        ok, detail = await panel_cmd(
            panel_ws, {"cmd": "goal", "joints": [float(x) for x in tgt]})
        if not ok:
            print(f"    PRZERWANE: panel odmowil - {detail}")
            return False
        if i % 4 == 0 or i == len(traj) - 1:
            print(f"    krok {i:2d}  cel {np.round(tgt * DEG, 1)}  "
                  f"teraz {np.round(cur * DEG, 1)}")
        await asyncio.sleep(1.0 / hz)
    return True


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", default="pick up the can")
    ap.add_argument("--rounds", type=int, default=3,
                    help="observe -> plan -> move cycles")
    ap.add_argument("--hz", type=float, default=4.0)
    ap.add_argument("--min-move", type=float, default=6.0)
    ap.add_argument("--tries", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not panel_state().get("q"):
        print("brak feedbacku CAN")
        return 1

    panel_ws = None
    try:
        if not a.dry_run:
            panel_ws = await websockets.connect(
                PANEL.replace("http://", "ws://") + "/ws", ping_interval=20)
            ok, detail = await panel_cmd(panel_ws, {"cmd": "engage"})
            print(f"engage: {ok} - {detail}")
            if not ok:
                return 1

        async with websockets.connect(POLICY, max_size=None,
                                      ping_interval=30) as pol:
            await pol.recv()
            for rnd in range(a.rounds):
                st = panel_state()
                start = np.asarray(st["q"][:6], float)
                head = grab_stream("/stream/robot")
                wrist = grab_stream("/stream/wrist")
                print(f"\n=== runda {rnd + 1}/{a.rounds} ===")
                print("  poza:", np.round(start * DEG, 1),
                      f"| klatki head {head.mean():.0f} wrist {wrist.mean():.0f}")

                obs = {"images": {"head_rgb": head, "left_wrist_rgb": wrist,
                                  "right_wrist_rgb": np.zeros((3, 480, 640),
                                                              np.uint8)},
                       "state": {"left_arm": start.astype(np.float32),
                                 "left_gripper": np.asarray([st["q"][6]],
                                                            np.float32),
                                 "right_arm": np.zeros(6, np.float32),
                                 "right_gripper": np.zeros(1, np.float32)},
                       "task": a.task, "embodiment_type": "galaxea_r1lite"}

                traj, move = await plan(pol, obs, start, a.min_move, a.tries)
                if traj is None:
                    print(f"  zaden z {a.tries} planow nie ruszyl sie "
                          f"o {a.min_move} deg - koniec")
                    break
                if move > MAX_TOTAL_DEG:
                    print(f"  ODMOWA: plan siega {move:.1f} deg "
                          f"> limit {MAX_TOTAL_DEG}")
                    break
                print(f"  gram plan {move:.1f} deg -> "
                      f"{np.round(traj[-1] * DEG, 1)}")
                if a.dry_run:
                    continue
                if not await play(panel_ws, traj, a.hz):
                    break
                end = np.asarray(panel_state()["q"][:6], float)
                print("  przejechane:", np.round((end - start) * DEG, 1))
    finally:
        if panel_ws is not None:
            try:
                ok, detail = await panel_cmd(panel_ws, {"cmd": "disengage"})
                print(f"\ndisengage: {detail}")
            finally:
                await panel_ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
