"""Tool schemas (single source of truth, verbatim from spec E) and their
async implementations.

Every implementation returns a ToolResult: compact JSON content for the
tool-role message, plus zero or more (caption, jpeg) frames that the caller
injects as user-role image messages (spec E pattern).

Motion tools (goto_preset, pan_tilt) go over the panel WS and NEVER
swallow errors: a PanelError is caught explicitly, logged, and returned to
the model as {"ok": false, "error": ...}.
"""

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any

from . import cameras, config, detectors
from .panel_client import PanelClient, PanelError

log = logging.getLogger(__name__)

# --- Tool JSON schemas: passed verbatim as tools=[...] (spec E) --------------

TOOLS = [
 {"type":"function","function":{"name":"list_presets","description":"List the whitelisted camera view presets with descriptions.","parameters":{"type":"object","properties":{},"required":[]}}},
 {"type":"function","function":{"name":"look","description":"Turn the camera one step in a direction. left/right rotate the arm base by 30 degrees per call (many calls sweep the whole workspace). up/down tilt the view by 10 degrees per call (tilt is limited to a fixed safe band; at the band edge the call reports no movement). Motion takes 1-3 s; ALWAYS get_view after moving.","parameters":{"type":"object","properties":{"direction":{"type":"string","enum":["left","right","up","down"]}},"required":["direction"]}}},
 {"type":"function","function":{"name":"get_view","description":"Capture the current frame from a camera and attach it to the conversation.","parameters":{"type":"object","properties":{"camera":{"type":"string","enum":["robot","side"]}},"required":["camera"]}}},
 {"type":"function","function":{"name":"detect","description":"Run an object detector on the current frame and return boxes/counts as JSON.","parameters":{"type":"object","properties":{"camera":{"type":"string","enum":["robot","side"]},"model":{"type":"string","enum":["people","ppe","cans","hazards"]},"annotated":{"type":"boolean","description":"If true, also attach the annotated image","default":False}},"required":["camera","model"]}}},
 {"type":"function","function":{"name":"count_cans","description":"Count beverage cans visible from a camera (YOLOE). Returns count and boxes.","parameters":{"type":"object","properties":{"camera":{"type":"string","enum":["robot","side"],"default":"robot"}},"required":[]}}},
 {"type":"function","function":{"name":"set_tracking","description":"Enable/disable the automatic person tracker: when on, the camera follows one randomly chosen person while they are visible, and sweeps the workspace searching for the next person when nobody is in view. Needs the arm engaged.","parameters":{"type":"object","properties":{"enabled":{"type":"boolean"}},"required":["enabled"]}}},
 {"type":"function","function":{"name":"set_loop","description":"Enable/disable the continuous autonomous monitoring loop, optionally with a new objective (what to watch for) and interval in seconds (min 15). While enabled, you run a cycle every interval and report one status line.","parameters":{"type":"object","properties":{"enabled":{"type":"boolean"},"objective":{"type":"string"},"interval_s":{"type":"integer","minimum":15}},"required":["enabled"]}}},
 {"type":"function","function":{"name":"set_patrol","description":"Enable/disable patrol mode or change its interval.","parameters":{"type":"object","properties":{"enabled":{"type":"boolean"},"interval_s":{"type":"integer","minimum":60,"default":300}},"required":["enabled"]}}},
 {"type":"function","function":{"name":"scan_environment","description":"Systematically sweep the whole pan range sector by sector, run object+can+people detection at every stop, and build/update the persistent world map (what is where, by pan angle). Takes about a minute; the arm must be engaged. Returns the completed map.","parameters":{"type":"object","properties":{},"required":[]}}},
 {"type":"function","function":{"name":"get_map","description":"The persistent world map from previous scans: per pan sector, which objects were detected there and when. Use it to answer 'where is X' and to decide where to look.","parameters":{"type":"object","properties":{},"required":[]}}},
 {"type":"function","function":{"name":"get_position","description":"Where the camera points right now: base pan angle and tilt angle in degrees, their allowed ranges and step sizes, and which pan sectors were already viewed for the current goal. Use it to plan systematic sweeps and avoid re-looking at covered sectors.","parameters":{"type":"object","properties":{},"required":[]}}},
 {"type":"function","function":{"name":"get_arm_state","description":"Current arm joint state / engaged flag from the panel.","parameters":{"type":"object","properties":{},"required":[]}}},
]

FRAME_MAX_AGE_S = 5.0


