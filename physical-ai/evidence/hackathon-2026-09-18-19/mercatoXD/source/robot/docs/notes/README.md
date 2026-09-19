# Working notes

Raw material, kept for provenance. These are not user documentation — for that
see [STEERING.md](../STEERING.md), [PROTOCOL.md](../PROTOCOL.md),
[HARDWARE.md](../HARDWARE.md) and [SAFETY.md](../SAFETY.md).

| file | what it is |
| --- | --- |
| [`DIAGNOSE.md`](DIAGNOSE.md) | the brief for the diagnosis session that established the arm is position-only. Its results are in [`../../diag/REPORT.md`](../../diag/REPORT.md) |
| [`PROMPT.md`](PROMPT.md) | the brief for the arm-to-arm teleop work |

Both were written before some of what is now settled was known, so where they
disagree with the docs above, the docs above are right. In particular both
declare `can1 = LEADER, can0 = FOLLOWER`; that labelling was found to be
inverted mid-session and USB enumeration has since proven unstable across
replugs anyway. Determine roles empirically with `which_arm.py`.
