#!/usr/bin/env python3
"""Does the gravity bias lock the joints? Three phases, same arm, same hands.

  A  NOTHING SENT           -- the arm's own default hold
  B  FLOAT p_des = q        -- setpoint chases position, no bias, no assist
  C  FLOAT + gravity bias   -- adds the learned standing offset

Move EVERY joint in each phase. If B frees joints that A does not, the float
works. If C is stiffer than B, the bias is locking them and the hypothesis is
right. Travel per joint per phase is printed at the end.

Nothing here is destructive: phases stream p_des = q at most, and on exit the
arm re-latches where it is.
"""
import socket, struct, time, math, sys

IFACE = sys.argv[1] if len(sys.argv) > 1 else "can0"
PHASE = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
KP, KD = 20.0, 0.0
GAIN, DEADV, ADAPTV, BMAX = 0.5, math.radians(1.0), math.radians(15.0), math.radians(8.0)
LEASH = math.radians(60.0)
FIELDS = ((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))

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

def run(label, stream, bias_on):
    print(f"\n{'='*66}")
    print(f"  PHASE {label}   ({PHASE:.0f}s)   -- MOVE EVERY JOINT NOW")
    print(f"{'='*66}")
    drain(); start=list(q[:6]); p=list(start); bias=[0.0]*6
    lo=list(start); hi=list(start); emax=[0.0]*6
    t0=time.time(); nxt=t0; prev=t0
    while time.time()-t0<PHASE:
        drain(); now=time.time()
        for j in range(6):
            lo[j]=min(lo[j],q[j]); hi[j]=max(hi[j],q[j]); emax[j]=max(emax[j],abs(e[j]))
        dt=max(1e-4,now-prev); prev=now
        if stream:
            for j in range(6):
                if bias_on and DEADV < abs(v[j]) < ADAPTV:
                    bias[j]=max(-BMAX,min(BMAX,bias[j]-GAIN*v[j]*dt))
                p[j]=max(start[j]-LEASH,min(start[j]+LEASH,q[j]+bias[j]))
            if now>=nxt:
                nxt=now+1/200.0
                s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)
                       + encode(p,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
        time.sleep(0.0005)
    trav=[math.degrees(hi[j]-lo[j]) for j in range(6)]
    print(f"  travel: {[round(x,2) for x in trav]}")
    if bias_on: print(f"  final bias: {[round(math.degrees(b),2) for b in bias]}")
    return trav, emax

res={}
res['A'], eA = run("A  NOTHING SENT", False, False)
for i in (5,3,1): print(f"  next phase in {i}s..."); time.sleep(2)
res['B'], eB = run("B  FLOAT p_des=q", True, False)
for i in (5,3,1): print(f"  next phase in {i}s..."); time.sleep(2)
res['C'], eC = run("C  FLOAT + gravity bias", True, True)

print(f"\n{'='*66}")
print("  TRAVEL PER JOINT PER PHASE (degrees)")
print(f"  {'joint':>6} {'A none':>9} {'B float':>9} {'C +bias':>9}   verdict")
for j in range(6):
    A,B,C = res['A'][j], res['B'][j], res['C'][j]
    if B > A*2 + 1.0 and C < B*0.5:      v="float frees it, BIAS LOCKS IT"
    elif B > A*2 + 1.0:                  v="float frees it; bias fine"
    elif A > 2.0:                        v="already free with nothing sent"
    elif max(A,B,C) < 1.0:               v="never moved in any phase"
    else:                                v="marginal"
    print(f"  {'J'+str(j+1):>6} {A:9.2f} {B:9.2f} {C:9.2f}   {v}")
