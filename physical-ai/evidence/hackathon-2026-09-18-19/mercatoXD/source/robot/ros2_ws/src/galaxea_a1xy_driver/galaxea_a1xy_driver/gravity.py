"""Gravity model for the A1X, and the calibration that makes it trustworthy.

Why this exists
---------------
An A1X has exactly two states we knew how to reach, and neither is usable as a
hand-guided leader:

    enabled  (function frame 1/6)   reports at 200 Hz, but holds itself rigid
    released (function frame 2/3/4) hand-movable, but 0x052 freezes -- no encoders

Galaxea's own A1Z SDK (github.com/userguide-galaxea/GALAXEA-A1Z) resolves this
with a third state it calls *zero-gravity mode*, and the A1X speaks the same MIT
impedance law on 0x050, so it is reachable here too:

    tau = kp*(p_des - p) + kd*(v_des - v) + t_ff
          kp = 0                 no position servo -- nothing pulls it to a pose
          kd = small, NON-ZERO   damping only, so it cannot oscillate
          t_ff = g(q)            cancels the arm's own weight

The motors stay ENERGISED throughout -- which is what keeps the encoders
reporting -- but the commanded torque is exactly the torque gravity is taking
away, so the arm floats. That is the state a hand-guided leader needs.

Note that `kd` is deliberately non-zero. Streaming an all-zero command
(kp = kd = t_ff = 0) was already measured on this hardware and does NOT soften
the arm; Galaxea's SDK carries the matching remark that a motor "does not return
feedback on enable alone -- it needs at least one MIT command first", and its
own probe frame uses kd = 0.05 rather than 0. An all-zero payload appears not to
count as a command.

Why the model must be calibrated before it is used
--------------------------------------------------
t_ff is an OPEN-LOOP torque. Nothing corrects it. If its sign is wrong, the
compensation adds to gravity instead of cancelling it and a brakeless arm
accelerates downward harder than free-fall. If its scale is wrong the arm
either sags or drives itself upward. So the model is never trusted on the
strength of the URDF alone.

Fortunately the arm hands us the ground truth for free. While the motors are
enabled and the arm is stationary and unsupported, the torque the motor reports
in 0x052 IS the torque required to hold that pose against gravity:

    effort_measured(q)  ==  gravity_torque(q)          (in the motor's own units)

So `fit()` regresses measured effort against the model, per joint, over several
resting poses. It returns a gain (which absorbs both the sign convention and any
unit mismatch) and an offset (which absorbs static friction and any constant
bias). Only a fit that actually explains the data is allowed to drive t_ff --
see `GravityCalibration.usable`.

This is what `leader_float.py --check` does, and it transmits nothing.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Iterable, List, Sequence, Tuple

N_JOINTS = 6

# The protocol clamps t_ff at +/-50, but nothing on a 4.6 kg arm needs anything
# close to that. These are per-joint ceilings on the compensation torque, sized
# a little above the largest gravity torque the URDF can produce (about 4 Nm on
# J2/J3), so a model blow-up is capped long before it becomes dangerous.
DEFAULT_TAU_CLAMP = (6.0, 8.0, 8.0, 4.0, 3.0, 3.0)

# A fit is only usable if the model genuinely explains the measurements.
MIN_R2 = 0.90            # per-joint coefficient of determination
MIN_SAMPLES = 3          # distinct resting poses
MIN_SPREAD = 0.25        # Nm of model spread; below this the joint is untested
GAIN_LIMITS = (0.2, 3.0) # |gain| outside this means the model is not the arm


@dataclass
class JointFit:
    """Least-squares map from model gravity torque to commanded t_ff."""

    gain: float = 0.0        # includes the sign convention
    offset: float = 0.0      # static friction / constant bias, in command units
    r2: float = 0.0
    spread: float = 0.0      # range of model torque covered by the samples
    n: int = 0

    @property
    def usable(self) -> bool:
        """Whether this joint's fit may be allowed to drive torque."""
        if self.n < MIN_SAMPLES:
            return False
        if self.spread < MIN_SPREAD:
            # The samples never loaded this joint, so the fit is unconstrained.
            # Not an error -- a wrist joint may carry no gravity in any pose we
            # sampled -- but it must not be extrapolated from.
            return False
        lo, hi = GAIN_LIMITS
        return self.r2 >= MIN_R2 and lo <= abs(self.gain) <= hi

    def apply(self, tau_model: float, use_offset: bool = False) -> float:
        """Map model torque to commanded t_ff.

        The offset is fitted so the gain comes out unbiased, but it is NOT fed
        forward by default: it is mostly static friction, and friction is not
        something we want to command. Adding it would push the arm at poses
        where gravity is zero -- exactly where a floating arm should sit still.
        """
        return self.gain * tau_model + (self.offset if use_offset else 0.0)


