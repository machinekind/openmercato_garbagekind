"""Galaxea A1XY driver node.

Reads the arm's 200 Hz CAN-FD feedback and republishes it as JointState, using
the topic names the vendor's HDAS uses so downstream code stays portable.

Transmit is DISABLED unless `command_can_id` is set to a non-negative value.
That ID is not published by Galaxea and is not recoverable from the SDK we have
(it lives in an encrypted config); sending a control payload on a guessed ID
could command unintended motion on an arm that has no joint brakes.
"""
import math
import os
import socket
import threading
import time

import rclpy
from rcl_interfaces.msg import ParameterDescriptor
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Float32

from galaxea_a1xy_msgs.msg import MotorControl

from . import can_io
from . import gravity
from .protocol import (
    CMD_CAN_ID, FB_CAN_ID, FB_LEN, FF_CAN_ID, N_JOINTS,
    FF_ENABLE, FF_ENABLE2, ArmCommand,
    decode_feedback, encode_command, encode_function_frame,
)

# FOLLOW mode -- what actually makes this arm hand-movable.
#
# Measured on this hardware, over our own SocketCAN path on can1:
#   * with kp = 0 the arm IGNORES the command completely. +/-1.0 Nm of t_ff
#     moved J1 by 0.00 deg. It keeps holding its own internal setpoint, which
#     is why every "zero gain" and "limp" attempt still left it rigid.
#   * kp does not set stiffness either. A 3 deg step tracks to 98% and reaches
#     half-way in ~0.18 s at kp = 0.5, at kp = 20, and everywhere between.
#   * t_ff and kd have no measurable effect at all.
#   * released (function frame 2/3/4) the arm IS free, but 0x052 freezes solid,
#     and streaming commands while released does NOT revive it (tested with an
#     all-zero payload and with kd=0.2: 1 distinct reading per joint).
#
# So the documented MIT impedance law is not live here: the arm honours p_des
# and nothing else, with a fixed high internal gain, and it only reports while
# energised. No gain makes it soft.
#
# What is left is to stop giving it a FIXED point to hold. Every cycle p_des is
# set to the position the arm is actually in, so there is no accumulated error
# to spring back to -- the servo chases your hand instead of resisting it. kp
# must be non-zero or the frame is discarded; its value is irrelevant.
FOLLOW_KP = 5.0
FOLLOW_KD = 0.3
# Optional latency compensation. The arm resists over the ~10 ms between our
# reading a position and its acting on the command; aiming p_des slightly ahead
# along the measured velocity cancels that and makes it feel lighter. It is
# positive feedback, so it is off by default and hard-bounded when enabled.
FOLLOW_LEAD_MAX = 0.06        # s of look-ahead allowed
FOLLOW_LEAD_CLAMP = 0.05      # rad; never aim more than this beyond the arm
# The reported velocity has a measured noise floor of 4-5 deg/s on a joint that
# is provably stationary (position steady to 0.01 deg). Multiplying that noise
# by the lead aims the target slightly off, the arm goes there, which produces
# more apparent velocity -- and the wrist walks away on its own. Seen: J5 drifted
# 35 deg and J6 27 deg in 5 s at lead=0.05 with nobody touching the arm. So the
# lead only engages once motion is unambiguously real.
FOLLOW_LEAD_DEADBAND = math.radians(12.0)   # rad/s
FLOAT_KD = (0.6, 0.6, 0.6, 0.3, 0.3, 0.3)
FLOAT_RATE = 250.0
DEFAULT_CAL = "/home/ros/ros2_ws/leader_gravity.json"

JOINT_NAMES = [f"arm_joint{i}" for i in range(1, 7)]
TEMP_CAN_ID = 0x054
VERSION_CAN_ID = 0x055
HEARTBEAT_CAN_ID = 0x023
HEARTBEAT_PERIOD = 0.4

