#!/usr/bin/env python3
"""Record SO-101 -> A1X teleoperation into a LeRobot dataset, with cameras.

Writes a standard LeRobot v3 dataset (parquet + encoded video), so the result
trains with lerobot policies and uploads to the Hub unchanged.

    action            (7,)  commanded A1X target: 6 joints + gripper
    observation.state (7,)  A1X measured: 6 joints + gripper
    observation.images.<name>   one video stream per camera

The teleop mapping is so101_bridge's --mode joint (see that file for why).
CAN is streamed at --rate; frames are recorded at --fps.

    ./record_a1x.py --repo-id polrolnik2/a1x_candy --task "pick up the candy" \
        --cameras "top:0,wrist:2" --episodes 5 --episode-secs 20

Ctrl-C ends the current episode cleanly and stops.
"""
from __future__ import annotations
import argparse, math, os, signal, subprocess, sys, time
from pathlib import Path
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The rerun SDK shells out to a `rerun` viewer binary that ships in the same
# env's bin/. Running this file as `/path/to/env/bin/python record_a1x.py`
# leaves that directory off PATH, so the viewer is "not found" and the live
# display silently never appears. Put it back.
_envbin = os.path.dirname(sys.executable)
if _envbin not in os.environ.get("PATH", "").split(os.pathsep):
    os.environ["PATH"] = _envbin + os.pathsep + os.environ.get("PATH", "")
from kinematics import Chain
from so101_bridge import (A1X, SO101, norm_to_rad, SO_ARM, JOINT_MAP,
                          A1X_JOINTS, A1X_URDF, SO_URDF, N)

