"""Does t_ff have ANY authority at higher magnitude, or none at all?
J1 base yaw, no gravity. Aborts if the joint runs past 15 deg."""
import socket, struct, time, math
KP, KD = 20.0, 1.0
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
anchor=list(q[:6]); base=anchor[0]
ABORT=math.radians(15.0)
def hold(tff, secs):
    t=[0.0]*6; t[0]=tff; samp=[]
    t0=time.time()
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)
               + encode(anchor,[0.0]*6,[KP]*6,[KD]*6,t).ljust(64,b"\x00"))
        drain()
        if abs(q[0]-base)>ABORT: return None,None,True
        if time.time()-t0>secs*0.5: samp.append((q[0],e[0]))
        time.sleep(1/200.0)
    return (sum(x[0] for x in samp)/len(samp), sum(x[1] for x in samp)/len(samp), False)
hold(0.0,1.5)
print(f"  {'t_ff':>6} {'offset':>9} {'predicted':>10} {'effort':>9}")
for tff in (0.0, 2.0, 4.0, 6.0, 8.0, 12.0, -12.0):
    pos,eff,ab = hold(tff, 3.0)
    if ab:
        print(f"  {tff:6.1f}   ABORT: J1 ran past 15 deg -- t_ff HAS AUTHORITY"); break
    print(f"  {tff:6.1f} {math.degrees(pos-base):8.2f}d {math.degrees(tff/KP):9.2f}d {eff:9.2f}")
    hold(0.0,1.0)
hold(0.0,1.5)
