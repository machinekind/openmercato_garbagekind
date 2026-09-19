"""Arm-to-arm teleoperation for two Galaxea A1X arms.

    leader   can1   our SocketCAN driver   /leader/hdas/feedback_arm   (read only)
    follower can0   vendor HDAS / ARM_APP  /motion_control/control_arm (MIT impedance)

The leader is never commanded and nothing is ever transmitted on its bus by this
node: the arm reports position only in certain hardware states, and the state it
is in when nothing has ever talked to it is the good one. Keeping that bus silent
is a feature, not an oversight.

The follower is driven through the vendor stack, which hardcodes can0 and is the
only path that can command an A1X gripper properly.

Control law on the follower is the A1X's own MIT impedance controller:

    tau = kp * (p_des - p) + kd * (v_des - v) + t_ff

so kp = kd = t_ff = 0 commands exactly zero torque no matter what p_des says.
That is the idle command, the first command of every session, and the command
sent down every exit path including exceptions and Ctrl-C.

Interactive keys (when stdin is a TTY), also available as words on ~/command:

    e  engage / re-reference (the clutch)   r  release to idle
    o  gripper open    c  gripper close     x  gripper stop
    ?  status          q  quit

Typical session:

    ros2 run galaxea_a1xy_teleop teleop_node

with the vendor stack up on can0 and our driver up on can1 (see teleop_a2a.sh).
"""
import math
import sys
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy, DurabilityPolicy
from sensor_msgs.msg import JointState
from std_msgs.msg import String

from .mapping import (
    DEFAULT_LIMIT_MARGIN, DEFAULT_MAX_SPEED, N_JOINTS,
    DeltaMap, FreezeDetector, GainRamp, PositionFilter, RateLimiter,
    clamp, clamp_to_limits, out_of_range,
)

try:
    from hdas_msg.msg import MotorControl
    from hdas_msg.srv import FunctionFrame
except ImportError as exc:                      # pragma: no cover
    raise SystemExit(
        "cannot import hdas_msg -- source the vendor SDK first:\n"
        "  source /home/ros/a1xy/atc_host_install/setup.bash\n"
        f"({exc})"
    )

# Function-frame codes that are known-safe to send. 1 and 6 energise the motors,
# 2/3/4 release them, 5 clears the DISCONNECT error bit. 0 is rejected by the
# vendor service as 'Invalid command'.
#
# Codes ABOVE 6 are undocumented and MUST NOT be sent. Sweeping 7..16 while
# hunting for a backdrive mode appears to have left one of these arms in a
# locked state that survived a power cycle. This allowlist exists so that no
# parameter typo can repeat that.
ALLOWED_FUNCTION_CODES = frozenset({1, 2, 3, 4, 5, 6})

IDLE, ENGAGING, ACTIVE = "IDLE", "ENGAGING", "ACTIVE"


def sensor_qos(depth: int = 1) -> QoSProfile:
    """Depth-1 best-effort: two 200 Hz streams into a 100 Hz loop.

    Queueing them would just build a backlog of samples that are already stale
    by the time they are read, so the transport is told to keep only the newest.
    Best-effort is compatible with the RELIABLE publishers on both sides.
    """
    return QoSProfile(
        reliability=ReliabilityPolicy.BEST_EFFORT,
        history=HistoryPolicy.KEEP_LAST,
        durability=DurabilityPolicy.VOLATILE,
        depth=depth,
    )


def command_qos(depth: int = 1) -> QoSProfile:
    """The vendor's control subscriptions are RELIABLE, so ours must be too --
    a BEST_EFFORT publisher would not match them and the arm would hear nothing.
    """
    return QoSProfile(
        reliability=ReliabilityPolicy.RELIABLE,
        history=HistoryPolicy.KEEP_LAST,
        durability=DurabilityPolicy.VOLATILE,
        depth=depth,
    )


class Sample:
    """Latest-wins holder for one feedback stream, with its arrival time."""

    __slots__ = ("position", "velocity", "effort", "stamp", "count")

    def __init__(self):
        self.position = None
        self.velocity = None
        self.effort = None
        self.stamp = 0.0
        self.count = 0

    def update(self, msg: JointState, now: float) -> None:
        self.position = [float(v) for v in msg.position]
        self.velocity = [float(v) for v in msg.velocity]
        self.effort = [float(v) for v in msg.effort]
        self.stamp = now
        self.count += 1

    def fresh(self, now: float, timeout: float) -> bool:
        return self.position is not None and (now - self.stamp) <= timeout