_stop = {"flag": False}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-id", default="", help="e.g. polrolnik2/a1x_candy")
    ap.add_argument("--task", default="teleop", help="natural-language task string")
    ap.add_argument("--cameras", default="top:0",
                    help='comma list name:target, e.g. "top:0,wrist:2" or, '
                         'preferably, a stable path: '
                         '"top:/dev/v4l/by-id/usb-...-video-index0". Bare '
                         'indices follow USB enumeration and CHANGE when you '
                         'replug, silently recording the wrong camera.')
    ap.add_argument("--fourcc", default="MJPG",
                    help="MJPG lets several cameras share USB bandwidth; "
                         "uncompressed YUYV saturates the bus and the second "
                         "camera fails to start. Pass '' for the driver default.")
    ap.add_argument("--cam-width", type=int, default=640)
    ap.add_argument("--cam-height", type=int, default=480)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--episodes", type=int, default=5)
    ap.add_argument("--episode-secs", type=float, default=20.0)
    ap.add_argument("--reset-secs", type=float, default=8.0)
    ap.add_argument("--follower", default="can0")
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--cal-id", default="my_leader")
    ap.add_argument("--home", default="",
                    help='optional pre-positioning, e.g. "0,60,-90,0,0,0". Off '
                         'by default: start the A1X wherever you want it.')
    ap.add_argument("--home-rate", type=float, default=25.0)
    ap.add_argument("--kp", type=float, default=20.0)
    ap.add_argument("--kd", type=float, default=1.0)
    ap.add_argument("--rate", type=float, default=200.0)
    ap.add_argument("--follow-rate", type=float, default=90.0)
    ap.add_argument("--gain", type=float, default=1.0)
    ap.add_argument("--signs", default="+++++")
    ap.add_argument("--smooth", type=float, default=0.35)
    ap.add_argument("--grip-open", type=float, default=-2.0,
                    help="A1X gripper p_des at fully open. MEASURED: "
                         "group-7 position is linear at 57.1 deg per unit "
                         "of p_des, no stall (effort flat ~3.3) out to "
                         "-3.0 where travel tapers. -0.6 used only ~40%.")
    ap.add_argument("--grip-closed", type=float, default=0.6)
    ap.add_argument("--grip-kp", type=float, default=25.0)
    ap.add_argument("--grip-force", type=float, default=1.2)
    ap.add_argument("--loopback", default="",
                    help='republish captured frames to v4l2loopback devices so '
                         'OBS (or any viewer) can see EXACTLY what is recorded, '
                         'e.g. "top:/dev/video10,wrist:/dev/video11". A V4L2 '
                         'camera has one reader; this script is it, and ffmpeg '
                         'fans the frames out. Load the module first:\n'
                         '  sudo modprobe v4l2loopback devices=2 video_nr=10,11 '
                         'card_label=a1x_top,a1x_wrist exclusive_caps=1')
    ap.add_argument("--display", default="rerun", choices=("rerun","foxglove","none"),
                    help="live view of camera feeds and state while teleoperating "
                         "(same backend lerobot-record uses for --display_data)")
    ap.add_argument("--display-every", type=int, default=1,
                    help="log every Nth frame; raise it if the viewer lags")
    ap.add_argument("--no-record", action="store_true",
                    help="run the teleop loop with the live view but write no "
                         "dataset -- for checking framing and mapping first")
    ap.add_argument("--root", default="", help="dataset dir (default HF cache)")
    ap.add_argument("--resume", action="store_true")
    a = ap.parse_args()

    if not a.no_record and not a.repo_id:
        print("  --repo-id is required unless --no-record"); return 1

    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    from lerobot.cameras.opencv.camera_opencv import OpenCVCamera
    from lerobot.cameras.opencv.configuration_opencv import OpenCVCameraConfig

    signs = [1.0 if c != "-" else -1.0 for c in a.signs.ljust(5, "+")[:5]]
    a1x_chain = Chain(A1X_URDF, A1X_JOINTS)
    so_chain = Chain(SO_URDF, SO_ARM)

    # --- cameras -----------------------------------------------------------
    cams = {}
    for spec in [s for s in a.cameras.split(",") if s.strip()]:
        name, _, tgt = spec.partition(":")
        name, tgt = name.strip(), tgt.strip()
        target = int(tgt) if tgt.isdigit() else Path(tgt)
        if isinstance(target, int):
            print(f"  NOTE camera '{name}' given as index {target}; indices move "
                  f"on replug -- prefer /dev/v4l/by-id/...")
        cfg = OpenCVCameraConfig(index_or_path=target, fps=a.fps,
                                 width=a.cam_width, height=a.cam_height,
                                 fourcc=(a.fourcc or None))
        c = OpenCVCamera(cfg); c.connect()
        cams[name] = c
        print(f"  camera '{name}' -> {target}: connected ({a.fourcc or 'default'})")

    # --- v4l2loopback republishing ------------------------------------------
    loop = {}
    for spec in [s for s in a.loopback.split(",") if s.strip()]:
        name, _, dev = spec.partition(":")
        name, dev = name.strip(), dev.strip()
        if name not in cams:
            print(f"  --loopback names an unknown camera '{name}'"); return 1
        if not os.path.exists(dev):
            print(f"  {dev} does not exist. Load the module first:\n"
                  f"    sudo modprobe v4l2loopback devices=2 video_nr=10,11 "
                  f"card_label=a1x_top,a1x_wrist exclusive_caps=1")
            return 1
        p = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-f", "rawvideo", "-pix_fmt", "rgb24",
             "-s", f"{a.cam_width}x{a.cam_height}", "-r", str(a.fps),
             "-i", "-", "-f", "v4l2", "-pix_fmt", "yuv420p", dev],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL)
        loop[name] = p
        print(f"  loopback '{name}' -> {dev} (open this in OBS)")

    # --- features ----------------------------------------------------------
    names7 = [f"arm_joint{i}" for i in range(1, 7)] + ["gripper"]
    features = {
        "action": {"dtype": "float32", "shape": (7,), "names": names7},
        "observation.state": {"dtype": "float32", "shape": (7,), "names": names7},
    }
    for name in cams:
        features[f"observation.images.{name}"] = {
            "dtype": "video", "shape": (a.cam_height, a.cam_width, 3),
            "names": ["height", "width", "channels"]}

    viz = None if a.display == "none" else a.display
    if viz:
        from lerobot.utils.visualization_utils import (init_visualization,
                                                       log_visualization_data,
                                                       shutdown_visualization)
        init_visualization(viz, session_name="so101_to_a1x")
        print(f"  live view: {viz} -- a viewer window should open")

    root = a.root or None
    if a.no_record:
        ds = None
        print("  --no-record: streaming the live view, writing NO dataset")
    elif a.resume:
        ds = LeRobotDataset(a.repo_id, root=root)
        print(f"  resuming dataset at episode {ds.num_episodes}")
    else:
        ds = LeRobotDataset.create(a.repo_id, fps=a.fps, features=features,
                                   root=root, robot_type="galaxea_a1x",
                                   use_videos=True, image_writer_threads=4)
        print(f"  created dataset {a.repo_id}")

    # --- hardware ----------------------------------------------------------
    lead = SO101(a.port, a.cal_id)
    arm = A1X(a.follower)
    if not arm.wait(3.0):
        print(f"  FAIL: no feedback on {a.follower}. Is the A1X powered?")
        return 1
    t0 = time.time()
    while time.time() - t0 < 0.5: arm.drain(); time.sleep(0.002)

    if a.home:
        hp = np.clip(np.array([math.radians(float(x)) for x in a.home.split(",")]),
                     a1x_chain.lower, a1x_chain.upper)
        cur = np.array(arm.q[:N]); secs = float(np.max(np.abs(hp-cur))/math.radians(a.home_rate))+0.5
        print(f"  HOMING to {np.round(np.degrees(hp),1)} over {secs:.1f}s -- KEEP CLEAR")
        time.sleep(2.0); t0 = time.time()
        while time.time()-t0 < secs:
            f = min(1.0, (time.time()-t0)/secs)
            arm.send_arm(list(cur + f*(hp-cur)), a.kp, a.kd); arm.drain()
            time.sleep(1.0/a.rate)
        arm.drain()

    if not arm.ensure_listening(a.kp, a.kd):
        return 1
    if not arm.ensure_gripper(a.kp, a.grip_kp, a.kd):
        print("  continuing WITHOUT gripper data in this dataset")

    signal.signal(signal.SIGINT, lambda *_: _stop.__setitem__("flag", True))
    slew = math.radians(a.follow_rate)

    for ep in range(a.episodes):
        if _stop["flag"]: break
        print(f"\n{'='*68}\n  EPISODE {ep+1}/{a.episodes}  ({a.episode_secs:g}s)  task: {a.task}\n{'='*68}")
        for k in (3, 2, 1): print(f"    starting in {k}..."); time.sleep(1)

        arm.drain()
        q_a0 = np.array(arm.q[:N])
        s0 = lead.read()
        q_so0 = np.array([norm_to_rad(so_chain, n, s0.get(f"{n}.pos", 0.0)) for n in SO_ARM])
        target = q_a0.copy(); q_filt = None; g_filt = None
        grip_t = a.grip_open; grip_frozen = False
        t0 = time.time(); nxt_can = t0; nxt_frame = t0; n_frames = 0; aborted = None
        last_can = t0

        while time.time()-t0 < a.episode_secs and not _stop["flag"]:
            arm.drain(); now = time.time()
            if now - arm.t > 0.2:
                aborted = f"stale A1X feedback ({(now-arm.t)*1e3:.0f} ms)"; break
            try:
                s = lead.read()
            except Exception as ex:
                aborted = str(ex); break

            q_raw = np.array([norm_to_rad(so_chain, n, s.get(f"{n}.pos", 0.0)) for n in SO_ARM])
            q_filt = q_raw.copy() if q_filt is None else q_filt + a.smooth*(q_raw-q_filt)
            goal = q_a0.copy()
            for i, n in enumerate(SO_ARM):
                j = JOINT_MAP[n]
                goal[j] = q_a0[j] + signs[i]*a.gain*(q_filt[i]-q_so0[i])
            goal = np.clip(goal, a1x_chain.lower, a1x_chain.upper)

            g_raw = np.clip(s.get("gripper.pos", 0.0), 0.0, 100.0)/100.0
            g_filt = g_raw if g_filt is None else g_filt + a.smooth*(g_raw-g_filt)
            want = a.grip_open + (1.0-g_filt)*(a.grip_closed-a.grip_open)
            eff = abs(arm.e[6]) if arm.e else 0.0
            closing = want > grip_t
            if closing and eff > a.grip_force: grip_frozen = True
            elif not closing: grip_frozen = False
            if not grip_frozen: grip_t = want

            if now >= nxt_can:
                # real elapsed time, not a nominal 1/rate: the loop does not
                # run at exactly --rate, and using the nominal value makes the
                # effective slew whatever the loop speed happens to be.
                dt_can = min(0.05, now - last_can); last_can = now
                step = slew * dt_can
                target += np.clip(goal-target, -step, step)
                nxt_can = now + 1.0/a.rate
                arm.send_arm(list(target), a.kp, a.kd)
                arm.send_grip(grip_t, a.grip_kp, 1.0)

            if now >= nxt_frame:
                nxt_frame = now + 1.0/a.fps
                frame = {
                    "action": np.asarray(list(target)+[grip_t], dtype=np.float32),
                    "observation.state": np.asarray(list(arm.q[:N])+[arm.q[6]], dtype=np.float32),
                    "task": a.task,
                }
                for name, c in cams.items():
                    img = c.async_read()
                    frame[f"observation.images.{name}"] = img
                    p = loop.get(name)
                    if p is not None and p.stdin is not None:
                        try:
                            p.stdin.write(img.tobytes())
                        except (BrokenPipeError, ValueError):
                            print(f"  loopback '{name}' died; dropping it")
                            loop.pop(name, None)
                if ds is not None:
                    ds.add_frame(frame)
                n_frames += 1
                if viz and n_frames % max(1, a.display_every) == 0:
                    obs = {k: v for k, v in frame.items()
                           if k.startswith("observation.")}
                    log_visualization_data(viz, observation=obs,
                                           action={"action": frame["action"]},
                                           compress_images=True)
            time.sleep(0.0005)

        if ds is None:
            print(f"  {n_frames} frames shown ({'aborted: '+aborted if aborted else 'ok'})")
        elif aborted:
            print(f"  episode aborted: {aborted} -- {n_frames} frames DISCARDED")
            try: ds.clear_episode_buffer()
            except Exception: pass
        else:
            ds.save_episode()
            print(f"  saved episode {ep+1}: {n_frames} frames "
                  f"({n_frames/a.episode_secs:.1f} fps effective)")

        if ep < a.episodes-1 and not _stop["flag"]:
            print(f"  reset the scene -- {a.reset_secs:g}s")
            t0 = time.time()
            while time.time()-t0 < a.reset_secs and not _stop["flag"]:
                arm.drain(); arm.send_arm(list(target), a.kp, a.kd); time.sleep(1.0/a.rate)

    for name, p in loop.items():
        try:
            if p.stdin: p.stdin.close()
            p.terminate(); p.wait(timeout=3)
        except Exception: pass
    for c in cams.values():
        try: c.disconnect()
        except Exception: pass
    lead.close()
    if viz:
        try: shutdown_visualization(viz)
        except Exception: pass
    if ds is None:
        print("\n  done (no dataset written)")
        return 0
    print(f"\n  done. dataset: {ds.root}")
    print(f"  episodes: {ds.num_episodes}   frames: {ds.num_frames}")
    print(f"  push with:  huggingface-cli upload {a.repo_id} {ds.root} --repo-type dataset")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