@dataclass
class GravityCalibration:
    """Per-joint fits plus the metadata needed to judge whether to trust them."""

    fits: List[JointFit] = field(default_factory=lambda: [JointFit() for _ in range(N_JOINTS)])
    urdf: str = ""
    note: str = ""

    @property
    def usable(self) -> bool:
        """True only if every joint is either well fitted or provably unloaded.

        A joint that carries no gravity torque in any sampled pose (`spread`
        below MIN_SPREAD) is safe to leave at zero compensation -- it needs
        none. A joint that IS loaded but fits badly is not safe, because we
        would be guessing at the sign of a torque that can drop the arm.
        """
        for f in self.fits:
            if f.spread < MIN_SPREAD:
                continue          # unloaded joint: zero compensation is correct
            if not f.usable:
                return False
        return True

    def unusable_joints(self) -> List[int]:
        return [j for j, f in enumerate(self.fits)
                if f.spread >= MIN_SPREAD and not f.usable]

    def unloaded_joints(self) -> List[int]:
        return [j for j, f in enumerate(self.fits) if f.spread < MIN_SPREAD]

    def tau(self, tau_model: Sequence[float], factor: float = 1.0,
            clamp: Sequence[float] = DEFAULT_TAU_CLAMP) -> List[float]:
        """Map model gravity torque to the t_ff to command.

        Joints whose fit is not usable get ZERO compensation rather than a
        guess. That makes them sag under float mode, which is visible and
        recoverable; commanding a wrongly-signed torque is neither.
        """
        out = []
        for j in range(N_JOINTS):
            f = self.fits[j]
            v = f.apply(float(tau_model[j])) * factor if f.usable else 0.0
            lim = clamp[j]
            out.append(max(-lim, min(lim, v)))
        return out

    # ---- persistence ------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "urdf": self.urdf,
            "note": self.note,
            "fits": [{"gain": f.gain, "offset": f.offset, "r2": f.r2,
                      "spread": f.spread, "n": f.n} for f in self.fits],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "GravityCalibration":
        c = cls(urdf=d.get("urdf", ""), note=d.get("note", ""))
        c.fits = [JointFit(**f) for f in d["fits"]]
        return c

    def save(self, path: str) -> None:
        with open(path, "w") as fh:
            json.dump(self.to_dict(), fh, indent=2)

    @classmethod
    def load(cls, path: str) -> "GravityCalibration":
        with open(path) as fh:
            return cls.from_dict(json.load(fh))

    def describe(self) -> str:
        lines = ["  joint   gain    offset      R^2   spread(Nm)  n   verdict"]
        for j, f in enumerate(self.fits):
            if f.spread < MIN_SPREAD:
                verdict = "unloaded (no compensation)"
            elif f.usable:
                verdict = "OK"
            else:
                why = []
                if f.n < MIN_SAMPLES:
                    why.append(f"n<{MIN_SAMPLES}")
                if f.r2 < MIN_R2:
                    why.append(f"R^2<{MIN_R2}")
                if not (GAIN_LIMITS[0] <= abs(f.gain) <= GAIN_LIMITS[1]):
                    why.append("gain out of range")
                verdict = "REJECTED: " + ", ".join(why)
            lines.append(f"   J{j+1}   {f.gain:+6.3f}  {f.offset:+7.3f}  "
                         f"{f.r2:6.3f}   {f.spread:8.3f}  {f.n:2d}   {verdict}")
        return "\n".join(lines)


