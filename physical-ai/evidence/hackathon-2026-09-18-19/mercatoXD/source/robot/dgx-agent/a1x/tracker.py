"""Person tracker: a two-state camera automaton (TRACK / SEARCH) built on
Ultralytics' native multi-object tracking (ByteTrack) with persistent IDs.

SEARCH  — sweep the pan range step by step until YOLO sees a person.
TRACK   — pick one person's TRACK ID (random on acquisition) and keep that
          identity centered with small proportional pan/tilt moves.
          ByteTrack keeps IDs stable across frames (survives people crossing
          and brief occlusions); after MISS_LIMIT cycles without the locked
          ID the target is declared lost and SEARCH resumes.

Pure YOLO + control math (~3 Hz vision, no VLM). Motion goes through the
panel's move_joints with all its server-side clamps; cycles pause while a
chat episode holds the episode lock.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import threading

from . import cameras, config, detectors
from .panel_client import PanelClient, PanelError

log = logging.getLogger(__name__)

CYCLE_S = 0.35                # vision cadence (~3 Hz keeps ByteTrack happy)
SEARCH_STEP_DEG = 30.0        # sweep step in SEARCH
PAN_LIMIT_DEG = 150.0         # sweep envelope (inside the J1 window)
DEADBAND_FRAC = 0.12          # no motion while target within this of center
PAN_GAIN_DEG = 22.0           # full-half-frame error -> this many degrees
TILT_GAIN_DEG = 8.0
PAN_STEP_CAP_DEG = 15.0       # per-cycle motion caps (panel clamps again)
TILT_STEP_CAP_DEG = 8.0
MISS_LIMIT = 9                # ~3 s without the locked ID before "lost"
TRACK_CONF = 0.4
# Flip these if the camera mounting inverts the image axes.
PAN_SIGN = 1.0                # +1: person left of center -> pan left (+J1)
TILT_SIGN = 1.0               # +1: person above center -> tilt up (+J3)

_model_lock = threading.Lock()


def _load_model():
    from ultralytics import YOLO
    engine = config.ENGINES_DIR / "yolo11m.engine"
    weights = config.WEIGHTS_DIR / "yolo11m.pt"
    path = engine if engine.is_file() else weights
    log.info("tracker: loading %s for ByteTrack", path)
    return YOLO(str(path), task="detect")


class TrackerTask:
    def __init__(self, panel: PanelClient, robot_slot: cameras.FrameSlot,
                 episode_lock: asyncio.Lock) -> None:
        self.panel = panel
        self.slot = robot_slot
        self.episode_lock = episode_lock
        self.enabled = False
        self.state = "search"
        self._target_id: int | None = None    # ByteTrack persistent ID
        self._miss = 0
        self._sweep_dir = 1.0
        self._wake = asyncio.Event()
        self._model = None

    def set_tracking(self, enabled: bool) -> dict:
        self.enabled = bool(enabled)
        if not enabled:
            self.state, self._target_id, self._miss = "search", None, 0
        self._wake.set()
        return {"enabled": self.enabled, "state": self.state,
                "target_id": self._target_id}

    # -- helpers --------------------------------------------------------------

    def _track_sync(self, bgr):
        """One ByteTrack step; returns [{'id', 'xyxy'}] for persons."""
        with _model_lock:
            if self._model is None:
                self._model = _load_model()
            results = self._model.track(
                bgr, persist=True, classes=[0], conf=TRACK_CONF,
                tracker="bytetrack.yaml", verbose=False)
        people = []
        if results and results[0].boxes is not None:
            for box in results[0].boxes:
                tid = None if box.id is None else int(box.id.item())
                people.append({"id": tid,
                               "xyxy": [int(v) for v in
                                        box.xyxy[0].tolist()]})
        return people

    async def _people(self):
        bgr, _t = self.slot.get_bgr()
        if bgr is None or self.slot.age_s > 2.0:
            return None, []
        try:
            people = await asyncio.to_thread(self._track_sync, bgr)
        except Exception as exc:  # noqa: BLE001 — tracker must survive
            log.warning("tracker inference failed: %s", exc)
            return bgr, []
        return bgr, people

    async def _move(self, dpan_deg: float, dtilt_deg: float) -> bool:
        deltas = [0.0] * 6
        deltas[0] = math.radians(dpan_deg)
        deltas[2] = math.radians(dtilt_deg)
        try:
            await self.panel.send_cmd({"cmd": "move_joints", "deltas": deltas})
            return True
        except PanelError as exc:
            log.warning("tracker move refused: %s", exc)
            return False

    def _pan_deg(self) -> float | None:
        q = (self.panel.latest_state or {}).get("q")
        return math.degrees(q[0]) if q and len(q) >= 1 else None

    @staticmethod
    def _center(box) -> tuple[float, float]:
        x1, y1, x2, y2 = box["xyxy"]
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    async def _aim_point(self, bgr, person) -> tuple[float, float]:
        """Aim at the locked person's FACE when one is visible inside their
        box; otherwise at the head region (upper part of the person box)."""
        px1, py1, px2, py2 = person["xyxy"]
        try:
            r = await detectors.detect("faces", bgr, conf=0.35)
            faces = []
            for b in r["boxes"]:
                fx, fy = self._center(b)
                if px1 <= fx <= px2 and py1 <= fy <= py2:
                    x1, y1, x2, y2 = b["xyxy"]
                    faces.append(((x2 - x1) * (y2 - y1), (fx, fy)))
            if faces:
                return max(faces)[1]           # largest face in the box
        except detectors.DetectorError:
            pass
        # Head-region fallback: person turned away or face model offline.
        return ((px1 + px2) / 2.0, py1 + 0.18 * (py2 - py1))

    # -- states ---------------------------------------------------------------

    async def _search_cycle(self) -> None:
        _bgr, people = await self._people()
        with_id = [p for p in people if p["id"] is not None]
        if with_id:
            target = random.choice(with_id)
            self._target_id = target["id"]
            self._miss = 0
            self.state = "track"
            await self.panel.post_event(
                "status", f"tracker: locked person id={self._target_id} "
                          f"({len(with_id)} visible) — following")
            return
        pan = self._pan_deg()
        if pan is None:
            return
        if pan >= PAN_LIMIT_DEG:
            self._sweep_dir = -1.0
        elif pan <= -PAN_LIMIT_DEG:
            self._sweep_dir = 1.0
        await self._move(self._sweep_dir * SEARCH_STEP_DEG, 0.0)
        await asyncio.sleep(1.0)          # let the sweep step settle

    async def _track_cycle(self) -> None:
        bgr, people = await self._people()
        if bgr is None:
            return
        h, w = bgr.shape[:2]
        target = next((p for p in people if p["id"] == self._target_id), None)
        if target is None:
            self._miss += 1
            if self._miss >= MISS_LIMIT:
                lost = self._target_id
                self.state, self._target_id, self._miss = "search", None, 0
                await self.panel.post_event(
                    "status", f"tracker: lost person id={lost} — searching")
            return
        self._miss = 0
        cx, cy = await self._aim_point(bgr, target)
        ex = (cx - w / 2.0) / (w / 2.0)          # -1..1, + = right of center
        ey = (cy - h / 2.0) / (h / 2.0)          # -1..1, + = below center
        dpan = dtilt = 0.0
        if abs(ex) > DEADBAND_FRAC:
            dpan = -PAN_SIGN * ex * PAN_GAIN_DEG
            dpan = max(-PAN_STEP_CAP_DEG, min(PAN_STEP_CAP_DEG, dpan))
        if abs(ey) > DEADBAND_FRAC:
            dtilt = -TILT_SIGN * ey * TILT_GAIN_DEG
            dtilt = max(-TILT_STEP_CAP_DEG, min(TILT_STEP_CAP_DEG, dtilt))
        if dpan or dtilt:
            await self._move(dpan, dtilt)

    # -- main loop ------------------------------------------------------------

    async def run(self) -> None:
        while True:
            if not self.enabled:
                self._wake.clear()
                await self._wake.wait()
                continue
            if self.episode_lock.locked():
                await asyncio.sleep(CYCLE_S)   # chat goal has the arm
                continue
            state = self.panel.latest_state or {}
            if not state.get("engaged"):
                await asyncio.sleep(2.0)
                continue
            try:
                if self.state == "search":
                    await self._search_cycle()
                else:
                    await self._track_cycle()
            except Exception:  # noqa: BLE001 — tracker must survive
                log.exception("tracker cycle failed")
            await asyncio.sleep(CYCLE_S)
