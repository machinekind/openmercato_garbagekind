#!/usr/bin/env python3
"""Convert the A1X SolidWorks URDF into a MuJoCo MJCF model.

The URDF ships `package://` mesh URIs and SolidWorks inertias, neither of which
MuJoCo accepts as-is. This rewrites the mesh paths, injects the <mujoco>
compiler block MuJoCo looks for, compiles the model and writes the MJCF next to
the other sim assets.

    ./urdf_to_mjcf.py            # writes sim/a1x_arm.xml
"""
from __future__ import annotations

import argparse
import pathlib
import re
import tempfile
import xml.etree.ElementTree as ET

import mujoco

SIM_DIR = pathlib.Path(__file__).parent.resolve()
DESCRIPTION = SIM_DIR.parent / "ros2_ws/src/galaxea_a1xy_description"
DEFAULT_URDF = DESCRIPTION / "urdf/a1x.urdf"
DEFAULT_MESHES = DESCRIPTION / "meshes"

# SolidWorks exports link inertias that MuJoCo rejects as non-positive-definite;
# balanceinertia fixes them up instead of failing the compile. The block goes
# *inside* <robot>: placed before it, MuJoCo's parser takes <mujoco> as the root
# element, reads the file as MJCF and compiles an empty model (nbody == 1).
COMPILER_BLOCK = """  <mujoco>
    <compiler meshdir="{meshdir}" balanceinertia="true" discardvisual="false" strippath="false"/>
  </mujoco>
"""


def rewrite(urdf_text: str, meshdir: pathlib.Path) -> str:
    """Strip package:// URIs and add the MuJoCo compiler block."""
    text = re.sub(r'filename="package://[^/]+/meshes/', 'filename="', urdf_text)
    if "<mujoco>" in text:
        return text
    block = COMPILER_BLOCK.format(meshdir=meshdir)
    # SolidWorks writes the opening tag over two lines: `<robot\n  name="a1x">`.
    return re.sub(r'(<robot\s+name="[^"]*"\s*>)', lambda m: m.group(1) + "\n" + block,
                  text, count=1)


def convert(urdf: pathlib.Path, meshes: pathlib.Path, out: pathlib.Path) -> mujoco.MjModel:
    patched = rewrite(urdf.read_text(), meshes)
    # Compile from the URDF's own directory so relative meshdir resolves.
    with tempfile.NamedTemporaryFile("w", suffix=".urdf", dir=urdf.parent, delete=False) as fh:
        fh.write(patched)
        tmp = pathlib.Path(fh.name)
    try:
        model = mujoco.MjModel.from_xml_path(str(tmp))
        mujoco.mj_saveLastXML(str(out), model)
    finally:
        tmp.unlink(missing_ok=True)
    add_sim_fixups(out)
    return mujoco.MjModel.from_xml_path(str(out))


# Measured off the finger meshes in the arm_link6 frame: the jaw spans
# x 0.099..0.138 and z -0.051..0.057, and closes along y. Its centre is the
# point IK should be asked to put on the object.
TCP_POS = (0.119, 0.0, 0.003)
# Behind and above the jaw, looking down the approach axis, so the view holds
# the grasp in frame the way a real wrist camera bracket would.
WRIST_CAM_POS = (0.02, 0.0, 0.10)


# The finger STL is one plate plus its mounting bracket, and MuJoCo collides
# meshes by their convex hull -- which spans both and fills the jaw cavity, so
# the two hulls touch at 25 mm of travel and the gripper can never close on
# anything. Measured off the vertex cloud, the pad itself is the dense block at
# y in [-0.026, -0.006]; everything beyond y > 0.009 is bracket. These boxes are
# that pad, in the finger's local frame, and they replace the mesh for collision
# while the mesh stays on as the visual.
PAD_POS = (-0.0024, -0.016, -0.006)
PAD_SIZE = (0.0169, 0.010, 0.030)
# Pad inner face sits 0.026 from the finger origin, which starts 0.013453 off
# the centreline, so the faces meet here -- this, not 0, is a closed jaw.
FINGER_CLOSED_SLIDE = 0.0126


def add_sim_fixups(mjcf: pathlib.Path) -> None:
    """Add what MuJoCo cannot get from a URDF: TCP site, wrist camera, pads.

    They go in here rather than in the scene because all three attach to bodies
    that live in this generated file -- MJCF cannot add children to an included
    body, or edit its geoms, from outside.
    """
    tree = ET.parse(mjcf)
    for i, finger in enumerate(
            b for b in tree.iter("body") if str(b.get("name", "")).startswith("gripper_finger_link")):
        # mirror the pad for the finger on the -y side
        sign = 1.0 if finger.get("name", "").endswith("1") else -1.0
        for geom in list(finger.findall("geom")):
            if geom.get("mesh") and geom.get("contype") != "0":
                finger.remove(geom)
        ET.SubElement(finger, "geom", {
            "name": f"pad{i + 1}", "type": "box",
            "pos": " ".join(str(v * (sign if k == 1 else 1.0))
                            for k, v in enumerate(PAD_POS)),
            "size": " ".join(map(str, PAD_SIZE)),
            # condim 6 gives the pad contact torsional and rolling friction.
            # With MuJoCo's default sliding-only contact a sphere held between
            # two flat pads simply rotates out of the jaw during the lift.
            "condim": "6",
            "friction": "1.5 0.05 0.005", "solimp": "0.97 0.99 0.001",
            "solref": "0.004 1", "rgba": "0.2 0.2 0.2 1"})
    link6 = next((b for b in tree.iter("body") if b.get("name") == "arm_link6"), None)
    if link6 is None:
        raise SystemExit("arm_link6 missing: the URDF chain changed, fix TCP_POS too")
    if link6.find("site[@name='tcp']") is None:
        ET.SubElement(link6, "site", {
            "name": "tcp", "pos": " ".join(map(str, TCP_POS)),
            "size": "0.005", "group": "3", "rgba": "0 1 0 0.6"})
    if link6.find("camera[@name='wrist']") is None:
        ET.SubElement(link6, "camera", {
            "name": "wrist", "pos": " ".join(map(str, WRIST_CAM_POS)),
            "mode": "fixed", "fovy": "70",
            # look down +x (the jaw) with the jaw's z as image up
            "xyaxes": "0 -1 0  0 0 1"})
    ET.indent(tree, space="  ")
    tree.write(mjcf, encoding="unicode")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--urdf", type=pathlib.Path, default=DEFAULT_URDF)
    ap.add_argument("--meshes", type=pathlib.Path, default=DEFAULT_MESHES)
    ap.add_argument("--out", type=pathlib.Path, default=SIM_DIR / "a1x_arm.xml")
    a = ap.parse_args()

    model = convert(a.urdf, a.meshes, a.out)
    print(f"wrote {a.out}")
    print(f"  bodies={model.nbody}  joints={model.njnt}  dof={model.nv}  geoms={model.ngeom}")
    for i in range(model.njnt):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, i)
        lo, hi = model.jnt_range[i]
        print(f"  joint {i}: {name:24s} range=[{lo:+.4f}, {hi:+.4f}]")


if __name__ == "__main__":
    main()
