#!/usr/bin/env python3
"""Live SO-101 leader joint states on a web page.

Reads the leader arm over the Feetech bus in a background thread and
streams the normalized joint positions to the browser via SSE.

Usage:
    python3 so101_web.py [--port /dev/ttyACM0] [--cal-id my_leader_arm]
                         [--http-port 8090] [--rate 30]

Then open http://localhost:8090
"""
import argparse
import asyncio
import json
import os
import sys
import threading
import time

sys.path.insert(0, "/home/bukareszt/Downloads/robbo/src")  # lerobot checkout
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from aiohttp import web

from so101_bridge import SO101

# Normalized ranges per joint (lerobot MotorNormMode): gripper 0..100, rest -100..100.
JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex",
          "wrist_flex", "wrist_roll", "gripper"]


class ArmReader:
    """Background thread polling the arm; latest state shared under a lock."""

    def __init__(self, port, cal_id, rate_hz):
        self.arm = SO101(port, cal_id)
        self.period = 1.0 / rate_hz
        self.lock = threading.Lock()
        self.state = {"ok": False, "joints": {}, "error": "not read yet",
                      "t": 0.0, "reads": 0, "errors": 0}
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                pos = self.arm.read()
                joints = {k.removesuffix(".pos"): round(v, 2)
                          for k, v in pos.items()}
                with self.lock:
                    self.state = {"ok": True, "joints": joints, "error": None,
                                  "t": time.time(),
                                  "reads": self.state["reads"] + 1,
                                  "errors": self.state["errors"]}
            except Exception as ex:
                with self.lock:
                    self.state = {**self.state, "ok": False, "error": str(ex),
                                  "errors": self.state["errors"] + 1}
            dt = time.monotonic() - t0
            if dt < self.period:
                time.sleep(self.period - dt)

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def close(self):
        self._stop.set()
        self.thread.join(timeout=1.0)
        self.arm.close()


PAGE = """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SO-101 Joints</title>
<style>
  :root { --bg:#111; --fg:#eee; --bar:#2d7ef7; --track:#2a2a2a; --dim:#888; }
  body { background:var(--bg); color:var(--fg); font-family:system-ui,monospace;
         max-width:640px; margin:2rem auto; padding:0 16px; }
  h1 { font-size:1.2rem; }
  .joint { margin:14px 0; }
  .row { display:flex; justify-content:space-between; font-size:0.95rem; }
  .val { font-variant-numeric:tabular-nums; }
  .track { position:relative; height:14px; background:var(--track);
           border-radius:7px; margin-top:4px; overflow:hidden; }
  .fill { position:absolute; top:0; bottom:0; background:var(--bar);
          transition:left 60ms linear, width 60ms linear; }
  .mid { position:absolute; left:50%; top:0; bottom:0; width:1px; background:#555; }
  #status { color:var(--dim); font-size:0.85rem; margin-top:1.2rem;
            white-space:pre-wrap; }
  #status.err { color:#f66; }
</style></head><body>
<h1>SO-101 leader — joint states</h1>
<div id="joints"></div>
<div id="status">connecting…</div>
<script>
const NAMES = __JOINTS__;
const box = document.getElementById("joints");
const rows = {};
for (const n of NAMES) {
  const d = document.createElement("div");
  d.className = "joint";
  d.innerHTML = `<div class="row"><span>${n}</span>
                 <span class="val" id="v-${n}">—</span></div>
                 <div class="track"><div class="mid"></div>
                 <div class="fill" id="b-${n}"></div></div>`;
  box.appendChild(d);
  rows[n] = { v: d.querySelector(`#v-${n}`), b: d.querySelector(`#b-${n}`) };
}
function setBar(name, val) {
  const bar = rows[name].b;
  if (name === "gripper") {              // 0..100 from the left
    bar.style.left = "0%";
    bar.style.width = Math.max(0, Math.min(100, val)) + "%";
  } else {                               // -100..100 around center
    const pct = Math.max(-100, Math.min(100, val)) / 2;  // -50..50
    bar.style.left = (50 + Math.min(0, pct)) + "%";
    bar.style.width = Math.abs(pct) + "%";
  }
}
const status = document.getElementById("status");
const es = new EventSource("/events");
es.onmessage = (e) => {
  const s = JSON.parse(e.data);
  if (s.ok) {
    for (const [n, v] of Object.entries(s.joints)) {
      if (!rows[n]) continue;
      rows[n].v.textContent = v.toFixed(2);
      setBar(n, v);
    }
    status.className = "";
    status.textContent = `reads ${s.reads}  bus errors ${s.errors}  ` +
                         `updated ${new Date(s.t*1000).toLocaleTimeString()}`;
  } else {
    status.className = "err";
    status.textContent = "read error: " + s.error;
  }
};
es.onerror = () => { status.className = "err";
                     status.textContent = "connection lost — retrying…"; };
</script></body></html>
"""


async def index(request):
    html = PAGE.replace("__JOINTS__", json.dumps(JOINTS))
    return web.Response(text=html, content_type="text/html")


async def state(request):
    return web.json_response(request.app["reader"].snapshot())


async def events(request):
    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    })
    await resp.prepare(request)
    reader = request.app["reader"]
    try:
        while True:
            snap = reader.snapshot()
            await resp.write(f"data: {json.dumps(snap)}\n\n".encode())
            await asyncio.sleep(request.app["period"])
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--cal-id", default="my_leader_arm")
    ap.add_argument("--http-port", type=int, default=8090)
    ap.add_argument("--rate", type=float, default=30.0, help="bus read Hz")
    a = ap.parse_args()

    reader = ArmReader(a.port, a.cal_id, a.rate)
    app = web.Application()
    app["reader"] = reader
    app["period"] = 1.0 / a.rate
    app.add_routes([web.get("/", index),
                    web.get("/state", state),
                    web.get("/events", events)])
    try:
        web.run_app(app, port=a.http_port)
    finally:
        reader.close()


if __name__ == "__main__":
    main()
