# "Grab the can": what works, what does not, what to try next

Honest status as of 19 Sep 2026, from the live runs on the A1X. Read this before
promising a demo. Sources: [knowledge/d7ea01b3.md](knowledge/d7ea01b3.md) and
[knowledge/400-cdc-d9d.md](knowledge/400-cdc-d9d.md).

## Works

* **The whole task path.** Queue → claim → stage reports → terminal status,
  with a full trace per attempt. Exercised by 56 tests with no hardware.
* **Panel-mediated motion.** Engage gate, joint window, 30°/s slew, auto-
  disengage, single CAN writer. The arm has never been commanded outside its
  window by this stack.
* **Gripper open/close and holding detection.** Full travel verified: open →
  −1.795 (effort −0.16); close on nothing → +0.6; close on an object → stalls at
  ~+0.007 with effort +6.45. That force signature is the grasp check.
* **G0.5 inference on the DGX.** `OpenGalaxea/G05` `g05-base` runs zero-shot on
  GB10/sm_121 in a minimal inference venv (Python 3.12, torch 2.11+cu130),
  despite the upstream pin to 3.10/cu128 with no aarch64 wheels for the sim
  deps. ~58 ms per cached step, 1.05–1.9 s per recompute end to end.
* **The model is genuinely conditioning on the image.** Control test: all-black
  frames → 0.2° of chunk deviation; real frames → 19–27°.

## Does not work

* **The gripper action is never emitted.** `g05-base` zero-shot dropped
  `left_gripper` from its action dict in *every* observed trial, dozens of them.
  The model plans a reach and no grasp. The bridge therefore scripts the close
  itself (`pick.py:_grasp`) — that is a workaround, not a fix.
* **The reach does not converge on the can.** A 3-round live run oscillated
  (elbow down 9.6°, back up 8.3°, net ~0). A 100-round run made consistent
  progress for 8 rounds, then stopped itself when J3 hit the top of its window
  (0°) and every later plan had nowhere to go. Forward kinematics over those
  rounds shows the end-effector moved +9.1 cm forward and +0.7 cm up — a
  reasonable direction, not a closing trajectory.
* **Task phrasing swings the plan.** "pick up the can" → J2 −6…−7°; "grasp the
  can and lift it" → +56…+75°, opposite direction, much larger. Unexplained.
* **No idea where the can is.** The cameras have no known extrinsics, so a pixel
  cannot be turned into a position in the arm's frame. There is no ground truth
  to measure plan error in centimetres — only in degrees of joint motion.

## The one change that mattered most

Camera placement. With the "head" camera pointed at the room and no wrist
camera, the same task on the same scene produced contradictory plans (33.8° one
run, 0.1° the next). After mounting a camera on the gripper looking down the
grasp axis and re-aiming the other at the bench:

| task | before | after |
|---|---|---|
| `pick up the can` | 33.8° / 0.1° | 18.6° / 15.4° |
| `pick up the red bull can from the table` | 0.6° / 2.7° | 18.2° / 24.5° |
| `grasp the can and lift it` | 14.4° / 1.9° | 74.5° / 56.1° |

Repeatability within a task went from "coin flip" to near-identical (two runs:
J2 −6.4 vs −7.1, J3 +15.8 vs +13.7, J4 −15.0 vs −15.4). If you change nothing
else, mount the wrist camera.

## Next steps, in the order they are worth doing

1. **Teach-by-demonstration reference point.** Backdrive the disengaged arm so
   the jaws surround the can, read the joint pose, run FK (`robot/kinematics.py`)
   to get the can's position in the base frame. Gives a ground truth to measure
   plan error in centimetres, and a trigger for a hybrid grasp: let the policy
   drive the approach, close the gripper when FK says the end-effector is within
   a few centimetres.
2. **Fine-tune instead of zero-shot.** `robot/record_a1x.py` already writes
   LeRobot v3; 30–100 teleop episodes is the quoted cost. Known data issues to
   fix first: teleop mapping is relative to the start pose rather than
   task-anchored, `arm_joint5` never moves under SO-101 teleop (constant column),
   gripper dimension semantics unverified, and inference and the panel cannot
   both own `can0`.
3. **Sample several chunks per observation and take the median.** The policy is
   stochastic enough that the same observation yields a reach one time and a hold
   the next; the bridge resamples flat chunks but does not yet vote.
4. **Check for a sampling seed/temperature** on `serve_policy.py` — reproducible
   plans would make every experiment above cheaper.

## If you need a working demo tomorrow

Run the bridge with `--policy preset`. It walks the panel's whitelisted poses and
scripts the grasp; it cannot find anything, but it exercises the full queue,
reporting and safety path with an arm that actually moves. Pair it with a fixed
can position and it will pick it up.
