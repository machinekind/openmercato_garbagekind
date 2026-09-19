#!/usr/bin/env python3
"""Acceleration/velocity watchdog for the leader arm.

Rationale
---------
The A1X has no joint brakes. Any torque-mode experiment (gravity compensation,
t_ff probing) can in principle run away: a sign error, a bad model, or a gain
that is too high all show up first as the arm ACCELERATING. Position error is a
lagging indicator; acceleration is the leading one.

This watchdog samples joint state, differentiates to get acceleration, and on
any breach immediately:
  1. streams zero-torque commands (kp=kd=t_ff=0), and
  2. sends the motor-release function frame,
then reports why it tripped.

Thresholds are deliberately conservative; a human moving a leader arm by hand
rarely exceeds ~400 deg/s^2 or ~180 deg/s.
"""
import math
import time
from collections import deque

from protocol import (CMD_CAN_ID, FF_CAN_ID, N_JOINTS, ArmCommand,
                      encode_command, encode_function_frame, FF_RELEASE)
import can_io

# Hard ceilings: above what a person can impart by hand on this arm.
MAX_ACCEL = math.radians(600.0)    # rad/s^2 per joint
MAX_VEL = math.radians(220.0)      # rad/s  per joint
WINDOW = 5                         # samples used for the velocity derivative

# Runaway discriminator. A hand pushing the arm produces acceleration in
# whatever direction the hand chooses, briefly, and it reverses as the hand
# decelerates. A wrong-signed or over-large t_ff produces acceleration that is
# SUSTAINED and ALIGNED WITH THE COMMANDED TORQUE -- the arm driving itself.
# That is the case a plain threshold catches too late, so it trips much lower.
RUNAWAY_ACCEL = math.radians(150.0)   # rad/s^2, aligned-and-sustained
RUNAWAY_SAMPLES = 12                  # consecutive samples (~0.12 s at 100 Hz)

# The velocity field is quantised at 1/750 rad/s, so a single-sample step
# differentiates into a huge phantom acceleration (a 1 LSB jump over 10 ms
# reads as ~7 deg/s^2; a few LSB of noise reads as hundreds). Raw derivatives
# are therefore unusable as a trip condition. We low-pass the velocity and
# require the breach to PERSIST, which keeps the response fast (~30 ms) while
# ignoring quantisation noise.
VEL_ALPHA = 0.35                      # EMA smoothing on velocity
BREACH_SAMPLES = 3                    # consecutive samples over a hard limit


class SafetyTrip(Exception):
    """Raised when the watchdog cuts the motors."""


class SafetyMonitor:
    def __init__(self, sock, max_accel=MAX_ACCEL, max_vel=MAX_VEL, verbose=True):
        self.sock = sock
        self.max_accel = max_accel
        self.max_vel = max_vel
        self.verbose = verbose
        self.hist = deque(maxlen=WINDOW)     # (t, [vel])
        self.tripped = False
        self.peak_accel = [0.0] * N_JOINTS
        self.peak_vel = [0.0] * N_JOINTS
        self.aligned = [0] * N_JOINTS      # consecutive aligned-accel samples
        self.breach = [0] * N_JOINTS       # consecutive hard-limit samples
        self.vf = None                     # filtered velocity

    def cut(self, reason):
        """Kill torque immediately: zero-torque stream, then motor release."""
        self.tripped = True
        try:
            for _ in range(25):
                can_io.send_frame(self.sock, CMD_CAN_ID,
                                  encode_command(ArmCommand.zero_torque()))
                time.sleep(0.002)
            can_io.send_frame(self.sock, FF_CAN_ID,
                              encode_function_frame(FF_RELEASE))
        except OSError:
            pass
        if self.verbose:
            print(f"  *** SAFETY CUT *** {reason}")
        raise SafetyTrip(reason)

    def update(self, fb, tau=None):
        """Feed one feedback sample (and the torque just commanded, if any).

        Raises SafetyTrip on breach.
        """
        now = time.time()
        raw = list(fb.velocity[:N_JOINTS])
        if self.vf is None:
            self.vf = list(raw)
        else:
            for j in range(N_JOINTS):
                self.vf[j] += VEL_ALPHA * (raw[j] - self.vf[j])
        vel = list(self.vf)

        for j in range(N_JOINTS):
            self.peak_vel[j] = max(self.peak_vel[j], abs(vel[j]))
            if abs(vel[j]) > self.max_vel:
                self.cut(f"J{j+1} velocity {math.degrees(vel[j]):.0f} deg/s "
                         f"> limit {math.degrees(self.max_vel):.0f}")

        if self.hist:
            t_prev, v_prev = self.hist[-1]
            dt = now - t_prev
            if dt > 1e-4:
                for j in range(N_JOINTS):
                    acc = (vel[j] - v_prev[j]) / dt
                    self.peak_accel[j] = max(self.peak_accel[j], abs(acc))
                    if abs(acc) > self.max_accel:
                        self.breach[j] += 1
                        if self.breach[j] >= BREACH_SAMPLES:
                            self.cut(f"J{j+1} acceleration {math.degrees(acc):.0f} "
                                     f"deg/s^2 sustained {self.breach[j]} samples "
                                     f"> hard limit {math.degrees(self.max_accel):.0f}")
                    else:
                        self.breach[j] = 0

                    # self-driving check: is the arm accelerating the way we are
                    # pushing it, and keeping it up? A hand does not do that.
                    if tau is not None and abs(tau[j]) > 1e-3 \
                            and abs(acc) > RUNAWAY_ACCEL \
                            and math.copysign(1, acc) == math.copysign(1, tau[j]):
                        self.aligned[j] += 1
                        if self.aligned[j] >= RUNAWAY_SAMPLES:
                            self.cut(
                                f"J{j+1} RUNAWAY: {math.degrees(acc):.0f} deg/s^2 "
                                f"sustained {self.aligned[j]} samples aligned with "
                                f"commanded t_ff={tau[j]:+.2f} Nm -- not hand motion")
                    else:
                        self.aligned[j] = 0
        self.hist.append((now, vel))

    def report(self):
        pa = [round(math.degrees(a)) for a in self.peak_accel]
        pv = [round(math.degrees(v)) for v in self.peak_vel]
        print(f"  watchdog peak accel (deg/s^2): {pa}")
        print(f"  watchdog peak vel   (deg/s)  : {pv}")
        print(f"  limits: accel {math.degrees(self.max_accel):.0f}, "
              f"vel {math.degrees(self.max_vel):.0f}   "
              f"{'TRIPPED' if self.tripped else 'not tripped'}")
