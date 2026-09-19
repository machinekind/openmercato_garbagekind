"""Patrol/alert state machine (spec G).

Default OFF; toggled through the set_patrol tool (operator chat). Each
cycle walks the preset route, waits for the panel to reach each goal,
runs the cheap detectors first, and only invokes the VLM on a trigger or
every Nth cycle. Alerts are two-frame confirmed (PPE) or VLM-verified
(open-vocab hazards), deduped for 10 minutes, and their annotated JPEGs
are kept in a 7-day ring buffer on DGX disk.

Pause rules: patrol pauses while the operator has the arm engaged and
resumes 60 s after disengage; chat episodes preempt patrol between
presets (shared episode lock), never mid-move.
"""

import asyncio
import json
import logging
import re
import time
from typing import Any

import cv2

from . import cameras, config, detectors
from .llm import LLMClient, image_user_message
from .panel_client import PanelClient, PanelError
from .tools import wait_goal_reached

log = logging.getLogger(__name__)

_VLM_SYSTEM = (
    "You are a workspace safety monitor. Answer briefly and factually "
    "about what the attached camera frame shows.")


def _in_empty_hours(now: float | None = None) -> bool:
    if config.PATROL_EMPTY_HOURS is None:
        return False
    start, end = config.PATROL_EMPTY_HOURS
    hour = time.localtime(now).tm_hour
    if start <= end:
        return start <= hour < end
    return hour >= start or hour < end


