"""Control math for arm-to-arm teleoperation of the Galaxea A1X. No ROS here.

Everything in this module is a pure function of its inputs plus explicit,
inspectable state, so the whole pipeline can be exercised on a laptop with

    python3 mapping.py

The per-cycle pipeline is:

    raw     = follower_start + (leader_now - leader_ref)   DeltaMap
    bounded = clamp_to_limits(raw)                         URDF joint limits
    target  = limiter.step(bounded, dt)                    RateLimiter

Two deliberate absences are worth stating outright, because both were paid for
the hard way:

* There is **no deadband** anywhere in that chain. The obvious place to put one
  is on the leader delta, but the delta is measured against a *fixed reference*,
  not accumulated, and a deadband on it would discard increments permanently --
  the arm would drift away from the leader and slow, deliberate leader motion
  would vanish entirely. If the input is noisy, filter the leader signal
  (see PositionFilter) rather than gating the delta.

* The RateLimiter is **not** a deadband. It only ever delays motion, and always
  converges on the true target, so nothing is silently dropped.
"""

N_JOINTS = 6

# Joint limits straight out of ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf.
# (lower, upper) in radians.
JOINT_LIMITS = (
    (-2.8798, 2.8798),   # J1  +/-165 deg
    (0.0000, 3.1416),    # J2     0..180 deg
    (-3.3161, 0.0000),   # J3  -190..0 deg
    (-1.5708, 1.5708),   # J4  +/-90 deg
    (-1.5708, 1.5708),   # J5  +/-90 deg
    (-2.8798, 2.8798),   # J6  +/-165 deg
)

# The arm's zero calibration does not exactly agree with the URDF: J3 rests a
# little *outside* its own [-3.3161, 0] range (about +1.5 deg has been seen, and
# +0.1 deg on the arm as it sits today). Clamping hard to the URDF value would
# therefore command a jump away from the resting pose on the very first cycle.
# The margin makes the clamp tolerant of that calibration offset while still
# stopping runaway targets.
DEFAULT_LIMIT_MARGIN = 0.05          # rad, ~2.9 deg

DEFAULT_MAX_SPEED = 1.5708           # rad/s, 90 deg/s -- comfortable to follow


def clamp(value: float, lo: float, hi: float) -> float:
    return lo if value < lo else (hi if value > hi else value)


def clamp_to_limits(q, margin: float = DEFAULT_LIMIT_MARGIN):
    """Clamp a 6-vector to the URDF joint limits, widened by *margin*."""
    return [clamp(v, lo - margin, hi + margin)
            for v, (lo, hi) in zip(q, JOINT_LIMITS)]


def out_of_range(q, margin: float = DEFAULT_LIMIT_MARGIN):
    """Indices of joints sitting outside the widened limits (for reporting)."""
    return [i for i, (v, (lo, hi)) in enumerate(zip(q, JOINT_LIMITS))
            if v < lo - margin or v > hi + margin]


class DeltaMap:
    """Relative leader->follower mapping.

    The two arms sit at different poses and have different zero calibrations, so
    mirroring absolute joint angles would fling the follower across its range at
    startup. Instead both arms are referenced at the moment of engagement and
    only the *change* in the leader's pose is applied to the follower.

    Re-calling `reference()` while running is the clutch: let go, move the
    leader somewhere more comfortable, re-reference, carry on.
    """

    def __init__(self):
        self.leader_ref = None
        self.follower_start = None

    @property
    def referenced(self) -> bool:
        return self.leader_ref is not None

    def reference(self, leader_now, follower_now) -> None:
        self.leader_ref = list(leader_now[:N_JOINTS])
        self.follower_start = list(follower_now[:N_JOINTS])

    def target(self, leader_now):
        if not self.referenced:
            raise RuntimeError("DeltaMap.target() before reference()")
        return [s + (n - r) for s, n, r
                in zip(self.follower_start, leader_now, self.leader_ref)]


