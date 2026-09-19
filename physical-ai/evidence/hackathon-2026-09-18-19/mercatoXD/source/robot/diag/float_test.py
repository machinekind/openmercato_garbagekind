"""Stream p_des = measured q, so the setpoint chases the arm instead of fighting it.

The servo holds a setpoint. If the setpoint IS the current position, the error
term vanishes and the arm should feel free -- while the motors stay ENABLED, so
0x052 keeps reporting. That is the compliant+reporting state release cannot give.

Gravity is not compensated, so the arm would sag and the setpoint would follow it
down. The leash bounds that: p_des is clamped to +/-LEASH of the start pose, so
the arm is free inside a window and springs back at the edge.
"""
import socket, struct, sys, time, math

IFACE   = sys.argv[1] if len(sys.argv) > 1 else "can0"
SECS    = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
KP      = float(sys.argv[3]) if len(sys.argv) > 3 else 20.0
KD      = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
LEASH   = math.radians(15.0)
ABORT   = math.radians(22.0)
RATE    = 200.0
CANFD_BRS = 0x01
S_POS, S_VEL, S_EFF = 4700.0, 750.0, 600.0
FIELDS = ((-6.5,6.5,4700.0), (-40.0,40.0,750.0), (0.0,500.0,60.0),
          (0.0,200.0,150.0), (-50.0,50.0,600.0))

def encode(p_des, v_des, kp, kd, t_ff):
    out = bytearray(60)
    for j in range(6):
        for k, vals in enumerate((p_des, v_des, kp, kd, t_ff)):
            lo, hi, sc = FIELDS[k]
            v = vals[j]
            v = lo if v < lo else (hi if v > hi else v)
            raw = max(-32768, min(32767, int(v * sc)))
            off = j*10 + k*2
            out[off]   = (raw >> 8) & 0xFF
            out[off+1] = raw & 0xFF
    return bytes(out)

def send(sock, cid, payload):
    n = len(payload)
    if n <= 8:
        sock.send(struct.pack("=IBBBB", cid, n, 0, 0, 0) + payload.ljust(8, b"\x00"))
    else:
        sock.send(struct.pack("=IBBBB", cid, n, CANFD_BRS, 0, 0) + payload.ljust(64, b"\x00"))

s = socket.socket(socket.AF_CAN, socket.SOCK_RAW, socket.CAN_RAW)
s.setsockopt(socket.SOL_CAN_RAW, socket.CAN_RAW_FD_FRAMES, 1)
s.bind((IFACE,))
s.settimeout(0.02)

def read_q(timeout=1.0):
    end = time.time() + timeout
    q = None
    while time.time() < end:
        try: buf = s.recv(72)
        except socket.timeout: continue
        cid = struct.unpack("=I", buf[:4])[0] & 0x1FFFFFFF
        if cid != 0x052: continue
        d = buf[8:8+48]
        v = struct.unpack(">21h", d[:42])
        q = [v[g*3]/S_POS for g in range(6)]
        e = [v[g*3+2]/S_EFF for g in range(6)]
        return q, e
    return None, None

q0, e0 = read_q(2.0)
if q0 is None:
    print(f"  no 0x052 on {IFACE} -- arm not reporting"); raise SystemExit(1)
start = list(q0)
print(f"  {IFACE}: start pose (deg) {[round(math.degrees(x),2) for x in start]}")
print(f"  start effort            {[round(x,3) for x in e0]}")
print(f"  streaming p_des = q, kp={KP} kd={KD}, leash +/-6 deg, {SECS:.0f}s")
print(f"  --- MOVE THE ARM BY HAND NOW ---")

q = list(start)
n_tx = n_rx = 0
maxdev = 0.0
eff_max = [0.0]*6
t0 = time.time()
nxt = t0
aborted = False
while time.time() - t0 < SECS:
    nq, ne = read_q(0.01)
    while True:
        _n, _e = read_q(0.0)
        if _n is None: break
        nq, ne = _n, _e; n_rx += 1
    if nq is not None:
        q = nq; n_rx += 1
        for i in range(6): eff_max[i] = max(eff_max[i], abs(ne[i]))
        dev = max(abs(q[i]-start[i]) for i in range(6))
        maxdev = max(maxdev, dev)
        if dev > ABORT:
            print(f"  ABORT: joint moved {math.degrees(dev):.1f} deg (>12) -- stopping stream")
            aborted = True; break
    now = time.time()
    if now >= nxt:
        nxt = now + 1.0/RATE
        p_des = [max(start[i]-LEASH, min(start[i]+LEASH, q[i])) for i in range(6)]
        send(s, 0x050, encode(p_des, [0.0]*6, [KP]*6, [KD]*6, [0.0]*6))
        n_tx += 1

qf, ef = read_q(1.0)
print()
print(f"  frames tx={n_tx} rx={n_rx}   telemetry {'LIVE' if n_rx > 100 else 'STALLED'}")
print(f"  largest deviation from start: {math.degrees(maxdev):.2f} deg")
print(f"  per-joint |effort| max: {[round(x,2) for x in eff_max]}")
if qf: print(f"  final pose (deg) {[round(math.degrees(x),2) for x in qf]}")
print(f"  {'ABORTED' if aborted else 'completed'} -- stream stopped, arm now holds its last setpoint")
