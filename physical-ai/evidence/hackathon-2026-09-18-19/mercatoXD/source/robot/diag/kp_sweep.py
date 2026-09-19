"""Lowest kp the arm will ACCEPT. J2 moving = frame processed."""
import socket, struct, time, math
FIELDS=((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))
KP_DEF=[30.,30.,30.,20.,5.,5.]; KD_DEF=[1.,1.,1.,.5,.5,.5]
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
q=None
def drain():
    global q
    ok=False
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42]); q=[r[g*3]/4700.0 for g in range(7)]; ok=True
    return ok
t0=time.time()
while not drain() and time.time()-t0<3: time.sleep(0.002)
def hold(p,kp,kd,secs):
    t0=time.time()
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.]*6,kp,kd,[0.]*6).ljust(64,b"\x00"))
        drain(); time.sleep(1/200.)
print(f"  {'kp[J1]':>8} {'J2 moved':>10}  frame")
print(f"  {'-'*8} {'-'*10}  {'-'*20}")
raw_seen=[]
for kp1 in (0.0, 0.008, 0.017, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0):
    drain(); start=list(q[:6]); p=list(start); p[1]=start[1]+math.radians(1.5)
    kp=list(KP_DEF); kd=list(KD_DEF); kp[0]=kp1
    hold(p,kp,kd,1.8); drain()
    moved=math.degrees(abs(q[1]-start[1]))
    raw=int(kp1*60.0)
    raw_seen.append((kp1,raw,moved))
    print(f"  {kp1:8.3f} {moved:9.2f}d  raw={raw:<4} {'ACCEPTED' if moved>0.4 else 'DISCARDED'}")
    hold(start,KP_DEF,KD_DEF,1.2)          # put J2 back
ok=[r for r in raw_seen if r[2]>0.4]
print(f"\n  lowest accepted kp[J1]: {min(r[0] for r in ok) if ok else 'NONE'}"
      f"   (encoded raw = {min(r[1] for r in ok) if ok else '-'} ; scale is kp*60)")
