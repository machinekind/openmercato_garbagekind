"""Policies that turn "pick up the can" into joint targets.

Two implementations:

* `G05Policy` - Galaxea's G0.5 VLA served over a local WebSocket. Its r1lite
  action spec (6 joints + 1 gripper, radians) is a byte-for-byte match for the
  A1X, because R1-Lite arms *are* A1X arms.
* `PresetPolicy` - no model at all: walk the panel's whitelisted poses. This is
  what runs on a machine with no GPU, and what the tests use.

Two facts from the live runs shape this file:

1. The server answers in 16-step chunks and recomputes only when it asks for a
   fresh observation via `need_obs`. Sending an observation every cycle
   restarts the chunk forever, so the caller only ever sees step 0 - which sits
   on top of the current pose and looks like "the policy does nothing".
2. `g05-base` zero-shot never emits a `left_gripper` action. Grasping is
   therefore scripted by the runner, not planned by the model.
"""
from __future__ import annotations

import logging
from typing import Any

from .types import PickTask

log = logging.getLogger(__name__)

# Runtime observation keys. These are what `serve_policy.py` validates against;
# the `configs/data/r1lite.yaml` names (exterior / wrist_left) are docs only.
IMAGE_KEYS = ("head_rgb", "left_wrist_rgb", "right_wrist_rgb")
EMBODIMENT = "galaxea_r1lite"
N_ARM_JOINTS = 6


class PolicyError(Exception):
    """The policy server refused, is unreachable, or answered nonsense."""


class PresetPolicy:
    """Scripted fallback: a fixed sequence of panel presets.

    Not a substitute for a trained policy - it cannot find anything. It exists
    so the whole queue -> claim -> report -> finish path can be exercised on a
    bench with no GPU, and so a cell without a policy server still has a
    defined behaviour instead of an exception.
    """

    def __init__(self, presets: list[str]):
        self.presets = presets

    async def plan(self, task: PickTask, state: dict[str, Any]) -> list[list[float]]:
        """No joint chunk: the runner drives presets for this policy."""
        return []

    @property
    def is_scripted(self) -> bool:
        return True


class G05Policy:
    """G0.5 over `ws://host:8765`, speaking the chunk/`need_obs` protocol."""

    is_scripted = False

    def __init__(self, url: str, chunk_size: int = 16):
        self.url = url
        self.chunk_size = chunk_size
        self._ws: Any = None
        self._chunk: list[list[float]] = []
        self._need_obs = True

    async def connect(self) -> None:
        try:
            import websockets  # noqa: PLC0415 - optional dependency, DGX only
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise PolicyError("websockets is not installed; cannot reach the G0.5 server") from exc
        self._ws = await websockets.connect(self.url, max_size=None)
        meta = self._unpack(await self._ws.recv())
        log.info("policy: connected to %s, metadata=%s", self.url, meta)
        self._need_obs = True

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None

    @staticmethod
    def _pack(payload: dict[str, Any]) -> bytes:
        import msgpack  # noqa: PLC0415 - optional dependency

        return msgpack.packb(payload, use_bin_type=True)

    @staticmethod
    def _unpack(raw: bytes) -> dict[str, Any]:
        import msgpack  # noqa: PLC0415 - optional dependency

        return msgpack.unpackb(raw, raw=False)

    def build_observation(
        self,
        task: PickTask,
        joints_rad: list[float],
        images: dict[str, Any],
    ) -> dict[str, Any]:
        """Assemble one observation.

        The right arm and right gripper are absent on this robot but mandatory
        in the observation, so they go in as zeros - the checkpoint's own
        `absent_key_fill_value` handling only covers action keys, not state.
        """
        arm = [float(v) for v in joints_rad[:N_ARM_JOINTS]]
        if len(arm) < N_ARM_JOINTS:
            raise PolicyError(f"need {N_ARM_JOINTS} arm joints, got {len(arm)}")
        gripper = float(joints_rad[N_ARM_JOINTS]) if len(joints_rad) > N_ARM_JOINTS else 0.0
        missing = [k for k in ("head_rgb", "left_wrist_rgb") if k not in images]
        if missing:
            # The wrist camera is not optional: without a view down the grasp
            # axis the plans were non-reproducible and contradictory.
            raise PolicyError(f"observation is missing camera(s): {', '.join(missing)}")
        return {
            "images": {key: images[key] for key in IMAGE_KEYS if key in images},
            "state": {
                "left_arm": arm,
                "left_gripper": [gripper],
                "right_arm": [0.0] * N_ARM_JOINTS,
                "right_gripper": [0.0],
            },
            "task": task.instruction,
            "embodiment_type": EMBODIMENT,
        }

    @property
    def needs_observation(self) -> bool:
        """True when the cached chunk is exhausted and a fresh frame is due."""
        return self._need_obs or not self._chunk

    async def plan(self, task: PickTask, state: dict[str, Any]) -> list[list[float]]:
        """Return the pending chunk, fetching a new one only when asked to.

        `state` carries `joints` (radians) and `images` (already RGB CHW uint8).
        """
        if self._ws is None:
            raise PolicyError("policy is not connected")
        if not self.needs_observation and self._chunk:
            return self._chunk

        obs = self.build_observation(task, list(state["joints"]), dict(state["images"]))
        await self._ws.send(self._pack(obs))
        reply = self._unpack(await self._ws.recv())
        self._need_obs = bool(reply.get("need_obs", True))

        action = reply.get("action") or {}
        arm_chunk = action.get("left_arm")
        if not arm_chunk:
            # Observed every run of g05-base: absent keys are dropped, and
            # left_gripper is always one of them.
            raise PolicyError(f"policy returned no left_arm action (keys: {sorted(action)})")
        self._chunk = [[float(v) for v in step] for step in arm_chunk]
        return self._chunk

    def pop_step(self) -> list[float] | None:
        """Take the next cached step; None when the chunk is spent."""
        if not self._chunk:
            self._need_obs = True
            return None
        step = self._chunk.pop(0)
        if not self._chunk:
            self._need_obs = True
        return step
