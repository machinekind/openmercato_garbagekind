#!/usr/bin/env python3
"""Web panel for the Galaxea A1X: camera view, joint state, agent chat.

    python3 webpanel/server.py [--iface can0] [--cameras robot:listen://]
                               [--port 8080] [--slew 30]

Routes:
    /                    the panel (video + chat + joint state)
    /stream/{name}       multipart MJPEG for one camera
    /ws                  WebSocket: arm state @15 Hz + events down, commands up
    /api/state           arm snapshot (same payload as the WS "state" message)
    /api/events?since=N  event ring buffer (poll fallback for the agent)
    /api/event           POST an event (agent -> panel; chat/status/alert/log)
    /api/presets         named poses and their descriptions
    /health              camera + arm diagnostics

Trust model:
    Connections from the agent network (--agent-net, the direct cable by
    default) get the AGENT role: preset / pantilt / move_joints / chat only,
    and only while the operator has engaged with agent control allowed.
    Everything else is an OPERATOR: engage, enable, jog, grip, stop.
    REST carries no motion at all, and REST events may not claim to come
    from the operator.

The panel must be the ONLY transmitter on the bus - do not run
so101_bridge.py / teleop scripts / the ROS driver with TX enabled at the
same time (two writers on 0x050 interleave and the arm sees garbage).
"""
from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import logging
import os

from aiohttp import web, WSMsgType

import safety
from arm_ctl import ArmController, urdf_limits
from camera import Camera
from events import EventBus

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_HZ = 15.0
BOUNDARY = "galaxeoframe"
OPERATOR = "operator"
AGENT = "agent"
AGENT_CMDS = {"preset", "pantilt", "move_joints", "chat"}

log = logging.getLogger("server")


# --- roles -----------------------------------------------------------------

def role_of(request: web.Request) -> str:
    """AGENT for peers on the agent network, OPERATOR for anyone else."""
    peer = request.remote or ""
    try:
        if ipaddress.ip_address(peer) in request.app["agent_net"]:
            return AGENT
    except ValueError:
        pass
    return OPERATOR


# --- plain routes ----------------------------------------------------------

async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(os.path.join(HERE, "static", "index.html"))


async def health(request: web.Request) -> web.Response:
    return web.json_response({
        "arm": request.app["arm"].snapshot(),
        "cameras": {name: {"device": cam.device, "frames": cam.frames_read,
                           "last_error": cam.last_error}
                    for name, cam in request.app["cameras"].items()},
        "your_role": role_of(request),
    })