def fit(samples: Iterable[Tuple[Sequence[float], Sequence[float]]],
        model: "GravityModel", urdf: str = "", note: str = "") -> GravityCalibration:
    """Regress measured hold effort against model gravity torque, per joint.

    `samples` is an iterable of (q, effort) pairs, each recorded while the arm
    was ENERGISED, STATIONARY and UNSUPPORTED -- so that the reported effort is
    the torque holding that pose against gravity, and nothing else.
    """
    xs: List[List[float]] = [[] for _ in range(N_JOINTS)]
    ys: List[List[float]] = [[] for _ in range(N_JOINTS)]
    for q, eff in samples:
        tau = model.tau(q)
        for j in range(N_JOINTS):
            xs[j].append(float(tau[j]))
            ys[j].append(float(eff[j]))

    cal = GravityCalibration(urdf=urdf, note=note)
    for j in range(N_JOINTS):
        cal.fits[j] = _lsq(xs[j], ys[j])
    return cal


def _lsq(x: List[float], y: List[float]) -> JointFit:
    """Ordinary least squares y = a*x + b, with R^2 and the covered spread."""
    n = len(x)
    f = JointFit(n=n)
    if n == 0:
        return f
    f.spread = max(x) - min(x)
    if n < 2 or f.spread < MIN_SPREAD:
        # Never loaded, so the slope is unidentifiable -- dividing by a spread
        # of ~0 yields an enormous number that looks like a measurement and is
        # not one. Report no gain; `usable` already treats this as "needs no
        # compensation" rather than as a failure.
        f.offset = sum(y) / n
        return f
    mx = sum(x) / n
    my = sum(y) / n
    sxx = sum((v - mx) ** 2 for v in x)
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    if sxx <= 0.0:
        return f
    f.gain = sxy / sxx
    f.offset = my - f.gain * mx
    syy = sum((v - my) ** 2 for v in y)
    if syy <= 0.0:
        # Every measurement identical: the fit explains nothing, so say so
        # rather than reporting a perfect R^2 for a degenerate case.
        f.r2 = 0.0
    else:
        resid = sum((b - (f.gain * a + f.offset)) ** 2 for a, b in zip(x, y))
        f.r2 = max(0.0, 1.0 - resid / syy)
    return f


class GravityModel:
    """Inverse-dynamics gravity torque g(q) for the A1X, via Pinocchio RNEA.

    Kept deliberately thin: the interesting part is not computing g(q), it is
    knowing whether g(q) describes the arm in front of us. See `fit()`.
    """

    def __init__(self, urdf_path: str) -> None:
        import pinocchio                      # imported late: only float mode needs it

        if not os.path.exists(urdf_path):
            raise FileNotFoundError(urdf_path)
        self._pin = pinocchio
        self.urdf_path = urdf_path
        self.model = pinocchio.buildModelFromUrdf(urdf_path)
        self.data = self.model.createData()
        try:
            self.idx_q = [self.model.joints[self.model.getJointId(f"arm_joint{j+1}")].idx_q
                          for j in range(N_JOINTS)]
            self.idx_v = [self.model.joints[self.model.getJointId(f"arm_joint{j+1}")].idx_v
                          for j in range(N_JOINTS)]
        except Exception as exc:              # pragma: no cover - bad URDF
            raise RuntimeError(f"{urdf_path}: arm_joint1..6 not found ({exc})")
        self._q = pinocchio.neutral(self.model)
        self.mass = float(sum(i.mass for i in self.model.inertias))

    def tau(self, q: Sequence[float]) -> List[float]:
        """Gravity torque at pose `q` (6 joint angles, rad), in URDF convention."""
        for j in range(N_JOINTS):
            self._q[self.idx_q[j]] = float(q[j])
        g = self._pin.computeGeneralizedGravity(self.model, self.data, self._q)
        return [float(g[self.idx_v[j]]) for j in range(N_JOINTS)]


