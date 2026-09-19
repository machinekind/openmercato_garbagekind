"""Is J2/J3 stiffness gravity (asymmetric) or the servo (symmetric)?

Floats ONLY J2 and J3; every other joint holds a fixed setpoint.
Logs position, setpoint, error, effort and velocity at 200 Hz.
"""
import socket, struct, time, math, sys
SECS=float(sys.argv[1]) if len(sys.argv)>1 else 24.0
KP=20.0; KD=0.0; FREE=(1,2)              # J2, J3 zero-indexed
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
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind(("can0",)); s.settimeout(0.0)
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
start=list(q[:6]); p=list(start)
print(f"  J2 start {math.degrees(start[1]):+.2f}  J3 start {math.degrees(start[2]):+.2f}")
print(f"  J2/J3 floating, others held rigid.\n")
print(f"  0-{SECS/2:.0f}s : push J2 and J3 UP (lift the arm)")
print(f"  {SECS/2:.0f}-{SECS:.0f}s: push J2 and J3 DOWN (lower it)\n")
rows=[]; t0=time.time(); nxt=t0
while time.time()-t0<SECS:
    drain()
    for j in FREE: p[j]=q[j]
    now=time.time()
    if now>=nxt:
        nxt=now+1/200.0
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
        rows.append((now-t0,q[1],q[2],e[1],e[2],v[1],v[2]))
    time.sleep(0.0005)
half=SECS/2
for tag,sel in (("UP   phase", lambda r: r[0]<half), ("DOWN phase", lambda r: r[0]>=half)):
    sub=[r for r in rows if sel(r)]
    for name,qi,ei,vi in (("J2",1,3,5),("J3",2,4,6)):
        mv=math.degrees(max(r[qi] for r in sub)-min(r[qi] for r in sub))
        print(f"  {tag} {name}: travel {mv:6.2f} deg   |eff| mean {sum(abs(r[ei]) for r in sub)/len(sub):5.2f} "
              f"max {max(abs(r[ei]) for r in sub):5.2f}   |v|max {math.degrees(max(abs(r[vi]) for r in sub)):5.1f} deg/s")
