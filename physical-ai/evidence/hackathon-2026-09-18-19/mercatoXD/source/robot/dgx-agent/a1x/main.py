"""Asyncio entrypoint/supervisor for the A1X agent (spec E).

Runs, and restarts on crash, the concurrent pieces:
- camera task: robot-cam capture thread (owns /dev/video0, pushes JPEGs
  outbound to the panel) + async side-cam stream reader,
- panel WS client (+ REST event-poll fallback while the WS is down),
- chat task: one agentic episode per operator chat event (max 8 tool
  rounds), single episode at a time,
- patrol task (spec G).

The agent ignores chat events whose "from" is itself — no self-reply loop.
"""

import asyncio
import json
import logging
import signal
from typing import Any

import aiohttp

from . import config, detectors
from .cameras import FrameSlot, OverlayState, RobotCamera, SideCamReader
from .tracker import TrackerTask
from .llm import LLMClient, image_user_message
from .panel_client import PanelClient
from .patrol import PatrolTask
from .tools import TOOLS, ToolExecutor

log = logging.getLogger("a1x.main")

SYSTEM_PROMPT = (
    "You are A1X, an agent embodied in a camera mounted on a 6-joint robot "
    "arm, with a second fixed side camera. Every operator message is a GOAL. "
    "Pursue it as a ReAct loop: think briefly, act with a tool, observe the "
    "result, repeat — up to 20 steps — until the goal is achieved or you "
    "conclude it cannot be. Then give a short final report. When you write "
    "text together with a tool call, keep it to one line — it is shown live "
    "as your visible reasoning.\n"
    "Movement: the look tool turns your camera — left/right rotates the "
    "base 30 degrees per call (a full sweep of the workspace takes several "
    "calls in one direction), up/down tilts 10 degrees per call within a "
    "fixed safe band. Every message carries a [pose] line: your current pan "
    "and tilt angles and which pan sectors you already viewed this goal — "
    "navigate by it. get_position gives the same as a tool. To explore "
    "everything: sweep pan sector by sector to one limit, then the other, "
    "capturing a view at each stop and skipping sectors already viewed; add "
    "up/down at interesting spots. ALWAYS get_view after each look call. "
    "set_tracking turns on the automatic person tracker: the camera follows "
    "one randomly chosen person while visible and sweeps searching for the "
    "next person when nobody is in view — use it when asked to watch or "
    "follow people; it runs by itself until disabled. "
    "scan_environment does a full automated sweep and builds the persistent "
    "world map (also shown in [pose] as 'map:'); use it when asked to "
    "explore or when the map is empty/stale, and use get_map / the map "
    "digest to answer 'where is X' and to aim directly at known objects. "
    "If a move fails with 'not engaged', ask the operator to press Engage "
    "in the panel and continue with what you can see. Use detectors for "
    "counting and safety checks when available; if they are offline, rely "
    "on your own vision. You remember previous goals and observations — "
    "use that memory to compare and to avoid repeating work. Keep the "
    "final answer short and factual; it is shown in a small chat panel."
)

# Persistent chat history trimmed to this many messages between episodes
# (token/image pruning happens separately in llm.prune_history).
HISTORY_MAX_MESSAGES = 80


