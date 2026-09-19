"""Does EVERY joint respond to a commanded step? If the per-joint frame layout
were wrong, some joints would obey and others would not -- which would be a
configuration error rather than mechanics."""
import socket, struct, time, math
KP,KD=20.0,1.0
LIMITS=[(-2.880,2.880),(0.0,3.142),(-3.316,0.0),(-1.571,1.571),(-1.571,1.571),(-2.880,2.880)]
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
q=e=None
def drain():
    global q,e
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42])
        q=[r[g*3]/4700.0 for g in range(7)]; e=[r[g*3+2]/600.0 for g in range(7)]
t0=time.time()
while q is None and time.time()-t0<3: drain(); time.sleep(0.002)
def hold(p,secs):
    t0=time.time()
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.]*6,[KP]*6,[KD]*6,[0.]*6).ljust(64,b"\x00"))
        drain(); time.sleep(1/200.)
print(f"  {'joint':>6} {'commanded':>10} {'moved':>8} {'ratio':>7} {'eff':>7}  verdict")
for J in range(6):
    drain(); start=list(q[:6]); p=list(start)
    lo,hi=LIMITS[J]
    step=math.radians(2.0)
    if start[J]+step > hi: step=-step                 # move away from the stop
    p[J]=max(lo,min(hi,start[J]+step))
    cmd=math.degrees(p[J]-start[J])
    if abs(cmd)<0.5:
        print(f"  {'J'+str(J+1):>6}   no room inside limits, skipped"); continue
    peak=0.0; emax=0.0; t0=time.time()
    while time.time()-t0<2.5:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.]*6,[KP]*6,[KD]*6,[0.]*6).ljust(64,b"\x00"))
        drain(); peak=max(peak,abs(q[J]-start[J])); emax=max(emax,abs(e[J]))
        time.sleep(1/200.)
    mv=math.degrees(peak); r=mv/abs(cmd)*100
    print(f"  {'J'+str(J+1):>6} {cmd:9.2f}d {mv:7.2f}d {r:6.0f}% {emax:7.2f}  "
          f"{'obeys' if r>70 else 'PARTIAL' if r>20 else 'NO RESPONSE'}")
    hold(start,2.0)
