"""Bridge entry point: claim a task, drive the arm, report, repeat.

    python -m om_bridge.main --policy g05      # G0.5 on the DGX
    python -m om_bridge.main --policy preset   # no GPU, preset walk only

Environment (see config.py): OM_BASE_URL, OM_API_KEY, OM_ROBOT_CELL_ID,
A1X_PANEL_URL, A1X_POLICY_URL.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import socket

import aiohttp

from .config import BridgeConfig, ConfigError
from .om_client import OpenMercatoClient
from .panel import PanelArm, PanelError
from .pick import PickRunner, PickSettings
from .policy import G05Policy, PresetPolicy
from .types import PickResult, PickStage, TaskStatus

log = logging.getLogger("om_bridge")


async def run_forever(cfg: BridgeConfig, policy_kind: str, stop: asyncio.Event) -> None:
    bridge_name = f"{socket.gethostname()}/{policy_kind}"
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=30)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        arm = PanelArm(session, cfg.panel_base_url, cfg.goal_timeout_s)
        sink = OpenMercatoClient(session, cfg.om_base_url, cfg.om_api_key, bridge_name)
        policy = (
            G05Policy(cfg.policy_url or "ws://127.0.0.1:8765")
            if policy_kind == "g05"
            else PresetPolicy([cfg.search_preset, cfg.home_preset])
        )
        settings = PickSettings(
            home_preset=cfg.home_preset,
            search_preset=cfg.search_preset,
            goal_timeout_s=cfg.goal_timeout_s,
        )

        while not stop.is_set():
            try:
                task = await sink.claim(cfg.cell_id)
            except Exception as exc:  # noqa: BLE001 - a flaky app must not kill the bridge
                log.warning("claim failed: %s", exc)
                await _sleep_or_stop(stop, cfg.poll_interval_s)
                continue

            if task is None:
                await _sleep_or_stop(stop, cfg.poll_interval_s)
                continue

            log.info("claimed %s: %s", task.id, task.instruction)
            result = await _run_one(arm, policy, sink, settings, task, policy_kind)
            with contextlib.suppress(Exception):
                await sink.finish(result)
            log.info("finished %s: %s (%s)", task.id, result.status.value, result.detail)


async def _run_one(arm, policy, sink, settings, task, policy_kind: str) -> PickResult:
    """Connect what this attempt needs, run it, and always tear it down."""
    try:
        await arm.connect()
        await arm.check_role()
        if policy_kind == "g05":
            await policy.connect()
    except (PanelError, Exception) as exc:  # noqa: BLE001 - reported, not raised
        return PickResult(task.id, TaskStatus.FAILED, PickStage.ENGAGING, f"setup failed: {exc}")

    try:
        return await PickRunner(arm, policy, sink, settings).run(task)
    finally:
        with contextlib.suppress(Exception):
            await arm.close()
        if policy_kind == "g05":
            with contextlib.suppress(Exception):
                await policy.close()


async def _sleep_or_stop(stop: asyncio.Event, seconds: float) -> None:
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(stop.wait(), timeout=seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="Open Mercato <-> A1X pick bridge")
    parser.add_argument("--policy", choices=("g05", "preset"), default="preset")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    try:
        cfg = BridgeConfig.from_env()
    except ConfigError as exc:
        raise SystemExit(f"configuration error: {exc}") from exc

    async def runner() -> None:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, stop.set)
        await run_forever(cfg, args.policy, stop)

    asyncio.run(runner())


if __name__ == "__main__":
    main()
