"""Do codes 3 or 4 drop torque while KEEPING telemetry? Never tested."""
import socket, struct, time, math, sys, subprocess
IFACE="can0"; CODE=int(sys.argv[1]); WIN=float(sys.argv[2]) if len(sys.argv)>2 else 15.0
s=socket.socket(socket.AF_CAN,socket.SOCK_RAW,socket.CAN_RAW)
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind((IFACE,)); s.settimeout(0.0)
def grab(secs):
    fr=[]; t0=time.time()
    while time.time()-t0<secs:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): time.sleep(0.001); continue
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        fr.append(b[8:8+48])
    return fr
def rep(tag,fr):
    if not fr: return print(f"  {tag}: NO FRAMES")
    pos=[struct.unpack(">21h",f[:42]) for f in fr]
    rng=max(math.degrees((max(p[g*3] for p in pos)-min(p[g*3] for p in pos))/4700.0) for g in range(7))
    eff=max(abs(p[g*3+2])/600.0 for p in pos for g in range(7))
    print(f"  {tag}: {len(fr)} frames, {len(set(fr))} distinct, pos-range {rng:.2f} deg, "
          f"|eff|max {eff:.2f}  -> {'LIVE' if len(set(fr))>1 else 'FROZEN'}")
rep("before      ", grab(3.0))
print(f"\n  >>> sending FF {CODE} -- HOLD THE ARM <<<\n")
subprocess.run(f"cansend {IFACE} 053#{CODE:02X}", shell=True, check=True)
time.sleep(0.5)
print(f"  ---- MOVE THE ARM BY HAND FOR {WIN:.0f}s ----")
fr=grab(WIN)
rep(f"after FF {CODE} ", fr)
print("\n  re-enabling (1 -> 5 -> 6)")
for c in (1,5,6):
    subprocess.run(f"cansend {IFACE} 053#{c:02X}", shell=True, check=True); time.sleep(0.4)
time.sleep(0.5)
rep("re-enabled  ", grab(3.0))
