"""Motion envelope for the web panel: joint windows, step caps, presets.

Everything that can command the arm goes through here first. The rules are
fail-closed by construction:

  * the configured window is intersected with the URDF limits, so a typo in
    presets.json can only ever make the allowed range SMALLER;
  * a preset pose is clipped into that window at load time, and a preset that
    lands outside it is reported at startup instead of moving the arm;
  * non-finite values (NaN / inf) are rejected, never clipped - np.clip(NaN)
    returns NaN and would stream garbage onto the bus.
"""
from __future__ import annotations

import json
import logging
import math
import os

import numpy as np

log = logging.getLogger("safety")

N = 6
DEFAULT_PRESETS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "presets.json")


class Envelope:
    """Per-joint limits, step caps and named poses. Immutable after load."""

    def __init__(self, lower: np.ndarray, upper: np.ndarray,
                 pan_step: float, tilt_step: float, joint_step: float,
                 presets: dict[str, dict]):
        self.lower = lower                  # rad, length N
        self.upper = upper                  # rad, length N
        self.pan_step = pan_step            # rad, max |dj1| per command
        self.tilt_step = tilt_step          # rad, max |dj3| per command
        self.joint_step = joint_step        # rad, max |dq| per command
        self.presets = presets              # name -> {"desc", "q" (rad list)}

    # ---- checks ----

    @staticmethod
    def finite(values) -> bool:
        return all(isinstance(v, (int, float)) and math.isfinite(v)
                   for v in values)

    def clamp(self, q_rad) -> np.ndarray:
        return np.clip(np.asarray(q_rad, dtype=float), self.lower, self.upper)

    def clamp_deltas(self, deltas_rad) -> np.ndarray:
        """Cap a relative move per joint (pan and tilt get their own caps)."""
        caps = np.full(N, self.joint_step)
        caps[0] = self.pan_step
        caps[2] = self.tilt_step
        d = np.asarray(deltas_rad, dtype=float)
        return np.clip(d, -caps, caps)

    def describe(self) -> dict:
        """Shape served by GET /api/presets."""
        return {name: {"desc": p["desc"],
                       "q_deg": [round(math.degrees(x), 1) for x in p["q"]]}
                for name, p in self.presets.items()}


def _window(raw: dict, urdf_lower: np.ndarray,
            urdf_upper: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lower = urdf_lower.copy()
    upper = urdf_upper.copy()
    for i in range(N):
        pair = raw.get(f"j{i + 1}")
        if not isinstance(pair, list) or len(pair) != 2:
            log.warning("window j%d missing in presets.json, using URDF limit",
                        i + 1)
            continue
        lo, hi = (math.radians(float(pair[0])), math.radians(float(pair[1])))
        # Intersection, so a bad config narrows and never widens.
        lower[i] = max(lower[i], min(lo, hi))
        upper[i] = min(upper[i], max(lo, hi))
        if lower[i] > upper[i]:
            raise SystemExit(
                f"presets.json: window j{i + 1} does not intersect the URDF "
                f"limit [{math.degrees(urdf_lower[i]):.1f}, "
                f"{math.degrees(urdf_upper[i]):.1f}] deg")
    return lower, upper


def load(path: str, urdf_lower: np.ndarray, urdf_upper: np.ndarray) -> Envelope:
    with open(path) as f:
        cfg = json.load(f)

    lower, upper = _window(cfg.get("window_deg", {}), urdf_lower, urdf_upper)
    caps = cfg.get("step_cap_deg", {})
    pan = math.radians(float(caps.get("pan", 30.0)))
    tilt = math.radians(float(caps.get("tilt", 10.0)))
    joint = math.radians(float(caps.get("joint", 30.0)))

    presets: dict[str, dict] = {}
    for name, body in (cfg.get("presets") or {}).items():
        q_deg = body.get("q_deg")
        if not isinstance(q_deg, list) or len(q_deg) != N:
            log.error("preset %r dropped: q_deg must hold %d values", name, N)
            continue
        if not Envelope.finite(q_deg):
            log.error("preset %r dropped: non-finite value", name)
            continue
        q = np.radians(np.array(q_deg, dtype=float))
        clipped = np.clip(q, lower, upper)
        if not np.allclose(q, clipped, atol=1e-9):
            log.warning("preset %r clipped into the window: %s -> %s deg",
                        name, np.round(np.degrees(q), 1),
                        np.round(np.degrees(clipped), 1))
        presets[name] = {"desc": str(body.get("desc", "")),
                         "q": [float(x) for x in clipped]}

    log.info("envelope: %s .. %s deg, presets: %s",
             np.round(np.degrees(lower), 1), np.round(np.degrees(upper), 1),
             ", ".join(presets) or "none")
    return Envelope(lower, upper, pan, tilt, joint, presets)
