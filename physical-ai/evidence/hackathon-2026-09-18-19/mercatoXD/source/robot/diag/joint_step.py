"""Can the MOTOR move J2/J3, even though hands cannot?"""
import socket, struct, time, math, sys
IFACE="can0"; KP=20.0; KD=1.0
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
q=e=None
def drain():
    global q,e
    ok=False
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42])
        q=[r[g*3]/4700.0 for g in range(7)]; e=[r[g*3+2]/600.0 for g in range(7)]; ok=True
    return ok
t0=time.time()
while not drain() and time.time()-t0<3: time.sleep(0.002)
LIMITS=[(-2.880,2.880),(0.0,3.142),(-3.316,0.0),(-1.571,1.571),(-1.571,1.571),(-2.880,2.880)]
for J,step_deg in ((1, +2.0), (2, -2.0)):        # J2 up (away from 0), J3 down (away from 0)
    drain(); start=list(q[:6]); p=list(start)
    lo,hi=LIMITS[J]
    p[J]=max(lo,min(hi,start[J]+math.radians(step_deg)))
    actual=math.degrees(p[J]-start[J])
    peak=0.0; emax=0.0; t0=time.time()
    while time.time()-t0<2.5:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
        drain(); peak=max(peak,abs(q[J]-start[J])); emax=max(emax,abs(e[J]))
        time.sleep(1/200.0)
    moved=math.degrees(peak)
    print(f"  J{J+1}: commanded {actual:+.2f} deg -> moved {moved:5.2f} deg "
          f"({moved/abs(actual)*100 if actual else 0:3.0f}%)  |eff|max {emax:5.2f}  "
          f"{'MOTOR CAN MOVE IT' if moved>0.5 else 'MOTOR CANNOT MOVE IT EITHER'}")
    # put it back
    t0=time.time()
    while time.time()-t0<2.0:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(start,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
        drain(); time.sleep(1/200.0)