class ChatAgent:
    def __init__(self, panel: PanelClient, llm: LLMClient,
                 tool_executor: ToolExecutor, patrol: PatrolTask,
                 episode_lock: asyncio.Lock):
        self.panel = panel
        self.llm = llm
        self.tools = tool_executor
        self.patrol = patrol
        self.episode_lock = episode_lock
        self.history: list[dict[str, Any]] = []
        self.loop: "LoopTask | None" = None      # wired in amain()
        self.tracker = None                      # TrackerTask, wired in amain()
        self.memory: str = self._load_memory()

    # -- long-term memory -----------------------------------------------------

    @staticmethod
    def _load_memory() -> str:
        try:
            with open(config.MEMORY_PATH) as f:
                return str(json.load(f).get("summary", ""))
        except (OSError, json.JSONDecodeError, AttributeError):
            return ""

    def _save_memory(self) -> None:
        try:
            with open(config.MEMORY_PATH, "w") as f:
                json.dump({"summary": self.memory}, f)
        except OSError as exc:
            log.warning("memory save failed: %s", exc)

    async def _absorb_into_memory(self, dropped_texts: list[str]) -> None:
        """Merge trimmed history into the rolling memory note via the LLM."""
        material = "\n".join(t for t in dropped_texts if t)[:8000]
        if not material.strip():
            return
        prompt = (
            "You maintain the long-term memory of a workspace-monitoring "
            f"robot agent. Merge the OLD MEMORY and the NEW EVENTS into one "
            f"note of at most {config.MEMORY_MAX_WORDS} words. Keep: durable "
            "facts about the workspace, where objects are/were, people seen, "
            "operator preferences and standing instructions, unresolved "
            "observations with rough times. Drop: routine no-change chatter "
            "and tool mechanics.\n\n"
            f"OLD MEMORY:\n{self.memory or '(empty)'}\n\n"
            f"NEW EVENTS:\n{material}")
        try:
            message = await self.llm.chat(
                [{"role": "user", "content": prompt}], tools=None)
            summary = (message.content or "").strip()
            if summary:
                self.memory = summary
                self._save_memory()
                log.info("memory updated (%d chars)", len(summary))
        except Exception as exc:  # noqa: BLE001 — memory is best-effort
            log.warning("memory summarization failed: %s", exc)

    def _memory_message(self) -> dict[str, Any]:
        mem = self.memory or "(no long-term memory yet)"
        return {"role": "user",
                "content": f"[long-term memory]\n{mem}"}

    async def run(self) -> None:
        while True:
            event = await self.panel.events.get()
            if event.get("kind") != "chat":
                continue
            sender = str(event.get("from", ""))
            if sender == config.AGENT_NAME:
                continue  # our own broadcast echo — never self-reply
            text = str(event.get("text", "")).strip()
            if not text:
                continue
            if await self._handle_direct_command(text):
                continue
            if self.tracker is not None and self.tracker.enabled:
                # Hard mode split: while tracking, the VLM is fully off.
                await self.panel.post_event(
                    "chat", "tracking mode — VLM is off; switch to Agent "
                            "mode (or say 'stop tracking') to chat")
                continue
            try:
                await self.run_episode(sender, text)
            except Exception as exc:  # noqa: BLE001 — chat must survive
                log.exception("chat episode failed")
                await self.panel.post_event(
                    "status", f"chat episode failed: {exc}")

    async def _handle_direct_command(self, text: str) -> bool:
        """Deterministic fast path for patrol toggles (spec G)."""
        lowered = text.lower().strip(" .!")
        if lowered in ("start patrol", "patrol on"):
            status = self.patrol.set_patrol(True)
            await self.panel.post_event(
                "chat", f"patrol enabled (interval {status['interval_s']}s)")
            return True
        if lowered in ("stop patrol", "patrol off"):
            self.patrol.set_patrol(False)
            await self.panel.post_event("chat", "patrol disabled")
            return True
        if self.tracker is not None:
            if lowered in ("start tracking", "track people", "tracking on"):
                # Tracking is exclusive: VLM loop and patrol go dark.
                if self.loop is not None:
                    self.loop.set_loop(False)
                self.patrol.set_patrol(False)
                self.tracker.set_tracking(True)
                await self.panel.post_event(
                    "chat", "TRACKING MODE — pure YOLO + joint control, VLM "
                            "off. Say 'stop tracking' or press Agent to "
                            "return. (needs Engage)")
                return True
            if lowered in ("stop tracking", "tracking off"):
                self.tracker.set_tracking(False)
                await self.panel.post_event("chat", "tracker off")
                return True
        if self.loop is not None:
            if lowered in ("start loop", "loop on") or \
                    lowered.startswith("start loop:"):
                objective = text.partition(":")[2].strip() or None
                st = self.loop.set_loop(True, objective=objective)
                await self.panel.post_event(
                    "chat", f"loop ON every {st['interval_s']}s — "
                            f"{st['objective']}")
                return True
            if lowered in ("stop loop", "loop off"):
                self.loop.set_loop(False)
                await self.panel.post_event("chat", "loop off")
                return True
        return False

    async def run_episode(self, sender: str, text: str,
                          kind: str = "chat") -> None:
        """One agentic episode: tool loop until a plain-text answer."""
        async with self.episode_lock:
            if kind == "chat":
                self.tools.visited_sectors.clear()  # fresh goal, fresh map
            self.history.append({
                "role": "user",
                "content": f"{sender}: {text}\n"
                           f"[pose] {self.tools.pose_summary()}"})
            messages = [{"role": "system", "content": SYSTEM_PROMPT},
                        self._memory_message(),
                        *self.history]
            answered = False
            for _round in range(config.MAX_TOOL_ROUNDS):
                message = await self.llm.chat(messages, tools=TOOLS)
                assistant = self.llm.assistant_message_dict(message)
                messages.append(assistant)
                self.history.append(assistant)
                if not message.tool_calls:
                    answer = (message.content or "").strip() or "(no answer)"
                    await self.panel.post_event(kind, answer)
                    answered = True
                    break
                # Interleaved text next to a tool call = the ReAct "thought";
                # surface it live so the operator sees the agent reasoning.
                thought = (message.content or "").strip()
                if thought:
                    await self.panel.post_event("status", thought[:200])
                for call in message.tool_calls:
                    await self._run_tool_call(call, messages)
            if not answered:
                note = "I hit my tool budget without a final answer."
                self.history.append({"role": "user",
                                     "content": f"[system] {note}"})
                await self.panel.post_event("chat", note)
            self._trim_history()

    async def _run_tool_call(self, call, messages: list[dict]) -> None:
        try:
            args = json.loads(call.function.arguments or "{}")
            if not isinstance(args, dict):
                raise ValueError("arguments not an object")
        except (json.JSONDecodeError, ValueError) as exc:
            args = None
            error = f"bad tool arguments: {exc}"
        if args is None:
            result_content = json.dumps({"ok": False, "error": error})
            images: list[tuple[str, bytes]] = []
        else:
            log.info("tool call: %s(%s)", call.function.name, args)
            # Surface every function call in the panel chat log.
            arg_str = json.dumps(args)[:120] if args else ""
            await self.panel.post_event(
                "log", f"⚙ {call.function.name}({arg_str})")
            result = await self.tools.execute(call.function.name, args)
            result_content, images = result.content, result.images
        tool_msg = {"role": "tool", "tool_call_id": call.id,
                    "content": result_content}
        messages.append(tool_msg)
        self.history.append(tool_msg)
        # Frames ride in user-role messages, never tool-role (spec E).
        for caption, jpeg in images:
            frame_msg = image_user_message(caption, jpeg)
            messages.append(frame_msg)
            self.history.append(frame_msg)

    def _trim_history(self) -> None:
        if len(self.history) <= HISTORY_MAX_MESSAGES:
            return
        cut = len(self.history) - HISTORY_MAX_MESSAGES
        # Never start history on a tool reply (breaks tool-call pairing).
        while cut < len(self.history) and \
                self.history[cut].get("role") == "tool":
            cut += 1
        dropped = self.history[:cut]
        self.history = self.history[cut:]
        # Trimmed context becomes memory instead of vanishing.
        texts = []
        for m in dropped:
            c = m.get("content")
            if isinstance(c, str):
                texts.append(f"{m.get('role')}: {c[:400]}")
        asyncio.get_running_loop().create_task(
            self._absorb_into_memory(texts))


