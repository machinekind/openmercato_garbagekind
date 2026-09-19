# Mined session notes

Engineering facts extracted from the Claude Code transcripts of 18–19 Sep 2026 —
the two days of robot-arm work this repo is built on. Each file is dense notes,
not narrative: hardware, exact commands, protocol strings, measured numbers,
gotchas with their error text, decisions with their rationale, and the open
problems each session ended on.

They are the primary source behind [../ROBOT-STACK.md](../ROBOT-STACK.md) and
[../PICK-STATE-OF-PLAY.md](../PICK-STATE-OF-PLAY.md). Where the two disagree,
these notes are closer to what actually happened; the docs are the reading of it.

| File | Sessions | Covers |
|---|---|---|
| `d7ea01b3.md` | 19 Sep, panel + VLA | Web panel rebuild, role/engage rules, the deterministic YOLO tracker, full G0.5 bring-up, the camera-placement fix, gripper deaf-channel diagnosis |
| `400-cdc-d9d.md` | 18–19 Sep | Panel v1, the "deaf arm" power-cycle incident, DGX↔laptop streaming, real2sim research, G0.5 selection and checkpoint download |
| `7fb26521.md` | 18–19 Sep | GR00T N1.7 zero-shot trials, shadow mode, the garbage-sorting Track B plan, the Qwen3-VL monitoring agent and its safety review |
| `mid-sessions.md` | 11 shorter sessions | CAN frame ids, two-adapter confusion, VLA model comparison table, repo prune, the decision to integrate with Open Mercato |
| `so101-trash.md` | 18 Sep, SO-101 | SO-101 servo/power facts, two separate trash-sorting codebases, π0.5 benchmark result, what an ERP needs from a pick task |

Provenance markers like `(t=17:07)` or `(session cdcb1331, t=…)` point back at
the moment in the transcript a fact came from.