def default_urdf() -> str:
    """The A1X URDF as it is laid out both in-container and in the workspace."""
    for p in ("/home/ros/ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf",
              os.path.join(os.path.dirname(__file__),
                           "../../galaxea_a1xy_description/urdf/a1x.urdf")):
        p = os.path.abspath(p)
        if os.path.exists(p):
            return p
    return "/home/ros/ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf"


def _selftest() -> None:
    """Exercise the fit logic without a robot, URDF or Pinocchio."""

    class FakeModel:
        """g(q) = [q0, 2*q1, 0, 0, 0, 0] -- J3..J6 carry no gravity, ever."""

        def tau(self, q):
            return [q[0], 2.0 * q[1], 0.0, 0.0, 0.0, 0.0]

    m = FakeModel()

    # A clean measurement set: effort = -1 * model on J1, +0.5 on J2.
    samples = []
    for a in (0.0, 0.5, 1.0, 1.5):
        q = [a, a, 0, 0, 0, 0]
        tau = m.tau(q)
        samples.append((q, [-1.0 * tau[0], 0.5 * tau[1], 0, 0, 0, 0]))
    cal = fit(samples, m)
    assert abs(cal.fits[0].gain + 1.0) < 1e-9, cal.fits[0]
    assert abs(cal.fits[1].gain - 0.5) < 1e-9, cal.fits[1]
    assert cal.fits[0].r2 > 0.999 and cal.fits[1].r2 > 0.999
    # J3..J6 were never loaded -> reported unloaded, not fitted
    assert cal.unloaded_joints() == [2, 3, 4, 5], cal.unloaded_joints()
    assert cal.usable, cal.describe()
    # ... and they must receive exactly zero compensation
    out = cal.tau(m.tau([1.0, 1.0, 0, 0, 0, 0]))
    assert out[2:] == [0.0] * 4, out
    assert abs(out[0] - (-1.0)) < 1e-9 and abs(out[1] - 1.0) < 1e-9, out

    # A gain far outside the plausible range must be rejected, not used.
    bad = fit([([a, 0, 0, 0, 0, 0], [50.0 * a, 0, 0, 0, 0, 0])
               for a in (0.0, 0.5, 1.0)], m)
    assert not bad.fits[0].usable and not bad.usable, bad.describe()
    assert bad.tau(m.tau([1.0, 0, 0, 0, 0, 0]))[0] == 0.0

    # Noise that destroys the correlation must also be rejected.
    noisy = fit([([a, 0, 0, 0, 0, 0], [b, 0, 0, 0, 0, 0])
                 for a, b in ((0.0, 1.0), (0.5, -3.0), (1.0, 2.0), (1.5, -1.0))], m)
    assert not noisy.fits[0].usable, noisy.describe()

    # Clamping
    strong = fit([([a, 0, 0, 0, 0, 0], [a, 0, 0, 0, 0, 0]) for a in (0.0, 1.0, 2.0)], m)
    assert abs(strong.tau([100.0, 0, 0, 0, 0, 0])[0] - DEFAULT_TAU_CLAMP[0]) < 1e-9

    # Round-trip through JSON
    import tempfile
    with tempfile.NamedTemporaryFile("w+", suffix=".json", delete=True) as fh:
        cal.save(fh.name)
        back = GravityCalibration.load(fh.name)
        assert abs(back.fits[0].gain - cal.fits[0].gain) < 1e-12

    print("gravity selftest: fit, rejection, unloaded joints, clamp, json OK")


if __name__ == "__main__":
    _selftest()