DEFAULT_LOOP_OBJECTIVE = (
    "Monitor the workspace continuously. Look around (move joints when "
    "engaged), track people, cans and anything unusual, and note changes "
    "since your previous observations."
)

LOOP_STEP_NUDGE = (
    "[loop] Objective: {objective}\n"
    "Continue the ReAct cycle: reason about what to check next, act with "
    "tools (move, look, detect), observe. When you have a meaningful "
    "observation for this step, reply with ONE short status line "
    "('no change' is fine). Then you will be called again."
)

# Max tool actions inside one reason-act step before we force a status line.
LOOP_STEP_MAX_ACTIONS = 6


class LoopTask:
    """Continuous ReAct loop: one persistent reason->act->observe chain over
    the shared chat history. Each step holds the episode lock (so operator
    chat preempts between steps, never mid-step), runs up to
    LOOP_STEP_MAX_ACTIONS tool calls, ends with a short status event, then
    yields for interval_s before the next step."""

    def __init__(self, chat: "ChatAgent", panel: PanelClient) -> None:
        self.chat = chat
        self.panel = panel
        self.enabled = False
        self.objective = DEFAULT_LOOP_OBJECTIVE
        self.interval_s = 20
        self._wake = asyncio.Event()

    def set_loop(self, enabled: bool, objective: str | None = None,
                 interval_s: int | None = None) -> dict:
        self.enabled = bool(enabled)
        if objective:
            self.objective = str(objective)
        if interval_s:
            self.interval_s = max(5, int(interval_s))
        self._wake.set()
        return {"enabled": self.enabled, "interval_s": self.interval_s,
                "objective": self.objective[:120]}

    async def _step(self) -> None:
        """One reason-act-observe step on the shared history."""
        chat = self.chat
        async with chat.episode_lock:
            chat.history.append({
                "role": "user",
                "content": LOOP_STEP_NUDGE.format(objective=self.objective)
                           + f"\n[pose] {chat.tools.pose_summary()}"})
            messages = [{"role": "system", "content": SYSTEM_PROMPT},
                        chat._memory_message(),
                        *chat.history]
            for _ in range(LOOP_STEP_MAX_ACTIONS + 1):
                message = await chat.llm.chat(messages, tools=TOOLS)
                assistant = chat.llm.assistant_message_dict(message)
                messages.append(assistant)
                chat.history.append(assistant)
                if not message.tool_calls:
                    status = (message.content or "").strip() or "no change"
                    await self.panel.post_event("status", status)
                    break
                for call in message.tool_calls:
                    await chat._run_tool_call(call, messages)
            else:
                await self.panel.post_event(
                    "status", "loop step hit action budget; continuing")
            chat._trim_history()

    async def run(self) -> None:
        while True:
            if not self.enabled:
                self._wake.clear()
                await self._wake.wait()
                continue
            try:
                await self._step()
            except Exception as exc:  # noqa: BLE001 — loop must survive
                log.exception("loop step failed")
                await self.panel.post_event("status",
                                            f"loop step failed: {exc}")
            try:
                await asyncio.wait_for(self._wake.wait(),
                                       timeout=self.interval_s)
                self._wake.clear()
            except asyncio.TimeoutError:
                pass