class RateLimiter:
    """Per-joint slew limit on the commanded target.

    Holds the last value it emitted and moves it toward the requested target by
    at most `max_speed * dt` each call, so it always converges: a slow leader
    still gets there, it just gets there smoothly.
    """

    def __init__(self, max_speed: float = DEFAULT_MAX_SPEED, n: int = N_JOINTS):
        self.max_speed = max_speed
        self.n = n
        self.value = None
        self.velocity = [0.0] * n        # actual slew achieved, for v_des

    def reset(self, value) -> None:
        self.value = list(value[:self.n])
        self.velocity = [0.0] * self.n

    def step(self, target, dt: float):
        if self.value is None:
            self.reset(target)
            return list(self.value)
        span = self.max_speed * max(dt, 0.0)
        out, vel = [], []
        for cur, want in zip(self.value, target):
            delta = clamp(want - cur, -span, span)
            out.append(cur + delta)
            vel.append(delta / dt if dt > 0.0 else 0.0)
        self.value, self.velocity = out, vel
        return list(out)


class GainRamp:
    """Smooth 0->1 ease-in for kp/kd.

    Stepping straight to full stiffness makes the follower snap to its target;
    easing in over a couple of seconds lets it take up the pose gently. Uses
    smoothstep so the ramp starts and ends with zero slope.
    """

    def __init__(self, duration: float = 3.0):
        self.duration = max(duration, 1e-6)

    def fraction(self, elapsed: float) -> float:
        t = clamp(elapsed / self.duration, 0.0, 1.0)
        return t * t * (3.0 - 2.0 * t)


class PositionFilter:
    """First-order low-pass on the leader position, in place of a deadband.

    `alpha` is the per-sample blend factor; 1.0 disables filtering. This removes
    encoder dither without discarding real motion, because every sample still
    contributes to the output.
    """

    def __init__(self, alpha: float = 1.0, n: int = N_JOINTS):
        self.alpha = clamp(alpha, 1e-3, 1.0)
        self.n = n
        self.value = None

    def reset(self, value=None) -> None:
        self.value = None if value is None else list(value[:self.n])

    def update(self, sample):
        s = list(sample[:self.n])
        if self.value is None or self.alpha >= 1.0:
            self.value = s
        else:
            a = self.alpha
            self.value = [a * new + (1.0 - a) * old
                          for new, old in zip(s, self.value)]
        return list(self.value)


class FreezeDetector:
    """Spot a leader that is transmitting but not actually reporting.

    A released A1X keeps putting 0x052 on the wire at a full 200 Hz while
    repeating one identical payload, so "frames are arriving" is not evidence
    that the encoders are live. Real encoder output dithers by at least an LSB,
    so a *bit-identical* position vector held across a couple of seconds means
    the arm has stopped reporting -- not that it is being held still.

    Note this tests the whole vector, not each joint: J2 legitimately reads a
    constant 0.0 on both of these arms, so a per-joint test would cry wolf.
    """

    def __init__(self, threshold: int = 400):
        self.threshold = threshold
        self.count = 0
        self.last = None

    def update(self, position) -> bool:
        key = tuple(position[:N_JOINTS])
        if self.last is not None and key == self.last:
            self.count += 1
        else:
            self.count = 0
        self.last = key
        return self.frozen

    @property
    def frozen(self) -> bool:
        return self.count >= self.threshold

    def reset(self) -> None:
        self.count = 0
        self.last = None