@dataclass
class ToolResult:
    content: str
    images: list[tuple[str, bytes]] = field(default_factory=list)


def _ok(**kwargs: Any) -> str:
    return json.dumps({"ok": True, **kwargs})


def _err(error: str, **kwargs: Any) -> str:
    return json.dumps({"ok": False, "error": error, **kwargs})


async def wait_goal_reached(panel: PanelClient,
                            timeout: float = config.PATROL_GOAL_TIMEOUT_S
                            ) -> bool:
    """Wait for the panel state to report the goal reached.

    The panel snapshot shape is not pinned by the spec; try, in order:
    explicit goal flags, a moving flag, joint-position stability, and
    finally a fixed dwell.
    """
    state = panel.latest_state
    if any(k in state for k in ("goal_reached", "at_goal")):
        done = await panel.wait_state(
            lambda s: bool(s.get("goal_reached") or s.get("at_goal")),
            timeout)
        return done is not None
    if "moving" in state:
        await asyncio.sleep(0.5)  # let motion start before testing the flag
        done = await panel.wait_state(
            lambda s: s.get("moving") is False, timeout - 0.5)
        return done is not None

    joints_key = next((k for k in ("q", "joints", "positions")
                       if isinstance(state.get(k), list)), None)
    if joints_key is None:
        await asyncio.sleep(min(3.0, timeout))  # blind dwell fallback
        return True

    deadline = time.monotonic() + timeout
    await asyncio.sleep(min(1.0, timeout / 2))  # grace: motion ramp-up
    prev = None
    while time.monotonic() < deadline:
        cur = panel.latest_state.get(joints_key)
        if isinstance(cur, list) and prev is not None and len(cur) == len(prev):
            if max(abs(a - b) for a, b in zip(cur, prev)) < 0.005:
                return True
        prev = cur
        await asyncio.sleep(0.3)
    return False