class OverlayTask:
    """Runs detectors on the live robot frames and feeds the stream overlay,
    so the browser shows what the robot 'sees' in real time."""

    def __init__(self, slot: FrameSlot, overlay: OverlayState) -> None:
        self.slot = slot
        self.overlay = overlay
        self._warned: set[str] = set()

    async def run(self) -> None:
        period = 1.0 / config.OVERLAY_FPS
        while True:
            bgr, t = self.slot.get_bgr()
            if bgr is None or self.slot.age_s > 2.0:
                await asyncio.sleep(0.5)
                continue
            boxes: list[dict] = []
            for model in config.OVERLAY_MODELS:
                try:
                    r = await detectors.detect(model, bgr)
                    boxes.extend(r["boxes"])
                except detectors.DetectorError as exc:
                    if model not in self._warned:
                        self._warned.add(model)
                        log.warning("overlay: %s unavailable: %s", model, exc)
            self.overlay.set(boxes)
            await asyncio.sleep(period)


async def _supervise(name: str, factory) -> None:
    """Run factory() forever, restarting with backoff on crash."""
    backoff = config.BACKOFF_INITIAL_S
    while True:
        try:
            started = asyncio.get_event_loop().time()
            await factory()
            log.error("task %s exited cleanly; restarting", name)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — supervisor must log and restart
            log.exception("task %s crashed", name)
        if asyncio.get_event_loop().time() - started > 60:
            backoff = config.BACKOFF_INITIAL_S
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, config.BACKOFF_MAX_S)


async def amain() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    robot_slot = FrameSlot("robot")
    side_slot = FrameSlot("side")
    overlay = OverlayState()
    robot_cam = RobotCamera(robot_slot, overlay)
    robot_cam.start()
    overlay_task = OverlayTask(robot_slot, overlay)

    episode_lock = asyncio.Lock()
    llm = LLMClient()

    timeout = aiohttp.ClientTimeout(total=None)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        panel = PanelClient(session)
        side_reader = SideCamReader(side_slot, session)
        patrol = PatrolTask(panel, robot_slot, side_slot, llm, episode_lock)
        tool_executor = ToolExecutor(panel, robot_slot, side_slot, patrol)
        chat = ChatAgent(panel, llm, tool_executor, patrol, episode_lock)
        agent_loop = LoopTask(chat, panel)
        chat.loop = agent_loop
        tool_executor.loop_ctl = agent_loop
        tracker = TrackerTask(panel, robot_slot, episode_lock)
        chat.tracker = tracker
        tool_executor.tracker_ctl = tracker
        if tool_executor.world_map:
            # Repopulate the panel's radar after a restart.
            asyncio.create_task(panel.post_map(tool_executor.world_map))

        tasks = [
            asyncio.create_task(_supervise("panel-ws", panel.run_ws),
                                name="panel-ws"),
            asyncio.create_task(
                _supervise("event-poll", panel.run_event_poll_fallback),
                name="event-poll"),
            asyncio.create_task(_supervise("side-cam", side_reader.run),
                                name="side-cam"),
            asyncio.create_task(_supervise("chat", chat.run), name="chat"),
            asyncio.create_task(_supervise("patrol", patrol.run),
                                name="patrol"),
            asyncio.create_task(_supervise("agent-loop", agent_loop.run),
                                name="agent-loop"),
            asyncio.create_task(_supervise("overlay", overlay_task.run),
                                name="overlay"),
            asyncio.create_task(_supervise("tracker", tracker.run),
                                name="tracker"),
        ]

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        try:
            await stop.wait()
        finally:
            log.info("shutting down")
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            robot_cam.stop()


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()
