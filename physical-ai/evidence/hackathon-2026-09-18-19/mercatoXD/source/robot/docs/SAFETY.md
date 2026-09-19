# Safety

Short, and worth reading once before the first power-on. Everything here was
learned the hard way on real hardware.

## The arm has no brakes

There are no holding brakes on the joint motors. **Cutting power drops the
arm** — it falls under its own weight, from wherever it is, immediately.

* Support the arm, or clear the space under it, before powering off.
* The same applies to a tripped supply, a yanked cable, or an e-stop.
* Fit an e-stop anyway. Falling is better than falling *and* still driving.

## Never enable without streaming a setpoint

The enable sequence is function frames **1 → 5 → 6** on `0x053`, and **FF 5
briefly disengages the motors**. If nothing is streaming `p_des = q` across
that moment, the arm comes back holding a stale setpoint.

Measured consequence of getting this wrong: a **76 degree swing at saturated
torque**, effort 50.0.

Stream `p_des = q_measured` at 100–200 Hz *before*, *during* and *after* the
sequence.

## Start every command session at p_des = q

A setpoint that is not where the arm currently is makes it travel there as fast
as it can. Read `0x052`, seed `p_des` from the measured position, and move it
from there. Slew-limit everything after that — `so101_bridge.py` caps at 90
deg/s by default.

## Stopping is safe; starting is where it goes wrong

An uncommanded arm holds its position and does not drift. Ctrl-C on any of
these scripts stops the stream, and the arm re-latches where it is: it does not
fall, and it does not snap back to an old pose.

So the dangerous moments are all at the *start* of a session, not the end.

## One writer per bus

Exactly one process may transmit on a given CAN interface. Two senders on
`0x050` — say `ARM_APP` and one of these scripts — means the arm receives them
interleaved and tracks neither. `teleop2.py` refuses to start if it detects
another writer; do the same in anything you write.

## Dry-run first

`so101_bridge.py --dry-run` transmits nothing and prints the targets it would
send. Use it to check every joint's direction sign before the first live run.
A joint mapped with the wrong sign drives *away* from where the operator is
moving, and the operator's instinct is to push harder.

## There is no compliance to fall back on

`t_ff`, `kp`, `kd` and `mode` are inert on this transport (see
[STEERING.md](STEERING.md#why-there-is-no-float-mode)). You cannot make the arm
soft, you cannot gravity-compensate it, and it will not yield if it drives into
something. Position limits and slew caps in your own code are the only
protection there is.

## Bus health

`restart-ms 100` is set by `can_up.sh` so the controller recovers from bus-off
by itself. If frames stop arriving mid-session, check for bus-off before
assuming the arm faulted:

```bash
ip -det -s link show can0
```

Termination matters: the CAN box has switches **R1/R2, both in the top
position**. The supply is **24 V**, not 48 V.