async def stream(request: web.Request) -> web.StreamResponse:
    """Multipart MJPEG. Each client gets the latest frame, never a backlog."""
    name = request.match_info.get("name")
    cams: dict[str, Camera] = request.app["cameras"]
    if name is None:                     # bare /stream -> first camera
        name = next(iter(cams))
    cam = cams.get(name)
    if cam is None:
        raise web.HTTPNotFound(text=f"no camera {name!r}")
    resp = web.StreamResponse(status=200, headers={
        "Content-Type": f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        "Cache-Control": "no-store",
    })
    await resp.prepare(request)
    try:
        while True:
            frame = await cam.next_frame()
            if frame is None:
                continue
            await resp.write(
                f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\n"
                f"Content-Length: {len(frame)}\r\n\r\n".encode()
                + frame + b"\r\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


# --- REST ------------------------------------------------------------------

async def api_state(request: web.Request) -> web.Response:
    return web.json_response(request.app["arm"].snapshot())


async def api_presets(request: web.Request) -> web.Response:
    return web.json_response({"presets": request.app["env"].describe()})


async def api_events(request: web.Request) -> web.Response:
    try:
        since = int(request.query.get("since", "0"))
    except ValueError:
        raise web.HTTPBadRequest(text="since must be an integer")
    return web.json_response({"events": request.app["bus"].since(since)})


async def api_event(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise web.HTTPBadRequest(text="body must be JSON")
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text="body must be a JSON object")
    sender = str(body.get("from", "unknown"))
    # The operator identity exists only on the WS; nothing over REST may
    # wear it, or an agent could put words in the operator's mouth.
    if sender == OPERATOR:
        raise web.HTTPForbidden(text="REST events may not claim 'operator'")
    event = request.app["bus"].publish(
        kind=str(body.get("kind", "log")), sender=sender,
        text=str(body.get("text", "")), image=body.get("image"))
    return web.json_response({"ok": True, "seq": event["seq"]})


async def api_map_post(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        raise web.HTTPBadRequest(text="body must be JSON")
    world = body.get("map") if isinstance(body, dict) else None
    request.app["map"] = world if isinstance(world, dict) else {}
    return web.json_response({"ok": True})


async def api_map_get(request: web.Request) -> web.Response:
    return web.json_response({"map": request.app["map"]})


# --- WebSocket -------------------------------------------------------------

def handle_command(app: web.Application, role: str,
                   msg: dict) -> tuple[bool, str]:
    """Dispatch one client command; returns (ok, human-readable detail)."""
    arm: ArmController = app["arm"]
    cmd = msg.get("cmd")

    if role == AGENT and cmd not in AGENT_CMDS:
        return False, f"{cmd!r} is operator-only"

    if cmd == "chat":
        text = str(msg.get("text", "")).strip()
        if not text:
            return False, "chat: empty text"
        # The agent filters its own chat by sender name, so speak under the
        # name it knows itself by - otherwise it would answer itself.
        sender = app["agent_name"] if role == AGENT else OPERATOR
        app["bus"].publish("chat", sender, text)
        return True, "sent"

    if cmd in ("preset", "pantilt", "move_joints") and role == AGENT \
            and not arm.snapshot()["agent_control"]:
        return False, "agent control is switched off by the operator"

    if cmd == "engage":
        via = AGENT if arm.snapshot()["agent_control"] else OPERATOR
        detail = arm.engage(via)
        return detail.startswith("engaged"), detail
    if cmd in ("disengage", "stop"):
        return True, arm.disengage()
    if cmd == "grip_probe":
        detail = arm.request_grip_probe()
        return detail.startswith("gripper probe"), detail
    if cmd == "enable":
        detail = arm.request_enable()
        return detail.startswith("enable sequence"), detail
    if cmd == "agent_control":
        return True, arm.set_agent_control(bool(msg.get("value", True)))
    if cmd == "preset":
        detail = arm.goto_preset(str(msg.get("name", "")))
        return detail == "ok", detail
    if cmd == "move_joints":
        deltas = msg.get("deltas")
        if not isinstance(deltas, list):
            return False, "move_joints: missing deltas"
        try:
            detail = arm.move_joints([float(x) for x in deltas])
        except (TypeError, ValueError):
            return False, "move_joints: deltas must be numbers"
        return detail == "ok", detail
    if cmd == "pantilt":
        try:
            deltas = [0.0] * safety.N
            deltas[0] = float(msg.get("dpan", 0.0))    # radians, capped
            deltas[2] = float(msg.get("dtilt", 0.0))
            detail = arm.move_joints(deltas)
        except (TypeError, ValueError):
            return False, "pantilt: dpan/dtilt must be numbers"
        return detail == "ok", detail
    if cmd == "goal":
        joints = msg.get("joints")
        if not isinstance(joints, list):
            return False, "goal: missing joints"
        try:
            detail = arm.set_goal([float(x) for x in joints])
        except (TypeError, ValueError):
            return False, "goal: joints must be numbers"
        return detail == "ok", detail
    if cmd == "jog":
        try:
            detail = arm.jog(int(msg.get("joint", -1)),
                             float(msg.get("delta_deg", 0.0)))
        except (TypeError, ValueError):
            return False, "jog: bad arguments"
        return detail == "ok", detail
    if cmd == "grip":
        try:
            detail = arm.set_grip(float(msg.get("value", 0.0)))
        except (TypeError, ValueError):
            return False, "grip: bad value"
        return detail == "ok", detail
    return False, f"unknown command: {cmd!r}"


async def websocket(request: web.Request) -> web.WebSocketResponse:
    app = request.app
    arm: ArmController = app["arm"]
    role = role_of(request)
    ws = web.WebSocketResponse(heartbeat=10.0)
    await ws.prepare(request)
    app["ws_clients"].add((ws, role))
    log.info("ws client %s connected as %s", request.remote, role)

    queue = app["bus"].subscribe()

    async def push_state() -> None:
        while not ws.closed:
            await ws.send_json({"type": "state", **arm.snapshot()})
            await asyncio.sleep(1.0 / STATE_HZ)

    async def push_events() -> None:
        while not ws.closed:
            event = await queue.get()
            await ws.send_json(event)

    loop = asyncio.get_running_loop()
    tasks = [loop.create_task(push_state()), loop.create_task(push_events())]
    try:
        async for raw in ws:
            if raw.type != WSMsgType.TEXT:
                continue
            try:
                msg = json.loads(raw.data)
            except json.JSONDecodeError:
                await ws.send_json({"type": "result", "ok": False,
                                    "detail": "bad JSON"})
                continue
            ok, detail = handle_command(app, role, msg)
            await ws.send_json({"type": "result", "cmd": msg.get("cmd"),
                                "ok": ok, "detail": detail})
    finally:
        for task in tasks:
            task.cancel()
        app["bus"].unsubscribe(queue)
        app["ws_clients"].discard((ws, role))
        # A vanished operator must not leave the arm chasing an old goal.
        # The agent is not an operator: its WS dropping never holds the arm.
        if arm.engaged and role == OPERATOR:
            others = any(not c.closed and r == OPERATOR
                         for c, r in app["ws_clients"])
            if not others:
                log.warning("last operator left while engaged -> disengage")
                arm.disengage()
    return ws


# --- wiring ----------------------------------------------------------------

async def on_startup(app: web.Application) -> None:
    for cam in app["cameras"].values():
        cam.start()
    app["arm"].start()


async def on_cleanup(app: web.Application) -> None:
    for cam in app["cameras"].values():
        await cam.stop()
    app["arm"].stop()


def parse_cameras(spec: str, size: str) -> dict[str, Camera]:
    """"robot:listen://,pc:/dev/video0" -> {name: Camera}."""
    cams: dict[str, Camera] = {}
    for i, part in enumerate(p.strip() for p in spec.split(",") if p.strip()):
        name, sep, dev = part.partition(":")
        if not sep or dev.startswith("//"):     # bare device or bare URL
            name, dev = f"cam{i}", part
        cams[name.strip()] = Camera(dev.strip(), size=size)
    if not cams:
        raise SystemExit("no cameras in --cameras")
    return cams


def make_app(args: argparse.Namespace) -> web.Application:
    app = web.Application()
    lower, upper = urdf_limits()
    env = safety.load(args.presets, lower, upper)
    arm = ArmController(args.iface, envelope=env, slew_deg_s=args.slew,
                        kp=args.kp, kd=args.kd)

    app["env"] = env
    app["arm"] = arm
    app["cameras"] = parse_cameras(args.cameras, args.size)
    app["bus"] = EventBus()
    app["ws_clients"] = set()
    app["map"] = {}
    app["agent_net"] = ipaddress.ip_network(args.agent_net)
    app["agent_name"] = args.agent_name

    app.router.add_get("/", index)
    app.router.add_get("/health", health)
    app.router.add_get("/stream", stream)
    app.router.add_get("/stream/{name}", stream)
    app.router.add_get("/ws", websocket)
    app.router.add_get("/api/state", api_state)
    app.router.add_get("/api/presets", api_presets)
    app.router.add_get("/api/events", api_events)
    app.router.add_post("/api/event", api_event)
    app.router.add_get("/api/map", api_map_get)
    app.router.add_post("/api/map", api_map_post)
    app.router.add_static("/static", os.path.join(HERE, "static"))
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--iface", default="can0")
    ap.add_argument("--cameras", default="robot:listen://",
                    help='comma list of name:device. Device is a local '
                         '/dev/videoN, listen://[ip[:port]] (the DGX agent '
                         'owns its camera and pushes frames to us), '
                         'ssh://host/dev/videoN or '
                         'sshtcp://host/dev/videoN?via=addr&pass=1 (we start '
                         'the remote capture ourselves - only when the agent '
                         'is NOT running)')
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--presets", default=safety.DEFAULT_PRESETS)
    ap.add_argument("--agent-net", default="10.42.0.0/24",
                    help="peers on this network get the agent role")
    ap.add_argument("--agent-name", default="a1x",
                    help="name the agent posts under (a1x.config.AGENT_NAME)")
    ap.add_argument("--slew", type=float, default=30.0,
                    help="deg/s slew cap on the arm (conservative default)")
    ap.add_argument("--kp", type=float, default=20.0)
    ap.add_argument("--kd", type=float, default=1.0)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    web.run_app(make_app(a), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
