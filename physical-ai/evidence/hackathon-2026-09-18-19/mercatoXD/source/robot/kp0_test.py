#!/usr/bin/env python3
"""Does kp=0 free a joint, as Galaxea's A1Z docs say it should?

  "kp=0, kd=small value -- only gravity compensation torque counters gravity;
   the arm can be freely backdriven."

Tested on J1 ONLY. J1 is base yaw: no gravity load, so kp=0 there cannot make
the arm fall. Every other joint keeps Galaxea's documented default gains
KP [30,30,30,20,5,5] / KD [1,1,1,0.5,0.5,0.5] and holds its position.

Phase A sends nothing (control). Phase B sends kp[J1]=0. Same joint, same hands.

To prove the frame is ACCEPTED rather than discarded, phase B also commands J2
by +1.5 deg with its normal kp=30. If J2 moves, the frame was processed -- so a
motionless J1 would mean kp=0 does not free it, not that the frame was dropped.
"""
import socket, struct, time, math, sys

IFACE = sys.argv[1] if len(sys.argv) > 1 else "can0"
JFREE = int(sys.argv[4]) - 1 if len(sys.argv) > 4 else 0
PHASE = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
KD_FREE = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
KP_DEF = [30.0, 30.0, 30.0, 20.0, 5.0, 5.0]      # Galaxea documented defaults
KD_DEF = [1.0, 1.0, 1.0, 0.5, 0.5, 0.5]
FIELDS=((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))

def encode(p,v,kp,kd,t):
    out=bytearray(60)
    for j in range(6):
        for k,vals in enumerate((p,v,kp,kd,t)):
            lo,hi,sc=FIELDS[k]; x=max(lo,min(hi,vals[j]))
            raw=max(-32768,min(32767,int(x*sc))); off=j*10+k*2
            out[off]=(raw>>8)&0xFF; out[off+1]=raw&0xFF
    return bytes(out)

s=socket.socket(socket.AF_CAN,socket.SOCK_RAW,socket.CAN_RAW)
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind((IFACE,)); s.settimeout(0.0)
q=v=e=None
def drain():
    global q,v,e
    ok=False
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42])
        q=[r[g*3]/4700.0 for g in range(7)]; v=[r[g*3+1]/750.0 for g in range(7)]
        e=[r[g*3+2]/600.0 for g in range(7)]; ok=True
    return ok
t0=time.time()
while not drain() and time.time()-t0<3: time.sleep(0.002)

def run(label, stream):
    print(f"\n{'='*64}\n  {label}   ({PHASE:.0f}s)  -- SWING J1 (base yaw) BY HAND\n{'='*64}")
    drain(); start=list(q[:6])
    lo=list(start); hi=list(start); emax=[0.0]*6
    p=list(start)
    if stream: p[1]=start[1]+math.radians(1.5)      # J2 probe: proves acceptance
    t0=time.time(); nxt=t0
    while time.time()-t0<PHASE:
        drain()
        for j in range(6):
            lo[j]=min(lo[j],q[j]); hi[j]=max(hi[j],q[j]); emax[j]=max(emax[j],abs(e[j]))
        now=time.time()
        if stream and now>=nxt:
            nxt=now+1/200.0
            kp=list(KP_DEF); kd=list(KD_DEF)
            kp[JFREE]=0.0; kd[JFREE]=KD_FREE
            p[JFREE]=q[JFREE]
            s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)
                   + encode(p,[0.0]*6,kp,kd,[0.0]*6).ljust(64,b"\x00"))
        time.sleep(0.0005)
    trav=[math.degrees(hi[j]-lo[j]) for j in range(6)]
    print(f"  travel/joint: {[round(x,2) for x in trav]}")
    print(f"  J{JFREE+1} travel {trav[JFREE]:.2f} deg   J{JFREE+1} |eff|max {emax[JFREE]:.2f}")
    if stream:
        j2 = math.degrees(abs(q[1]-start[1]))
        print(f"  J2 probe: commanded +1.50 deg, moved {j2:.2f} deg -> "
              f"{'FRAME ACCEPTED' if j2>0.4 else 'FRAME MAY BE DISCARDED'}")
    return trav

a = run("PHASE A  NOTHING SENT (control)", False)
for i in (4,2): print(f"  next phase in {i}s..."); time.sleep(2)
b = run(f"PHASE B  kp[J1]=0  kd[J1]={KD_FREE}", True)
print(f"\n{'='*64}")
print(f"  J{JFREE+1} travel:  A(nothing) {a[JFREE]:.2f} deg   B(kp=0) {b[JFREE]:.2f} deg")
if b[JFREE] > a[JFREE]*2 + 3.0:
    print("  >>> kp=0 FREES THE JOINT. The docs are right and our earlier")
    print("      'kp=0 frames are discarded' was a false negative.")
else:
    print("  >>> kp=0 changed nothing on this interface.")