def _selftest() -> None:
    import math

    # -- clamp ---------------------------------------------------------------
    wild = [99.0] * N_JOINTS
    for v, (lo, hi) in zip(clamp_to_limits(wild, 0.0), JOINT_LIMITS):
        assert abs(v - hi) < 1e-12, v
    # the J3 calibration offset must survive the clamp
    q = [0.0, 0.0, 0.026, 0.0, 0.0, 0.0]          # J3 1.5 deg past its limit
    assert clamp_to_limits(q)[2] == 0.026, "margin must not fight the zero offset"
    assert clamp_to_limits(q, margin=0.0)[2] == 0.0
    assert out_of_range(q) == [] and out_of_range(q, 0.0) == [2]

    # -- delta map -----------------------------------------------------------
    dm = DeltaMap()
    lead0 = [0.1, 0.2, -0.3, 0.0, 0.5, -0.2]
    foll0 = [-1.0, 1.2, -2.0, 0.3, -0.4, 0.9]
    dm.reference(lead0, foll0)
    assert dm.target(lead0) == foll0, "at the reference the follower must not move"
    moved = [v + 0.25 for v in lead0]
    assert all(abs(t - (f + 0.25)) < 1e-12
               for t, f in zip(dm.target(moved), foll0))

    # Returning the leader to the reference must return the target exactly --
    # this is the property a deadband would destroy.
    for k in range(500):
        dm.target([v + 0.0001 * k for v in lead0])
    assert all(abs(t - f) < 1e-12 for t, f in zip(dm.target(lead0), foll0)), \
        "target must be a pure function of the current leader pose"

    # -- rate limiter --------------------------------------------------------
    rl = RateLimiter(max_speed=1.0)
    rl.reset([0.0] * N_JOINTS)
    step = rl.step([10.0] * N_JOINTS, 0.01)
    assert all(abs(v - 0.01) < 1e-12 for v in step), step
    assert all(abs(v - 1.0) < 1e-9 for v in rl.velocity), rl.velocity
    for _ in range(2000):                      # must converge, not oscillate
        rl.step([0.5] * N_JOINTS, 0.01)
    assert all(abs(v - 0.5) < 1e-9 for v in rl.value), rl.value

    # Motion slower than the slew limit must pass through undistorted: nothing
    # is dropped, so many tiny steps still accumulate to the full distance.
    rl = RateLimiter(max_speed=1.0)
    rl.reset([0.0] * N_JOINTS)
    for k in range(1, 1001):
        rl.step([k * 1e-5] * N_JOINTS, 0.01)   # 1e-3 rad/s, far under the limit
    assert all(abs(v - 1e-2) < 1e-9 for v in rl.value), rl.value

    # -- gain ramp -----------------------------------------------------------
    gr = GainRamp(2.0)
    assert gr.fraction(-1.0) == 0.0 and gr.fraction(0.0) == 0.0
    assert gr.fraction(2.0) == 1.0 and gr.fraction(99.0) == 1.0
    assert abs(gr.fraction(1.0) - 0.5) < 1e-12
    prev = -1.0
    for i in range(101):                        # monotonic
        f = gr.fraction(2.0 * i / 100.0)
        assert f >= prev - 1e-12
        prev = f

    # -- filter --------------------------------------------------------------
    pf = PositionFilter(alpha=1.0)
    assert pf.update([1.0] * N_JOINTS) == [1.0] * N_JOINTS
    pf = PositionFilter(alpha=0.5)
    pf.update([0.0] * N_JOINTS)
    assert all(abs(v - 0.5) < 1e-12 for v in pf.update([1.0] * N_JOINTS))
    for _ in range(200):                        # converges, no steady-state droop
        out = pf.update([1.0] * N_JOINTS)
    assert all(abs(v - 1.0) < 1e-9 for v in out)

    # -- freeze detector -----------------------------------------------------
    fd = FreezeDetector(threshold=5)
    same = [0.1, 0.0, 0.0, 0.0, 0.0, 0.0]
    for _ in range(5):                          # 5 samples == 4 repeats
        fd.update(same)
    assert not fd.frozen, "threshold counts repeats, so it is not reached yet"
    fd.update(same)                             # the 5th repeat trips it
    assert fd.frozen, "identical payloads must read as frozen"
    fd.update([0.1000001, 0.0, 0.0, 0.0, 0.0, 0.0])
    assert not fd.frozen, "one differing sample must clear the freeze"
    # a constant J2 alongside a dithering J1 must NOT read as frozen
    fd = FreezeDetector(threshold=5)
    for k in range(50):
        fd.update([0.1 + (k % 2) * 2e-4, 0.0, 0.0, 0.0, 0.0, 0.0])
        assert not fd.frozen

    # -- full pipeline -------------------------------------------------------
    dm, rl = DeltaMap(), RateLimiter(max_speed=DEFAULT_MAX_SPEED)
    dm.reference(lead0, foll0)
    rl.reset(foll0)
    tgt = rl.step(clamp_to_limits(dm.target(lead0)), 0.01)
    assert all(abs(a - b) < 1e-12 for a, b in zip(tgt, foll0)), \
        "first commanded target must equal the follower's own pose (no startup jump)"
    print(f"selftest: limits, delta map, rate limiter, ramp, filter, freeze, "
          f"pipeline OK  (max_speed {math.degrees(DEFAULT_MAX_SPEED):.0f} deg/s)")


if __name__ == "__main__":
    _selftest()