class PatrolTask:
    def __init__(self, panel: PanelClient, robot_slot: cameras.FrameSlot,
                 side_slot: cameras.FrameSlot, llm: LLMClient,
                 episode_lock: asyncio.Lock):
        self.panel = panel
        self.robot_slot = robot_slot
        self.side_slot = side_slot
        self.llm = llm
        self.episode_lock = episode_lock

        self.enabled = False
        self.interval_s = config.PATROL_INTERVAL_S
        self._cycle_count = 0
        self._alert_last: dict[str, float] = {}   # key -> last emit time
        self._stable_cans: dict[str, int] = {}    # preset -> baseline count
        self._own_motion_until = 0.0
        self._last_disengaged_t = 0.0
        self._was_engaged = False

    # -- control (called from the set_patrol tool) ----------------------------

    def set_patrol(self, enabled: bool,
                   interval_s: int | None = None) -> dict[str, Any]:
        self.enabled = enabled
        if interval_s is not None:
            self.interval_s = max(interval_s, config.PATROL_MIN_INTERVAL_S)
        log.info("patrol: enabled=%s interval=%ds",
                 self.enabled, self.interval_s)
        return {"patrol_enabled": self.enabled,
                "interval_s": self.interval_s}

    # -- operator-engage pause -------------------------------------------------

    def _operator_engaged(self) -> bool:
        """True while the arm is engaged by someone other than this agent.

        The snapshot shape is not pinned: prefer an engaged_via field when
        present; otherwise treat any engaged=True outside our own motion
        window as operator activity.
        """
        state = self.panel.latest_state
        engaged = bool(state.get("engaged"))
        if not engaged:
            if self._was_engaged:
                self._last_disengaged_t = time.time()
            self._was_engaged = False
            return False
        self._was_engaged = True
        via = state.get("engaged_via")
        if via is not None and str(via) in (config.AGENT_NAME, "agent",
                                            "api"):
            return False
        # via == "ws" is AMBIGUOUS: the panel cannot say which WS client
        # engaged (the agent's own motion also goes over a WS), so fall
        # through to the motion-window heuristic — engaged outside our own
        # motion window means operator activity. Treating every "ws" as
        # operator would deadlock patrol (paused whenever motion is
        # possible, refused whenever it is not).
        return time.time() > self._own_motion_until

    def _pause_reason(self) -> str | None:
        if self._operator_engaged():
            return "operator engaged"
        since = time.time() - self._last_disengaged_t
        if (self._last_disengaged_t
                and since < config.PATROL_RESUME_AFTER_DISENGAGE_S):
            return f"post-disengage hold ({since:.0f}s)"
        return None

    # -- main loop -------------------------------------------------------------

    async def run(self) -> None:
        while True:
            if not self.enabled:
                await asyncio.sleep(1.0)
                continue
            reason = self._pause_reason()
            if reason:
                log.debug("patrol: paused (%s)", reason)
                await asyncio.sleep(2.0)
                continue
            started = time.monotonic()
            try:
                await self._cycle()
            except (PanelError, detectors.DetectorError, ValueError) as exc:
                log.error("patrol cycle failed: %s", exc)
                await self.panel.post_event(
                    "status", f"patrol cycle failed: {exc}")
            elapsed = time.monotonic() - started
            remaining = max(self.interval_s - elapsed, 1.0)
            while remaining > 0 and self.enabled:
                await asyncio.sleep(min(remaining, 1.0))
                remaining -= 1.0

    async def _cycle(self) -> None:
        self._cycle_count += 1
        vlm_cycle = self._cycle_count % config.PATROL_VLM_EVERY_N_CYCLES == 0
        totals = {"people": 0, "cans": 0, "violations": 0, "hazards": 0}
        for preset in config.PATROL_ROUTE:
            if not self.enabled:
                return
            if self._pause_reason():
                return
            # Chat preempts patrol between presets: episodes and preset
            # visits share this lock; we never yield mid-move.
            async with self.episode_lock:
                await self._visit(preset, totals, vlm_cycle)
        await self.panel.post_event(
            "status",
            f"patrol ok, {totals['people']} people, {totals['cans']} cans, "
            f"{totals['violations']} PPE violations, "
            f"{totals['hazards']} hazards")

    # -- one preset visit ------------------------------------------------------

    async def _visit(self, preset: str, totals: dict[str, int],
                     vlm_cycle: bool) -> None:
        self._own_motion_until = time.time() + config.PATROL_GOAL_TIMEOUT_S + 5
        try:
            ok, detail = await self.panel.send_cmd(
                {"cmd": "preset", "name": preset})
        except PanelError as exc:
            log.error("patrol: goto_preset(%s) failed: %s", preset, exc)
            raise
        if not ok:
            # A refused preset (not engaged / unknown preset) is a cycle
            # failure — never report "patrol ok" for a route that never
            # moved.
            raise PanelError(
                f"panel refused preset {preset!r}: {detail}")
        reached = await wait_goal_reached(self.panel)
        if not reached:
            log.warning("patrol: %s goal not confirmed within timeout", preset)
        await asyncio.sleep(config.PATROL_SETTLE_S)
        self._own_motion_until = 0.0

        frames = self._grab_frames()
        if not frames:
            log.warning("patrol: no fresh frames at %s, skipping", preset)
            return

        for camera, bgr in frames.items():
            people = await detectors.detect("people", bgr)
            n_people = people["counts"].get("person", 0)
            totals["people"] += n_people

            if n_people and _in_empty_hours():
                await self._alert(
                    key=f"empty-hours:{camera}",
                    text=(f"{n_people} person(s) during empty hours "
                          f"({camera} cam @ {preset})"),
                    bgr=bgr, det=people)

            if camera == "side" and n_people:
                await self._check_ppe(preset, bgr, totals)

            if camera == "robot" and preset in config.PATROL_CANS_PRESETS:
                await self._check_cans(preset, bgr, totals)

            if camera == "robot" and preset in config.PATROL_HAZARDS_PRESETS:
                await self._check_hazards(preset, bgr, totals)

        if vlm_cycle:
            await self._vlm_summary(preset, frames)

    def _grab_frames(self) -> dict[str, Any]:
        frames: dict[str, Any] = {}
        for camera, slot in (("robot", self.robot_slot),
                             ("side", self.side_slot)):
            bgr, t = slot.get_bgr()
            if bgr is not None and time.time() - t < 5.0:
                frames[camera] = bgr
        return frames

    # -- triggers --------------------------------------------------------------

    async def _check_ppe(self, preset: str, bgr, totals: dict) -> None:
        first = await detectors.detect("ppe", bgr,
                                       conf=config.PATROL_PPE_CONF)
        # Detector class names are normalized to snake_case ("no-helmet" ->
        # "no_helmet"). The interim HF PPE model has NO no-vest class; a
        # no_vest signal only exists once the construction-PPE fine-tune
        # (T5) lands, so filtering on it here would be dead code.
        bad = [b for b in first["boxes"] if b["cls"] == "no_helmet"]
        if not bad:
            return
        # Two-frame confirmation: re-grab and re-run after a short gap.
        await asyncio.sleep(config.PATROL_CONFIRM_GAP_S)
        bgr2, t2 = self.side_slot.get_bgr()
        if bgr2 is None or time.time() - t2 > 5.0:
            return
        second = await detectors.detect("ppe", bgr2,
                                        conf=config.PATROL_PPE_CONF)
        bad2 = [b for b in second["boxes"] if b["cls"] == "no_helmet"]
        if not bad2:
            return
        classes = sorted({b["cls"] for b in bad2})
        totals["violations"] += len(bad2)
        await self._alert(
            key=f"ppe:{','.join(classes)}",
            text=(f"PPE violation {classes} x{len(bad2)} "
                  f"(side cam @ {preset}, 2-frame confirmed)"),
            bgr=bgr2, det=second)

    async def _check_cans(self, preset: str, bgr, totals: dict) -> None:
        result = await detectors.detect("cans", bgr)
        count = result["total"]
        totals["cans"] += count
        baseline = self._stable_cans.get(preset)
        if baseline is not None and \
                abs(count - baseline) >= config.PATROL_CAN_DELTA_ALERT:
            await self._alert(
                key=f"cans:{preset}",
                text=(f"can count changed {baseline} -> {count} "
                      f"(robot cam @ {preset})"),
                bgr=bgr, det=result)
        # Re-baseline every visit so a persistent change alerts once.
        self._stable_cans[preset] = count

    async def _check_hazards(self, preset: str, bgr, totals: dict) -> None:
        first = await detectors.detect("hazards", bgr,
                                       conf=config.PATROL_HAZARD_CONF)
        if not first["boxes"]:
            return
        # Two-frame confirmation (open-vocab YOLOE is noisy).
        await asyncio.sleep(config.PATROL_CONFIRM_GAP_S)
        bgr2, t2 = self.robot_slot.get_bgr()
        if bgr2 is None or time.time() - t2 > 5.0:
            return
        second = await detectors.detect("hazards", bgr2,
                                        conf=config.PATROL_HAZARD_CONF)
        if not second["boxes"]:
            return
        classes = sorted({b["cls"] for b in second["boxes"]})
        # VLM verification before alerting.
        confirmed = await self._vlm_confirm_hazard(bgr2, classes)
        if not confirmed:
            log.info("patrol: hazard %s at %s rejected by VLM", classes,
                     preset)
            return
        totals["hazards"] += len(second["boxes"])
        await self._alert(
            key=f"hazard:{','.join(classes)}",
            text=(f"hazard {classes} (robot cam @ {preset}, "
                  "detector 2-frame + VLM confirmed)"),
            bgr=bgr2, det=second)

    # -- VLM calls -------------------------------------------------------------

    async def _vlm_confirm_hazard(self, bgr, classes: list[str]) -> bool:
        ok, raw = cv2.imencode(".jpg", bgr)
        if not ok:
            log.error("patrol: hazard frame encode failed; keeping alert")
            return True
        jpeg = cameras.reencode_jpeg_max_edge(raw.tobytes())
        question = (
            f"A detector flagged possible hazards {classes} in this frame. "
            "Look carefully. Reply with exactly YES if any such hazard is "
            "really visible, otherwise exactly NO.")
        messages = [
            {"role": "system", "content": _VLM_SYSTEM},
            image_user_message(f"[patrol hazard check] {question}", jpeg),
        ]
        try:
            reply = await self.llm.chat(messages, tools=None, max_tokens=8)
        except Exception as exc:  # noqa: BLE001 — VLM is best-effort here
            log.error("patrol: VLM hazard confirm failed (%s); "
                      "alerting on detector evidence alone", exc)
            return True
        return bool(re.search(r"\byes\b", (reply.content or "").lower()))

    async def _vlm_summary(self, preset: str, frames: dict) -> None:
        bgr = frames.get("robot")
        if bgr is None:
            bgr = frames.get("side")
        if bgr is None:
            return
        ok, jpeg = cv2.imencode(".jpg", bgr)
        if not ok:
            return
        small = cameras.reencode_jpeg_max_edge(jpeg.tobytes())
        messages = [
            {"role": "system", "content": _VLM_SYSTEM},
            image_user_message(
                f"[patrol summary @ {preset}] Anything notable in this "
                "workspace frame? One short sentence.", small),
        ]
        try:
            reply = await self.llm.chat(messages, tools=None, max_tokens=80)
        except Exception as exc:  # noqa: BLE001 — summary is best-effort
            log.error("patrol: VLM summary failed: %s", exc)
            return
        text = (reply.content or "").strip()
        if text:
            await self.panel.post_event("status", f"patrol VLM: {text}")

    # -- alerting --------------------------------------------------------------

    async def _alert(self, key: str, text: str, bgr, det: dict) -> None:
        now = time.time()
        last = self._alert_last.get(key, 0.0)
        if now - last < config.PATROL_ALERT_DEDUPE_S:
            log.info("patrol: alert %r suppressed (dedupe)", key)
            return
        self._alert_last[key] = now
        filename = self._save_alert_jpeg(key, bgr, det)
        suffix = f" [{filename}]" if filename else ""
        await self.panel.post_event("alert", text + suffix)
        log.warning("patrol ALERT: %s%s", text, suffix)

    def _save_alert_jpeg(self, key: str, bgr, det: dict) -> str | None:
        try:
            config.ALERTS_DIR.mkdir(parents=True, exist_ok=True)
            safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
            name = f"{time.strftime('%Y%m%d-%H%M%S')}_{safe}.jpg"
            path = config.ALERTS_DIR / name
            path.write_bytes(detectors.annotate(bgr, det))
            cutoff = time.time() - config.ALERTS_MAX_AGE_S
            for old in config.ALERTS_DIR.glob("*.jpg"):
                if old.stat().st_mtime < cutoff:
                    old.unlink(missing_ok=True)
            return name
        except OSError as exc:
            log.error("patrol: could not save alert JPEG: %s", exc)
            return None