class TeleopNode(Node):

    def __init__(self) -> None:
        super().__init__("a1x_teleop")

        p = self.declare_parameter
        p("leader_topic", "/leader/hdas/feedback_arm")
        p("follower_topic", "/hdas/feedback_arm")
        p("follower_gripper_topic", "/hdas/feedback_gripper")
        p("control_topic", "/motion_control/control_arm")
        p("gripper_control_topic", "/motion_control/control_gripper")
        p("function_frame_service", "/function_frame_arm")

        p("rate", 100.0)                 # control loop, Hz
        p("kp", 25.0)                    # gentle: J2/J3 will sag a little
        p("kd", 3.0)
        p("gain_ramp_time", 3.0)         # seconds to ease the gains in
        p("max_speed", DEFAULT_MAX_SPEED)          # rad/s on the target
        p("limit_margin", DEFAULT_LIMIT_MARGIN)    # rad of slack on URDF limits
        p("leader_filter_alpha", 0.4)    # 1.0 disables; NOT a deadband
        p("velocity_feedforward", True)
        p("stale_timeout", 0.25)         # s before a stream counts as dead
        p("freeze_frames", 400)          # 2 s at 200 Hz of identical payloads

        p("auto_enable", True)           # energise the follower on engage
        p("enable_code", 1)
        p("clear_errors_on_engage", True)
        p("clear_code", 5)
        # Energising the follower interrupts its feedback: ARM_APP stops
        # publishing for a few hundred ms and the payload it resumes with can
        # briefly read zero on some joints. Both the reference capture and the
        # staleness fault have to wait that out -- see _wait_for_follower().
        p("engage_settle_time", 0.4)     # s of unbroken feedback before trusting it
        p("engage_settle_timeout", 5.0)  # s to wait for the stream to come back
        p("engage_pose_tolerance", 0.15) # rad; larger pre/post shift aborts engage
        p("fault_debounce", 0.5)         # s of stale feedback before disengaging
        p("release_on_disengage", False)  # send a release code as well as zero gains

        p("enable_gripper", False)       # opt-in: see the note in _gripper_step
        p("gripper_speed", 0.6)          # units/s on the vendor gripper scale
        p("gripper_effort_limit", 1.2)   # stop advancing on contact
        p("gripper_kp", 20.0)
        p("gripper_kd", 2.0)
        p("gripper_min", -1.0)
        p("gripper_max", 6.0)

        p("keyboard", True)
        p("auto_engage", False)          # engage as soon as preconditions pass

        g = lambda n: self.get_parameter(n).value          # noqa: E731
        self.rate = max(1.0, float(g("rate")))
        self.kp_max = float(g("kp"))
        self.kd_max = float(g("kd"))
        self.max_speed = float(g("max_speed"))
        self.limit_margin = float(g("limit_margin"))
        self.vff = bool(g("velocity_feedforward"))
        self.stale_timeout = float(g("stale_timeout"))
        self.auto_enable = bool(g("auto_enable"))
        self.clear_on_engage = bool(g("clear_errors_on_engage"))
        self.release_on_disengage = bool(g("release_on_disengage"))
        self.use_gripper = bool(g("enable_gripper"))
        self.grip_speed = float(g("gripper_speed"))
        self.grip_effort_limit = abs(float(g("gripper_effort_limit")))
        self.grip_kp = float(g("gripper_kp"))
        self.grip_kd = float(g("gripper_kd"))
        self.grip_min = float(g("gripper_min"))
        self.grip_max = float(g("gripper_max"))

        self.enable_code = self._checked_code(int(g("enable_code")), "enable_code")
        self.clear_code = self._checked_code(int(g("clear_code")), "clear_code")
        self.settle_time = float(g("engage_settle_time"))
        self.settle_timeout = float(g("engage_settle_timeout"))
        self.pose_tolerance = float(g("engage_pose_tolerance"))
        self.stale_limit = max(1, int(float(g("fault_debounce")) * self.rate))

        self.delta = DeltaMap()
        self.limiter = RateLimiter(self.max_speed)
        self.ramp = GainRamp(float(g("gain_ramp_time")))
        self.filter = PositionFilter(float(g("leader_filter_alpha")))
        self.freeze = FreezeDetector(int(g("freeze_frames")))

        self.leader = Sample()
        self.follower = Sample()
        self.gripper = Sample()
        self._lock = threading.Lock()

        self.state = IDLE
        self.engage_time = 0.0
        self._stop = threading.Event()
        self._engage_busy = False
        self._grip_dir = 0                # -1 close, 0 hold, +1 open
        self._grip_target = None
        self._grip_blocked = False
        self._stale_cycles = 0
        self._holding = False
        self._status_errors = []

        qos = sensor_qos()
        self.create_subscription(JointState, g("leader_topic"), self._on_leader, qos)
        self.create_subscription(JointState, g("follower_topic"), self._on_follower, qos)
        self.create_subscription(JointState, g("follower_gripper_topic"),
                                 self._on_gripper, qos)
        self.create_subscription(String, "~/command", self._on_command, 10)

        self.pub = self.create_publisher(MotorControl, g("control_topic"), command_qos())
        self.pub_grip = self.create_publisher(
            MotorControl, g("gripper_control_topic"), command_qos())
        self.ff_client = self.create_client(FunctionFrame, g("function_frame_service"))

        try:
            from hdas_msg.msg import FeedbackStatus
            self.create_subscription(FeedbackStatus, "/hdas/feedback_status_arm",
                                     self._on_status, sensor_qos(depth=1))
        except ImportError:
            pass

        self.get_logger().info(
            f"leader {g('leader_topic')} -> follower {g('control_topic')}  "
            f"@{self.rate:.0f} Hz  kp<={self.kp_max:g} kd<={self.kd_max:g}  "
            f"max {math.degrees(self.max_speed):.0f} deg/s")
        self.get_logger().info("state IDLE -- zero torque. press 'e' to engage.")

        self._ctl = threading.Thread(target=self._control_loop, daemon=True)
        self._ctl.start()
        self._kbd = None
        if bool(g("keyboard")) and sys.stdin.isatty():
            self._kbd = threading.Thread(target=self._keyboard_loop, daemon=True)
            self._kbd.start()
        elif bool(g("keyboard")):
            self.get_logger().info(
                "stdin is not a TTY -- keyboard disabled; use ~/command instead")
        if bool(g("auto_engage")):
            threading.Thread(target=self._auto_engage_when_ready, daemon=True).start()

    def _checked_code(self, code: int, what: str) -> int:
        if code not in ALLOWED_FUNCTION_CODES:
            raise SystemExit(
                f"{what}={code} is not in the known-safe set "
                f"{sorted(ALLOWED_FUNCTION_CODES)}. Codes above 6 are "
                f"undocumented and have previously locked an arm; refusing.")
        return code

    # ---- feedback ---------------------------------------------------------
    def _on_leader(self, msg: JointState) -> None:
        if len(msg.position) < N_JOINTS:
            return
        with self._lock:
            self.leader.update(msg, time.monotonic())
            self.freeze.update(self.leader.position)

    def _on_follower(self, msg: JointState) -> None:
        # The vendor publishes name=['arm'] with 7 positions (6 joints then the
        # gripper), so entries are taken by index -- the names carry no mapping.
        if len(msg.position) < N_JOINTS:
            return
        with self._lock:
            self.follower.update(msg, time.monotonic())

    def _on_gripper(self, msg: JointState) -> None:
        if not msg.position:
            return
        with self._lock:
            self.gripper.update(msg, time.monotonic())

    def _on_status(self, msg) -> None:
        errs = [(e.name, e.error_code, list(e.error_description))
                for e in msg.errors if e.error_code]
        with self._lock:
            self._status_errors = errs

    def _on_command(self, msg: String) -> None:
        self.dispatch(msg.data.strip().lower())

    # ---- commands ---------------------------------------------------------
    def dispatch(self, word: str) -> None:
        if word in ("e", "engage", "clutch"):
            self.request_engage()
        elif word in ("r", "release", "idle", "disengage"):
            self.disengage("commanded")
        elif word in ("o", "open", "gripper_open"):
            self._set_grip(+1)
        elif word in ("c", "close", "gripper_close"):
            self._set_grip(-1)
        elif word in ("x", "gripper_stop"):
            self._set_grip(0)
        elif word in ("?", "status"):
            self.print_status()
        elif word in ("q", "quit", "stop"):
            self.request_stop()
        elif word:
            self.get_logger().warn(f"unknown command {word!r}")

    def _set_grip(self, direction: int) -> None:
        if not self.use_gripper:
            self.get_logger().warn(
                "gripper is disabled -- start with -p enable_gripper:=true "
                "(and read the travel-range note first)")
            return
        self._grip_dir = direction
        self._grip_blocked = False
        self.get_logger().info(
            f"gripper {'open' if direction > 0 else 'close' if direction < 0 else 'hold'}")

    def request_engage(self) -> None:
        if self._engage_busy:
            return
        with self._lock:
            running = self.state in (ENGAGING, ACTIVE)
            if running:
                # Re-referencing while running is the clutch: the follower holds
                # still and the leader's current pose becomes the new zero. The
                # follower is re-referenced to the last *commanded* target, not
                # to its measured pose, so the command stays continuous and the
                # arm does not twitch by whatever it happens to be sagging.
                if not self._preconditions_ok(reengage=True):
                    return
                if self.limiter.value is None:
                    return
                leader_now = self.filter.update(self.leader.position)
                self.delta.reference(leader_now, self.limiter.value)
        if running:
            self.get_logger().info("re-referenced (clutch) -- follower held in place")
            return
        self._engage_busy = True
        threading.Thread(target=self._engage_sequence, daemon=True).start()

    def _preconditions_ok(self, reengage: bool = False) -> bool:
        """Caller must hold the lock."""
        now = time.monotonic()
        if not self.leader.fresh(now, self.stale_timeout):
            self.get_logger().error(
                "leader is not publishing -- is the driver up on can1? "
                "(ros2 run galaxea_a1xy_driver driver_node "
                "--ros-args -r __ns:=/leader -p can_interface:=can1)")
            return False
        if not self.follower.fresh(now, self.stale_timeout):
            self.get_logger().error(
                "follower is not publishing -- is the vendor HDAS up on can0?")
            return False
        if self.freeze.frozen:
            self.get_logger().error(
                f"LEADER FROZEN: {self.freeze.count} identical position payloads. "
                "The arm is transmitting but its encoders are not reporting -- "
                "this is the released-motor state, not a still arm. Refusing to "
                "engage (the follower would simply never move).")
            return False
        if not reengage and len(self.follower.position) < N_JOINTS:
            self.get_logger().error("follower feedback too short")
            return False
        return True

    def _wait_for_follower(self) -> bool:
        """Block until the follower's feedback has run unbroken for settle_time.

        Energising the motors knocks the vendor's publisher over for a few
        hundred milliseconds, and the first payloads it produces afterwards can
        read zero on individual joints. Sampling the reference pose during that
        window captures a pose the arm is not actually in -- which the gain ramp
        would then faithfully drive it to. So wait for a continuous run of fresh
        samples rather than sleeping a fixed guess.
        """
        deadline = time.monotonic() + self.settle_timeout
        stable_since = None
        while time.monotonic() < deadline and not self._stop.is_set():
            now = time.monotonic()
            with self._lock:
                fresh = self.follower.fresh(now, self.stale_timeout)
            if not fresh:
                stable_since = None
            else:
                if stable_since is None:
                    stable_since = now
                elif now - stable_since >= self.settle_time:
                    return True
            time.sleep(0.02)
        return False

    def _engage_sequence(self) -> None:
        try:
            with self._lock:
                if not self._preconditions_ok():
                    return
                pre_pose = list(self.follower.position[:N_JOINTS])

            if self.auto_enable:
                if not self.ff_client.wait_for_service(timeout_sec=3.0):
                    self.get_logger().error(
                        "function_frame service unavailable -- refusing to engage")
                    return
                if self.clear_on_engage:
                    self._call_function_frame(self.clear_code, "clear errors")
                if not self._call_function_frame(self.enable_code, "energise motors"):
                    self.get_logger().error("enable failed -- staying IDLE")
                    return
                if not self._wait_for_follower():
                    self.get_logger().error(
                        f"follower feedback did not resume within "
                        f"{self.settle_timeout:.1f}s of energising -- staying IDLE")
                    return

            with self._lock:
                if not self._preconditions_ok():
                    return
                leader_now = self.filter.update(self.leader.position)
                follower_now = list(self.follower.position[:N_JOINTS])
                # The pose must not have jumped across the enable. If it has,
                # one of the two readings is junk and referencing to it would
                # command the difference as a real move once the gains ramp in.
                shift = max(abs(a - b) for a, b in zip(follower_now, pre_pose))
                if shift > self.pose_tolerance:
                    bad = max(range(N_JOINTS),
                              key=lambda i: abs(follower_now[i] - pre_pose[i]))
                    self.get_logger().error(
                        f"follower pose shifted {math.degrees(shift):.1f} deg "
                        f"(J{bad+1}) across the enable: "
                        f"{math.degrees(pre_pose[bad]):+.1f} -> "
                        f"{math.degrees(follower_now[bad]):+.1f} deg. One reading "
                        f"is unreliable; refusing to engage rather than commanding "
                        f"that as a move. Try again.")
                    return
                stray = out_of_range(follower_now, self.limit_margin)
                self.delta.reference(leader_now, follower_now)
                self.limiter.reset(follower_now)
                self.freeze.reset()
                self._stale_cycles = 0
                self._holding = False
                self.engage_time = time.monotonic()
                self.state = ENGAGING
                errs = list(self._status_errors)

            if stray:
                self.get_logger().warn(
                    "follower joints outside URDF limits at engage: "
                    + ", ".join(f"J{i+1}" for i in stray)
                    + " -- they will be pulled inside the clamp")
            if errs:
                self.get_logger().warn(
                    "follower reports errors: "
                    + "; ".join(f"{n}={','.join(d) or c}" for n, c, d in errs))
            self.get_logger().info(
                f"ENGAGED -- easing gains in over {self.ramp.duration:.1f}s. "
                f"follower start ["
                + " ".join(f"{math.degrees(v):+.1f}" for v in follower_now) + "] deg")
        finally:
            self._engage_busy = False

    def _call_function_frame(self, code: int, what: str) -> bool:
        code = self._checked_code(code, "function code")
        req = FunctionFrame.Request()
        req.command = code
        future = self.ff_client.call_async(req)
        deadline = time.monotonic() + 3.0
        while not future.done() and time.monotonic() < deadline and not self._stop.is_set():
            time.sleep(0.02)
        if not future.done():
            self.get_logger().error(f"{what} (code {code}): service call timed out")
            return False
        resp = future.result()
        if resp is None or not resp.success:
            msg = getattr(resp, "message", "no response")
            self.get_logger().error(f"{what} (code {code}) failed: {msg}")
            return False
        self.get_logger().info(f"{what} (code {code}): {resp.message or 'ok'}")
        return True

    def disengage(self, why: str) -> None:
        with self._lock:
            if self.state == IDLE:
                return
            self.state = IDLE
            self._grip_dir = 0
            self._grip_target = None
        self.get_logger().warn(f"RELEASED ({why}) -- zero torque, arm is limp")
        if self.release_on_disengage and self.auto_enable:
            threading.Thread(
                target=self._call_function_frame,
                args=(2, "release motors"), daemon=True).start()

    def request_stop(self) -> None:
        """Safe from a signal handler: touches nothing but an Event."""
        self._stop.set()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    # ---- control loop -----------------------------------------------------
    def _control_loop(self) -> None:
        period = 1.0 / self.rate
        last = time.monotonic()
        next_tick = last
        while not self._stop.is_set():
            next_tick += period
            sleep = next_tick - time.monotonic()
            if sleep > 0:
                time.sleep(sleep)
            else:
                next_tick = time.monotonic()        # fell behind; resynchronise
            now = time.monotonic()
            dt = min(max(now - last, 1e-4), 0.1)
            last = now
            try:
                self._cycle(now, dt)
            except Exception as exc:                # never let the loop die
                self.get_logger().error(f"control cycle failed: {exc}")
                self.disengage("control cycle raised")
        self._publish_zero()

    def _cycle(self, now: float, dt: float) -> None:
        """One control cycle.

        Every piece of shared state -- the samples, the delta map, the filter,
        the limiter and the mode -- is read and advanced under a single lock,
        because engage/clutch runs on its own thread and can re-reference the
        mapping part-way through a cycle. What to publish is therefore decided
        atomically; only the publishing itself happens outside the lock.
        """
        fault = None
        payload = None
        hold = None
        with self._lock:
            state = self.state
            follower_pos = (list(self.follower.position)
                            if self.follower.position else None)
            if state != IDLE:
                leader_ok = self.leader.fresh(now, self.stale_timeout)
                follower_ok = self.follower.fresh(now, self.stale_timeout)
                frac = self.ramp.fraction(now - self.engage_time)
                if self.freeze.frozen:
                    # Not a hiccup: a frozen leader never recovers on its own.
                    fault = "leader froze (encoders stopped reporting)"
                elif not (leader_ok and follower_ok):
                    # A brief gap is normal -- the vendor publisher stutters
                    # around mode changes. Hold the last target at the gains
                    # already applied (the arm simply stays put, which is what
                    # it would do anyway with no new leader data) and only give
                    # up if the stream really is gone.
                    self._stale_cycles += 1
                    which = "leader" if not leader_ok else "follower"
                    if self._stale_cycles >= self.stale_limit:
                        fault = f"{which} feedback stopped"
                    elif self.limiter.value is not None:
                        hold = (which, list(self.limiter.value),
                                [self.kp_max * frac] * N_JOINTS,
                                [self.kd_max * frac] * N_JOINTS)
                else:
                    self._stale_cycles = 0
                    if self._holding:
                        self._holding = False
                    smoothed = self.filter.update(self.leader.position)
                    bounded = clamp_to_limits(
                        self.delta.target(smoothed), self.limit_margin)
                    target = self.limiter.step(bounded, dt)
                    promoted = state == ENGAGING and frac >= 1.0
                    if promoted:
                        self.state = ACTIVE
                    v_des = ([clamp(v, -self.max_speed, self.max_speed)
                              for v in self.limiter.velocity]
                             if self.vff else [0.0] * N_JOINTS)
                    payload = (target, v_des,
                               [self.kp_max * frac] * N_JOINTS,
                               [self.kd_max * frac] * N_JOINTS, promoted)

        if fault is not None:
            self.disengage(fault)
            self._publish_zero(follower_pos)
            return
        if hold is not None:
            which, target, kp, kd = hold
            if not self._holding:
                self._holding = True
                self.get_logger().warn(
                    f"{which} feedback gap -- holding position "
                    f"(disengaging if it lasts {self.stale_limit / self.rate:.1f}s)")
            self._publish(target, [0.0] * N_JOINTS, kp, kd)
            return
        if payload is None:                             # IDLE
            self._publish_zero(follower_pos)
            self._gripper_step(dt, engaged=False)
            return

        target, v_des, kp, kd, promoted = payload
        if promoted:
            self.get_logger().info(f"ACTIVE -- kp={self.kp_max:g} kd={self.kd_max:g}")
        self._publish(target, v_des, kp, kd)
        self._gripper_step(dt, engaged=True)

    # ---- publishing -------------------------------------------------------
    def _msg(self, name: str, p, v, kp, kd) -> MotorControl:
        m = MotorControl()
        m.header.stamp = self.get_clock().now().to_msg()
        m.name = name
        m.p_des = [float(x) for x in p]
        m.v_des = [float(x) for x in v]
        m.kp = [float(x) for x in kp]
        m.kd = [float(x) for x in kd]
        m.t_ff = [0.0] * len(p)
        m.mode = 0
        return m

    def _publish(self, p, v, kp, kd) -> None:
        self.pub.publish(self._msg("arm", p, v, kp, kd))

    def _publish_zero(self, follower_pos=None) -> None:
        """The only command that provably cannot move the arm.

        p_des is set to the follower's own measured pose so that if anything
        downstream ever applied a gain of its own, the commanded pose would
        still be where the arm already is.
        """
        if follower_pos is None:
            with self._lock:
                follower_pos = (list(self.follower.position)
                                if self.follower.position else None)
        p = (follower_pos[:N_JOINTS] if follower_pos and len(follower_pos) >= N_JOINTS
             else [0.0] * N_JOINTS)
        z = [0.0] * N_JOINTS
        self._publish(p, z, z, z)

    # ---- gripper ----------------------------------------------------------
    def _gripper_step(self, dt: float, engaged: bool) -> None:
        """Key-driven, force-limited gripper.

        The A1X gripper is NOT backdrivable, so the leader's gripper cannot be a
        teleop input -- there is nothing to read from it. It is driven from keys
        instead, as a target that creeps in the requested direction and simply
        stops advancing once effort crosses the contact limit. Stopping the
        *target* rather than the torque is what makes it hold an object without
        crushing it: the impedance controller keeps a constant, bounded squeeze.

        Disabled by default. The vendor's gripper feedback is on a scale we have
        not calibrated (it reads ~3.6 at rest, which is not the arm's own
        gripper-group scale), so gripper_min/gripper_max are conservative
        guesses. Confirm the real travel on your hardware before trusting them.
        """
        if not self.use_gripper:
            return
        with self._lock:
            pos = self.gripper.position[0] if self.gripper.position else None
            eff = self.gripper.effort[0] if self.gripper.effort else 0.0
        if pos is None:
            return
        if not engaged:
            self._grip_target = None
            self.pub_grip.publish(self._msg("gripper", [pos], [0.0], [0.0], [0.0]))
            return
        if self._grip_target is None:
            self._grip_target = pos

        if self._grip_dir and abs(eff) >= self.grip_effort_limit:
            if not self._grip_blocked:
                self.get_logger().info(
                    f"gripper contact at effort {eff:+.2f} -- holding target")
                self._grip_blocked = True
        elif self._grip_dir:
            self._grip_blocked = False
            self._grip_target = clamp(
                self._grip_target + self._grip_dir * self.grip_speed * dt,
                self.grip_min, self.grip_max)

        self.pub_grip.publish(self._msg(
            "gripper", [self._grip_target], [0.0], [self.grip_kp], [self.grip_kd]))

    # ---- ui ---------------------------------------------------------------
    def print_status(self) -> None:
        now = time.monotonic()
        with self._lock:
            lp, fp = self.leader.position, self.follower.position
            lfresh = self.leader.fresh(now, self.stale_timeout)
            ffresh = self.follower.fresh(now, self.stale_timeout)
            frozen, fcount = self.freeze.frozen, self.freeze.count
            errs = list(self._status_errors)
        deg = lambda v: " ".join(f"{math.degrees(x):+7.2f}" for x in v[:N_JOINTS])  # noqa: E731
        self.get_logger().info(
            f"state={self.state}  leader={'ok' if lfresh else 'STALE'}"
            f"{' FROZEN' if frozen else ''}({fcount})  "
            f"follower={'ok' if ffresh else 'STALE'}")
        if lp:
            self.get_logger().info(f"  leader   deg [{deg(lp)}]")
        if fp:
            self.get_logger().info(f"  follower deg [{deg(fp)}]")
        if self.limiter.value:
            self.get_logger().info(f"  target   deg [{deg(self.limiter.value)}]")
        if errs:
            self.get_logger().info(
                "  errors: " + "; ".join(f"{n}={','.join(d) or c}" for n, c, d in errs))

    def _keyboard_loop(self) -> None:
        import select
        import termios
        import tty
        fd = sys.stdin.fileno()
        try:
            saved = termios.tcgetattr(fd)
        except termios.error:
            return
        try:
            tty.setcbreak(fd)
            while not self._stop.is_set():
                if not select.select([sys.stdin], [], [], 0.2)[0]:
                    continue
                ch = sys.stdin.read(1)
                if not ch:
                    continue
                if ch == " ":
                    self.disengage("panic key")
                elif ch == "\x03":               # Ctrl-C in cbreak mode
                    self.request_stop()
                else:
                    self.dispatch(ch)
        finally:
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, saved)
            except termios.error:
                pass

    # ---- shutdown ---------------------------------------------------------
    def final_release(self) -> None:
        """Zero-torque on the way out, whatever the exit path was."""
        self.state = IDLE
        try:
            for _ in range(10):
                self._publish_zero()
                time.sleep(0.01)
            self.get_logger().warn("zero torque sent -- follower is limp, support it")
        except Exception as exc:
            self.get_logger().error(f"final release failed: {exc}")

    def join_control(self, timeout: float = 2.0) -> None:
        if self._ctl.is_alive():
            self._ctl.join(timeout)


def main(args=None) -> None:
    import signal

    rclpy.init(args=args)
    node = None
    try:
        node = TeleopNode()
        # Signal handlers must not touch rclpy -- they only set an Event, and
        # the release is done by the main thread below on its way out.
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: node.request_stop())
        while rclpy.ok() and not node.stopping:
            rclpy.spin_once(node, timeout_sec=0.05)
    except KeyboardInterrupt:
        pass
    finally:
        if node is not None:
            node.request_stop()
            node.join_control()
            node.final_release()        # must happen before shutdown
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