# The arm's ACU only polls its joint motors while a host heartbeat is present on
# 0x023. Without it, 0x052 keeps arriving at 200 Hz but with a FROZEN payload --
# identical bytes every frame -- so the arm looks alive while reporting nothing.
# The vendor HDAS emits this on its own bus; on any bus we drive ourselves we
# must emit it too. This is a presence signal, not a motion command, so it is
# sent even when transmit is otherwise disabled.


class A1XYDriver(Node):
    def __init__(self) -> None:
        super().__init__("a1xy_driver")

        self.declare_parameter("can_interface", "can0")
        self.declare_parameter("command_can_id", -1)      # -1 = transmit disabled
        self.declare_parameter("publish_gripper", True)
        # Per-joint zero offsets in radians, SUBTRACTED from the raw reading.
        # arm_joint3 reads ~ +0.026 rad (1.5 deg) at rest against a URDF limit of
        # [-3.316, 0]; the group->joint mapping was confirmed by a push test
        # (effort loaded on J2/J3/J4, untouched on J5/J6), so this is a zero
        # offset rather than a decode error.
        self.declare_parameter("joint_offsets", [0.0] * N_JOINTS)
        # Backdrive / float mode: the arm reports joint position ONLY while its
        # motors are energised -- released, it transmits a frozen payload at full
        # rate. So a hand-guided leader must stay ENERGISED, and be made
        # compliant by what we command rather than by releasing it.
        #
        # Commanding zero torque does NOT achieve that: an all-zero payload was
        # measured on this arm and leaves it just as rigid. What works is the
        # MIT law Galaxea's own A1Z SDK calls zero-gravity mode --
        # kp = 0, kd = small but non-zero, t_ff = g(q) -- so the arm carries its
        # own weight and nothing else. See gravity.py.
        #
        # g(q) is open loop, so it is only ever driven from a calibration that
        # was fitted against this arm's own measured hold torque and passed its
        # checks. Without one, float mode refuses to transmit rather than
        # guessing at the sign of a torque that can drop a brakeless arm.
        self.declare_parameter("backdrive", False)
        self.declare_parameter("gravity_calibration", DEFAULT_CAL)
        # dynamic_typing: `-p gravity_factor:=0` arrives as an INTEGER, and a
        # parameter declared double rejects it and takes the whole node down
        # before it ever opens the bus. The one value a user is most likely to
        # type -- 0, for limp mode -- is exactly the one that would have failed.
        self.declare_parameter(
            "follow_lead", 0.0,
            ParameterDescriptor(dynamic_typing=True,
                                description="seconds of velocity look-ahead; 0=off"))
        self.declare_parameter(
            "gravity_factor", 1.0,
            ParameterDescriptor(dynamic_typing=True,
                                description="gravity compensation scale; "
                                            "0 = limp (no gravity model needed)"))
        # The driver is SILENT by default. When teleop was working, nothing had
        # ever transmitted on the leader's bus. The 0x023 heartbeat was added
        # later on the strength of a test whose result was misattributed (the
        # test also sent enable codes), so it is opt-in rather than automatic.
        self.declare_parameter("heartbeat", False)

        self.iface = self.get_parameter("can_interface").value
        self.cmd_id = int(self.get_parameter("command_can_id").value)
        self.pub_gripper = bool(self.get_parameter("publish_gripper").value)
        offs = list(self.get_parameter("joint_offsets").value)
        if len(offs) != N_JOINTS:
            self.get_logger().warn(
                f"joint_offsets has {len(offs)} entries, expected {N_JOINTS}; ignoring")
            offs = [0.0] * N_JOINTS
        self.offsets = [float(v) for v in offs]

        self.pub_arm = self.create_publisher(JointState, "hdas/feedback_arm", 10)
        self.pub_grip = self.create_publisher(JointState, "hdas/feedback_gripper", 10)
        self.pub_js = self.create_publisher(JointState, "joint_states", 10)

        try:
            self.sock = can_io.open_socket(self.iface)
        except OSError as exc:
            self.get_logger().error(f"cannot open {self.iface}: {exc}")
            raise

        if self.cmd_id < 0:
            self.get_logger().warn(
                "command_can_id is unset -> TRANSMIT DISABLED (read-only). "
                "The A1XY command CAN id is not published by Galaxea; set it "
                "explicitly once known."
            )
        else:
            self.get_logger().warn(
                f"TRANSMIT ENABLED on CAN id 0x{self.cmd_id:03x} - arm may MOVE."
            )
            self.create_subscription(
                MotorControl, "motion_control/control_arm", self.on_command, 10)

        self.backdrive = bool(self.get_parameter("backdrive").value)
        self.heartbeat = bool(self.get_parameter("heartbeat").value)
        self._hb_stop = threading.Event()
        if self.heartbeat:
            self._hb_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
            self._hb_thread.start()
        self._cal = None
        self._model = None
        self._q = None
        self._v = None
        # DANGEROUS -- off unless explicitly asked for, and not reachable from
        # teleop_a2a.sh at all. Velocity look-ahead is positive feedback: on this
        # arm at lead=0.05 it drove the wrist away on its own (J5 +35 deg, J6
        # +27 deg in 5 s, untouched) and on a later run spun the arm hard enough
        # that the operator killed power. A velocity deadband now suppresses the
        # noise-driven case, but the mechanism is still positive feedback and it
        # is not needed: it never made the arm meaningfully easier to guide.
        self.follow_lead = max(0.0, min(FOLLOW_LEAD_MAX,
                                        float(self.get_parameter("follow_lead").value)))
        if self.follow_lead > 0.0:
            self.get_logger().warn(
                f"follow_lead={self.follow_lead:.3f}s is POSITIVE FEEDBACK and has "
                "caused a runaway on this hardware. Keep a hand on the arm and be "
                "ready to cut power.")
        if self.backdrive:
            if not self._load_gravity():
                self.backdrive = False
            else:
                for code in (FF_ENABLE, FF_ENABLE2):
                    try:
                        can_io.send_frame(self.sock, FF_CAN_ID,
                                          encode_function_frame(code))
                    except OSError:
                        pass
                    time.sleep(0.3)
                self._bd_thread = threading.Thread(target=self._backdrive_loop,
                                                   daemon=True)
                self._bd_thread.start()
                self.get_logger().warn(
                    "FOLLOW mode: motors energised, p_des tracks the MEASURED "
                    "pose (kp=%g, lead=%.3fs). The arm keeps reporting and the "
                    "servo chases your hand instead of holding a fixed point. "
                    "No brakes -- support it." % (FOLLOW_KP, self.follow_lead))
        if self.heartbeat:
            self.get_logger().info(
                f"emitting 0x{HEARTBEAT_CAN_ID:03x} heartbeat on {self.iface}")
        if self.backdrive:
            self.get_logger().info(
                f"{self.iface}: TRANSMITTING compliance commands on "
                f"0x{CMD_CAN_ID:03x} at {FLOAT_RATE:.0f} Hz")
        elif not self.heartbeat:
            self.get_logger().info(
                f"{self.iface}: READ-ONLY, transmitting nothing")

        self._frames = 0
        self._last_payload = None
        self._identical = 0
        self._last_report = self.get_clock().now()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._rx_loop, daemon=True)
        self._thread.start()
        self.create_timer(5.0, self._report)
        self.get_logger().info(f"listening on {self.iface} for 0x{FB_CAN_ID:03x}")

    def _load_gravity(self) -> bool:
        """Load and vet the gravity calibration. False -> do not transmit."""
        path = str(self.get_parameter("gravity_calibration").value)
        self.gravity_factor = float(self.get_parameter("gravity_factor").value)
        if self.gravity_factor == 0.0:
            # Limp mode: kp = 0, kd = small, t_ff = 0. Purely dissipative, so
            # there is no gravity model to get wrong and nothing to calibrate.
            # The arm goes compliant and keeps reporting; it just does not carry
            # its own weight.
            self._cal, self._model = None, None
            self.get_logger().warn(
                "gravity_factor=0 -> LIMP mode: kp=0, kd=%s, t_ff=0. The arm "
                "will be hand-movable and will SAG. No calibration needed."
                % (list(FLOAT_KD),))
            return True
        if not os.path.exists(path):
            self.get_logger().error(
                f"backdrive requested but no gravity calibration at {path}. "
                "Run `leader_float.py --check` (read-only) first. Staying "
                "READ-ONLY -- transmitting nothing.")
            return False
        try:
            cal = gravity.GravityCalibration.load(path)
            model = gravity.GravityModel(cal.urdf or gravity.default_urdf())
        except Exception as exc:
            self.get_logger().error(
                f"cannot use {path}: {exc}. Staying READ-ONLY.")
            return False
        if not cal.usable:
            self.get_logger().error(
                f"gravity calibration {path} did not pass its own checks:\n"
                f"{cal.describe()}\nStaying READ-ONLY -- transmitting nothing.")
            return False
        self._cal, self._model = cal, model
        self.get_logger().info(f"gravity calibration loaded from {path}\n"
                               f"{cal.describe()}")
        return True

    def _backdrive_loop(self) -> None:
        """Zero-gravity float: keep the motors energised (so the encoders keep
        reporting) while commanding only the torque that cancels the arm's own
        weight, so it offers no resistance to a hand."""
        period = 1.0 / FLOAT_RATE
        next_tick = time.time()
        while not self._hb_stop.is_set():
            next_tick += period
            sleep = next_tick - time.time()
            if sleep > 0:
                time.sleep(sleep)
            else:
                next_tick = time.time()
            q = self._q
            if q is None:
                continue
            v = self._v or [0.0] * N_JOINTS
            # Aim at where the arm IS (optionally a little ahead of it), never
            # at a fixed point. kp must be non-zero or the arm discards the
            # whole frame and keeps holding its own setpoint.
            if self.follow_lead > 0.0:
                p_des = []
                for j in range(N_JOINTS):
                    vj = v[j] if abs(v[j]) > FOLLOW_LEAD_DEADBAND else 0.0
                    p_des.append(q[j] + max(-FOLLOW_LEAD_CLAMP,
                                            min(FOLLOW_LEAD_CLAMP,
                                                vj * self.follow_lead)))
            else:
                p_des = list(q)
            cmd = ArmCommand()
            cmd.p_des = p_des
            cmd.v_des = list(v)
            cmd.kp = [FOLLOW_KP] * N_JOINTS
            cmd.kd = [FOLLOW_KD] * N_JOINTS
            cmd.t_ff = ([0.0] * N_JOINTS if self._cal is None
                        else self._cal.tau(self._model.tau(q),
                                           factor=self.gravity_factor))
            try:
                can_io.send_frame(self.sock, CMD_CAN_ID, encode_command(cmd))
            except OSError:
                pass

    def _heartbeat_loop(self) -> None:
        while not self._hb_stop.is_set():
            try:
                can_io.send_frame(self.sock, HEARTBEAT_CAN_ID, b"\x00")
            except OSError:
                pass
            self._hb_stop.wait(HEARTBEAT_PERIOD)

    # ---- receive ----------------------------------------------------------
    def _rx_loop(self) -> None:
        while not self._stop.is_set():
            try:
                frame = can_io.recv_frame(self.sock)
            except OSError:
                continue
            if frame is None:
                continue
            can_id, payload = frame
            if can_id == FB_CAN_ID and len(payload) == FB_LEN:
                if payload == self._last_payload:
                    self._identical += 1
                    if self._identical == 400:      # ~2 s of identical frames
                        self.get_logger().warn(
                            "feedback payload IDENTICAL for 400 frames -- the arm "
                            "is transmitting but not reporting. Is the 0x023 "
                            "heartbeat reaching it?")
                else:
                    self._identical = 0
                self._last_payload = payload
                try:
                    self._on_feedback(payload)
                except Exception as exc:            # never let the loop die
                    self.get_logger().error(f"feedback handling failed: {exc}")

    def _on_feedback(self, payload: bytes) -> None:
        fb = decode_feedback(payload)
        self._frames += 1
        # Float mode recomputes g(q) from this, so it must be the raw joint
        # angles the model expects -- offsets are a reporting convention only.
        self._q = list(fb.position[:N_JOINTS])
        self._v = list(fb.velocity[:N_JOINTS])
        now = self.get_clock().now().to_msg()

        arm = JointState()
        arm.header.stamp = now
        arm.name = JOINT_NAMES
        arm.position = [float(v) - o
                        for v, o in zip(fb.position[:N_JOINTS], self.offsets)]
        arm.velocity = [float(v) for v in fb.velocity[:N_JOINTS]]
        arm.effort = [float(v) for v in fb.effort[:N_JOINTS]]
        self.pub_arm.publish(arm)

        # Build plain lists first: rclpy converts these fields to array.array on
        # assignment, and array.array cannot be extended with a list.
        names = list(JOINT_NAMES)
        pos = list(arm.position)
        vel = [float(v) for v in fb.velocity[:N_JOINTS]]
        eff = [float(v) for v in fb.effort[:N_JOINTS]]
        if self.pub_gripper:
            # URDF gripper fingers are prismatic 0..0.05 m, mirrored.
            stroke = max(0.0, min(0.05, fb.position[6] * 0.05))
            names += ["gripper_finger_joint1", "gripper_finger_joint2"]
            pos += [stroke, -stroke]
            vel += [0.0, 0.0]
            eff += [0.0, 0.0]

        js = JointState()
        js.header.stamp = now
        js.name = names
        js.position = pos
        js.velocity = vel
        js.effort = eff
        self.pub_js.publish(js)

        if self.pub_gripper:
            grip = JointState()
            grip.header.stamp = now
            grip.name = ["gripper"]
            grip.position = [float(fb.position[6])]
            grip.velocity = [float(fb.velocity[6])]
            grip.effort = [float(fb.effort[6])]
            self.pub_grip.publish(grip)

    # ---- transmit ---------------------------------------------------------
    def on_command(self, msg: MotorControl) -> None:
        if self.cmd_id < 0:
            return
        cmd = ArmCommand()
        for name in ("p_des", "v_des", "kp", "kd", "t_ff"):
            vals = list(getattr(msg, name))
            if not vals:
                continue
            if len(vals) != N_JOINTS:
                self.get_logger().error(
                    f"{name} has {len(vals)} entries, expected {N_JOINTS}; dropping")
                return
            setattr(cmd, name, [float(v) for v in vals])
        try:
            can_io.send_fd_frame(self.sock, self.cmd_id, encode_command(cmd))
        except OSError as exc:
            self.get_logger().error(f"CAN send failed: {exc}")

    # ---- housekeeping -----------------------------------------------------
    def _report(self) -> None:
        rate = self._frames / 5.0
        if rate == 0:
            self.get_logger().warn(
                f"no frames on {self.iface} - arm powered off, or CAN unplugged?")
        else:
            self.get_logger().info(f"feedback {rate:.0f} Hz")
        self._frames = 0

        self._frames = 0

    def destroy_node(self) -> bool:
        self._hb_stop.set()
        self._stop.set()
        try:
            self.sock.close()
        except OSError:
            pass
        return super().destroy_node()


def main(args=None) -> None:
    rclpy.init(args=args)
    node = None
    try:
        node = A1XYDriver()
        rclpy.spin(node)
    except (KeyboardInterrupt, OSError):
        pass
    finally:
        if node is not None:
            node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