class ToolExecutor:
    """Binds the tool implementations to the live subsystems."""

    def __init__(self, panel: PanelClient,
                 robot_slot: cameras.FrameSlot,
                 side_slot: cameras.FrameSlot,
                 patrol_ctl):
        self.panel = panel
        self._slots = {"robot": robot_slot, "side": side_slot}
        self.patrol_ctl = patrol_ctl  # patrol.PatrolTask (set via main)
        self.visited_sectors: set[int] = set()  # pan sectors seen this goal
        self.world_map: dict[str, dict] = self._load_world_map()

    # -- world map -------------------------------------------------------------

    @staticmethod
    def _load_world_map() -> dict:
        try:
            with open(config.WORLDMAP_PATH) as f:
                m = json.load(f)
            return m if isinstance(m, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_world_map(self) -> None:
        try:
            with open(config.WORLDMAP_PATH, "w") as f:
                json.dump(self.world_map, f)
        except OSError as exc:
            log.warning("world map save failed: %s", exc)
        # Mirror to the panel's radar view (fire-and-forget).
        try:
            asyncio.get_running_loop().create_task(
                self.panel.post_map(self.world_map))
        except RuntimeError:
            pass  # no loop (unit context) — file save already succeeded

    def map_digest(self) -> str:
        """Compact 'what is where' line for context injection."""
        if not self.world_map:
            return "world map empty (run scan_environment)"
        parts = []
        for sec in sorted(self.world_map, key=lambda s: int(s)):
            counts = self.world_map[sec].get("counts", {})
            if counts:
                objs = ",".join(f"{k}x{v}" if v > 1 else k
                                for k, v in sorted(counts.items()))
                parts.append(f"{sec}deg:{objs}")
        return "map: " + ("; ".join(parts) if parts else "nothing detected")

    # -- frame access ---------------------------------------------------------

    def _grab(self, camera: str) -> tuple[bytes, Any]:
        slot = self._slots.get(camera)
        if slot is None:
            raise ValueError(f"unknown camera {camera!r}")
        jpeg, t = slot.get_jpeg()
        if jpeg is None or time.time() - t > FRAME_MAX_AGE_S:
            raise ValueError(
                f"no fresh frame from {camera!r} camera "
                f"(age {slot.age_s:.1f}s)")
        bgr, _ = slot.get_bgr()
        if bgr is None:
            raise ValueError(f"could not decode {camera!r} frame")
        return jpeg, bgr

    @staticmethod
    def _caption(camera: str, note: str = "") -> str:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
        extra = f" {note}" if note else ""
        return f"[frame: {camera}{extra}, {stamp}]"

    # -- dispatch -------------------------------------------------------------

    async def execute(self, name: str, args: dict[str, Any]) -> ToolResult:
        handler = getattr(self, f"_tool_{name}", None)
        if handler is None:
            return ToolResult(_err(f"unknown tool {name!r}"))
        try:
            return await handler(args)
        except (ValueError, detectors.DetectorError) as exc:
            log.warning("tool %s failed: %s", name, exc)
            return ToolResult(_err(str(exc)))
        except Exception as exc:  # noqa: BLE001 — a tool crash must never
            # kill the episode/loop; the model gets the error and adapts.
            log.exception("tool %s crashed", name)
            return ToolResult(_err(f"tool {name} crashed: {exc}"))

    # -- implementations ------------------------------------------------------

    async def _tool_list_presets(self, args: dict) -> ToolResult:
        try:
            presets = await self.panel.get_presets()
        except PanelError as exc:
            return ToolResult(_err(f"panel unreachable: {exc}"))
        compact = {name: p.get("desc", "") if isinstance(p, dict) else ""
                   for name, p in presets.items()}
        return ToolResult(_ok(presets=compact))

    async def _tool_goto_preset(self, args: dict) -> ToolResult:
        name = args.get("name")
        if not isinstance(name, str) or not name:
            return ToolResult(_err("goto_preset requires a preset name"))
        try:
            ok, detail = await self.panel.send_cmd(
                {"cmd": "preset", "name": name})
        except PanelError as exc:
            log.error("goto_preset(%s) send failed: %s", name, exc)
            return ToolResult(_err(f"motion command failed: {exc}"))
        if not ok:
            log.warning("goto_preset(%s) refused: %s", name, detail)
            return ToolResult(_err(f"panel refused preset: {detail}"))
        reached = await wait_goal_reached(self.panel)
        return ToolResult(_ok(preset=name, goal_reached=reached))

    async def _tool_pan_tilt(self, args: dict) -> ToolResult:
        try:
            dpan = float(args["dpan"])
            dtilt = float(args["dtilt"])
        except (KeyError, TypeError, ValueError):
            return ToolResult(_err("pan_tilt requires numeric dpan and dtilt"))
        try:
            ok, detail = await self.panel.send_cmd(
                {"cmd": "pantilt", "dpan": dpan, "dtilt": dtilt})
        except PanelError as exc:
            log.error("pan_tilt(%.3f, %.3f) send failed: %s",
                      dpan, dtilt, exc)
            return ToolResult(_err(f"motion command failed: {exc}"))
        if not ok:
            log.warning("pan_tilt refused: %s", detail)
            return ToolResult(_err(f"panel refused pantilt: {detail}"))
        await asyncio.sleep(0.8)  # small nudge; panel clamps server-side
        return ToolResult(_ok(dpan=dpan, dtilt=dtilt,
                              note="deltas clamped server-side"))

    # Navigation constants mirroring the panel-enforced envelope.
    PAN_RANGE_DEG = (-165.0, 165.0)
    TILT_WINDOW_DEG = (-70.0, -10.0)
    PAN_STEP_DEG = 30.0
    TILT_STEP_DEG = 10.0

    def _angles_deg(self) -> tuple[float, float] | None:
        q = (self.panel.latest_state or {}).get("q")
        if not q or len(q) < 3:
            return None
        return math.degrees(q[0]), math.degrees(q[2])

    def _mark_visited(self) -> None:
        a = self._angles_deg()
        if a is not None:
            sector = int(round(a[0] / self.PAN_STEP_DEG) * self.PAN_STEP_DEG)
            self.visited_sectors.add(sector)

    def pose_summary(self) -> str:
        """One-line navigation context injected into every ReAct step."""
        a = self._angles_deg()
        if a is None:
            return "pose unknown (no arm state yet)"
        pan, tilt = a
        seen = sorted(self.visited_sectors)
        return (f"pan {pan:+.0f}deg (range -165..+165, 30deg/step), "
                f"tilt {tilt:+.0f}deg (window -70..-10, 10deg/step), "
                f"pan sectors viewed this goal: {seen if seen else 'none'}; "
                f"{self.map_digest()}")

    # look steps (rad): left/right on the base (j index 0), up/down on the
    # elbow (j index 2). Signs: +j0 = left; +j2 = view up (toward the -10 deg
    # end of the panel-enforced window).
    _LOOK_DELTAS = {
        "left":  (0, math.radians(30.0)),
        "right": (0, -math.radians(30.0)),
        "up":    (2, math.radians(10.0)),
        "down":  (2, -math.radians(10.0)),
    }

    async def _tool_look(self, args: dict) -> ToolResult:
        direction = args.get("direction")
        if direction not in self._LOOK_DELTAS:
            return ToolResult(_err("look requires direction "
                                   "left|right|up|down"))
        joint, delta = self._LOOK_DELTAS[direction]
        deltas = [0.0] * 6
        deltas[joint] = delta
        try:
            ok, detail = await self.panel.send_cmd({"cmd": "move_joints",
                                                    "deltas": deltas})
        except PanelError as exc:
            log.error("look(%s) send failed: %s", direction, exc)
            return ToolResult(_err(f"motion command failed: {exc}"))
        if not ok:
            log.warning("look(%s) refused: %s", direction, detail)
            return ToolResult(_err(f"panel refused move: {detail}"))
        reached = await wait_goal_reached(self.panel)
        self._mark_visited()
        return ToolResult(_ok(direction=direction, goal_reached=reached,
                              pose=self.pose_summary(),
                              note="step clamped server-side; at a limit the "
                                   "view may not change"))

    async def _pan_to(self, target_deg: float, tries: int = 12) -> bool:
        """Drive the base to target_deg via repeated clamped relative steps."""
        for _ in range(tries):
            a = self._angles_deg()
            if a is None:
                return False
            err = target_deg - a[0]
            if abs(err) <= 3.0:
                return True
            step = math.radians(max(-self.PAN_STEP_DEG,
                                    min(self.PAN_STEP_DEG, err)))
            deltas = [0.0] * 6
            deltas[0] = step
            ok, detail = await self.panel.send_cmd(
                {"cmd": "move_joints", "deltas": deltas})
            if not ok:
                log.warning("_pan_to: move refused: %s", detail)
                return False
            await wait_goal_reached(self.panel)
        a = self._angles_deg()
        return a is not None and abs(target_deg - a[0]) <= 6.0

    async def _tool_scan_environment(self, args: dict) -> ToolResult:
        state = self.panel.latest_state or {}
        if not state.get("engaged"):
            return ToolResult(_err("not engaged — ask the operator to press "
                                   "Engage, then scan"))
        lo, hi = self.PAN_RANGE_DEG
        sectors = [s for s in range(int(lo) + 15, int(hi) - 14,
                                    int(self.PAN_STEP_DEG))]
        scanned = 0
        for sec in sectors:
            if not await self._pan_to(float(sec)):
                continue
            await asyncio.sleep(0.6)          # let the image settle
            _jpeg, bgr = self._grab("robot")
            counts: dict[str, int] = {}
            boxes: list[dict] = []
            for model in ("people", "cans"):
                try:
                    r = await detectors.detect(model, bgr)
                    boxes.extend(r["boxes"])
                    for k, v in r["counts"].items():
                        counts[k] = counts.get(k, 0) + v
                except detectors.DetectorError:
                    pass
            self.world_map[str(sec)] = {"counts": counts, "t": time.time()}
            self._mark_visited()
            scanned += 1
            ann = cameras.reencode_jpeg_max_edge(
                detectors.annotate(bgr, {"boxes": boxes}))
            asyncio.get_running_loop().create_task(self.panel.post_event(
                "log", f"scan {sec:+d}deg: "
                       f"{counts if counts else 'nothing'}", image_jpeg=ann))
        self._save_world_map()
        return ToolResult(_ok(scanned_sectors=scanned,
                              map=self.world_map,
                              digest=self.map_digest()))

    async def _tool_get_map(self, args: dict) -> ToolResult:
        return ToolResult(_ok(map=self.world_map, digest=self.map_digest()))

    async def _tool_get_position(self, args: dict) -> ToolResult:
        a = self._angles_deg()
        if a is None:
            return ToolResult(_err("no arm state yet"))
        return ToolResult(_ok(
            pan_deg=round(a[0]), tilt_deg=round(a[1]),
            pan_range_deg=list(self.PAN_RANGE_DEG),
            tilt_window_deg=list(self.TILT_WINDOW_DEG),
            pan_step_deg=self.PAN_STEP_DEG, tilt_step_deg=self.TILT_STEP_DEG,
            visited_pan_sectors_deg=sorted(self.visited_sectors),
            engaged=bool((self.panel.latest_state or {}).get("engaged"))))

    async def _tool_get_view(self, args: dict) -> ToolResult:
        camera = args.get("camera")
        if camera not in self._slots:
            return ToolResult(_err("camera must be 'robot' or 'side'"))
        jpeg, _bgr = self._grab(camera)
        small = cameras.reencode_jpeg_max_edge(jpeg)
        caption = self._caption(camera)
        return ToolResult(_ok(camera=camera, attached=True, caption=caption),
                          images=[(caption, small)])

    async def _tool_detect(self, args: dict) -> ToolResult:
        camera = args.get("camera")
        model = args.get("model")
        annotated = bool(args.get("annotated", False))
        if camera not in self._slots:
            return ToolResult(_err("camera must be 'robot' or 'side'"))
        if model not in detectors.MODELS:
            return ToolResult(_err(f"model must be one of {detectors.MODELS}"))
        _jpeg, bgr = self._grab(camera)
        result = await detectors.detect(model, bgr)
        ann = detectors.annotate(bgr, result)
        ann = cameras.reencode_jpeg_max_edge(ann)
        # Always show the operator what the detector saw (fire-and-forget).
        asyncio.get_running_loop().create_task(self.panel.post_event(
            "log", f"{model} on {camera}: total {result.get('total', 0)} "
                   f"{result.get('counts', {})}", image_jpeg=ann))
        images: list[tuple[str, bytes]] = []
        if annotated:
            caption = self._caption(camera, f"annotated:{model}")
            images.append((caption, ann))
        return ToolResult(json.dumps({"ok": True, **result}), images=images)

    async def _tool_count_cans(self, args: dict) -> ToolResult:
        camera = args.get("camera", "robot")
        if camera not in self._slots:
            return ToolResult(_err("camera must be 'robot' or 'side'"))
        _jpeg, bgr = self._grab(camera)
        result = await detectors.detect("cans", bgr)
        ann = cameras.reencode_jpeg_max_edge(detectors.annotate(bgr, result))
        asyncio.get_running_loop().create_task(self.panel.post_event(
            "log", f"cans on {camera}: {result['total']}", image_jpeg=ann))
        return ToolResult(_ok(camera=camera, count=result["total"],
                              boxes=result["boxes"]))

    async def _tool_set_tracking(self, args: dict) -> ToolResult:
        if getattr(self, "tracker_ctl", None) is None:
            return ToolResult(_err("tracker not wired"))
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            return ToolResult(_err("set_tracking requires boolean 'enabled'"))
        if enabled and getattr(self, "loop_ctl", None) is not None:
            self.loop_ctl.set_loop(False)      # tracking is exclusive
        if enabled and self.patrol_ctl is not None:
            self.patrol_ctl.set_patrol(False)
        status = self.tracker_ctl.set_tracking(enabled)
        return ToolResult(_ok(**status))

    async def _tool_set_loop(self, args: dict) -> ToolResult:
        if getattr(self, "loop_ctl", None) is None:
            return ToolResult(_err("loop control not wired"))
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            return ToolResult(_err("set_loop requires boolean 'enabled'"))
        status = self.loop_ctl.set_loop(
            enabled,
            objective=args.get("objective"),
            interval_s=args.get("interval_s"))
        return ToolResult(_ok(**status))

    async def _tool_set_patrol(self, args: dict) -> ToolResult:
        if self.patrol_ctl is None:
            return ToolResult(_err("patrol controller not available"))
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            return ToolResult(_err("set_patrol requires boolean 'enabled'"))
        interval = args.get("interval_s")
        if interval is not None:
            try:
                interval = max(int(interval), config.PATROL_MIN_INTERVAL_S)
            except (TypeError, ValueError):
                return ToolResult(_err("interval_s must be an integer"))
        status = self.patrol_ctl.set_patrol(enabled, interval)
        return ToolResult(_ok(**status))

    async def _tool_get_arm_state(self, args: dict) -> ToolResult:
        state = self.panel.latest_state
        if state and time.time() - self.panel.state_t < 1.0:
            return ToolResult(_ok(source="ws", state=state))
        try:
            state = await self.panel.get_state_rest()
        except PanelError as exc:
            return ToolResult(_err(f"panel unreachable: {exc}"))
        return ToolResult(_ok(source="rest", state=state))
