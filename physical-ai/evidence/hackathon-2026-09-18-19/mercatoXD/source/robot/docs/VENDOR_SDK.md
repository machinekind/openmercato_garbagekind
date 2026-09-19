# Galaxea's own SDKs

**You do not need any of these.** The driver in `ros2_ws/src/` and the scripts
at the top level talk to the arm directly over CAN-FD. This page exists because
finding the right vendor SDK took a long time and the answer is not obvious —
three different packages get called "the Galaxea SDK" and two of them are for
other products.

None of them are redistributed in this repo. `tools/fetch_vendor_sdk.sh`
downloads them into `a1xy/`, which is gitignored.

## Which is which

| package | product | arch | stack | for the A1X? |
| --- | --- | --- | --- | --- |
| `atc_host_standard-*_x86_64.tar.gz` | ATC / A1XY | **x86_64** | ROS 2 Humble | **yes** — this is the useful one |
| `A1_XY.tar.gz` | A1XY | x86 | ROS 1 Noetic | yes, but effectively unobtainable |
| `galaxea-sdk-*-arm64.run` | R1 / R1 Lite / R1 Pro | aarch64 | ROS 2 Humble | no — Jetson robots |
| `userguide-galaxea/A1_SDK` (GitHub) | serial **A1** | x86 | ROS 1 | no — different arm entirely |

## The one that works: the x86_64 ATC host build

`atc_host_standard-V2.0.4-20250515_19_34_04_x86_64.tar.gz`, 219 MB.

```bash
./tools/fetch_vendor_sdk.sh atc
```

* Google Drive folder: [`1ZQX9nKik3OO9LzeD6MqQF0x8Mf7VN5YD`](https://drive.google.com/drive/folders/1ZQX9nKik3OO9LzeD6MqQF0x8Mf7VN5YD)
  (alive as of 2026-08-23)
* Drive file id: `1rePSAjlbXCJhj5HYNWJavqFT3Ohcc-_M`
* Baidu mirror: <https://pan.baidu.com/s/1Qewogh-_Xa_wJ1zgcBWRSQ?pwd=v204>

What matters inside it:

* `HDAS/lib/HDAS/ARM_APP` — ELF x86-64, product string `A1XY`, hardcodes `can0`
* `HDAS/share/HDAS/launch/A1XY.py` — launches ARM_APP with `product:=A1XY`.
  Note the **capitalised** filename; a lowercase `a1xy*` glob misses it
* also `HDAS_TELEOPERATION`, `check_node`, `mcu_ota`, `ota_test`, all x86-64
* `module_config/*.yaml.enc` is Fernet-encrypted, which no longer matters —
  ARM_APP decrypts its own config at runtime

`ldd` reports **zero** missing libraries once `/opt/ros/humble/setup.bash` and
the SDK's own `setup.bash` are sourced. It needs ROS 2 Humble on Ubuntu 22.04,
which is exactly the `galaxeo/ros2-humble` container in this repo.

```bash
./ros2.sh shell
  source ~/a1xy/atc_host_install/local_setup.bash
  ros2 launch HDAS A1XY.py
```

Newer ATC releases (v2.1.x, v2.4.0) have changelog pages on
docs.galaxea-dynamics.com; check those for a newer x86_64 host build.

### How it was found

`Gates-456/galaxea_arm_a1x_moveit2`'s `run.sh` runs `ros2 launch HDAS a1xy.py`
— which proves a **ROS 2** A1XY SDK exists at all, something the public A1XY
docs (ROS 1 only) never mention. The R1 changelog pages in
`Product_User_Guide` then showed that ATC releases are published as one
Drive/Baidu folder per version, and the V2.0.4 folder is still live.

Two tricks that make this repeatable: Drive folders list without auth via
`https://drive.google.com/embeddedfolderview?id=<ID>#list`, and large files
download from `drive.usercontent.google.com/download` once you scrape the
`confirm=t` and `uuid` tokens out of the virus-scan interstitial. That is what
`tools/fetch_vendor_sdk.sh` automates.

## A1_XY.tar.gz — the documented one, effectively gone

This is what Galaxea's A1XY documentation tells you to download: x86 only,
Ubuntu 20.04 + ROS Noetic.

* Google Drive `180qSZTc7bZgwklVuwcuhq5O2DPteI2nR` — **dead, HTTP 404**
* Baidu Cloud <https://pan.baidu.com/s/1jVEqjL-r_Ll7bKFB1XxKIw?pwd=a1xy> —
  alive, needs a Baidu account

Those two are the only sources that have ever existed, confirmed against the
English and Chinese docs and Wayback snapshots back to 2025-08-15. There is no
GitHub release, no mirror and no archived copy of the tarball. For a re-share,
ask <support@galaxea.ai>.

Startup, per the vendor guide:

```bash
sudo ip link set dev can0 type can bitrate 1000000 dbitrate 5000000 fd on
sudo ip link set up can0
roscore
source {workspace}/install/setup.bash && roslaunch HDAS A1XY.launch
roslaunch mobiman a1x_jointTrackerdemo.launch          # a1y_ for the Y variant
```

Docs source, since docs.galaxea-ai.com is often 503 — the GitHub mirror is
reliable:
`https://raw.githubusercontent.com/userguide-galaxea/Product_User_Guide/galaxea/main/docs/en/Guide/A1XY/`

## The two that aren't for this arm

**`galaxea-sdk-*-arm64.run`** is the ATC ROS 2 SDK for the R1 family — mobile
robots with an onboard Jetson. aarch64 only, so it will not run on an x86_64
laptop at all. Wrong product and wrong architecture.

**`userguide-galaxea/A1_SDK`** on GitHub (780 MB, releases to v1.6.0) is the
**serial A1**: `signal_arm`, `/dev/ttyACM0`, `roslaunch signal_arm
single_arm_node.launch`. It contains no HDAS, no CAN and no A1XY launch files.
It is the repo people are most often pointed at by mistake, which is why
`tools/fetch_vendor_sdk.sh a1` can fetch it — for comparison, not for driving
an A1X.

## Known vendor-stack issue

HDAS V2.0.4 reports `RECEIVE_TIMEOUT` on all 7 joints and the arm never answers
the `0x023` poll — most likely a firmware/SDK version mismatch, since the arm
here is V2.4.0-era. Commands are still transmitted; whether the motors act on
them through that path was never confirmed.

Our own driver does not use `0x023` at all and is unaffected.
