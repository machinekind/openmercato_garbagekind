"""Raw SocketCAN helpers for the A1XY (CAN-FD only)."""
import socket
import struct

CANFD_MTU = 72
CAN_MTU = 16
SOL_CAN_RAW = 101
CAN_RAW_FD_FRAMES = 5


def open_socket(interface: str, rx_only: bool = True) -> socket.socket:
    """Open a CAN-FD raw socket bound to *interface*.

    CAN_RAW_FD_FRAMES is mandatory: the A1XY transmits only FD frames, so a
    socket without it silently receives nothing.
    """
    s = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
    s.setsockopt(SOL_CAN_RAW, CAN_RAW_FD_FRAMES, 1)
    s.bind((interface,))
    return s


def recv_frame(sock: socket.socket):
    """Return (can_id, payload) or None for a non-FD/short frame."""
    data = sock.recv(CANFD_MTU)
    if len(data) < CAN_MTU:
        return None
    can_id, length, _flags, _res0, _res1 = struct.unpack_from("=IBBBB", data, 0)
    can_id &= socket.CAN_EFF_MASK
    return can_id, data[8:8 + length]


CANFD_BRS = 0x01

# SocketCAN requires a COMPLETE frame struct to be written, not a truncated one:
#   struct can_frame   = 8 byte header + 8 byte data   = 16 bytes
#   struct canfd_frame = 8 byte header + 64 byte data  = 72 bytes
# Writing "header + actual payload" fails with EINVAL.


def send_frame(sock: socket.socket, can_id: int, payload: bytes) -> None:
    """Transmit one CAN frame, choosing classic vs FD by payload size.

    Payloads of 8 bytes or fewer go out as classic CAN (which is what the arm's
    1-byte function frames on 0x053 look like on the wire); anything longer
    goes out as CAN-FD, padded up to the next valid FD length.
    """
    n = len(payload)
    if n > 64:
        raise ValueError(f"payload {n} > 64 bytes")
    if n <= 8:
        buf = struct.pack("=IBBBB", can_id, n, 0, 0, 0) + payload.ljust(8, b"\x00")
        assert len(buf) == CAN_MTU
    else:
        # The len field must carry the ACTUAL payload length -- the kernel maps
        # it to the nearest CAN-FD DLC itself. Rounding it up here changes what
        # the peer sees: the gripper expects exactly 10 bytes on 0x051 and
        # silently ignores a 12-byte frame (which is what rounding produced).
        buf = (struct.pack("=IBBBB", can_id, n, CANFD_BRS, 0, 0)
               + payload.ljust(64, b"\x00"))
        assert len(buf) == CANFD_MTU
    sock.send(buf)


# backwards-compatible alias
def send_fd_frame(sock: socket.socket, can_id: int, payload: bytes) -> None:
    send_frame(sock, can_id, payload)
