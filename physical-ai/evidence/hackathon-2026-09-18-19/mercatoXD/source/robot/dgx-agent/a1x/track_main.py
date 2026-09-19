"""Tracker-only entrypoint: NO VLM anywhere in the process.

Runs: robot camera (owner + push to panel), live YOLO/face overlay on the
pushed stream, and the person tracker (TRACK/SEARCH automaton). The panel
chat accepts exactly two commands — "start tracking" / "stop tracking"
(the panel's Agent/Tracking buttons send the same strings); anything else
gets a fixed reply. The full VLM stack lives in a1x.main — swap the
entrypoint back when reasoning is wanted again.

    venv/bin/python -m a1x.track_main
"""
from __future__ import annotations

import asyncio
import logging
import signal

import aiohttp

from . import config
from .cameras import FrameSlot, OverlayState, RobotCamera
from .main import OverlayTask, _supervise
from .panel_client import PanelClient
from .tracker import TrackerTask

log = logging.getLogger("a1x.track")


class CommandLoop:
    """Deterministic chat handling: tracking on/off, nothing else."""

    def __init__(self, panel: PanelClient, tracker: TrackerTask) -> None:
        self.panel = panel
        self.tracker = tracker

    async def run(self) -> None:
        while True:
            event = await self.panel.events.get()
            if event.get("kind") != "chat":
                continue
            if str(event.get("from", "")) == config.AGENT_NAME:
                continue
            text = str(event.get("text", "")).strip().lower().strip(" .!")
            if text in ("start tracking", "track people", "tracking on"):
                self.tracker.set_tracking(True)
                await self.panel.post_event(
                    "chat", "TRACKING ON — following people, sweeping when "
                            "nobody is visible (needs Engage)")
            elif text in ("stop tracking", "tracking off"):
                self.tracker.set_tracking(False)
                await self.panel.post_event("chat", "tracking off — idle")
            else:
                await self.panel.post_event(
                    "chat", "tracker-only build (VLM removed): commands are "
                            "'start tracking' / 'stop tracking'")


async def amain() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    robot_slot = FrameSlot("robot")
    overlay = OverlayState()
    robot_cam = RobotCamera(robot_slot, overlay)
    robot_cam.start()
    overlay_task = OverlayTask(robot_slot, overlay)

    timeout = aiohttp.ClientTimeout(total=None)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        panel = PanelClient(session)
        # Dummy episode lock: no VLM episodes exist to preempt the tracker.
        tracker = TrackerTask(panel, robot_slot, asyncio.Lock())
        commands = CommandLoop(panel, tracker)

        tasks = [
            asyncio.create_task(_supervise("panel-ws", panel.run_ws),
                                name="panel-ws"),
            asyncio.create_task(
                _supervise("event-poll", panel.run_event_poll_fallback),
                name="event-poll"),
            asyncio.create_task(_supervise("overlay", overlay_task.run),
                                name="overlay"),
            asyncio.create_task(_supervise("tracker", tracker.run),
                                name="tracker"),
            asyncio.create_task(_supervise("commands", commands.run),
                                name="commands"),
        ]

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        log.info("tracker-only build up (no VLM in this process)")
        await panel.post_event(
            "status", "tracker-only build started — VLM removed; "
                      "'start tracking' to begin")
        try:
            await stop.wait()
        finally:
            log.info("shutting down")
            for t in tasks:
                t.cancel()
            robot_cam.stop()


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()
