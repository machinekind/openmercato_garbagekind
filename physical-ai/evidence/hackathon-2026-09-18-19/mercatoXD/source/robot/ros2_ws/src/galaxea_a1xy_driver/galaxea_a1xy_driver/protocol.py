"""
Galaxea A1XY CAN-FD protocol — recovered from the vendor's own binaries.

Feedback  (CAN 0x052, 48 B, 200 Hz) : a1_arm_analysis::arm_decode_impl
Command   (64 B)                    : a1_arm_analysis::arm_encode_impl
in libprotocol_modules.so (aarch64). All fields are BIG-ENDIAN int16.

Constants below are read directly out of the disassembly, not guessed; every
saturation branch cross-checks (6.5*4700 = 30550 = 0x7756; 40*750 = 200*150 =
50*600 = 30000 = 0x7530).
"""
import struct
from dataclasses import dataclass, field
from typing import List

# ---- feedback (decode) -------------------------------------------------------
FB_CAN_ID   = 0x052
FB_LEN      = 48
POS_DIV     = 4700.0   # -> rad
VEL_DIV     = 750.0    # -> rad/s
EFF_DIV     = 600.0
N_GROUPS    = 7        # J1..J6 + gripper
FOOTER      = bytes.fromhex("5c2e0024a827")


@dataclass
class ArmFeedback:
    position: List[float] = field(default_factory=list)   # rad
    velocity: List[float] = field(default_factory=list)   # rad/s
    effort:   List[float] = field(default_factory=list)


def decode_feedback(payload: bytes) -> ArmFeedback:
    """Decode a 0x052 payload into joint state."""
    if len(payload) != FB_LEN:
        raise ValueError(f"expected {FB_LEN} bytes, got {len(payload)}")
    fb = ArmFeedback()
    for g in range(N_GROUPS):
        p, v, e = struct.unpack_from(">hhh", payload, g * 6)
        fb.position.append(p / POS_DIV)
        fb.velocity.append(v / VEL_DIV)
        fb.effort.append(e / EFF_DIV)
    return fb


# ---- CAN id map (all verified on the wire) -----------------------------------
# 0x050  60 B  host -> arm : joint command (this file's encode_command)
# 0x052  48 B  arm -> host : joint feedback (decode_feedback)
# 0x053   1 B  host -> arm : function frame (enable/disable/reset), payload=code
# 0x054  16 B  arm -> host : temperatures
# 0x055  64 B  arm -> host : version / serial
# 0x023   1 B  host -> arm : heartbeat emitted by the vendor HDAS
CMD_CAN_ID = 0x050
FF_CAN_ID  = 0x053

# FunctionFrame codes, established empirically by watching effort:
FF_ENABLE   = 1    # engages motors (6 also engages)
FF_RELEASE  = 2    # releases motors (3, 4 also release)
FF_ENABLE2  = 6
FF_CLEAR    = 5    # clears the DISCONNECT error bit
# NOTE: code 0 is rejected by the vendor service as 'Invalid command'.


def encode_function_frame(code: int) -> bytes:
    """One-byte payload for CAN id 0x053."""
    if not 1 <= code <= 255:
        raise ValueError("function frame code must be 1..255 (0 is invalid)")
    return bytes([code])


# ---- command (encode) --------------------------------------------------------
CMD_LEN   = 60
N_JOINTS  = 6
BYTES_PER_JOINT = 10

# (clamp_lo, clamp_hi, scale) in field order p_des, v_des, kp, kd, t_ff
FIELDS = (
    ("p_des", -6.5,  6.5, 4700.0),
    ("v_des", -40.0, 40.0, 750.0),
    ("kp",      0.0, 500.0,  60.0),
    ("kd",      0.0, 200.0, 150.0),
    ("t_ff",  -50.0, 50.0, 600.0),
)


@dataclass
class ArmCommand:
    p_des: List[float] = field(default_factory=lambda: [0.0] * N_JOINTS)
    v_des: List[float] = field(default_factory=lambda: [0.0] * N_JOINTS)
    kp:    List[float] = field(default_factory=lambda: [0.0] * N_JOINTS)
    kd:    List[float] = field(default_factory=lambda: [0.0] * N_JOINTS)
    t_ff:  List[float] = field(default_factory=lambda: [0.0] * N_JOINTS)

    @staticmethod
    def zero_torque() -> "ArmCommand":
        """kp=kd=t_ff=0 -> commands zero torque regardless of p_des/v_des.

        This is the only command that is provably incapable of moving the arm,
        and is the correct first frame to put on a live bus.
        """
        return ArmCommand()


def encode_command(cmd: ArmCommand) -> bytes:
    """Build the 64-byte command payload, matching arm_encode_impl."""
    out = bytearray(CMD_LEN)
    for j in range(N_JOINTS):
        for k, (name, lo, hi, scale) in enumerate(FIELDS):
            v = getattr(cmd, name)[j]
            v = lo if v < lo else (hi if v > hi else v)
            raw = int(v * scale)                       # fcvtzs = truncate toward zero
            raw = max(-32768, min(32767, raw))
            off = j * BYTES_PER_JOINT + k * 2
            out[off]     = (raw >> 8) & 0xFF           # high byte first
            out[off + 1] = raw & 0xFF
    return bytes(out)


def _selftest() -> None:
    # saturation constants must reproduce the exact bytes in the binary
    c = ArmCommand()
    c.p_des = [7.0] * N_JOINTS      # above +6.5 clamp
    b = encode_command(c)
    assert b[0:2] == bytes([0x77, 0x56]), b[0:2].hex()      # 6.5*4700 = 30550
    c = ArmCommand(); c.v_des = [99.0] * N_JOINTS
    assert encode_command(c)[2:4] == bytes([0x75, 0x30])    # 40*750 = 30000
    c = ArmCommand(); c.kd = [999.0] * N_JOINTS
    assert encode_command(c)[6:8] == bytes([0x75, 0x30])    # 200*150 = 30000
    c = ArmCommand(); c.t_ff = [999.0] * N_JOINTS
    assert encode_command(c)[8:10] == bytes([0x75, 0x30])   # 50*600 = 30000
    # zero-torque frame must be all zeros
    assert encode_command(ArmCommand.zero_torque()) == bytes(CMD_LEN)
    assert CMD_LEN == 60, "vendor sends 60 bytes, not 64"
    assert encode_function_frame(1) == b"\x01"
    print("selftest: 60-byte frame, saturation bytes, zero-torque, function frame OK")


if __name__ == "__main__":
    _selftest()
