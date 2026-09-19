"""Camera frames for the policy observation.

Two rules learned the hard way on this arm:

* one camera must be wrist-mounted, looking down the grasp axis with the jaws
  and the object in frame at ~10-20 cm. Without it the plans were
  non-reproducible and contradictory for the same task string;
* the other must be fixed and aimed at the workspace (bench, arm, work area),
  not at the room.

640x480 is enough - the model downsamples to 256 internally.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

# Panel stream name -> observation key expected by serve_policy.py.
CAMERA_MAP: dict[str, str] = {
    os.environ.get("A1X_HEAD_CAM", "robot"): "head_rgb",
    os.environ.get("A1X_WRIST_CAM", "wrist"): "left_wrist_rgb",
}


class VisionError(Exception):
    """A frame could not be fetched or decoded."""


def jpeg_to_chw_rgb(buf: bytes) -> Any:
    """Decode JPEG -> RGB, channel-first, uint8.

    The panel serves BGR JPEGs (cv2/ffmpeg); the policy server validates RGB
    (C,H,W) uint8, and feeding it BGR silently degrades the plan rather than
    raising.
    """
    try:
        import cv2  # noqa: PLC0415 - optional, robot-side only
        import numpy as np  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise VisionError("cv2/numpy are required to build a policy observation") from exc

    frame = cv2.imdecode(np.frombuffer(buf, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise VisionError("could not decode a JPEG frame from the panel")
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return np.ascontiguousarray(rgb.transpose(2, 0, 1))


async def fetch_observation_images(arm: Any) -> dict[str, Any]:
    """Pull every configured camera in parallel and key them for the policy."""
    names = list(CAMERA_MAP)
    frames = await asyncio.gather(*(arm.frame(name) for name in names), return_exceptions=True)

    images: dict[str, Any] = {}
    errors: list[str] = []
    for name, frame in zip(names, frames):
        if isinstance(frame, Exception):
            errors.append(f"{name}: {frame}")
            continue
        images[CAMERA_MAP[name]] = jpeg_to_chw_rgb(frame)

    if "left_wrist_rgb" not in images:
        raise VisionError("wrist camera unavailable; " + ("; ".join(errors) or "not configured"))
    return images
